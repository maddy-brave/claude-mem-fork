/**
 * Fork P4: an in-band auth refusal ("Failed to authenticate: OAuth token
 * revoked") reaches GeneratorRunner as the abort reason `auth:observer_text`.
 * ResponseProcessor has already cooled the refused credential (covered in
 * tests/worker/agents/response-processor.test.ts); here the generator exit
 * either restarts on a healthy pool token or keeps the old auth pause.
 *
 * Drives SessionRoutes.ensureGeneratorRunning for real, as
 * overflow-recycle-resume.test.ts does. Tokens are fake strings.
 */
import { describe, it, expect, beforeEach, afterEach, afterAll } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import type { ActiveSession } from '../../src/services/worker-types.js';
import { resetQuotaCooldownsForTesting } from '../../src/shared/quota-cooldown.js';
import { resetDependencyStatusesForTesting } from '../../src/shared/dependency-health.js';
import * as observerHealth from '../../src/shared/observer-health.js';
import { clearKeychainCooldown, readClaudeOAuthToken } from '../../src/shared/oauth-token.js';
import { oauthTokenPool } from '../../src/shared/oauth-token-pool.js';
import { coolActiveToken, resetPoolRestartGuard } from '../../src/shared/quota-pool-rotation.js';

const { SessionRoutes } = await import('../../src/services/worker/http/routes/SessionRoutes.js');

