/**
 * Pool-aware quota handling.
 *
 * A quota refusal on one OAuth pool token must cool only that token and rotate
 * the session to a healthy one. The provider-wide quota breaker is armed only
 * when no healthy token remains or no pool is configured. A bounded restart
 * guard stops a misclassified error from restart-looping forever.
 *
 * Logs name token ids (a stable hash), never token values.
 */

import { logger } from '../utils/logger.js';
import { getLastTokenSelection, markKeychainCooldown } from './oauth-token.js';
import { oauthTokenPool, type CooldownKind } from './oauth-token-pool.js';

/** Sliding window for the restart guard. */
export const POOL_RESTART_WINDOW_MS = 10 * 60_000;

const restartStamps: number[] = [];

export interface CoolActiveResult {
  /** Pool token id (or 'keychain' / 'env-fallback') that was cooled, if any. */
  cooledId?: string;
  /** Id of the healthy pool token the next start will use, if any. */
  rotatedToId?: string;
}

/**
 * Cool the token the last request used. Pool tokens cool in the pool; a
 * keychain or env token cools through the keychain cooldown so the next read
 * falls through to the pool.
 */
export function coolActiveToken(kind: CooldownKind, retryAfterMs?: number): CoolActiveResult {
  const selection = getLastTokenSelection();
  let cooledId: string | undefined;
  if (selection?.source === 'file-fallback') {
    cooledId = selection.poolId ?? oauthTokenPool.lastSelectedId;
    if (cooledId) oauthTokenPool.markCooldown(cooledId, kind, retryAfterMs);
  } else if (selection?.source === 'keychain' || selection?.source === 'env-fallback') {
    markKeychainCooldown(kind, retryAfterMs);
    cooledId = selection.source;
  }
  return { cooledId, rotatedToId: oauthTokenPool.firstHealthyId() };
}

export type PoolRotationReason =
  | 'rotate'
  | 'no_pool'
  | 'all_exhausted'
  | 'guard_tripped';

export interface PoolRotationPlan {
  /** True when the caller must restart on another token and skip the breaker. */
  rotate: boolean;
  reason: PoolRotationReason;
  rotatedToId?: string;
  /** Restarts already spent in the current window, set on guard_tripped. */
  recentRestarts?: number;
  restartLimit?: number;
}

/**
 * Decide, after the active token was cooled, whether to rotate or to arm the
 * provider-wide breaker. Consumes one restart from the guard when rotating.
 */
export function planPoolRotation(now: number = Date.now()): PoolRotationPlan {
  if (!oauthTokenPool.isConfigured()) return { rotate: false, reason: 'no_pool' };
  const rotatedToId = oauthTokenPool.firstHealthyId();
  if (!rotatedToId) return { rotate: false, reason: 'all_exhausted' };

  while (restartStamps.length > 0 && now - restartStamps[0] >= POOL_RESTART_WINDOW_MS) {
    restartStamps.shift();
  }
  const restartLimit = Math.max(1, oauthTokenPool.size);
  if (restartStamps.length >= restartLimit) {
    logger.warn('OAUTH', 'Pool restart guard tripped; arming the provider breaker instead of rotating', {
      recentRestarts: restartStamps.length,
      restartLimit,
      windowMs: POOL_RESTART_WINDOW_MS,
    });
    return {
      rotate: false,
      reason: 'guard_tripped',
      recentRestarts: restartStamps.length,
      restartLimit,
    };
  }
  restartStamps.push(now);
  return { rotate: true, reason: 'rotate', rotatedToId };
}

/** Test seam: forget recorded restarts. */
export function resetPoolRestartGuard(): void {
  restartStamps.length = 0;
}
