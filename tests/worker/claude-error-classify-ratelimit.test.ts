/**
 * B1 tests: classifyClaudeError rate-limit in-band message detection.
 *
 * RED first per TDD: these tests are written BEFORE the implementation.
 * They must FAIL until classifyClaudeError gains the message-based rate_limit
 * branch described in the poison-loop fix (part B1).
 */
import { describe, it, expect, beforeEach, afterEach, spyOn } from 'bun:test';
import {
  classifyClaudeError,
  __resetEffortHintLatchForTesting,
} from '../../src/services/worker/ClaudeProvider.js';
import { logger } from '../../src/utils/logger.js';

let warnSpy: ReturnType<typeof spyOn>;

beforeEach(() => {
  __resetEffortHintLatchForTesting();
  warnSpy = spyOn(logger, 'warn').mockImplementation(() => {});
});

afterEach(() => {
  warnSpy.mockRestore();
  __resetEffortHintLatchForTesting();
});

describe('classifyClaudeError — in-band rate-limit message (B1)', () => {
  it('classifies "You\'ve hit your session limit · resets 5:50am (Australia/Melbourne)" as rate_limit', () => {
    const err = new Error("You've hit your session limit · resets 5:50am (Australia/Melbourne)");
    const classified = classifyClaudeError(err);
    expect(classified.kind).toBe('rate_limit');
  });

  it('classifies "You\'ve hit your session limit" (short form) as rate_limit', () => {
    const err = new Error("You've hit your session limit");
    const classified = classifyClaudeError(err);
    expect(classified.kind).toBe('rate_limit');
  });

  it('classifies "hit your usage limit" as rate_limit', () => {
    const err = new Error("You've hit your usage limit · resets in 15 minutes");
    const classified = classifyClaudeError(err);
    expect(classified.kind).toBe('rate_limit');
  });

  it('classifies case-insensitive "SESSION LIMIT" as rate_limit', () => {
    const err = new Error("you've hit your SESSION LIMIT");
    const classified = classifyClaudeError(err);
    expect(classified.kind).toBe('rate_limit');
  });

  it('still classifies status=429 as rate_limit (existing branch not broken)', () => {
    const err = Object.assign(new Error('rate limited'), { status: 429 });
    const classified = classifyClaudeError(err);
    expect(classified.kind).toBe('rate_limit');
  });

  it('still classifies "Prompt is too long" as unrecoverable (no regression)', () => {
    const err = new Error('Prompt is too long for this model');
    const classified = classifyClaudeError(err);
    expect(classified.kind).toBe('unrecoverable');
  });

  it('still classifies context overflow as unrecoverable (no regression)', () => {
    const err = new Error('Claude session context overflow: prompt is too long');
    const classified = classifyClaudeError(err);
    expect(classified.kind).toBe('unrecoverable');
  });

  it('still classifies "Invalid API key" as auth_invalid (no regression)', () => {
    const err = new Error('Invalid API key: check your API key configuration');
    const classified = classifyClaudeError(err);
    expect(classified.kind).toBe('auth_invalid');
  });

  it('does not over-match "limit" in unrelated error messages', () => {
    const err = new Error('File size limit exceeded during upload');
    const classified = classifyClaudeError(err);
    // Must NOT classify as rate_limit — the phrase "session limit" or "usage limit"
    // is not present.
    expect(classified.kind).not.toBe('rate_limit');
  });

  it('classifies "Claude usage limit reached" thrown by stream loop as rate_limit', () => {
    // This is the exact message format the stream-loop throw will produce (B1 part 2).
    const err = new Error('Claude usage limit reached: You\'ve hit your session limit · rese...');
    const classified = classifyClaudeError(err);
    expect(classified.kind).toBe('rate_limit');
  });
});
