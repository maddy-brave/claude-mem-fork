# Maintaining this fork

This is a personal fork of `thedotmack/claude-mem`, pinned so Claude Code loads it
instead of upstream. It carries a small set of cross-platform + Windows patches on
top of a tagged upstream base. This file is the single source of truth during an
upstream rebase: what each patch is for, whether upstream now covers it, and how to
bring the fork forward without re-introducing already-fixed bugs.

## Branch + tag layout

- `stable-v13.10.2` — **current canonical branch.** Base: upstream **v13.10.2**, merged
  on top of the prior `stable-v13.6.1` line (which was at `v13.6.1-fork.3` plus the D4
  observer batch/throttle commit). Merge-based history (see "Rebase procedure"). Mac- and
  Windows-compatible. Rollback tag `rollback/2026-07-11-pre-v13.10.2-rebase` (pre-merge
  fork.3 head `6428eaf9`).
- `stable-v13.6.1` — prior canonical branch (base v13.6.1, last released
  `v13.6.1-fork.3`). Kept as the rollback record; do not delete.
- `stable-v13.5.5` — prior canonical branch (base v13.5.5, last released `v13.5.5-fork.3`).
  Kept as the rollback record; do not delete.
- `mac-v13.5.5` — identical to `stable-v13.5.5` (zero divergence). Kept as a named
  pointer for the Mac workstation. Historically the Mac branch carried an extra
  `bash -c` hook wrap; that wrap is no longer needed (see below), so the branches have
  converged.
- `v13.5.5-fork.1` — annotated tag at the merge commit (the first released fork build).
- `v13.5.5-fork.2` — dependency-maintenance release on `stable-v13.5.5`: `@anthropic-ai/claude-agent-sdk` `^0.2.138` -> `^0.3.172` (resolved 0.3.172). No source changes beyond the version pin + provenance comment; worker bundle rebuilt. See "Dependency maintenance" below.
- `v13.5.5-fork.3` — file-based OAuth token POOL (`src/shared/oauth-token-pool.ts`, `oauth-token.ts`, `ClaudeProvider.ts`) for Claude-Code-only machines (keychain absent). Rides along on `stable-v13.6.1`; inert on Windows (keychain present).
- `v13.6.1-fork.1` — annotated tag at the v13.6.1 merge commit. Base upstream **v13.6.1**; carries all fork.1–fork.3 patches minus `spawn-lock.ts` (dropped → upstream `worker-spawn-gate.ts`). Rollback tag `rollback/2026-06-17-pre-v13.6.1-rebase`.
- `v13.6.1-fork.2` — OAuth Option A: expired keychain falls through to the token pool.
- `v13.6.1-fork.3` — observer poison-loop durable fix (respawn decouple + rate-limit pool
  rotation + prompt guard). Fix A (respawn decouple) DROPPED at v13.10.2 → upstreamed
  (see patch table); Fix B (pool rotation) and Fix C (prompt XML guard) carried forward.
- `v13.10.2-fork.1` — annotated tag at the v13.10.2 merge commit. Base upstream
  **v13.10.2**. Adds the D4 observer batch/throttle levers (default-off) and RESTORES the
  daemon-side port-walk that was silently lost at the v13.6.1 rebase ("Option A" kept only
  pidfile discovery — ledger bug B1 recurred 2026-07-11 as a direct result). Also fixes B1
  itself: the daemon duplicate gate now health-probes before refusing, so a dead-PID ghost
  LISTEN socket no longer blocks startup (it is walked past instead).
- Older: `stable` (base v13.3.0), `mac-sh-hook-wrapper-2026-05-28` (v13.3.0 + the old
  Mac wrap), tag `v13.3.1-fork.2`, and `rollback/2026-06-11-pre-v13.5.5-rebase`
  (pre-rebase rollback point). Do not delete; they are the rollback record.

Fork version string is bumped to `<upstream>-fork.N` on every rebase so the plugin
cache key changes and Claude Code lands fresh content in a new cache dir.

## Patch inventory (status at v13.10.2)

