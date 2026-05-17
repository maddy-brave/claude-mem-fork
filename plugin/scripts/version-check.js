#!/usr/bin/env node
import { existsSync, readFileSync, writeFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath, pathToFileURL } from 'url';
import { homedir, platform } from 'os';
import { spawnSync } from 'child_process';
import { createRequire } from 'module';

const IS_WINDOWS = platform() === 'win32';

const BUN_COMMON_PATHS = IS_WINDOWS
  ? [join(homedir(), '.bun', 'bin', 'bun.exe')]
  : [join(homedir(), '.bun', 'bin', 'bun'), '/usr/local/bin/bun', '/opt/homebrew/bin/bun'];

const CRITICAL_SUBPATH_IMPORTS = [
  'zod',
  'zod/v3',
  'zod/v4',
  'zod/v4-mini',
  'shell-quote',
];

function resolveRoot() {
  if (process.env.CLAUDE_PLUGIN_ROOT) {
    const root = process.env.CLAUDE_PLUGIN_ROOT;
    if (existsSync(join(root, 'package.json'))) return root;
  }
  try {
    const scriptDir = dirname(fileURLToPath(import.meta.url));
    const candidate = dirname(scriptDir);
    if (existsSync(join(candidate, 'package.json'))) return candidate;
  } catch {}
  return null;
}

const ROOT = resolveRoot();
if (!ROOT) process.exit(0);

function emitUpgradeHint(message) {
  if (process.env.CLAUDE_MEM_CODEX_HOOK === '1') {
    console.log(JSON.stringify({
      hookSpecificOutput: {
        hookEventName: 'SessionStart',
        additionalContext: message,
      },
    }));
  } else {
    console.error(message);
  }
}

const LEGACY_VERSION_MARKER_RE =
  /^v?\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/;

function readInstallMarkerVersion(markerPath) {
  const content = readFileSync(markerPath, 'utf-8');
  try {
    const marker = JSON.parse(content);
    return marker && typeof marker === 'object' && typeof marker.version === 'string'
      ? marker.version
      : null;
  } catch {
    const legacyVersion = content.trim();
    return LEGACY_VERSION_MARKER_RE.test(legacyVersion)
      ? legacyVersion.replace(/^v/i, '')
      : null;
  }
}

function findBun() {
  const probe = spawnSync('bun', ['--version'], {
    encoding: 'utf-8',
    stdio: ['ignore', 'pipe', 'pipe'],
    shell: IS_WINDOWS,
  });
  if (!probe.error && probe.status === 0) return 'bun';
  return BUN_COMMON_PATHS.find(existsSync) || null;
}

function verifyCriticalModules(targetDir, pkg) {
  const deps = (pkg && pkg.dependencies) || {};
  const relevant = CRITICAL_SUBPATH_IMPORTS.filter((spec) => {
    const topLevel = spec.split('/')[0];
    return Object.prototype.hasOwnProperty.call(deps, topLevel);
  });
  if (relevant.length === 0) return [];

  const require = createRequire(pathToFileURL(join(targetDir, 'package.json')).href);
  const missing = [];
  for (const spec of relevant) {
    try {
      require.resolve(spec);
    } catch {
      missing.push(spec);
    }
  }
  return missing;
}

function runBunInstall(targetDir, bunPath) {
  const result = spawnSync(bunPath, ['install', '--ignore-scripts'], {
    cwd: targetDir,
    encoding: 'utf-8',
    stdio: ['ignore', 'pipe', 'pipe'],
    timeout: 120_000,
    shell: false,
  });
  if (result.error) throw result.error;
  if (typeof result.status === 'number' && result.status !== 0) {
    const err = new Error(`bun install exited with status ${result.status}`);
    err.stderr = result.stderr ? String(result.stderr).trim() : '';
    throw err;
  }
}

function writeMarker(markerPath, version) {
  const marker = {
    version,
    installedAt: new Date().toISOString(),
    selfHealed: true,
  };
  writeFileSync(markerPath, JSON.stringify(marker));
}

function selfHeal(pkg, markerPath) {
  const bunPath = findBun();
  if (!bunPath) {
    return { ok: false, reason: 'bun not found on PATH or in known locations' };
  }
  try {
    runBunInstall(ROOT, bunPath);
  } catch (error) {
    const msg = error?.stderr ? String(error.stderr) : String(error?.message ?? error);
    const trimmed = msg.split('\n').slice(-2).join(' | ').slice(0, 240);
    return { ok: false, reason: `bun install failed: ${trimmed}` };
  }
  const missing = verifyCriticalModules(ROOT);
  if (missing.length > 0) {
    return { ok: false, reason: `post-install verify failed: ${missing.join(', ')}` };
  }
  try {
    writeMarker(markerPath, pkg.version);
  } catch {
    // Marker write failure is non-fatal: next session will retry self-heal.
  }
  return { ok: true };
}

const SKIP_SELFHEAL = process.env.CLAUDE_MEM_DISABLE_SELFHEAL === '1';

function emitLegacyHint(markerExists, markerVersion, versionOk, pkgVersion, missing) {
  if (!markerExists) {
    emitUpgradeHint('claude-mem: runtime not yet set up - run: npx claude-mem@latest install');
  } else if (!markerVersion) {
    emitUpgradeHint('claude-mem: install marker unreadable - run: npx claude-mem@latest install');
  } else if (!versionOk) {
    emitUpgradeHint(`claude-mem: upgraded to v${pkgVersion} - run: npx claude-mem@latest install`);
  } else if (missing && missing.length > 0) {
    emitUpgradeHint(`claude-mem: missing modules ${missing.join(', ')} - run: npx claude-mem@latest install`);
  }
}

try {
  const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf-8'));
  const markerPath = join(ROOT, '.install-version');
  const markerExists = existsSync(markerPath);
  const markerVersion = markerExists ? readInstallMarkerVersion(markerPath) : null;
  const versionOk = markerVersion === pkg.version;
  const missing = verifyCriticalModules(ROOT, pkg);
  const modulesOk = missing.length === 0;

  if (versionOk && modulesOk) {
    process.exit(0);
  }

  if (SKIP_SELFHEAL) {
    emitLegacyHint(markerExists, markerVersion, versionOk, pkg.version, missing);
    process.exit(0);
  }

  const result = selfHeal(pkg, markerPath);
  if (result.ok) {
    emitUpgradeHint(`claude-mem: self-healed to v${pkg.version} (bun install --ignore-scripts).`);
    process.exit(0);
  }

  let hint;
  if (!markerExists) {
    hint = `claude-mem: runtime not yet set up (${result.reason}) - run: npx claude-mem@latest install`;
  } else if (!markerVersion) {
    hint = `claude-mem: install marker unreadable (${result.reason}) - run: npx claude-mem@latest install`;
  } else if (!versionOk) {
    hint = `claude-mem: upgraded to v${pkg.version}, self-heal failed (${result.reason}) - run: npx claude-mem@latest install`;
  } else {
    hint = `claude-mem: missing modules ${missing.join(', ')} (${result.reason}) - run: npx claude-mem@latest install`;
  }
  emitUpgradeHint(hint);
} catch (error) {
  emitUpgradeHint(`claude-mem: install marker unreadable (${error?.message ?? 'unknown'}) - run: npx claude-mem@latest install`);
}
process.exit(0);
