import { describe, it, expect, beforeEach, afterEach, afterAll } from 'bun:test';
import * as fs from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { oauthTokenPool } from '../../src/shared/oauth-token-pool.js';
import { resetPoolRestartGuard } from '../../src/shared/quota-pool-rotation.js';
import { getQuotaCooldown, recordQuotaExhausted } from '../../src/shared/quota-cooldown.js';
import type { ActiveSession } from '../../src/services/worker-types.js';
import { resetQuotaCooldownsForTesting } from '../../src/shared/quota-cooldown.js';
import { resetDependencyStatusesForTesting } from '../../src/shared/dependency-health.js';

const { SessionRoutes } = await import('../../src/services/worker/http/routes/SessionRoutes.js');
const {
  MAX_CONSECUTIVE_STALL_RESUMES,
  RESPONSE_STALL_RESUME_DELAY_MS,
} = await import('../../src/services/worker/session/response-pacer.js');

// The pool singleton lazily loads the real token file. Point it at a fixture
// the test writes so no real credentials are ever read.
const ORIGINAL_TOKENS_FILE = process.env.CLAUDE_MEM_OAUTH_TOKENS_FILE;
const poolTmpRoot = fs.mkdtempSync(join(tmpdir(), 'quota-rotate-test-'));

function usePool(tokens: string[]): string[] {
  const file = join(poolTmpRoot, tokens.length === 0 ? '__none__' : `pool-${tokens.length}-${Date.now()}.tokens`);
  if (tokens.length > 0) fs.writeFileSync(file, tokens.join(String.fromCharCode(10)), 'utf-8');
  process.env.CLAUDE_MEM_OAUTH_TOKENS_FILE = file;
  oauthTokenPool.resetForTests();
  resetPoolRestartGuard();
  return oauthTokenPool.statusSnapshot().map(e => e.id);
}

beforeEach(() => {
  usePool([]);
});

afterAll(() => {
  if (ORIGINAL_TOKENS_FILE === undefined) delete process.env.CLAUDE_MEM_OAUTH_TOKENS_FILE;
  else process.env.CLAUDE_MEM_OAUTH_TOKENS_FILE = ORIGINAL_TOKENS_FILE;
  oauthTokenPool.resetForTests();
  try { fs.rmSync(poolTmpRoot, { recursive: true, force: true }); } catch {}
});

function makeSession(): ActiveSession {
  return {
    sessionDbId: 77,
    contentSessionId: 'content-77',
    memorySessionId: 'memory-77',
    project: 'project',
    platformSource: 'claude',
    userPrompt: 'prompt',
    abortController: new AbortController(),
    generatorPromise: null,
    lastPromptNumber: 3,
    startTime: Date.now(),
    cumulativeInputTokens: 0,
    cumulativeOutputTokens: 0,
    earliestPendingTimestamp: null,
    claimedMessageIds: [],
    conversationHistory: [],
    currentProvider: null,
    consecutiveRestarts: 0,
    consecutiveInvalidOutputs: 0,
    consecutiveContextOverflows: 0,
    lastGeneratorActivity: Date.now(),
  };
}

/** Let the deferred resume timer (setTimeout 0) run. */
function nextTick(): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, 5));
}

function buildRoutes(session: ActiveSession, startSession: () => Promise<void>) {
  let finalizeCalls = 0;
  let removed = 0;
  let active: ActiveSession | undefined = session;

  const sessionManager = {
    getSession: () => active,
    getMessageBuffer: () => ({ getPendingCount: () => 1, peekTypes: () => [] }),
    removeSessionImmediate: () => {
      removed += 1;
      active = undefined;
    },
  };

  const routes = new SessionRoutes(
    sessionManager as any,
    {} as any,
    { startSession } as any,
    { startSession: async () => {} } as any,
    { startSession: async () => {} } as any,
    {} as any,
    {} as any,
    { finalizeSession: async () => { finalizeCalls += 1; } } as any,
  );

  return { routes, stats: () => ({ finalizeCalls, removed, active }) };
}

