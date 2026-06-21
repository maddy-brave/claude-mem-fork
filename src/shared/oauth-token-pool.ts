/**
 * Multi-subscription OAuth token pool for claude-mem.
 *
 * Holds N operator-supplied `claude setup-token` values and rotates across
 * them when a subscription hits a rate/quota/auth cap. Cooldown state is
 * in-memory (module-level Map); lost on worker restart and self-correcting
 * (a still-capped token re-fails once and re-cools). No persisted state file
 * in v1 (YAGNI).
 *
 * Token file path: ${CLAUDE_MEM_DATA_DIR}/.oauth_tokens
 * Override:        CLAUDE_MEM_OAUTH_TOKENS_FILE (absolute path)
 *
 * File format (line-oriented):
 *   - one token per line
 *   - blank lines and lines beginning with '#' are skipped
 *   - optional label prefix: "label: <token>" — everything up to the first ':'
 *     is stripped; the label MUST NOT contain whitespace if present
 *   - de-duplicates identical token values preserving first-seen order
 *
 * Raw token values are NEVER logged. Logs reference poolId only.
 */

import { existsSync, readFileSync } from 'fs';
import { join } from 'path';
import { createHash } from 'crypto';
import { paths } from './paths.js';
import { logger } from '../utils/logger.js';

export interface PoolEntry {
  id: string;     // stable non-reversible hash of the token value
  token: string;  // raw token, never logged
}

/** Cooldown kinds that drive rotation. */
export type CooldownKind = 'rate_limit' | 'quota_exhausted' | 'auth_invalid';

export const DEFAULT_COOLDOWN_MS: Record<CooldownKind, number> = {
  rate_limit: 15 * 60_000,        // 15 min
  quota_exhausted: 60 * 60_000,   // 1 h
  auth_invalid: 6 * 60 * 60_000,  // 6 h (treat as likely-dead)
};

/** Derive a short, stable, non-reversible id from the raw token value. */
function deriveId(token: string): string {
  return createHash('sha256').update(token).digest('hex').slice(0, 12);
}

/** Parse the .oauth_tokens file into a de-duplicated ordered list. */
function parseTokenFile(filePath: string): PoolEntry[] {
  let raw: string;
  try {
    raw = readFileSync(filePath, 'utf-8');
  } catch {
    return [];
  }

  const seen = new Set<string>();
  const entries: PoolEntry[] = [];

  for (const line of raw.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;

    // Optional "label: <token>" prefix. A label has no whitespace and is
    // followed by ':'. A bare token (no ':') is used verbatim.
    let tokenValue: string;
    const colonIdx = trimmed.indexOf(':');
    if (colonIdx > 0) {
      const beforeColon = trimmed.slice(0, colonIdx);
      // Label must be non-empty and whitespace-free
      if (beforeColon.length > 0 && !/\s/.test(beforeColon)) {
        tokenValue = trimmed.slice(colonIdx + 1).trim();
      } else {
        // Token itself contains a ':' (e.g. sk-ant-oat...:...) — use as-is
        tokenValue = trimmed;
      }
    } else {
      tokenValue = trimmed;
    }

    if (!tokenValue) continue;

    if (!seen.has(tokenValue)) {
      seen.add(tokenValue);
      entries.push({ id: deriveId(tokenValue), token: tokenValue });
    }
  }

  return entries;
}

class OAuthTokenPool {
  private _entries: PoolEntry[] = [];
  private _cooldowns = new Map<string, number>(); // id -> cooldownUntilMs
  private _lastSelectedId: string | undefined;
  private _loaded = false;

  /** Reload the token file from disk. Called lazily on first access. */
  loadPool(): PoolEntry[] {
    const filePath =
      process.env.CLAUDE_MEM_OAUTH_TOKENS_FILE ??
      join(paths.dataDir(), '.oauth_tokens');

    if (!existsSync(filePath)) {
      this._entries = [];
      this._loaded = true;
      return [];
    }

    this._entries = parseTokenFile(filePath);
    this._loaded = true;

    if (this._entries.length > 0) {
      logger.info('OAUTH', `Token pool loaded: ${this._entries.length} token(s)`, {
        ids: this._entries.map(e => e.id),
      });
    }
    return this._entries;
  }

  private ensureLoaded(): void {
    if (!this._loaded) this.loadPool();
  }

  /** Pool size (entry count). */
  get size(): number {
    this.ensureLoaded();
    return this._entries.length;
  }

  /** The id of the most-recently selected token. */
  get lastSelectedId(): string | undefined {
    return this._lastSelectedId;
  }

  /**
   * Select the first token whose cooldown has expired.
   * If ALL tokens are on cooldown, return the one with the soonest
   * cooldownUntil (still attempt — better than a hard fail).
   * Returns undefined only when the pool is empty.
   */
  selectToken(): PoolEntry | undefined {
    this.ensureLoaded();
    if (this._entries.length === 0) return undefined;

    const now = Date.now();
    const healthy = this._entries.filter(
      e => (this._cooldowns.get(e.id) ?? 0) <= now,
    );

    let selected: PoolEntry;
    if (healthy.length > 0) {
      selected = healthy[0];
    } else {
      // All cooling — pick the one expiring soonest
      selected = this._entries.reduce((best, cur) => {
        const bestUntil = this._cooldowns.get(best.id) ?? 0;
        const curUntil = this._cooldowns.get(cur.id) ?? 0;
        return curUntil < bestUntil ? cur : best;
      });
    }

    this._lastSelectedId = selected.id;
    return selected;
  }

  /**
   * Mark a token on cooldown. retryAfterMs overrides the default when the
   * error surface carries a retry-after hint.
   */
  markCooldown(id: string, kind: CooldownKind, retryAfterMs?: number): void {
    const duration = retryAfterMs ?? DEFAULT_COOLDOWN_MS[kind];
    const until = Date.now() + duration;
    this._cooldowns.set(id, until);
    logger.info('OAUTH', `Pool token cooled: id=${id} kind=${kind} cooldownUntil=${new Date(until).toISOString()}`);
  }

  /**
   * True if at least one token OTHER than lastSelectedId has cooldownUntil <= now.
   * Used by ClaudeProvider to decide whether rotation is worth attempting.
   */
  hasAnotherHealthyToken(): boolean {
    this.ensureLoaded();
    if (this._entries.length <= 1) return false;
    const now = Date.now();
    return this._entries.some(
      e => e.id !== this._lastSelectedId && (this._cooldowns.get(e.id) ?? 0) <= now,
    );
  }

  /**
   * True if every token in the pool has cooldownUntil > now.
   */
  allExhausted(): boolean {
    this.ensureLoaded();
    if (this._entries.length === 0) return false;
    const now = Date.now();
    return this._entries.every(e => (this._cooldowns.get(e.id) ?? 0) > now);
  }

  /** Expose entries (without raw tokens) for diagnostics. */
  statusSnapshot(): Array<{ id: string; cooldownUntil: number | undefined }> {
    this.ensureLoaded();
    return this._entries.map(e => ({
      id: e.id,
      cooldownUntil: this._cooldowns.get(e.id),
    }));
  }
}

/** Module-level singleton — shared across the whole worker process. */
export const oauthTokenPool = new OAuthTokenPool();
