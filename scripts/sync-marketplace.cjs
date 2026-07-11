#!/usr/bin/env node

// sync-marketplace.cjs -- cross-platform file sync.
// Uses Node fs.cpSync (Node 16.7+) instead of rsync so it works on Windows.
// All three rsync calls replaced with mirrorDir() which does rmSync+cpSync.

const { execSync } = require("child_process");
const { existsSync, readFileSync, rmSync, cpSync, mkdirSync } = require("fs");
const path = require("path");
const os = require("os");

// ---------------------------------------------------------------------------
// Profile resolution -- priority: $CLAUDE_CONFIG_DIR > ~/.claude (default)
// $CLAUDE_BRAVEAGENT_HOME is not referenced anywhere in this repo, so that
// tier is intentionally skipped per the profile-selection spec.
// ---------------------------------------------------------------------------
function resolveProfileDir() {
  if (process.env.CLAUDE_CONFIG_DIR) {
    return { dir: process.env.CLAUDE_CONFIG_DIR, source: "CLAUDE_CONFIG_DIR" };
  }
  return { dir: path.join(os.homedir(), ".claude"), source: "default" };
}

const { dir: PROFILE_DIR, source: PROFILE_SOURCE } = resolveProfileDir();

if (!existsSync(PROFILE_DIR)) {
  console.error(
    "\x1b[31m[sync-marketplace] ERROR: resolved profile dir does not exist: " + PROFILE_DIR + "\x1b[0m"
  );
  console.error(
    "\x1b[31mSet CLAUDE_CONFIG_DIR to an existing Claude Code profile directory, or create " + PROFILE_DIR + " first.\x1b[0m"
  );
  process.exit(2);
}

console.log("[sync-marketplace] target profile: " + PROFILE_DIR + " (source: " + PROFILE_SOURCE + ")");

const INSTALLED_PATH = path.join(PROFILE_DIR, "plugins", "marketplaces", "thedotmack");
const CACHE_BASE_PATH = path.join(PROFILE_DIR, "plugins", "cache", "thedotmack", "claude-mem");

// Reject obviously invalid ports before they reach http.request, which would
// throw with a confusing error like "RangeError: Port should be > 0 and < 65536".
function parseWorkerPort(value) {
  const port = Number.parseInt(String(value ?? ""), 10);
  return Number.isInteger(port) && port >= 1 && port <= 65535 ? port : null;
}