function makeSession(): ActiveSession {
  return {
    sessionDbId: 78,
    contentSessionId: 'content-78',
    memorySessionId: 'memory-78',
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

function buildRoutes(session: ActiveSession, startSession: (s: ActiveSession) => Promise<void>) {
  let active: ActiveSession | undefined = session;
  const sessionManager = {
    getSession: () => active,
    getMessageBuffer: () => ({ getPendingCount: () => 1, peekTypes: () => [] }),
    removeSessionImmediate: () => { active = undefined; },
  };
  return new SessionRoutes(
    sessionManager as any,
    {} as any,
    { startSession: () => startSession(session) } as any,
    { startSession: async () => {} } as any,
    { startSession: async () => {} } as any,
    {} as any,
    {} as any,
    { finalizeSession: async () => {} } as any,
  );
}

describe('observer rotates to the pool after an in-band auth refusal (fork P4)', () => {
  const saved = {
    poolFile: process.env.CLAUDE_MEM_OAUTH_TOKENS_FILE,
    prefer: process.env.CLAUDE_MEM_OAUTH_PREFER_POOL,
    envToken: process.env.CLAUDE_CODE_OAUTH_TOKEN,
  };
  let tempDir: string;

  function restoreEnv(key: keyof typeof saved, name: string): void {
    if (saved[key] === undefined) delete process.env[name];
    else process.env[name] = saved[key];
  }

  function armPool(tokens: string[]): void {
    const file = join(tempDir, '.oauth_tokens');
    writeFileSync(file, tokens.join('\n') + '\n', 'utf-8');
    process.env.CLAUDE_MEM_OAUTH_TOKENS_FILE = file;
    oauthTokenPool.resetForTests();
  }

  /**
   * One generator run that spawned on a pool token and was then refused in-band:
   * the token read, then the cooling ResponseProcessor does, then the abort.
   * The opt-in flag keeps the read off the real keychain.
   */
  async function refusedOnPoolToken(session: ActiveSession): Promise<void> {
    session.observerAuth = 'subscription';
    process.env.CLAUDE_MEM_OAUTH_PREFER_POOL = '1';
    const result = await readClaudeOAuthToken();
    expect(result.kind === 'present' && result.source).toBe('file-fallback');
    coolActiveToken('auth_invalid');
    session.abortReason = 'auth:observer_text';
  }

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'claude-mem-auth-rotate-'));
    process.env.CLAUDE_MEM_OAUTH_TOKENS_FILE = join(tempDir, 'no-pool-file');
    delete process.env.CLAUDE_MEM_OAUTH_PREFER_POOL;
    delete process.env.CLAUDE_CODE_OAUTH_TOKEN;
    oauthTokenPool.resetForTests();
    resetPoolRestartGuard();
    clearKeychainCooldown();
    resetQuotaCooldownsForTesting();
    resetDependencyStatusesForTesting();
    observerHealth.recordObserverSuccess();
  });

  afterEach(() => {
    restoreEnv('poolFile', 'CLAUDE_MEM_OAUTH_TOKENS_FILE');
    restoreEnv('prefer', 'CLAUDE_MEM_OAUTH_PREFER_POOL');
    restoreEnv('envToken', 'CLAUDE_CODE_OAUTH_TOKEN');
    oauthTokenPool.resetForTests();
    resetPoolRestartGuard();
    clearKeychainCooldown();
    observerHealth.recordObserverSuccess();
    rmSync(tempDir, { recursive: true, force: true });
  });

  afterAll(() => {
    resetQuotaCooldownsForTesting();
  });

  it('restarts on a healthy pool token and books no auth outage', async () => {
    armPool(['pool-token-refused', 'pool-token-spare']);
    const session = makeSession();
    let starts = 0;
    const routes = buildRoutes(session, async s => {
      starts += 1;
      if (starts === 1) {
        await refusedOnPoolToken(s);
        return;
      }
      await new Promise<void>(() => {});
    });

    await routes.ensureGeneratorRunning(session.sessionDbId, 'observation');
    await session.generatorPromise;
    await nextTick();

    expect(starts).toBe(2);
    expect(observerHealth.readObserverHealth()?.consecutiveFailures ?? 0).toBe(0);
  });

  it('keeps the auth pause and its booking when no pool is configured', async () => {
    const session = makeSession();
    let starts = 0;
    const routes = buildRoutes(session, async s => {
      starts += 1;
      s.observerAuth = 'subscription';
      s.abortReason = 'auth:observer_text';
    });

    await routes.ensureGeneratorRunning(session.sessionDbId, 'observation');
    await session.generatorPromise;
    await nextTick();

    expect(starts).toBe(1);
    const health = observerHealth.readObserverHealth()!;
    expect(health.consecutiveFailures).toBeGreaterThan(0);
    expect(health.lastErrorKind).toBe('auth_invalid');
  });

  it('keeps the auth pause when every pool token is cooling', async () => {
    armPool(['pool-token-only']);
    const session = makeSession();
    let starts = 0;
    const routes = buildRoutes(session, async s => {
      starts += 1;
      await refusedOnPoolToken(s);
    });

    await routes.ensureGeneratorRunning(session.sessionDbId, 'observation');
    await session.generatorPromise;
    await nextTick();

    expect(starts).toBe(1);
    expect(observerHealth.readObserverHealth()!.lastErrorKind).toBe('auth_invalid');
  });

  it('stops after the last pool token is refused instead of looping', async () => {
    armPool(['pool-token-first', 'pool-token-second']);
    const session = makeSession();
    let starts = 0;
    const routes = buildRoutes(session, async s => {
      starts += 1;
      await refusedOnPoolToken(s);
    });

    await routes.ensureGeneratorRunning(session.sessionDbId, 'observation');
    await session.generatorPromise;
    await nextTick();
    await session.generatorPromise;
    await nextTick();

    // First start rotates to the second token, the second start exhausts the pool.
    expect(starts).toBe(2);
    expect(observerHealth.readObserverHealth()!.lastErrorKind).toBe('auth_invalid');
  });

  it('does not rotate a run that billed an API key', async () => {
    armPool(['pool-token-a', 'pool-token-b']);
    const session = makeSession();
    let starts = 0;
    const routes = buildRoutes(session, async s => {
      starts += 1;
      s.observerAuth = 'api-key';
      s.abortReason = 'auth:observer_text';
    });

    await routes.ensureGeneratorRunning(session.sessionDbId, 'observation');
    await session.generatorPromise;
    await nextTick();

    expect(starts).toBe(1);
    expect(observerHealth.readObserverHealth()!.lastErrorKind).toBe('auth_invalid');
  });

  it('does not rotate the org-disabled refusal', async () => {
    armPool(['pool-token-a', 'pool-token-b']);
    const session = makeSession();
    let starts = 0;
    const routes = buildRoutes(session, async s => {
      starts += 1;
      s.observerAuth = 'subscription';
      s.abortReason = 'auth:observer_org_policy';
    });

    await routes.ensureGeneratorRunning(session.sessionDbId, 'observation');
    await session.generatorPromise;
    await nextTick();

    expect(starts).toBe(1);
    expect(String(observerHealth.readObserverHealth()!.lastErrorMessage)).toContain('organization has disabled');
  });
});
