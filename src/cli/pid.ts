// PID file helpers for the daemon. The daemon writes its PID to daemon.pid on
// start and removes it on exit (see src/daemon/main.ts). The CLI uses this to
// check liveness and to stop the daemon by SIGTERM.
import fs from 'node:fs';
import { paths, ensureUserDataDir } from './paths';

/** Read the recorded daemon PID, or null if missing/unreadable. */
export function readPid(): number | null {
  try {
    const raw = fs.readFileSync(paths.pidFile, 'utf-8').trim();
    const pid = parseInt(raw, 10);
    return Number.isFinite(pid) && pid > 0 ? pid : null;
  } catch {
    return null;
  }
}

/** Record the daemon PID. */
export function writePid(pid: number): void {
  ensureUserDataDir();
  fs.writeFileSync(paths.pidFile, String(pid), 'utf-8');
}

/** Remove the PID file (best effort). */
export function clearPid(): void {
  try { fs.unlinkSync(paths.pidFile); } catch { /* already gone */ }
}

/**
 * Test whether a process is alive without sending a real signal.
 * `process.kill(pid, 0)` throws if the process doesn't exist.
 */
export function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}
