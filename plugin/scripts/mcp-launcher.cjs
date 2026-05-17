#!/usr/bin/env node
/*
 * claude-mem MCP server launcher.
 *
 * The `.mcp.json` `command: "node"` bootstrap invokes this file via:
 *   node -e "...minimal bootstrap that resolves and requires this file..."
 *
 * Once loaded, this script searches for the bundled mcp-server.cjs across:
 *   1. $CLAUDE_PLUGIN_ROOT / $PLUGIN_ROOT (Claude Code or OpenCode plugin host)
 *   2. $PWD/plugin and $PWD (development tree)
 *   3. Codex plugin cache (.codex/plugins/cache/{claude-mem-local,thedotmack}/claude-mem/<version>/)
 *   4. Claude plugin cache (~/.claude/plugins/cache/thedotmack/claude-mem/<version>/)
 *   5. Claude marketplace install (~/.claude/plugins/marketplaces/thedotmack/plugin)
 *
 * The bash precursor lived inside `.mcp.json` args as a `sh -c` script. That broke on Windows
 * because Claude Code wraps stdio MCP server spawns through `cmd.exe /d /s /c "<command> ..."`,
 * and cmd.exe cannot resolve the bare token `sh` from its own PATH (Git Bash lives under
 * C:/Program Files/Git/bin which is not on cmd.exe's PATH). Moving the search to a real JS
 * launcher and changing the `.mcp.json` command to `node` lets cmd.exe resolve `node.exe`
 * directly (already on PATH in any Claude Code session) and skips the shell tokenisation
 * issues that arrow functions (=>) and comparison operators (<, >) would have triggered if
 * the search logic stayed inline in `args`.
 */
'use strict';

const fs = require('fs');
const path = require('path');

function listVersions(root) {
  let entries;
  try {
    entries = fs.readdirSync(root);
  } catch (_) {
    return [];
  }
  const versioned = [];
  for (const name of entries) {
    if (!/^[0-9]/.test(name)) continue;
    let mtimeMs;
    try {
      mtimeMs = fs.statSync(path.join(root, name)).mtimeMs;
    } catch (_) {
      continue;
    }
    versioned.push({ name, mtimeMs });
  }
  versioned.sort(function compareNewestFirst(a, b) {
    return b.mtimeMs - a.mtimeMs;
  });
  return versioned.map(function pickName(v) {
    return path.join(root, v.name);
  });
}

function resolveServerPath() {
  const home = process.env.HOME || process.env.USERPROFILE || '';
  const configDir =
    process.env.CLAUDE_CONFIG_DIR || (home ? path.join(home, '.claude') : '');

  const candidates = [];

  const envRoot = process.env.CLAUDE_PLUGIN_ROOT || process.env.PLUGIN_ROOT;
  if (envRoot) candidates.push(envRoot);

  candidates.push(path.join(process.cwd(), 'plugin'));
  candidates.push(process.cwd());

  // Codex caches and Claude cache. Each contains one or more <version>/ subdirs.
  const versionedRoots = [];
  if (home) {
    versionedRoots.push(path.join(home, '.codex/plugins/cache/claude-mem-local/claude-mem'));
    versionedRoots.push(path.join(home, '.codex/plugins/cache/thedotmack/claude-mem'));
  }
  if (configDir) {
    versionedRoots.push(path.join(configDir, 'plugins/cache/thedotmack/claude-mem'));
  }
  for (const root of versionedRoots) {
    for (const versioned of listVersions(root)) {
      candidates.push(versioned);
    }
  }

  if (configDir) {
    candidates.push(path.join(configDir, 'plugins/marketplaces/thedotmack/plugin'));
  }

  for (let raw of candidates) {
    if (!raw) continue;
    const dir = raw.replace(/[\\/]$/, '');
    const pluginDir = fs.existsSync(path.join(dir, 'plugin/scripts')) ? path.join(dir, 'plugin') : dir;
    const serverPath = path.join(pluginDir, 'scripts/mcp-server.cjs');
    if (fs.existsSync(serverPath)) return serverPath;
  }

  return null;
}

const serverPath = resolveServerPath();
if (!serverPath) {
  process.stderr.write('claude-mem: mcp server not found\n');
  process.exit(1);
}

process.argv[1] = serverPath;
require(serverPath);
