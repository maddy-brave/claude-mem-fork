import { describe, it, expect } from 'bun:test';

import { SessionManager } from '../../src/services/worker/SessionManager.js';
import {
  shouldFlushObservationBatch,
  shouldDropForObservationCap,
} from '../../src/services/worker/ClaudeProvider.js';
import { SettingsDefaultsManager } from '../../src/shared/SettingsDefaultsManager.js';
import type { DatabaseManager } from '../../src/services/worker/DatabaseManager.js';

/**
 * D4 (token-audit 2026-07-11) — observer batch/throttle.
 *
 * arm1-claude-mem-observer.md ranked fix #3: coalesce N buffered
 * observation tool-events into a single observer SDK turn instead of one
 * turn per tool call, plus a per-session cap so a single content-session
 * cannot generate unbounded observation volume. Both mechanisms default to
 * the pre-D4 behavior (CLAUDE_MEM_OBSERVATION_BATCH_SIZE=1 flushes every
 * message; CLAUDE_MEM_MAX_OBSERVATIONS_PER_SESSION=0 disables the cap) so
 * this branch is safe to build/test without changing runtime behavior until
 * an operator raises either setting during a controlled deploy window.
 */

function makeDbManager(): DatabaseManager {
  return {
    getSessionById: () => ({
      content_session_id: 'content-batch-1',
      project: 'proj',
      platform_source: 'claude',
      user_prompt: 'do the thing',
      memory_session_id: null,
    }),
    getSessionStore: () => ({
      getPromptNumberFromUserPrompts: () => 1,
      ensureMemorySessionIdRegistered: () => {},
      storeObservations: () => ({ observationIds: [], summaryId: null, createdAtEpoch: 0 }),
    }),
    getChromaSync: () => undefined,
  } as unknown as DatabaseManager;
}

describe('shouldFlushObservationBatch (D4 observer batch/throttle)', () => {
  it('does not flush until the pending batch reaches batchSize', () => {
    expect(shouldFlushObservationBatch(1, 4)).toBe(false);
    expect(shouldFlushObservationBatch(3, 4)).toBe(false);
  });

  it('flushes once the pending batch reaches or exceeds batchSize', () => {
    expect(shouldFlushObservationBatch(4, 4)).toBe(true);
    expect(shouldFlushObservationBatch(5, 4)).toBe(true);
  });

  it('clamps batchSize<=0 to 1 — flush every message, never wedge the pipeline on a bad config', () => {
    expect(shouldFlushObservationBatch(1, 0)).toBe(true);
    expect(shouldFlushObservationBatch(1, -3)).toBe(true);
  });

  it('defaults to flush-every-message at batchSize=1 (CLAUDE_MEM_OBSERVATION_BATCH_SIZE default, current behavior)', () => {
    expect(shouldFlushObservationBatch(1, 1)).toBe(true);
  });
});

describe('shouldDropForObservationCap (D4 observer batch/throttle)', () => {
  it('never drops when the cap is disabled (0, the default)', () => {
    expect(shouldDropForObservationCap(1, 0)).toBe(false);
    expect(shouldDropForObservationCap(10_000, 0)).toBe(false);
  });

  it('allows exactly maxObservationsPerSession through, drops the next one', () => {
    expect(shouldDropForObservationCap(500, 500)).toBe(false);
    expect(shouldDropForObservationCap(501, 500)).toBe(true);
    expect(shouldDropForObservationCap(600, 500)).toBe(true);
  });
});

describe('SettingsDefaultsManager D4 keys (must default to current/off behavior)', () => {
  it('CLAUDE_MEM_OBSERVATION_BATCH_SIZE defaults to 1 (no coalescing unless an operator raises it)', () => {
    expect(SettingsDefaultsManager.getAllDefaults().CLAUDE_MEM_OBSERVATION_BATCH_SIZE).toBe('1');
  });

  it('CLAUDE_MEM_MAX_OBSERVATIONS_PER_SESSION defaults to 0 (cap disabled unless an operator sets it)', () => {
    expect(SettingsDefaultsManager.getAllDefaults().CLAUDE_MEM_MAX_OBSERVATIONS_PER_SESSION).toBe('0');
  });
});

describe('SessionManager.dropClaimedMessage (D4 observer batch/throttle)', () => {
  it('removes a claimed message from the buffer and from claimedMessageIds, so it cannot be re-yielded on the next generator restart', async () => {
    const sm = new SessionManager(makeDbManager());
    sm.initializeSession(1, 'do the thing', 1);
    await sm.queueObservation(1, {
      tool_name: 'Read', tool_input: {}, tool_response: {}, prompt_number: 1, toolUseId: 'tu-1',
    });
    await sm.queueObservation(1, {
      tool_name: 'Edit', tool_input: {}, tool_response: {}, prompt_number: 1, toolUseId: 'tu-2',
    });
    expect(sm.getMessageBuffer().getPendingCount(1)).toBe(2);

    // Claim the first message the same way ClaudeProvider.createMessageGenerator does
    // (via SessionManager.getMessageIterator, which pushes onto claimedMessageIds).
    const iterator = sm.getMessageIterator(1);
    const first = await iterator.next();
    expect(first.done).toBe(false);
    const claimedId = first.value!._persistentId;

    const session = sm.getSession(1)!;
    expect(session.claimedMessageIds).toContain(claimedId);
    // A claimed-but-unconfirmed message still counts toward the buffer's
    // total length (SessionMessageBuffer.getPendingCount does not
    // distinguish claimed vs unclaimed) — only confirm()/dropClaimedMessage
    // actually removes it from the list.
    expect(sm.getMessageBuffer().getPendingCount(1)).toBe(2);

    sm.dropClaimedMessage(1, claimedId);

    expect(session.claimedMessageIds).not.toContain(claimedId);
    expect(sm.getMessageBuffer().getPendingCount(1)).toBe(1);
  });

  it('is a no-op if the persistentId is not present (already confirmed or dropped)', () => {
    const sm = new SessionManager(makeDbManager());
    sm.initializeSession(2, 'do the thing', 1);
    expect(() => sm.dropClaimedMessage(2, 999_999)).not.toThrow();
  });

  it('is a no-op if the sessionDbId has no active session (defensive — cap check races session teardown)', () => {
    const sm = new SessionManager(makeDbManager());
    expect(() => sm.dropClaimedMessage(999, 1)).not.toThrow();
  });
});
