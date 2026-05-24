// Reads CLAUDE_MEM_* env vars from the Windows user-scope registry when the process env block is empty (e.g. claude.exe launched before the vars were set).
import { execSync } from 'child_process';

const KEYS = ['CLAUDE_MEM_DATA_DIR', 'CLAUDE_MEM_WORKER_PORT'] as const;

let _bootstrapped = false;

export function bootstrapEnvFromUserScope(): void {
  if (_bootstrapped) return;
  _bootstrapped = true;

  if (process.platform !== 'win32') return;

  for (const key of KEYS) {
    if (process.env[key]) continue;

    try {
      const output = execSync(`reg query "HKCU\\Environment" /v ${key}`, {
        stdio: ['ignore', 'pipe', 'ignore'],
        encoding: 'utf-8',
        windowsHide: true,
      });
      const match = new RegExp(`^\\s*${key}\\s+REG_(?:SZ|EXPAND_SZ)\\s+(.+?)\\s*$`, 'm').exec(output);
      if (match) {
        process.env[key] = match[1].trimEnd();
      }
    } catch {
      // reg.exe not found, value absent, or parse failure — silently continue
    }
  }
}

bootstrapEnvFromUserScope();