describe('observer resumes itself after recycling its conversation (#3800)', () => {
  beforeEach(() => {
    resetQuotaCooldownsForTesting();
    resetDependencyStatusesForTesting();
  });

  // #2756 round-3 review finding (important) — this file drives
  // SessionRoutes.ensureGeneratorRunning() for real, which runs the real
  // (unmocked) generator-exit handling; the "does not resume on a quota
  // pause" test below legitimately arms the real, module-level
  // quota-cooldown singleton as a side effect of that exit path, and (like
  // every other test here) relies on the NEXT test's own `beforeEach`
  // rather than cleaning up immediately — verified: adding
  // guardSharedQuotaCooldownSingleton's per-test before/after assertion to
  // this file (tried and reverted) false-positives on exactly that
  // legitimate, by-design behavior. Without this `afterAll`, a leftover
  // armed cooldown would still be sitting there for whichever OTHER file
  // runs next in the same `bun test` process — this file shares that
  // singleton with tests/worker/quota-cooldown.test.ts (which already
  // carries this same afterAll) and
  // tests/worker/http/routes/session-routes-provider-switch.test.ts (guarded
  // via tests/shared/quota-cooldown-singleton-guard.ts). Matches the
  // existing precedent in quota-cooldown.test.ts rather than a per-test
  // guard, since only file-boundary cleanup is safe here.
  afterAll(() => {
    resetQuotaCooldownsForTesting();
  });

  it('starts a replacement generation without waiting for another captured tool call', async () => {
    // The failure this guards: recycling resets the claimed batch to pending and
    // aborts, but the documented restart path needs a LATER ingest. On the last
    // observation of a session no later ingest arrives, so that work would sit
    // in the pending buffer forever and never be recorded.
    const session = makeSession();
    let starts = 0;

    const { routes } = buildRoutes(session, async () => {
      starts += 1;
      if (starts === 1) {
        session.abortReason = 'overflow:recycle';
        return;
      }
      // The replacement generation stays alive.
      await new Promise<void>(() => {});
    });

    await routes.ensureGeneratorRunning(session.sessionDbId, 'observation');
    await session.generatorPromise;
    await nextTick();

    expect(starts).toBe(2);
  });

  it('does not resume once the recycle budget is exhausted', async () => {
    const session = makeSession();
    let starts = 0;

    const { routes } = buildRoutes(session, async () => {
      starts += 1;
      session.abortReason = 'overflow:exhausted';
    });

    await routes.ensureGeneratorRunning(session.sessionDbId, 'observation');
    await session.generatorPromise;
    await nextTick();

    // Exactly one start: giving up must stay given up, or the pause is not a pause.
    expect(starts).toBe(1);
  });

  it('does not resume on a quota pause — that one waits for the user', async () => {
    const session = makeSession();
    let starts = 0;

    const { routes } = buildRoutes(session, async () => {
      starts += 1;
      session.abortReason = 'quota:weekly';
    });

    await routes.ensureGeneratorRunning(session.sessionDbId, 'observation');
    await session.generatorPromise;
    await nextTick();

    expect(starts).toBe(1);
  });

  it('does not resume on an auth pause', async () => {
    const session = makeSession();
    let starts = 0;

    const { routes } = buildRoutes(session, async () => {
      starts += 1;
      session.abortReason = 'auth:observer_text';
    });

    await routes.ensureGeneratorRunning(session.sessionDbId, 'observation');
    await session.generatorPromise;
    await nextTick();

    expect(starts).toBe(1);
  });

  it('preserves the session across a recycle instead of finalizing it', async () => {
    const session = makeSession();
    let starts = 0;

    const { routes, stats } = buildRoutes(session, async () => {
      starts += 1;
      if (starts === 1) {
        session.abortReason = 'overflow:recycle';
        return;
      }
      await new Promise<void>(() => {});
    });

    await routes.ensureGeneratorRunning(session.sessionDbId, 'observation');
    await session.generatorPromise;
    await nextTick();

    // Finalizing would drop the batch the recycle just reset to pending.
    expect(stats().finalizeCalls).toBe(0);
    expect(stats().removed).toBe(0);
    expect(stats().active).toBe(session);
  });

  describe('after a response stall (#4066)', () => {
    const realSetTimeout = globalThis.setTimeout;
    let requestedDelays: number[] = [];

    beforeEach(() => {
      requestedDelays = [];
      // Run the 30s resume delay immediately, but record that it was asked for.
      globalThis.setTimeout = ((fn: (...args: unknown[]) => void, ms?: number, ...args: unknown[]) => {
        if (ms === RESPONSE_STALL_RESUME_DELAY_MS) {
          requestedDelays.push(ms);
          return realSetTimeout(fn, 0, ...args);
        }
        return realSetTimeout(fn, ms, ...args);
      }) as typeof setTimeout;
    });

    afterEach(() => {
      globalThis.setTimeout = realSetTimeout;
    });

    it('resumes the preserved backlog after a delay', async () => {
      const session = makeSession();
      let starts = 0;

      const { routes, stats } = buildRoutes(session, async () => {
        starts += 1;
        if (starts === 1) {
          session.abortReason = 'transport:response_stall';
          return;
        }
        await new Promise<void>(() => {});
      });

      await routes.ensureGeneratorRunning(session.sessionDbId, 'observation');
      await session.generatorPromise;
      await nextTick();

      expect(requestedDelays).toEqual([RESPONSE_STALL_RESUME_DELAY_MS]);
      expect(starts).toBe(2);
      expect(session.consecutiveResponseStalls).toBe(1);
      expect(stats().finalizeCalls).toBe(0);
    });

    it('stops resuming once the consecutive stall cap is reached', async () => {
      const session = makeSession();
      session.consecutiveResponseStalls = MAX_CONSECUTIVE_STALL_RESUMES;
      let starts = 0;

      const { routes, stats } = buildRoutes(session, async () => {
        starts += 1;
        session.abortReason = 'transport:response_stall';
      });

      await routes.ensureGeneratorRunning(session.sessionDbId, 'observation');
      await session.generatorPromise;
      await nextTick();

      expect(requestedDelays).toEqual([]);
      expect(starts).toBe(1);
      // Still preserved for the next hook event rather than finalized.
      expect(stats().finalizeCalls).toBe(0);
      expect(stats().active).toBe(session);
    });
  });
});

