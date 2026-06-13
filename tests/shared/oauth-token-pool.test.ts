import { describe, it, expect, afterEach, afterAll } from 'bun:test';
import * as fs from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { oauthTokenPool } from '../../src/shared/oauth-token-pool.js';

/**
 * Unit coverage for the multi-subscription OAuth token pool rotation logic.
 *
 * The module exports only the process-level singleton, and cooldown state is
 * in-memory and persists across loadPool() calls. To keep cases independent we
 * give each case a disjoint set of token *values* (cooldowns key on the sha256
 * id of the value, so disjoint values => disjoint ids => no cross-talk).
 *
 * The real ~/.claude-mem/.oauth_tokens is never touched: every case points
 * CLAUDE_MEM_OAUTH_TOKENS_FILE at a temp fixture it writes itself.
 */

const ORIGINAL_FILE_ENV = process.env.CLAUDE_MEM_OAUTH_TOKENS_FILE;
const tmpRoot = fs.mkdtempSync(join(tmpdir(), 'oauth-pool-test-'));

function writeFixture(name: string, lines: string[]): string {
  const p = join(tmpRoot, name);
  fs.writeFileSync(p, lines.join('\n'), 'utf-8');
  process.env.CLAUDE_MEM_OAUTH_TOKENS_FILE = p;
  return p;
}

// The pool is a process-level singleton with no reset method; loadPool() caches
// entries for the worker's life. Empty it after every case (point at a missing
// file and reload) so cached fixture tokens cannot leak into other test files
// via readClaudeOAuthToken()'s shared file-fallback branch.
afterEach(() => {
  process.env.CLAUDE_MEM_OAUTH_TOKENS_FILE = join(tmpRoot, '__nonexistent__');
  oauthTokenPool.loadPool();
});

afterAll(() => {
  if (ORIGINAL_FILE_ENV === undefined) delete process.env.CLAUDE_MEM_OAUTH_TOKENS_FILE;
  else process.env.CLAUDE_MEM_OAUTH_TOKENS_FILE = ORIGINAL_FILE_ENV;
  try { fs.rmSync(tmpRoot, { recursive: true, force: true }); } catch {}
});

describe('OAuthTokenPool parsing', () => {
  it('skips comments/blanks, strips label prefix, de-dupes preserving order', () => {
    writeFixture('parse.tokens', [
      '# a comment',
      '',
      'sk-ant-oat-parse-A',
      '   sk-ant-oat-parse-B   ',     // surrounding whitespace trimmed
      'subscription1: sk-ant-oat-parse-C', // label stripped
      'sk-ant-oat-parse-A',           // duplicate -> removed
      '   ',                          // whitespace-only -> skipped
      '# trailing comment',
    ]);
    const entries = oauthTokenPool.loadPool();
    expect(entries.map(e => e.token)).toEqual([
      'sk-ant-oat-parse-A',
      'sk-ant-oat-parse-B',
      'sk-ant-oat-parse-C',
    ]);
    // ids are 12-char hex, stable, non-reversible
    for (const e of entries) expect(e.id).toMatch(/^[0-9a-f]{12}$/);
    expect(new Set(entries.map(e => e.id)).size).toBe(3);
  });

  it('returns empty + undefined selection for a missing file', () => {
    process.env.CLAUDE_MEM_OAUTH_TOKENS_FILE = join(tmpRoot, 'does-not-exist.tokens');
    expect(oauthTokenPool.loadPool()).toEqual([]);
    expect(oauthTokenPool.size).toBe(0);
    expect(oauthTokenPool.selectToken()).toBeUndefined();
  });
});

describe('OAuthTokenPool rotation', () => {
  it('selects first healthy, rotates past a cooled token, and reports another-healthy', () => {
    const entries = writeAndLoad('rotate.tokens', [
      'sk-ant-oat-rot-1',
      'sk-ant-oat-rot-2',
      'sk-ant-oat-rot-3',
    ]);
    const [t1, t2] = entries;

    // first selection = first healthy
    expect(oauthTokenPool.selectToken()!.id).toBe(t1.id);
    expect(oauthTokenPool.lastSelectedId).toBe(t1.id);
    expect(oauthTokenPool.hasAnotherHealthyToken()).toBe(true);

    // cool t1 -> next selection rotates to t2
    oauthTokenPool.markCooldown(t1.id, 'rate_limit');
    expect(oauthTokenPool.selectToken()!.id).toBe(t2.id);
    expect(oauthTokenPool.allExhausted()).toBe(false);
  });

  it('applies the correct cooldown TTL per kind', () => {
    const entries = writeAndLoad('ttl.tokens', [
      'sk-ant-oat-ttl-rl',
      'sk-ant-oat-ttl-auth',
    ]);
    const [rl, auth] = entries;

    const before = Date.now();
    oauthTokenPool.markCooldown(rl.id, 'rate_limit');       // 15 min
    oauthTokenPool.markCooldown(auth.id, 'auth_invalid');   // 6 h
    const after = Date.now();

    const snap = Object.fromEntries(
      oauthTokenPool.statusSnapshot().map(s => [s.id, s.cooldownUntil]),
    );
    expect(snap[rl.id]!).toBeGreaterThanOrEqual(before + 15 * 60_000);
    expect(snap[rl.id]!).toBeLessThanOrEqual(after + 15 * 60_000);
    expect(snap[auth.id]!).toBeGreaterThanOrEqual(before + 6 * 60 * 60_000);
    expect(snap[auth.id]!).toBeLessThanOrEqual(after + 6 * 60 * 60_000);
  });

  it('honours an explicit retry-after override', () => {
    const entries = writeAndLoad('retryafter.tokens', ['sk-ant-oat-ra-1']);
    const [t] = entries;
    const before = Date.now();
    oauthTokenPool.markCooldown(t.id, 'rate_limit', 5_000); // override default 15m
    const after = Date.now();
    const until = oauthTokenPool.statusSnapshot()[0].cooldownUntil!;
    expect(until).toBeGreaterThanOrEqual(before + 5_000);
    expect(until).toBeLessThanOrEqual(after + 5_000);
  });

  it('when every token is cooled, still returns the soonest-expiring (no hard fail)', () => {
    const entries = writeAndLoad('exhaust.tokens', [
      'sk-ant-oat-ex-1',
      'sk-ant-oat-ex-2',
    ]);
    const [a, b] = entries;
    oauthTokenPool.markCooldown(a.id, 'quota_exhausted', 60_000); // expires sooner
    oauthTokenPool.markCooldown(b.id, 'auth_invalid');            // 6h, later
    expect(oauthTokenPool.allExhausted()).toBe(true);
    expect(oauthTokenPool.hasAnotherHealthyToken()).toBe(false);
    // soonest-expiring is a (60s) over b (6h)
    expect(oauthTokenPool.selectToken()!.id).toBe(a.id);
  });
});

/** load a fresh fixture and return its parsed entries. */
function writeAndLoad(name: string, lines: string[]) {
  writeFixture(name, lines);
  return oauthTokenPool.loadPool();
}
