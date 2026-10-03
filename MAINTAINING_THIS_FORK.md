# Maintaining this fork

This is a personal fork of `thedotmack/claude-mem`, pinned so Claude Code loads it
instead of upstream. It carries a small set of cross-platform + Windows patches on
top of a tagged upstream base. This file is the single source of truth during an
upstream rebase: what each patch is for, whether upstream now covers it, and how to
bring the fork forward without re-introducing already-fixed bugs.

## Branch + tag layout

- `stable-v13.28.0` — **current canonical branch** (2026-10-03). Base: upstream **v13.28.0**,
  merged on top of the `stable-v13.17.0` line at `d894c7b7`. Released as `13.28.0-fork.1`.
- `stable-v13.17.0` — prior canonical branch. Base: upstream **v13.17.0**, merged on
  top of the `stable-v13.10.2` line. Head `d894c7b7` is `13.17.0-fork.2`. The 2026-10-03
  `13.28.0-fork.1` merge of upstream `v13.28.0` is cut from this head. Rollback tag
  `rollback/2026-10-03-pre-v13.28.0-rebase` at `d894c7b7`.
- `stable-v13.10.2` — prior canonical branch. Base: upstream **v13.10.2**, merged
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
- `v13.10.2-fork.2` — dependency-maintenance release on `stable-v13.10.2` (2026-07-12).
  In-range refresh of the full tree via `bun update` (notably `@anthropic-ai/claude-agent-sdk`
  `^0.3.172` -> `^0.3.207`, `bullmq` 5.80.2, `better-auth` 1.6.23, `dompurify` 3.4.12,
  `esbuild` 0.28.1, `shell-quote` 1.10.0 root + plugin, `tree-sitter-cli` 0.26.10,
  `@types/node` ^26 major). Security: `hono` forced to 4.12.29 via a new `overrides`
  entry (`^4.12.21` floor) — clears 1 high + 8 moderate advisories in the
  `@modelcontextprotocol/sdk › @hono/node-server › hono` chain that is esbuild-inlined
  into the shipped worker/mcp bundles. Known-accepted exposures (no in-range fix,
  dev-only, nothing ships): `tsup › bundle-require › esbuild@0.27.x` (low, GHSA-g7r4-m6w7-qqqr,
  tsup pins `^0.27.0`) and `np › cosmiconfig › js-yaml@4.1.1` (moderate DoS,
  GHSA-h67p-54hq-rp68, fix is the 5.x major). Deferred major: `typescript` 7.0.2
  (TS7 removed `moduleResolution=node10`, which upstream `tsconfig.json` still uses —
  migration is upstream's; fork stays on `^6.0.3`). Gates: `tsc --noEmit` 0 errors,
  build clean, 7/7 hooks `sh -n`, KEEP literals verified, segmented `bun test`
  worker+sdk equal to the pre-refresh baseline (only the known environmental
  worker-spawn status failure; CORS one-offs characterized as port-race flakes,
  0/8 failures in isolated repeats).
- `v13.12.4-fork.1` — fork release on the v13.12.4 line (2026-08-01). Commit `6eca8973a`.
  Newest fork tag found in the clone before the 13.17.0 merge.
- `v13.17.0-fork.1` — upstream **v13.17.0** merge (2026-08-29). Merge commit `fe0306b3`
  joins `6eca8973a` with upstream base `7a767820b`; version commit `fe3859e6a`. Rollback tag
  `rollback/2026-08-29-pre-v13.17.0-rebase`.
- `v13.17.0-fork.2` — follow-up release on `stable-v13.17.0` (2026-08-29). Head `d894c7b7`.
  Tag `v13.17.0-fork.1` exists on origin; fork.2 shipped by branch promotion with no tag, so
  `d894c7b7` is identified by the rollback tag above.
- `v13.28.0-fork.1` — upstream **v13.28.0** merge (2026-10-03). Merges tag `v13.28.0`
  (commit `57c38303`) into `stable-v13.17.0` at `d894c7b7`; common base `7a767820b`. Rollback
  tag `rollback/2026-10-03-pre-v13.28.0-rebase` at `d894c7b7`. Drops the `isPortInUse` bind-probe
  signature patch, removes four rows that were already upstream, and adds the port-reclaim
  composition (see "Patch inventory"). Merge the TAG, not `upstream/main`, which was 233
  commits past it.
- Older: `stable` (base v13.3.0), `mac-sh-hook-wrapper-2026-05-28` (v13.3.0 + the old
  Mac wrap), tag `v13.3.1-fork.2`, and `rollback/2026-06-11-pre-v13.5.5-rebase`
  (pre-rebase rollback point). Do not delete; they are the rollback record.

Fork version string is bumped to `<upstream>-fork.N` on every rebase so the plugin
cache key changes and Claude Code lands fresh content in a new cache dir.

## Patch inventory (status at 13.28.0-fork.1, 2026-10-03)

P-numbers match the 2026-10-03 merge conflict report. Rows without a P-number are DROPPED or
ALREADY UPSTREAM and are kept as the record of what not to reintroduce.

| Area | Origin | Platform | Status at 13.28.0-fork.1 |
|---|---|---|---|
| P1 Worker port-walk on EADDRINUSE + pidfile-authoritative `getWorkerPort` | `src/services/worker-service.ts`, `worker-spawner.ts`, `src/shared/worker-utils.ts` | cross (Windows phantom-listener primary) | **KEEP, carried forward at 13.28.0-fork.1.** The `HealthMonitor.isPortInUse(port, host)` bind-probe signature is DROPPED, see the next row. Re-derived at v13.10.2 as follows. The daemon-side walk loop in `WorkerService.start()` was silently LOST at the v13.6.1 rebase (only pidfile discovery was kept — "Option A") and is RESTORED here, walk base `getConfiguredWorkerPort()`, actual bound port written to the pidfile + `clearPortCache()`. NEW (ledger B1 fix): the `--daemon` duplicate gate health-probes (`waitForHealth`) before refusing — bound-but-unresponsive (ghost/foreign) falls through to the walk instead of `exit 0`. Fork-side `isProcessAlive` re-pointed to upstream's `supervisor/process-registry.isPidAlive`. All fork blocks tagged `// WINDOWS-FORK:`. |
| `HealthMonitor.isPortInUse(port, host)` kernel bind-probe signature | `src/services/infrastructure/HealthMonitor.ts` | cross | **DROPPED at 13.28.0-fork.1 → upstreamed.** Upstream `isPortInUse(port, timeoutMs?)` is bounded (`155fefce7`) and already falls through to a bind probe (`11518bc09`). Take upstream's function whole. Fork call sites in `worker-utils.ts` and `worker-spawner.ts` now pass `(port)` only. If the old `(port, host)` signature survives, upstream's `waitForPortFree` passes a number as `host`. |
| Observer poison-loop Fix A: respawn only on `poisoned` output class | was `src/services/worker/agents/ResponseProcessor.ts` (fork.3) | cross | **DROPPED → upstreamed (v13.9.0, `ad4bd6f7`).** Upstream went further than Fix A: the `poisoned` class, `respawnPoisonedSession`, and invalid-output respawn are REMOVED entirely; quota-limit prose now pauses the generator and preserves the queued batch (`isQuotaLimitedObserverOutput`), other non-XML output drops-and-confirms. Do NOT reintroduce the fork block — its symbols no longer exist. |
| P4 OAuth token pool + Fix B: `classifyClaudeError` `rate_limit` → pool rotation + keychain cooldown, Option A fall-through | `src/shared/oauth-token-pool.ts`, `src/shared/oauth-token.ts`, `src/services/worker/ClaudeProvider.ts`, `src/cli/handlers/context.ts` (hint text) | cross (Claude-Code-only machines primary) | **KEEP** — fork-only (the token pool does not exist upstream). After upstream `aa8ac2e79` and `fb755ce3c`, check that the pool still slots after env-fallback. Coexists with upstream's quota-pause: the provider throw fires first during streaming; upstream's `ResponseProcessor` quota branch is defense-in-depth behind it. |
| P5 In-band rate-limit throw: usage-limit assistant text → classified `rate_limit` throw | `src/services/worker/ClaudeProvider.ts` | cross | **KEEP.** Upstream `40bb3a663` moved the SDK quota signal to `rate_limit_event`. After each merge confirm the throw still reaches the `classifyClaudeError` catch before upstream's `isQuotaLimitedObserverOutput` pause can swallow it. |
| P6 D4 observer batch/throttle: `CLAUDE_MEM_OBSERVATION_BATCH_SIZE` + `CLAUDE_MEM_MAX_OBSERVATIONS_PER_SESSION` | `src/sdk/prompts.ts`, `src/services/worker/ClaudeProvider.ts`, `SessionManager.ts`, `worker-types.ts`, `SettingsDefaultsManager.ts`, `tests/worker/observation-batch-throttle.test.ts` | cross | **KEEP (fork-only, default-off), re-implemented at 13.28.0-fork.1 onto upstream's paced `createMessageGenerator(session, cwdTracker, activeResponseContext, worker, compressField, pacer, observationBatchSize, maxObservationsPerSession)`.** Coalesces N buffered observation events into one observer SDK turn; per-session observation cap with drop-and-confirm. Defaults (1 / 0) preserve upstream behavior byte-identically. A flushed batch is one yield plus one answer wait, and the batched prompt builder must apply `compressField` and `stripImagePayloads`. |
| Spawn-lock around lazy-spawn | was `src/shared/spawn-lock.ts` (fork-only) | cross | **DROPPED → upstreamed (v13.6.1).** Upstream v13.5.6 ships `src/shared/worker-spawn-gate.ts` (`acquireSpawnLock(): boolean` + `releaseSpawnLock()`, `wx`-flag `<DATA_DIR>/spawn.lock`, 60s staleness, owner-checked release) — a strict superset. `spawn-lock.ts` deleted; `worker-utils.ts`/`worker-spawner.ts` switched to the gate API (boolean + try/finally `releaseSpawnLock`). No stale build-verify guard referenced it (Gotcha 8 clear). |
| P2 HKCU env bootstrap when the launcher env block is empty | `src/shared/env-bootstrap.ts` (fork-only file), `SettingsDefaultsManager.ts`, `ProcessManager.ts` | Windows | **KEEP** — no upstream equivalent. |
| `sync-marketplace` uses `fs.cpSync` instead of `rsync` | `scripts/sync-marketplace.cjs` | Windows | **DROPPED, ALREADY UPSTREAM before the 13.17.0 base (`bb1db97dd`, build-and-sync without rsync or a POSIX shell).** No fork delta remains. |
| `tree-sitter.exe` resolution | `src/services/smart-file-read/parser.ts` | Windows | **DROPPED, ALREADY UPSTREAM before the 13.17.0 base (`efef7e9e0`, resolve tree-sitter.exe on Windows).** No fork delta remains. Do not re-apply. |
| `CLAUDE_CONFIG_DIR`-aware `build-and-sync` worker:restart | `package.json` scripts | cross (multi-profile) | **DROPPED, no fork delta exists at 13.28.0-fork.1.** The `package.json` fork diff against the 13.17.0 base is the version line only, and no `CLAUDE_CONFIG_DIR` text is present in the sync scripts. Do not re-derive. |
| Mac `bash -c` hook wrap | `plugin/hooks/hooks.json` (was a separate Mac branch) | Mac | **DROPPED** — upstream refactored hook commands to be POSIX `sh`-clean (replaced bash process substitution `< <(...)` with a portable `... \| while read` loop). Each command now parses and runs under `/bin/sh`. Verify after each rebase (see below) before assuming it stays unnecessary. |
| PreToolUse:Read timeout (was 10s) | `plugin/hooks/hooks.json` | cross | **DROPPED** — accept upstream's 60s. The 2000s runaway the 10s addressed no longer exists upstream. |
| chroma: skip `cmd.exe` wrapper for uvx spawn | `src/services/sync/ChromaMcpManager.ts` | Windows | **DROPPED → upstreamed.** Upstream spawns uvx directly on all platforms and adds `resolveUvxCommand()` (absolute uvx path on Windows). Strict superset of the fork fix. |
| mcp-search node launcher (`mcp-launcher.cjs`) + root `.mcp.json` restore | `plugin/.mcp.json`, `plugin/scripts/mcp-launcher.cjs`, `scripts/build-hooks.js` | cross | **DROPPED → upstreamed.** Upstream ships an inline `node -e` launcher in `plugin/.mcp.json`. `mcp-launcher.cjs` deleted; the fork build verification was aligned to upstream's inline launcher. |
| EACCES/EPIPE drain-all hook guard | `plugin/hooks/hooks.json` | cross | **DROPPED → upstreamed** verbatim. |
| Windows `bun.exe` direct-spawn (no `cmd.exe` shell) | `plugin/scripts/bun-runner.js` | Windows | **DROPPED, ALREADY UPSTREAM before the 13.17.0 base (`cb4675a8e`, `91736b492`).** Upstream spawns a resolved `bun.exe` directly and uses `cmd.exe` only for `.cmd` and `.bat` shims. The text below is the historical rationale. Formerly upstream resolved `bun.cmd` and spawns it with `shell:true`, so the chain is `node -> cmd.exe -> bun.exe`; with `windowsHide:true` the `cmd.exe` is hidden but it launches `bun.exe` WITHOUT propagating `CREATE_NO_WINDOW`, so the `bun.exe` grandchild gets a fresh **visible** console — one flash per capture-hook firing (`observation`/`file-context`/`summarize`) on Windows, i.e. effectively per tool use. The patch makes `findBun()` prefer `~/.bun/bin/bun.exe` and spawns it DIRECTLY (no shell) so `windowsHide:true` (`CREATE_NO_WINDOW`) actually suppresses the window; the `shell:true` path is retained only as a fallback for when no real `bun.exe` is resolvable (a `bun.cmd` shim cannot be spawned without a shell). bun-runner.js is copied verbatim (not bundled), so this takes effect on a plain marketplace sync with no rebuild. Do not re-apply after a rebase; upstream carries the equivalent. Origin: 2026-06-16 spawn-flash durable fix, complements the external pyw windowless shim (`claude-mem-hook-windowless.py`) that handles the node-level console. At v13.10.2 upstream's spawn-shim centralization (`83dd5925`) only fixed the `where bun` lookup (direct `where` spawn, `windowsHide:true`) — merged cleanly alongside the fork patch. |
| Marketplace-path lazy-spawn (ledger bug B3) | was fork-open | cross | **CLOSED → upstreamed (v13.10.1/.2, `eeaadb4a` + `c275b340`).** `resolveWorkerScriptPath` is now cache-FIRST (versioned cache dirs, then marketplace, then cwd) with a `CLAUDE_MEM_WORKER_SCRIPT_PATH` override, so hook/MCP/CLI/restart launches converge on one worker bundle and the `node_modules`-less marketplace clone is no longer the lazy-spawn target. |
| P3 Lazy-spawn env through `sanitizeEnv` plus DATA_DIR and PORT injection | `src/shared/worker-utils.ts` | cross | **KEEP.** Strips `CLAUDE_CODE_*` from the detached worker env. Now sits alongside upstream's `cwd: DATA_DIR` in the same `spawnHidden` options object; keep both. |
| P7 Cross-profile worker identity mismatch warning | `src/shared/worker-utils.ts` (`fetchWorkerHealthWorkerPath`, `deriveConfigDirFromWorkerPath`, `warnIfWorkerIdentityMismatched`) | cross (multi-profile) | **KEEP.** Detects and surfaces only. Warns when `/api/health.workerPath` differs from this profile's resolved script. Re-inserted at 13.28.0-fork.1 inside upstream's `if (ready)` branch. Upstream has no `workerPath` consumer. |
| P8 bun 1.3.13 Windows `unref` and AbortSignal workarounds | `src/services/worker-shutdown.ts`, `tests/services/stale-abort-controller-guard.test.ts` | Windows | **KEEP.** Drops `deadlineTimer.unref?.()` so the hard deadline fires, and polls `.aborted` in the test. Upstream still has the `unref` call at v13.28.0. |
| P9 sync-matrix E2E safety test restore | `tests/infrastructure/sync-matrix-e2e-safety.test.ts` | cross | **KEEP.** Puts upstream's test back after the sync-hub exclusion. Net delta against the upstream base is zero. |
| P10 Exclude the `workers/sync-hub` tree | `workers/sync-hub/**` | cross | **KEEP.** The fork does not ship the Cloudflare sync hub. Fork deletion wins every merge, resolved with `git rm -r workers/sync-hub`. Upstream keeps modifying it, so expect modify/delete conflicts. |
| P11 DB management scripts | `scripts/batch-import-from-db.ts`, `scripts/dump-backup-to-import-json.ts` | cross | **KEEP.** Operator import and backup tools. No upstream collision. |
| P12 Version-check test hardening | `tests/plugin-version-check.test.ts` | cross | **KEEP.** Adds `CLAUDE_MEM_DISABLE_SELFHEAL` and missing-modules tests. |
| P13 Fork tooling and docs | `.claude/settings.json`, `.gitignore`, `CHANGELOG.md`, `MAINTAINING_THIS_FORK.md`, `src/sdk/hardened-options.ts` | cross | **KEEP.** The `hardened-options.ts` delta is an SDK-version comment only; on conflict take upstream. |
| P14 Fork version strings and rebuilt bundles | 8 manifests, 4 `.cjs` bundles, `plugin/scripts/context-generator.cjs`, `plugin/ui/viewer-bundle.js` | cross | **KEEP.** Version is `13.28.0-fork.1` in the 8 manifests. See "Release-file checklist". Bundles are taken from upstream on conflict and rebuilt. |

### Port-reclaim composition (13.28.0-fork.1)

Upstream `cd5108c1d` added `src/shared/port-reclaim.ts` with `reclaimGhostListeningPort`. It
clears a ghost LISTEN socket only when every owner PID is dead and a chroma sidecar tree
(`uv`, `uvx`, `python`, `chroma-mcp`) is pinning the port. A live owner is never touched.
Upstream calls it in the daemon gate of `worker-service.ts` and in `worker-spawner.ts`, and
refuses to start when it declines (`process.exit(0)` and `return 'dead'` respectively).

This does not obsolete the port walk. Ghosts from `Stop-Process -Force` or from cache dirs
deleted under a running worker have no sidecar, and only a reboot clears them. A refusal when
reclaim declines is the B1 "no worker at all" failure.

KEEP composition: health wait, then upstream reclaim, then fall through to the fork's
EADDRINUSE port walk. Replace upstream's `process.exit(0)` and `return 'dead'` with the
fork's warn-and-continue. Rule: never refuse to start on a ghost listener. Both `readPidFile`
and `probeWorkerBootFailure` must be imported in `worker-spawner.ts`.

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

## Rebase gotchas

1. NEVER let a shell's working directory sit inside any claude-mem checkout while Claude Code
   hooks can fire. `src/shared/worker-utils.ts` resolves the worker script and plugin version
   from `process.cwd()` plus `plugin/scripts/worker-service.cjs` when the cwd is a claude-mem
   repo. A hook firing from inside a checkout treats that checkout as the installed plugin,
   detects a version mismatch, kills the live worker and spawns the checkout's worker. On
   2026-10-03 this swapped the live worker for pristine upstream v13.28.0 out of a test
   worktree and applied schema migrations 50 to 52 to the live database before anyone noticed.
   Use `git -C <path>` and subshells such as `( cd <path> && bun install )` so the outer cwd
   never moves.
2. Back up `<CLAUDE_MEM_DATA_DIR>/claude-mem.db` BEFORE any new-version worker can start, not
   merely before deploy. Use the SQLite backup API copy.

## Release-file checklist

All eight files carry the fork version literal and must read `<upstream>-fork.N`, here
`13.28.0-fork.1`. A raw merge with `--theirs` leaves the bare upstream version, so set it by hand:

| # | File |
|---|---|
| 1 | `package.json` |
| 2 | `plugin/package.json` |
| 3 | `.claude-plugin/plugin.json` |
| 4 | `plugin/.claude-plugin/plugin.json` |
| 5 | `.codex-plugin/plugin.json` |
| 6 | `plugin/.codex-plugin/plugin.json` |
| 7 | `.claude-plugin/marketplace.json` |
| 8 | `openclaw/openclaw.plugin.json` |

- In `.claude-plugin/marketplace.json` a separate `0.1.3` on a later line is another entry. Leave it.
- Excluded: `openclaw/package.json` and `.agents/plugins/marketplace.json`.
- Regenerated by `npm run build` and committed: `plugin/scripts/worker-service.cjs`,
  `mcp-server.cjs`, `server-service.cjs`, `transcript-watcher.cjs`, plus the tracked
  `plugin/scripts/context-generator.cjs` and `plugin/ui/viewer-bundle.js`.
- Tag annotated `v<upstream>-fork.N` at the merge commit. Create the rollback tag BEFORE merging.
- After the bump, grep the whole repo for the previous version to catch stragglers. The
  `tests/infrastructure/version-consistency.test.ts` bare-semver failure is an accepted
  fork-expected failure.

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