| Area | Origin | Platform | Status at v13.10.2 |
|---|---|---|---|
| Worker port-walk on EADDRINUSE + kernel bind probe + pidfile-authoritative `getWorkerPort` | `src/services/worker-service.ts`, `worker-spawner.ts`, `src/shared/worker-utils.ts`, `HealthMonitor.ts` | cross (Windows phantom-listener primary) | **KEEP, RE-DERIVED + EXTENDED at v13.10.2.** Upstream `isPortInUse` adopted the POSIX bind probe but on win32 STILL HTTP-probes (the phantom false-negative trap) — fork keeps the bind probe on all platforms, now defaulting to the configured worker host. The daemon-side walk loop in `WorkerService.start()` was silently LOST at the v13.6.1 rebase (only pidfile discovery was kept — "Option A") and is RESTORED here, walk base `getConfiguredWorkerPort()`, actual bound port written to the pidfile + `clearPortCache()`. NEW (ledger B1 fix): the `--daemon` duplicate gate health-probes (`waitForHealth`) before refusing — bound-but-unresponsive (ghost/foreign) falls through to the walk instead of `exit 0`. Fork-side `isProcessAlive` re-pointed to upstream's `supervisor/process-registry.isPidAlive`. All fork blocks tagged `// WINDOWS-FORK:`. |
| Observer poison-loop Fix A: respawn only on `poisoned` output class | was `src/services/worker/agents/ResponseProcessor.ts` (fork.3) | cross | **DROPPED → upstreamed (v13.9.0, `ad4bd6f7`).** Upstream went further than Fix A: the `poisoned` class, `respawnPoisonedSession`, and invalid-output respawn are REMOVED entirely; quota-limit prose now pauses the generator and preserves the queued batch (`isQuotaLimitedObserverOutput`), other non-XML output drops-and-confirms. Do NOT reintroduce the fork block — its symbols no longer exist. |
| Observer poison-loop Fix B: in-band rate-limit → `classifyClaudeError` `rate_limit` → OAuth pool rotation + keychain cooldown | `src/services/worker/ClaudeProvider.ts`, `src/shared/oauth-token.ts`, `oauth-token-pool.ts` (fork.3) | cross (Claude-Code-only machines primary) | **KEEP** — fork-only (the token pool does not exist upstream). Coexists with upstream's quota-pause: the provider throw fires first during streaming; upstream's `ResponseProcessor` quota branch is defense-in-depth behind it. |
| D4 observer batch/throttle: `CLAUDE_MEM_OBSERVATION_BATCH_SIZE` + `CLAUDE_MEM_MAX_OBSERVATIONS_PER_SESSION` | `src/sdk/prompts.ts`, `src/services/worker/ClaudeProvider.ts`, `SessionManager.ts`, `worker-types.ts`, `SettingsDefaultsManager.ts` | cross | **KEEP (fork-only, default-off).** Coalesces N buffered observation events into one observer SDK turn; per-session observation cap with drop-and-confirm. Defaults (1 / 0) preserve upstream behavior byte-identically. |
| Spawn-lock around lazy-spawn | was `src/shared/spawn-lock.ts` (fork-only) | cross | **DROPPED → upstreamed (v13.6.1).** Upstream v13.5.6 ships `src/shared/worker-spawn-gate.ts` (`acquireSpawnLock(): boolean` + `releaseSpawnLock()`, `wx`-flag `<DATA_DIR>/spawn.lock`, 60s staleness, owner-checked release) — a strict superset. `spawn-lock.ts` deleted; `worker-utils.ts`/`worker-spawner.ts` switched to the gate API (boolean + try/finally `releaseSpawnLock`). No stale build-verify guard referenced it (Gotcha 8 clear). |
| HKCU env bootstrap when the launcher env block is empty | `src/shared/env-bootstrap.ts` (fork-only file), `SettingsDefaultsManager.ts`, `ProcessManager.ts` | Windows | **KEEP** — no upstream equivalent. |
| `sync-marketplace` uses `fs.cpSync` instead of `rsync` | `scripts/sync-marketplace.cjs` | Windows | **KEEP** — upstream still uses rsync. Subsumes the old bun-install-cwd fix. |
| `tree-sitter.exe` resolution | `src/services/smart-file-read/parser.ts` | Windows | **KEEP** — upstream `getTreeSitterBin()` falls back to bare `tree-sitter` with no `.exe`. Re-apply onto the rewritten parser after each rebase. |
| `CLAUDE_CONFIG_DIR`-aware `build-and-sync` worker:restart | `package.json` scripts | cross (multi-profile) | **KEEP** — upstream hardcodes `~/.claude`. Re-derived onto upstream's new worker:restart clause as `${CLAUDE_CONFIG_DIR:-$HOME/.claude}`. |
| Mac `bash -c` hook wrap | `plugin/hooks/hooks.json` (was a separate Mac branch) | Mac | **DROPPED** — upstream refactored hook commands to be POSIX `sh`-clean (replaced bash process substitution `< <(...)` with a portable `... \| while read` loop). Each command now parses and runs under `/bin/sh`. Verify after each rebase (see below) before assuming it stays unnecessary. |
| PreToolUse:Read timeout (was 10s) | `plugin/hooks/hooks.json` | cross | **DROPPED** — accept upstream's 60s. The 2000s runaway the 10s addressed no longer exists upstream. |
| chroma: skip `cmd.exe` wrapper for uvx spawn | `src/services/sync/ChromaMcpManager.ts` | Windows | **DROPPED → upstreamed.** Upstream spawns uvx directly on all platforms and adds `resolveUvxCommand()` (absolute uvx path on Windows). Strict superset of the fork fix. |
| mcp-search node launcher (`mcp-launcher.cjs`) + root `.mcp.json` restore | `plugin/.mcp.json`, `plugin/scripts/mcp-launcher.cjs`, `scripts/build-hooks.js` | cross | **DROPPED → upstreamed.** Upstream ships an inline `node -e` launcher in `plugin/.mcp.json`. `mcp-launcher.cjs` deleted; the fork build verification was aligned to upstream's inline launcher. |
| EACCES/EPIPE drain-all hook guard | `plugin/hooks/hooks.json` | cross | **DROPPED → upstreamed** verbatim. |
| Windows `bun.exe` direct-spawn (no `cmd.exe` shell) | `plugin/scripts/bun-runner.js` | Windows | **KEEP** — no upstream equivalent. Upstream resolves `bun.cmd` and spawns it with `shell:true`, so the chain is `node -> cmd.exe -> bun.exe`; with `windowsHide:true` the `cmd.exe` is hidden but it launches `bun.exe` WITHOUT propagating `CREATE_NO_WINDOW`, so the `bun.exe` grandchild gets a fresh **visible** console — one flash per capture-hook firing (`observation`/`file-context`/`summarize`) on Windows, i.e. effectively per tool use. The patch makes `findBun()` prefer `~/.bun/bin/bun.exe` and spawns it DIRECTLY (no shell) so `windowsHide:true` (`CREATE_NO_WINDOW`) actually suppresses the window; the `shell:true` path is retained only as a fallback for when no real `bun.exe` is resolvable (a `bun.cmd` shim cannot be spawned without a shell). bun-runner.js is copied verbatim (not bundled), so this takes effect on a plain marketplace sync with no rebuild. Re-apply onto any rewritten bun-runner after a rebase. Origin: 2026-06-16 spawn-flash durable fix, complements the external pyw windowless shim (`claude-mem-hook-windowless.py`) that handles the node-level console. At v13.10.2 upstream's spawn-shim centralization (`83dd5925`) only fixed the `where bun` lookup (direct `where` spawn, `windowsHide:true`) — merged cleanly alongside the fork patch. |
| Marketplace-path lazy-spawn (ledger bug B3) | was fork-open | cross | **CLOSED → upstreamed (v13.10.1/.2, `eeaadb4a` + `c275b340`).** `resolveWorkerScriptPath` is now cache-FIRST (versioned cache dirs, then marketplace, then cwd) with a `CLAUDE_MEM_WORKER_SCRIPT_PATH` override, so hook/MCP/CLI/restart launches converge on one worker bundle and the `node_modules`-less marketplace clone is no longer the lazy-spawn target. |

