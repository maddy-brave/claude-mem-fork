import { openSync, writeSync, closeSync, unlinkSync, statSync, mkdirSync } from 'fs';
import path from 'path';
import { SettingsDefaultsManager } from './SettingsDefaultsManager.js';

const STALE_LOCK_MS = 30_000;

export interface SpawnLockHandle {
  release(): void;
}

function createLock(lockPath: string): SpawnLockHandle | null {
  try {
    const fd = openSync(lockPath, 'wx');
    try {
      writeSync(fd, `${process.pid}\n`);
    } finally {
      closeSync(fd);
    }
    return {
      release(): void {
        try { unlinkSync(lockPath); } catch { /* already removed */ }
      },
    };
  } catch (err: unknown) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === 'EEXIST') return null;
    throw err;
  }
}

export function acquireSpawnLock(): SpawnLockHandle | null {
  const dataDir = SettingsDefaultsManager.get('CLAUDE_MEM_DATA_DIR');
  const lockPath = path.join(dataDir, '.worker-spawn.lock');

  try {
    mkdirSync(dataDir, { recursive: true });
  } catch { /* best effort */ }

  const lock = createLock(lockPath);
  if (lock) return lock;

  try {
    const ageMs = Date.now() - statSync(lockPath).mtimeMs;
    if (ageMs > STALE_LOCK_MS) {
      try { unlinkSync(lockPath); } catch { /* race with another reclaim */ }
      return createLock(lockPath);
    }
  } catch { /* lock vanished between attempts */ }

  return null;
}
