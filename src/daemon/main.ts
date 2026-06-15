import fs from 'fs';
import path from 'path';
import { DaemonServer } from './server.js';

const PIPE_PATH = '\\\\.\\pipe\\conductor-pty-daemon';
// Write logs to multiple locations for debugging
const LOG_CANDIDATES = [
  process.env.USERPROFILE,
  process.env.TEMP,
  'C:\\',
  path.resolve(__dirname, '..', '..'),  // project root
].filter(Boolean) as string[];

function tryLog(filename: string, msg: string) {
  for (const dir of LOG_CANDIDATES) {
    try {
      const logPath = path.join(dir, filename);
      fs.appendFileSync(logPath, `${new Date().toISOString()} ${msg}\n`);
      return; // success, stop trying
    } catch { /* try next */ }
  }
}

const log = (msg: string) => tryLog('conductor-daemon.log', msg);

// PID file so the `conductor` CLI can check liveness and stop/restart the
// daemon by SIGTERM. Path matches src/cli/paths.ts (userData/conductor).
const PID_PATH = path.join(process.env.APPDATA || process.env.USERPROFILE || process.env.HOME || 'C:\\', 'conductor', 'daemon.pid');
function writePid() {
  try {
    fs.mkdirSync(path.dirname(PID_PATH), { recursive: true });
    fs.writeFileSync(PID_PATH, String(process.pid));
    log(`pid file written: ${PID_PATH}`);
  } catch (e) {
    log(`failed to write pid file: ${(e as Error).message}`);
  }
}
function clearPid() {
  try { fs.unlinkSync(PID_PATH); } catch { /* already gone */ }
}

log(`=== Daemon starting ===`);
log(`pid=${process.pid}, cwd=${process.cwd()}`);
log(`USERPROFILE=${process.env.USERPROFILE || 'UNSET'}`);
log(`TEMP=${process.env.TEMP || 'UNSET'}`);
log(`PIPE=${PIPE_PATH}`);
log(`__dirname=${__dirname}`);

// Catch unhandled errors so the daemon doesn't silently crash
process.on('uncaughtException', (err) => {
  tryLog('conductor-daemon-crash.log', `Uncaught: ${err.stack || err}`);
  console.error('[Daemon] Uncaught exception:', err);
});

process.on('unhandledRejection', (reason) => {
  tryLog('conductor-daemon-crash.log', `Rejection: ${reason}`);
  console.error('[Daemon] Unhandled rejection:', reason);
});

process.on('exit', (code) => {
  clearPid();
  log(`Process exit with code ${code}`);
});

const server = new DaemonServer(PIPE_PATH);
server.start();
writePid();
log('Server.start() called');

process.on('SIGINT', () => {
  log('SIGINT received');
  server.stop();
  clearPid();
  process.exit(0);
});

process.on('SIGTERM', () => {
  log('SIGTERM received');
  server.stop();
  clearPid();
  process.exit(0);
});

log('Daemon initialization complete');
console.log('PTY Daemon started');