Fork-only files that must survive every rebase: `src/shared/env-bootstrap.ts`,
`src/shared/oauth-token-pool.ts` (fork.3 OAuth pool). NOTE: `src/shared/spawn-lock.ts`
was a fork-only file but was DROPPED at v13.6.1 — superseded by upstream
`src/shared/worker-spawn-gate.ts`. Do NOT reintroduce it.

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

**v13.6.1-fork.1 (2026-06-17) — upstream v13.6.1 merge.** Merged upstream `v13.6.1` onto the
prior `stable-v13.5.5` line (`v13.5.5-fork.3`) → new `stable-v13.6.1` branch. Conflict surface:
2 source (`worker-utils.ts`, `worker-spawner.ts`), root `package.json`, `scripts/sync-marketplace.cjs`,
6 manifests, 5 build-artifact `.cjs` (took upstream, rebuilt). KEEP-pidfile (Option A) re-derived:
fork's pidfile-authoritative spawn/discovery (`waitForPidfilePort` + `boundPort` + `clearPortCache`
+ `CLAUDE_MEM_WORKER_PORT` spawn env) adapted onto upstream's new `worker-spawn-gate` API; pidfile-first
`getWorkerPort` auto-merged intact; did NOT adopt upstream's settings.json `getWorkerPort` move.
`resolveBunRuntime` dropped → upstream `resolveWorkerRuntimePath` (strict superset). `spawn-lock.ts`
dropped (see table). Dep bumps from upstream: `better-auth`/`@better-auth/api-key` `^1.6.16`,
`dompurify ^3.4.9`, `posthog-node ^5.36.15`; kept fork's higher `bullmq ^5.76.9`. Validation:
`npm run build` clean (worker bundle ~2531 KB), `tsc --noEmit` 0 errors, `npm audit` 0 vulns,
`npm outdated` empty (all latest-in-range), KEEP string-literals confirmed in rebuilt bundles
(port-walk + phantom-listener + `spawn.lock` + `.oauth_tokens` + `reg query` in `worker-service.cjs`,
`tree-sitter.exe` in `mcp-server.cjs`). Runtime validation post-deploy.