function getCurrentBranch() {
  try {
    if (!existsSync(path.join(INSTALLED_PATH, ".git"))) {
      return null;
    }
    return execSync("git rev-parse --abbrev-ref HEAD", {
      cwd: INSTALLED_PATH,
      encoding: "utf-8",
      stdio: ["pipe", "pipe", "pipe"]
    }).trim();
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Build a filter function from a list of exclude patterns + .gitignore.
// This replaces the rsync --exclude flags used previously.
// fs.cpSync filter receives absolute src paths; we compute relative paths.
//
// Pattern support (gitignore/rsync subset used in this codebase):
//   trailing /  = directory-only match
//   **          = any path sequence
//   *           = non-separator chars
//   ?           = single non-separator char
// ---------------------------------------------------------------------------
function buildCopyFilter(basePath, extraExcludes) {
  const gitignorePath = path.join(basePath, ".gitignore");
  const rawPatterns = [...(extraExcludes || [])];

  if (existsSync(gitignorePath)) {
    const lines = readFileSync(gitignorePath, "utf-8").split("\n");
    for (const line of lines) {
      const trimmed = line.trim();
      if (trimmed && !trimmed.startsWith("#") && !trimmed.startsWith("!")) {
        rawPatterns.push(trimmed);
      }
    }
  }

  function patternToRegex(pattern) {
    const dirOnly = pattern.endsWith("/");
    let p = pattern.replace(/\/$/, "");
    // Escape regex special chars except * and ?
    p = p.replace(/[.+^${}()|[\]\\]/g, "\\$&");
    // ** -> match any path sequence
    p = p.replace(/\*\*/g, "<<GLOBSTAR>>");
    // * -> non-separator chars
    p = p.replace(/\*/g, "[^/\\\\]*");
    // ? -> single non-separator char
    p = p.replace(/\?/g, "[^/\\\\]");
    // restore globstar
    p = p.replace(/<<GLOBSTAR>>/g, ".*");
    // If no slash in original (other than trailing), pattern matches basename
    const hasSlash = pattern.replace(/\/$/, "").includes("/");
    if (!hasSlash) {
      p = "(^|[/\\\\])" + p + "([/\\\\]|$)";
    } else {
      p = "^" + p + "([/\\\\]|$)";
    }
    return { regex: new RegExp(p), dirOnly };
  }

  const compiled = rawPatterns.map(patternToRegex);

  return function filter(src) {
    // src is an absolute path; compute relative to basePath
    let rel = src.slice(basePath.length);
    // normalise to forward slashes, strip leading separator
    rel = rel.replace(/\\/g, "/").replace(/^\//, "");
    if (!rel) return true; // always copy the root itself

    for (const { regex, dirOnly } of compiled) {
      if (dirOnly) {
        // Match if any path prefix component matches the pattern
        const parts = rel.split("/");
        const matches = parts.some((_, i) => {
          const prefix = parts.slice(0, i + 1).join("/");
          return regex.test(prefix);
        });
        if (matches) return false;
      } else {
        if (regex.test(rel)) return false;
      }
    }
    return true;
  };
}

// ---------------------------------------------------------------------------
// Mirror srcDir -> destDir (equivalent to rsync -av --delete).
// Wipes dest first so removed files do not persist, then copies src.
// Cross-platform: works on Windows, Linux, macOS (Node 16.7+).
// ---------------------------------------------------------------------------
function mirrorDir(srcDir, destDir, filterFn) {
  mkdirSync(path.dirname(destDir), { recursive: true });
  if (existsSync(destDir)) {
    rmSync(destDir, { recursive: true, force: true });
  }
  cpSync(srcDir, destDir, { recursive: true, force: true, filter: filterFn });
}

const branch = getCurrentBranch();
const isForce = process.argv.includes("--force");

if (branch && branch !== "main" && !isForce) {
  console.log("");
  console.log("\x1b[33m%s\x1b[0m", "WARNING: Installed plugin is on beta branch: " + branch);
  console.log("\x1b[33m%s\x1b[0m", "Running sync would overwrite beta code.");
  console.log("");
  console.log("Options:");
  console.log("  1. Use the claude-mem UI on the configured worker port to update beta");
  console.log("  2. Switch to stable in UI first, then run sync");
  console.log("  3. Force sync: npm run sync-marketplace:force");
  console.log("");
  process.exit(1);
}

function getPluginVersion() {
  try {
    const pluginJsonPath = path.join(__dirname, "..", "plugin", ".claude-plugin", "plugin.json");
    const pluginJson = JSON.parse(readFileSync(pluginJsonPath, "utf-8"));
    return pluginJson.version;
  } catch (error) {
    console.error("\x1b[31m%s\x1b[0m", "Failed to read plugin version:", error.message);
    process.exit(1);
  }
}

function detectInstalledVersion(buildVersion) {
  const dataDir = process.env.CLAUDE_MEM_DATA_DIR || path.join(os.homedir(), ".claude-mem");
  const settingsPath = path.join(dataDir, "settings.json");
  let port = parseWorkerPort(process.env.CLAUDE_MEM_WORKER_PORT);
  if (!port && existsSync(settingsPath)) {
    try {
      const s = JSON.parse(readFileSync(settingsPath, "utf8"));
      const settingsPort = parseWorkerPort(s.CLAUDE_MEM_WORKER_PORT);
      if (settingsPort) port = settingsPort;
    } catch {}
  }
  if (!port) {
    const uid = typeof process.getuid === "function" ? process.getuid() : 77;
    port = 37700 + (uid % 100);
  }
  let healthBody;
  try {
    healthBody = execSync("curl -s --max-time 2 http://127.0.0.1:" + port + "/api/health", {
      stdio: ["ignore", "pipe", "ignore"],
    }).toString().trim();
  } catch {
    return null;
  }
  if (!healthBody) return null;
  let installedVersion;
  let installedPath;
  try {
    const j = JSON.parse(healthBody);
    installedVersion = j.version;
    installedPath = j.workerPath;
  } catch {
    return null;
  }
  if (!installedVersion || installedVersion === buildVersion) return null;
  return { installedVersion, installedPath };
}

const installedMismatch = detectInstalledVersion(getPluginVersion());
if (installedMismatch) {
  console.log("");
  console.log("\x1b[33m%s\x1b[0m", "Version mismatch detected:");
  console.log("  Building:   " + getPluginVersion());
  console.log("  Installed:  " + installedMismatch.installedVersion);
  if (installedMismatch.installedPath) console.log("  Worker path: " + installedMismatch.installedPath);
  console.log("");
  console.log("Claude Code is pinned to the installed version, so the worker loads from");
  console.log("its cache dir. Mirroring this build into the installed-version cache so the");
  console.log("worker restart picks up new code without a Claude Code session restart.");
  console.log("");
  console.log("\x1b[36m%s\x1b[0m", "For a formal version bump, run `claude plugin update thedotmack/claude-mem`");
  console.log("\x1b[36m%s\x1b[0m", "and restart Claude Code so it loads the " + getPluginVersion() + " cache dir.");
  console.log("");
}

console.log("Syncing to marketplace...");
try {
  const rootDir = path.join(__dirname, "..");

  // Mirrors the original rsync exclude list for the full-repo copy:
  //   --exclude=.git --exclude=bun.lock --exclude=package-lock.json
  //   --exclude=scripts/package.json --exclude=scripts/node_modules
  //   plus all patterns from root .gitignore
  const rootExtraExcludes = [
    ".git",
    "bun.lock",
    "package-lock.json",
    "scripts/package.json",
    "scripts/node_modules",
  ];
  const rootFilter = buildCopyFilter(rootDir, rootExtraExcludes);

  console.log("  " + rootDir + " -> " + INSTALLED_PATH);
  mirrorDir(rootDir, INSTALLED_PATH, rootFilter);

  console.log("Running bun install in marketplace...");
  execSync("bun install", { cwd: INSTALLED_PATH, stdio: "inherit" });

  const version = getPluginVersion();
  const CACHE_VERSION_PATH = path.join(CACHE_BASE_PATH, version);

  const pluginDir = path.join(rootDir, "plugin");
  // plugin/ copy: .git excluded; plugin/.gitignore is currently absent
  const pluginExtraExcludes = [".git"];
  const pluginFilter = buildCopyFilter(pluginDir, pluginExtraExcludes);

  console.log("Syncing to cache folder (version " + version + ")...");
  console.log("  " + pluginDir + " -> " + CACHE_VERSION_PATH);
  mirrorDir(pluginDir, CACHE_VERSION_PATH, pluginFilter);

  console.log("Running bun install in cache folder (version " + version + ")...");
  execSync("bun install", { cwd: CACHE_VERSION_PATH, stdio: "inherit" });

  if (installedMismatch && installedMismatch.installedVersion !== version) {
    const INSTALLED_CACHE_PATH = path.join(CACHE_BASE_PATH, installedMismatch.installedVersion);
    console.log("Mirroring to installed-version cache (" + installedMismatch.installedVersion + ") for hot reload...");
    console.log("  " + pluginDir + " -> " + INSTALLED_CACHE_PATH);
    mirrorDir(pluginDir, INSTALLED_CACHE_PATH, pluginFilter);
    console.log("Running bun install in installed-version cache (" + installedMismatch.installedVersion + ")...");
    execSync("bun install", { cwd: INSTALLED_CACHE_PATH, stdio: "inherit" });
  }

  console.log("\x1b[32m%s\x1b[0m", "Sync complete!");

  console.log("\nTriggering worker restart...");
  const http = require("http");
  const dataDir = process.env.CLAUDE_MEM_DATA_DIR || path.join(os.homedir(), ".claude-mem");
  const settingsPath = path.join(dataDir, "settings.json");
  let settingsPort = null;
  if (existsSync(settingsPath)) {
    try {
      const settings = JSON.parse(readFileSync(settingsPath, "utf8"));
      settingsPort = parseWorkerPort(settings.CLAUDE_MEM_WORKER_PORT);
    } catch {
      // fall through to env / default
    }
  }
  const uid = typeof process.getuid === "function" ? process.getuid() : 77;
  const defaultPort = 37700 + (uid % 100);
  const workerPort =
    parseWorkerPort(process.env.CLAUDE_MEM_WORKER_PORT) ??
    settingsPort ??
    defaultPort;
  const req = http.request({
    hostname: "127.0.0.1",
    port: workerPort,
    path: "/api/admin/restart",
    method: "POST",
    timeout: 2000
  }, (res) => {
    if (res.statusCode === 200) {
      console.log("\x1b[32m%s\x1b[0m", "Worker restart triggered on port " + workerPort);
    } else {
      console.log("\x1b[33m%s\x1b[0m", "Worker restart on port " + workerPort + " returned status " + res.statusCode);
    }
  });
  req.on("error", () => {
    console.log("\x1b[33m%s\x1b[0m", "No worker reachable on port " + workerPort + "; the next worker:restart step will start one.");
  });
  req.on("timeout", () => {
    req.destroy();
    console.log("\x1b[33m%s\x1b[0m", "Worker restart on port " + workerPort + " timed out");
  });
  req.end();

} catch (error) {
  console.error("\x1b[31m%s\x1b[0m", "Sync failed:", error.message);
  process.exit(1);
}
