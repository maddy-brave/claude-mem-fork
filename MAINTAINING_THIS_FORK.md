# Maintaining this fork

This is a personal fork of `thedotmack/claude-mem`, pinned so Claude Code loads it
instead of upstream. It carries a small set of cross-platform + Windows patches on
top of a tagged upstream base. This file is the single source of truth during an
upstream rebase: what each patch is for, whether upstream now covers it, and how to
bring the fork forward without re-introducing already-fixed bugs.

## Branch + tag layout

- `stable-v13.5.5` — current canonical branch. Base: upstream **v13.5.5**. Merge-based
  history (see "Rebase procedure"). Mac- and Windows-compatible.
- `mac-v13.5.5` — identical to `stable-v13.5.5` (zero divergence). Kept as a named
  pointer for the Mac workstation. Historically the Mac branch carried an extra
  `bash -c` hook wrap; that wrap is no longer needed (see below), so the branches have
  converged.
- `v13.5.5-fork.1` — annotated tag at the merge commit (the first released fork build).
- `v13.5.5-fork.2` — dependency-maintenance release on `stable-v13.5.5`: `@anthropic-ai/claude-agent-sdk` `^0.2.138` -> `^0.3.172` (resolved 0.3.172). No source changes beyond the version pin + provenance comment; worker bundle rebuilt. See "Dependency maintenance" below.
- Older: `stable` (base v13.3.0), `mac-sh-hook-wrapper-2026-05-28` (v13.3.0 + the old
  Mac wrap), tag `v13.3.1-fork.2`, and `rollback/2026-06-11-pre-v13.5.5-rebase`
  (pre-rebase rollback point). Do not delete; they are the rollback record.

Fork version string is bumped to `<upstream>-fork.N` on every rebase so the plugin
cache key changes and Claude Code lands fresh content in a new cache dir.

## Patch inventory (status at v13.5.5)

| Area | Origin | Platform | Status at v13.5.5 |
|---|---|---|---|
| Worker port-walk on EADDRINUSE + kernel bind probe + pidfile-authoritative `getWorkerPort` | `src/services/worker-service.ts`, `worker-spawner.ts`, `src/shared/worker-utils.ts`, `HealthMonitor.ts` | cross (Windows phantom-listener primary) | **KEEP** — no upstream equivalent. Upstream `isPortInUse` still HTTP-probes; it exits cleanly on EADDRINUSE but does not walk. |
| Spawn-lock around lazy-spawn | `src/shared/spawn-lock.ts` (fork-only file), integrated in `worker-utils.ts` | cross | **KEEP** — no upstream equivalent. |
| HKCU env bootstrap when the launcher env block is empty | `src/shared/env-bootstrap.ts` (fork-only file), `SettingsDefaultsManager.ts`, `ProcessManager.ts` | Windows | **KEEP** — no upstream equivalent. |
| `sync-marketplace` uses `fs.cpSync` instead of `rsync` | `scripts/sync-marketplace.cjs` | Windows | **KEEP** — upstream still uses rsync. Subsumes the old bun-install-cwd fix. |
| `tree-sitter.exe` resolution | `src/services/smart-file-read/parser.ts` | Windows | **KEEP** — upstream `getTreeSitterBin()` falls back to bare `tree-sitter` with no `.exe`. Re-apply onto the rewritten parser after each rebase. |
| `CLAUDE_CONFIG_DIR`-aware `build-and-sync` worker:restart | `package.json` scripts | cross (multi-profile) | **KEEP** — upstream hardcodes `~/.claude`. Re-derived onto upstream's new worker:restart clause as `${CLAUDE_CONFIG_DIR:-$HOME/.claude}`. |
| Mac `bash -c` hook wrap | `plugin/hooks/hooks.json` (was a separate Mac branch) | Mac | **DROPPED** — upstream refactored hook commands to be POSIX `sh`-clean (replaced bash process substitution `< <(...)` with a portable `... \| while read` loop). Each command now parses and runs under `/bin/sh`. Verify after each rebase (see below) before assuming it stays unnecessary. |
| PreToolUse:Read timeout (was 10s) | `plugin/hooks/hooks.json` | cross | **DROPPED** — accept upstream's 60s. The 2000s runaway the 10s addressed no longer exists upstream. |
| chroma: skip `cmd.exe` wrapper for uvx spawn | `src/services/sync/ChromaMcpManager.ts` | Windows | **DROPPED → upstreamed.** Upstream spawns uvx directly on all platforms and adds `resolveUvxCommand()` (absolute uvx path on Windows). Strict superset of the fork fix. |
| mcp-search node launcher (`mcp-launcher.cjs`) + root `.mcp.json` restore | `plugin/.mcp.json`, `plugin/scripts/mcp-launcher.cjs`, `scripts/build-hooks.js` | cross | **DROPPED → upstreamed.** Upstream ships an inline `node -e` launcher in `plugin/.mcp.json`. `mcp-launcher.cjs` deleted; the fork build verification was aligned to upstream's inline launcher. |
| EACCES/EPIPE drain-all hook guard | `plugin/hooks/hooks.json` | cross | **DROPPED → upstreamed** verbatim. |
| Windows `bun.exe` direct-spawn (no `cmd.exe` shell) | `plugin/scripts/bun-runner.js` | Windows | **KEEP** — no upstream equivalent. Upstream resolves `bun.cmd` and spawns it with `shell:true`, so the chain is `node -> cmd.exe -> bun.exe`; with `windowsHide:true` the `cmd.exe` is hidden but it launches `bun.exe` WITHOUT propagating `CREATE_NO_WINDOW`, so the `bun.exe` grandchild gets a fresh **visible** console — one flash per capture-hook firing (`observation`/`file-context`/`summarize`) on Windows, i.e. effectively per tool use. The patch makes `findBun()` prefer `~/.bun/bin/bun.exe` and spawns it DIRECTLY (no shell) so `windowsHide:true` (`CREATE_NO_WINDOW`) actually suppresses the window; the `shell:true` path is retained only as a fallback for when no real `bun.exe` is resolvable (a `bun.cmd` shim cannot be spawned without a shell). bun-runner.js is copied verbatim (not bundled), so this takes effect on a plain marketplace sync with no rebuild. Re-apply onto any rewritten bun-runner after a rebase. Origin: 2026-06-16 spawn-flash durable fix, complements the external pyw windowless shim (`claude-mem-hook-windowless.py`) that handles the node-level console. |