**v13.10.2-fork.1 (2026-07-12) — upstream v13.10.2 merge.** Merged upstream `v13.10.2` onto
the prior `stable-v13.6.1` line (`v13.6.1-fork.3` + D4 commit) → new `stable-v13.10.2`
branch. Conflict surface: 5 source files, `package.json` + 6 manifests, 5 build-artifact
`.cjs` (took upstream, rebuilt; `server-beta-service.cjs` deleted upstream → `server-service.cjs`).
Notable upstream pickups (the reason this rebase was worthwhile — v13.6.1→v13.8.1 had been
assessed SKIP on 2026-06-28): observer prose-drop + quota-pause (`ad4bd6f7`, supersedes fork.3
Fix A), cache-first worker resolver closing ledger B3 (`c275b340`/`eeaadb4a`), centralized
Windows spawn shims (`83dd5925`), sqlite migration/settings-write hardening (`22e4325c`),
chroma uvx prewarm + shutdown hardening (`8702c8f3`), removal of client-side context truncation
(`29af0284`), 331-site error-handling sweep (`39dd77d9`), ponytail −10.4k-line cleanup +
worker-restart hardening (`edc5cf7d`), dependency health preflight (`c520c8f2`/`f7aa16d6`).
Upstream dependency reclassification adopted: runtime `dependencies` collapse to
better-auth (+api-key); the bundler-inlined set moves to devDependencies. Fork-side dep
freshness: in-range updates applied (`@clack/prompts` 1.7.0, `bullmq` 5.80.1, `esbuild` 0.28.1,
`ioredis` 5.11.1, `pg` 8.22.0, `react`/`react-dom` 19.2.7, `shell-quote` 1.10.0 — critical
newline-escape advisory GHSA-w7jw-789q-3m8p, `tree-sitter-cli` 0.26.10); `npm audit` clean bar
1 low in tsup's pinned nested esbuild (dev-server-only advisory, devDependency, not shipped;
out of in-range reach without `--force`). Majors deliberately NOT taken mid-rebase:
`@types/node` 26, `typescript` 7 (toolchain majors, separate maintenance release).
Telemetry: consent contract verified intact at v13.10.2 (`telemetry.json` `enabled === false`
→ off; only `DO_NOT_TRACK`/env rank above it) — the deployment's opt-out keeps every new
PostHog rollup/error-tracking path inert. Validation: `npm run build` clean, `tsc --noEmit`
0 errors, 7/7 hook commands parse under `sh -n`, KEEP string-literals confirmed in rebuilt
bundles (`walking to next candidate`, `phantom`, `spawn.lock`, `.oauth_tokens`, `reg query`
in `worker-service.cjs`; `tree-sitter.exe` in `mcp-server.cjs`), no `cmd.exe`+`uvx` pairing.

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
