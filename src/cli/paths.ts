// Centralized path resolution for the conductor CLI.
// All paths derive from the package root (the CLI ships inside the repo and is
// installed alongside dist/ via `npm link` / `npm i -g`), so commands work from
// any cwd.
import path from 'node:path';
import { homedir } from 'node:os';
import fs from 'node:fs';

// dist/cli/paths.js -> package root is two levels up (dist/cli -> dist -> root)
const PACKAGE_ROOT = path.join(__dirname, '..', '..');

/** %APPDATA%\conductor on Windows (matches Electron's userData for this app). */
export const userDataDir = path.join(process.env.APPDATA || homedir(), 'conductor');

export const paths = {
  packageRoot: PACKAGE_ROOT,
  daemonScript: path.join(PACKAGE_ROOT, 'dist', 'daemon', 'main.js'),
  /** Primary daemon log location (main.ts tries USERPROFILE first). */
  daemonLog: path.join(homedir(), 'conductor-daemon.log'),
  pidFile: path.join(userDataDir, 'daemon.pid'),
  agentsJson: path.join(userDataDir, 'agents.json'),
  worktreesRoot: path.join(homedir(), '.conductor', 'worktrees'),
  /** Named pipe the daemon listens on (Windows). */
  pipePath: '\\\\.\\pipe\\conductor-pty-daemon',
  /** Dev electron binary inside the repo; .cmd shim on Windows. */
  electronBin: process.platform === 'win32'
    ? path.join(PACKAGE_ROOT, 'node_modules', '.bin', 'electron.cmd')
    : path.join(PACKAGE_ROOT, 'node_modules', '.bin', 'electron'),
};

/** Ensure userData dir exists (for PID file / agents.json writes). */
export function ensureUserDataDir(): void {
  if (!fs.existsSync(userDataDir)) fs.mkdirSync(userDataDir, { recursive: true });
}