Fork-only files that must survive every rebase: `src/shared/spawn-lock.ts`,
`src/shared/env-bootstrap.ts`.

## Dependency maintenance

Every fork release keeps installed dependencies current with latest in-range security and
bug-fix versions, not just enough to make the build resolve (the `npm install --no-audit`
build step is build-correctness only). On each release: `npm outdated`, pull in-range
patch/minor updates, `npm audit` (apply fixes in-range only, never `--force`), re-verify the
security-sensitive set (express, better-auth, dompurify, bullmq, ioredis, pg, shell-quote,
@modelcontextprotocol/sdk), then `npm run build` so the new versions are bundled into
`worker-service.cjs` (a source bump that is not rebuilt never reaches the runtime).

**v13.5.5-fork.2 (2026-06-11) — Agent SDK 0.2.141 -> 0.3.172.** Previously deferred as a
breaking-minor decision; executed as an isolated dependency-maintenance release.
- The SDK consumer surface is `query()` + a hardened `Options` object + the `SDKUserMessage`
  / `SDK* ` types (`src/sdk/hardened-options.ts`, `src/services/worker/ClaudeProvider.ts`,
  `src/services/worker/knowledge/KnowledgeAgent.ts`, `worker-types.ts`, `RateLimitStore.ts`).
- 0.3 breaking changes assessed against that surface and found non-impacting: the
  `unstable_v2_*` session API is unused (`query()` only); `options.env` replace-vs-overlay
  (landed 0.2.113) is already the intended behaviour here (`env: isolatedEnv`, deliberately
  NOT `process.env`); `mcpServers:{}` is empty so the 0.3.142 background-MCP-connect change is
  moot; no `TodoWrite` tool-event parsing; `RateLimitStore` consumes the `{subtype:'rate_limit'}`
  info event, not the `api_retry.error` 529 string that changed to `'overloaded'` in 0.3.150.
- Peer-dep move (0.3.143: `@anthropic-ai/sdk` + `@modelcontextprotocol/sdk` -> peerDependencies)
  is transparent: the SDK self-bundles them, esbuild resolves cleanly, `@modelcontextprotocol/sdk`
  is already a direct dep. `@anthropic-ai/sdk` is intentionally absent from node_modules.
