
import path from 'path';
import { existsSync, mkdirSync, writeFileSync, unlinkSync, statSync } from 'fs';
import { logger } from '../utils/logger.js';
import { HOOK_TIMEOUTS } from '../shared/hook-constants.js';
import { SettingsDefaultsManager } from '../shared/SettingsDefaultsManager.js';
import { acquireSpawnLock } from '../shared/spawn-lock.js';
import {
  cleanStalePidFile,
  getPlatformTimeout,
  readPidFile,
  spawnDaemon,
  touchPidFile,
} from './infrastructure/ProcessManager.js';
import {
  isPortInUse,
  waitForHealth,
  waitForReadiness,
} from './infrastructure/HealthMonitor.js';

const WINDOWS_SPAWN_COOLDOWN_MS = 2 * 60 * 1000;

function getWorkerSpawnLockPath(): string {
  return path.join(SettingsDefaultsManager.get('CLAUDE_MEM_DATA_DIR'), '.worker-start-attempted');
}

function shouldSkipSpawnOnWindows(): boolean {
  if (process.platform !== 'win32') return false;
  const lockPath = getWorkerSpawnLockPath();
  if (!existsSync(lockPath)) return false;
  try {
    const modifiedTimeMs = statSync(lockPath).mtimeMs;
    return Date.now() - modifiedTimeMs < WINDOWS_SPAWN_COOLDOWN_MS;
  } catch (error) {
    if (error instanceof Error) {
      logger.debug('SYSTEM', 'Could not stat worker spawn lock file', {}, error);
    } else {
      logger.debug('SYSTEM', 'Could not stat worker spawn lock file', { error: String(error) });
    }
    return false;
  }
}

function markWorkerSpawnAttempted(): void {
  if (process.platform !== 'win32') return;
  try {
    const lockPath = getWorkerSpawnLockPath();
    mkdirSync(path.dirname(lockPath), { recursive: true });
    writeFileSync(lockPath, '', 'utf-8');
  } catch {
    // APPROVED OVERRIDE: best-effort cooldown marker. If we can't even create
    // the data dir or write the marker, the worker spawn itself is almost
    // certainly going to fail too — surfacing that downstream gives the user
    // a far more useful error than a noisy log line about a lock file.
  }
}

function clearWorkerSpawnAttempted(): void {
  if (process.platform !== 'win32') return;
  try {
    const lockPath = getWorkerSpawnLockPath();
    if (existsSync(lockPath)) unlinkSync(lockPath);
  } catch {
    // APPROVED OVERRIDE: best-effort cleanup of the cooldown marker after a
    // successful spawn. A stale marker on disk is harmless — the worst case
    // is one suppressed retry within the cooldown window, then it self-heals.
  }
}

export type WorkerStartResult = 'ready' | 'warming' | 'dead';

export async function ensureWorkerStarted(
  port: number,
  workerScriptPath: string
): Promise<WorkerStartResult> {
  if (!workerScriptPath) {
    logger.error('SYSTEM', 'ensureWorkerStarted called with empty workerScriptPath — caller bug');
    return 'dead';
  }
  if (!existsSync(workerScriptPath)) {
    logger.error(
      'SYSTEM',
      'ensureWorkerStarted: worker script not found at expected path — likely a partial install or build artifact missing',
      { workerScriptPath }
    );
    return 'dead';
  }

  const pidFileStatus = cleanStalePidFile();
  if (pidFileStatus === 'alive') {
    logger.info('SYSTEM', 'Worker PID file points to a live process, skipping duplicate spawn');
    const healthy = await waitForHealth(port, getPlatformTimeout(HOOK_TIMEOUTS.PORT_IN_USE_WAIT));
    if (healthy) {
      clearWorkerSpawnAttempted();
      const ready = await waitForReadiness(port, getPlatformTimeout(HOOK_TIMEOUTS.READINESS_WAIT));
      logger.info('SYSTEM', 'Worker became healthy while waiting on live PID');
      return ready ? 'ready' : 'warming';
    }
    logger.warn('SYSTEM', 'Live PID detected but worker did not become healthy before timeout — likely still starting');
    return 'warming';
  }

  if (await waitForHealth(port, 1000)) {
    clearWorkerSpawnAttempted();
    const ready = await waitForReadiness(port, getPlatformTimeout(HOOK_TIMEOUTS.READINESS_WAIT));
    if (!ready) {
      logger.warn('SYSTEM', 'Worker is alive but readiness timed out — proceeding anyway');
    }
    logger.info('SYSTEM', 'Worker already running and healthy');
    return ready ? 'ready' : 'warming';
  }

  // Phantom listener (Windows kernel TCP zombie) on the configured port no
  // longer aborts the spawn — the worker self-walks the port and binds the
  // next available one. We still log so the user can see the configured port
  // is unhealthy and choose to recover it.
  const portInUse = await isPortInUse(port);
  if (portInUse) {
    logger.warn(
      'SYSTEM',
      'Configured port has phantom listener — worker will walk to next available port',
      { configuredPort: port, pidFileStatus }
    );
  }

  if (shouldSkipSpawnOnWindows()) {
    logger.warn('SYSTEM', 'Worker unavailable on Windows — skipping spawn (recent attempt failed within cooldown)');
    return 'dead';
  }

  const spawnLock = acquireSpawnLock();
  if (spawnLock) {
    logger.info('SYSTEM', 'Starting worker daemon', { workerScriptPath, configuredPort: port });
    markWorkerSpawnAttempted();
    const pid = spawnDaemon(workerScriptPath, port);
    if (pid === undefined) {
      spawnLock.release();
      logger.error('SYSTEM', 'Failed to spawn worker daemon');
      return 'dead';
    }
  } else {
    logger.info('SYSTEM', 'Another spawn in flight; waiting for concurrent worker to bind');
  }

  // After spawn (ours or concurrent), the worker may have walked to a fallback
  // port. Wait for the pidfile to appear, then poll its actual port for
  // health/readiness rather than the configured port.
  const boundPort = await waitForPidfilePort(getPlatformTimeout(HOOK_TIMEOUTS.POST_SPAWN_WAIT));
  if (spawnLock) spawnLock.release();
  if (boundPort === null) {
    logger.warn('SYSTEM', 'Worker spawned but pidfile did not appear with a bound port — likely still starting in background');
    return 'warming';
  }
  if (boundPort !== port) {
    logger.info('SYSTEM', 'Worker bound fallback port', { configured: port, bound: boundPort });
  }

  const healthy = await waitForHealth(boundPort, getPlatformTimeout(HOOK_TIMEOUTS.POST_SPAWN_WAIT));
  if (!healthy) {
    logger.warn('SYSTEM', 'Worker spawned but health endpoint not responding within window — likely still starting in background');
    return 'warming';
  }

  const ready = await waitForReadiness(boundPort, getPlatformTimeout(HOOK_TIMEOUTS.READINESS_WAIT));
  if (!ready) {
    logger.warn('SYSTEM', 'Worker is alive but readiness timed out — proceeding anyway');
  }

  clearWorkerSpawnAttempted();
  touchPidFile();
  logger.info('SYSTEM', 'Worker started successfully', { port: boundPort });
  return ready ? 'ready' : 'warming';
}

async function waitForPidfilePort(timeoutMs: number): Promise<number | null> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const info = readPidFile();
    if (info && typeof info.port === 'number' && info.port > 0) {
      return info.port;
    }
    await new Promise(resolve => setTimeout(resolve, 250));
  }
  return null;
}