describe('quota refusal cools only the exhausted pool token', () => {
  beforeEach(() => {
    resetQuotaCooldownsForTesting();
    resetDependencyStatusesForTesting();
  });

  afterAll(() => {
    resetQuotaCooldownsForTesting();
  });

  async function waitFor(cond: () => boolean, ms = 1000): Promise<void> {
    const end = Date.now() + ms;
    while (!cond() && Date.now() < end) await new Promise(r => setTimeout(r, 5));
  }

  it('one of two tokens exhausted: no breaker, generator restarts on the other token', async () => {
    const [a] = usePool(['sk-fixture-rotate-A', 'sk-fixture-rotate-B']);
    const session = makeSession();
    let starts = 0;
    const { routes } = buildRoutes(session, async () => {
      starts += 1;
      if (starts === 1) {
        oauthTokenPool.selectToken();
        oauthTokenPool.markCooldown(a, 'quota_exhausted');
        session.abortReason = 'quota:five_hour';
        return;
      }
      await new Promise<void>(() => {});
    });

    await routes.ensureGeneratorRunning(session.sessionDbId, 'observation');
    await session.generatorPromise;
    await waitFor(() => starts >= 2);

    expect(starts).toBe(2);
    expect(getQuotaCooldown('claude')).toBeNull();
    expect(oauthTokenPool.firstHealthyId()).not.toBe(a);
  });

  it('one of two tokens exhausted clears a stale breaker for the provider', async () => {
    const [a] = usePool(['sk-fixture-stale-A', 'sk-fixture-stale-B']);
    const session = makeSession();
    let starts = 0;
    recordQuotaExhausted('claude', 'stale from an earlier refusal', 'five_hour');
    const { routes } = buildRoutes(session, async () => {
      starts += 1;
      if (starts === 1) {
        oauthTokenPool.selectToken();
        oauthTokenPool.markCooldown(a, 'quota_exhausted');
        session.abortReason = 'quota:five_hour';
        return;
      }
      await new Promise<void>(() => {});
    });

    await routes.ensureGeneratorRunning(session.sessionDbId, 'observation');
    await session.generatorPromise;
    await waitFor(() => starts >= 2);

    // The stale breaker did not gate the first start, and none was re-armed.
    expect(starts).toBe(2);
    expect(getQuotaCooldown('claude')).toBeNull();
  });

  it('all tokens exhausted: breaker armed as before and no restart', async () => {
    const ids = usePool(['sk-fixture-all-A', 'sk-fixture-all-B']);
    const session = makeSession();
    let starts = 0;
    const { routes } = buildRoutes(session, async () => {
      starts += 1;
      for (const id of ids) oauthTokenPool.markCooldown(id, 'quota_exhausted');
      session.abortReason = 'quota:five_hour';
    });

    await routes.ensureGeneratorRunning(session.sessionDbId, 'observation');
    await session.generatorPromise;
    await nextTick();

    expect(starts).toBe(1);
    expect(getQuotaCooldown('claude')).not.toBeNull();
  });

  it('no pool configured: old behaviour, breaker armed and no restart', async () => {
    usePool([]);
    const session = makeSession();
    let starts = 0;
    const { routes } = buildRoutes(session, async () => {
      starts += 1;
      session.abortReason = 'quota:five_hour';
    });

    await routes.ensureGeneratorRunning(session.sessionDbId, 'observation');
    await session.generatorPromise;
    await nextTick();

    expect(starts).toBe(1);
    expect(getQuotaCooldown('claude')).not.toBeNull();
  });

  it('restart guard trips after pool-size restarts and arms the breaker', async () => {
    usePool(['sk-fixture-guard-A', 'sk-fixture-guard-B']);
    const session = makeSession();
    let starts = 0;
    // A misclassified refusal: the abort repeats but no token ever cools.
    const { routes } = buildRoutes(session, async () => {
      starts += 1;
      session.abortReason = 'quota:five_hour';
    });

    await routes.ensureGeneratorRunning(session.sessionDbId, 'observation');
    await waitFor(() => getQuotaCooldown('claude') !== null);
    await nextTick();

    // Initial start plus two guarded restarts (pool size 2), then the breaker.
    expect(starts).toBe(3);
    expect(getQuotaCooldown('claude')).not.toBeNull();
  });

  it('a breaker left armed does not block a start while a pool token is healthy', async () => {
    usePool(['sk-fixture-admit-A', 'sk-fixture-admit-B']);
    recordQuotaExhausted('claude', 'armed by an earlier run', 'five_hour');
    const session = makeSession();
    let starts = 0;
    const { routes } = buildRoutes(session, async () => {
      starts += 1;
      await new Promise<void>(() => {});
    });

    await routes.ensureGeneratorRunning(session.sessionDbId, 'observation');
    await nextTick();

    expect(starts).toBe(1);
    expect(getQuotaCooldown('claude')).toBeNull();
  });

  it('a breaker stays armed when every pool token is exhausted', async () => {
    const ids = usePool(['sk-fixture-held-A', 'sk-fixture-held-B']);
    for (const id of ids) oauthTokenPool.markCooldown(id, 'quota_exhausted');
    recordQuotaExhausted('claude', 'armed by an earlier run', 'five_hour');
    const session = makeSession();
    let starts = 0;
    const { routes } = buildRoutes(session, async () => {
      starts += 1;
    });

    await routes.ensureGeneratorRunning(session.sessionDbId, 'observation');
    await nextTick();

    expect(starts).toBe(0);
    expect(getQuotaCooldown('claude')).not.toBeNull();
  });
});