- Validation: `npm run build` clean (bundle 2444 KB, within budget), `tsc --noEmit` 0 errors,
  worker `--version` boot exit 0, fork features present in the rebuilt bundle (port-walk
  EADDRINUSE, spawn-lock, CLAUDE_MEM_DATA_DIR). Runtime `query()` validation (observation
  generation) happens post-deploy.

## Telemetry / privacy (corporate deployment)

Upstream v13.5.0+ ships a PostHog analytics system (`src/services/telemetry/`) and a
v13.4.1 email opt-in prompt during `npx claude-mem install`. Both default ON / on-prompt.

Opt-out is done WITHOUT a source patch (rebase-safe):

- Write `~/.claude-mem/telemetry.json` = `{ "enabled": false, "installId": "<uuid>",
  "decidedAt": "<iso>" }`. The consent resolver reads this for BOTH the worker PostHog
  transport and the CLI direct-POST transport. `installId` MUST be a string or the file
  is ignored and the default (ON) applies.
- Note: `~/.claude-mem/.env` is a strict 5-key credential whitelist
  (`ANTHROPIC_*`/`GEMINI_API_KEY`/`OPENROUTER_API_KEY`) — it will NOT carry
  `CLAUDE_MEM_TELEMETRY`. Use `telemetry.json`, or set `CLAUDE_MEM_TELEMETRY=0` /
  `DO_NOT_TRACK=1` in the actual shell environment that launches Claude Code.
- The email opt-in only fires on interactive `npx claude-mem install`; a marketplace
  pull never triggers it. Before running the installer, set `DO_NOT_TRACK=1` or
  `CLAUDE_MEM_ONLINE_OPTIN=false` in the shell.

## Rebase procedure (merge, not rebase)

`stable*` carries merge commits from prior upstream bring-ups, so a `git rebase` would
replay commits upstream already contains and explode the conflict surface. Always merge:

1. `git fetch upstream` (the `upstream` remote push URL is disabled to prevent
   accidental pushes — keep it that way).
2. New branch off the current canonical branch; `git config rerere.enabled true`.
3. `git merge --no-ff --no-commit <upstream-tag>`.
4. For `plugin/scripts/*.cjs` and `plugin/ui/viewer-bundle.js` conflicts: take upstream
   (`git checkout --theirs`), never hand-merge — they are rebuilt.
5. For `src/**`: keep the KEEP patches above, drop the DROPPED ones. Heavily-refactored
   files (worker-service, worker-utils, worker-spawner) merge cleanly more often than
   expected; resolve per the table.
6. `npm install --no-audit --no-fund` (required — esbuild bundles server-beta +
   posthog-node unconditionally; skipping it = "Could not resolve" errors).
7. `npm run build` (bundles, regenerates manifests + `plugin/package.json` + `bun.lock`,
   and runs a generator-canonical verify on the hook command strings). Bump the fork
   version in `package.json` and `.claude-plugin/marketplace.json` first.
8. Commit the merge, tag `v<upstream>-fork.N`, push branches + tag.

## Post-rebase verification (do not skip)

- Hook commands parse under the real shell: for each of the 7 hooks, run the command
  string through `/bin/sh -c` and confirm no `syntax error`. (This is how we know the
  Mac wrap stays unnecessary. If upstream ever reintroduces bash-only syntax, re-derive
  the wrap at the generator `src/build/hook-shell-template.ts`, NOT by hand-editing
  `hooks.json` — the build verify rejects hand-edited command strings.)
- `node -e "require.resolve('zod/v3')"` + `zod/v4` + `shell-quote` resolve in the
  installed cache dir (run `bun install --ignore-scripts` in the cache dir if not).
- Worker `/health` returns ok on its bound port (read `~/.claude-mem/worker.pid` `port`).
- Bundled `worker-service.cjs` contains the port-walk strings ("walk to next available
  port", "phantom listener") and no `cmd.exe`-wrapping of `uvx`.
- Telemetry: `telemetry.json` `enabled:false` present.

## Rollback

The pre-rebase build is preserved: tag `v13.3.1-fork.2`, branches `stable` /
`mac-sh-hook-wrapper-2026-05-28`, and rollback tag `rollback/2026-06-11-pre-v13.5.5-rebase`.
Revert the fork default branch to one of those in the GitHub UI and restart; no history
rewrite needed. A full file-level snapshot of the running build also exists off-repo.
