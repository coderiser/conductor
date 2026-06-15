// `conductor daemon <action>` — manage the PTY daemon process.
import fs from 'node:fs';
import { spawn } from 'node:child_process';
import { paths } from '../paths';
import { readPid, writePid, clearPid, isAlive } from '../pid';
import { getDaemonStatus } from '../daemon-client';

/** `conductor daemon status` */
export async function status(): Promise<void> {
  // Pipe-first: a daemon is "running" if the pipe is reachable, even if no PID
  // file exists (e.g. started by the app, or an older build pre-PID-file).
  const ds = await getDaemonStatus();
  const pid = readPid();
  if (ds.reachable) {
    console.log(`Daemon: running${pid ? ` (pid=${pid})` : ' (no pid file)'} protocol v${ds.protocolVersion}`);
    console.log(`Sessions: ${ds.sessions.length}`);
    for (const s of ds.sessions) {
      console.log(`  ${s.sessionId}  ${s.agent.padEnd(8)}  pid=${s.pid}  ${s.cwd}`);
    }
    return;
  }
  // Pipe unreachable: infer from PID file if present.
  if (pid != null && isAlive(pid)) {
    console.log(`Daemon: pid=${pid} alive but pipe unreachable (${ds.error}) — starting or hung`);
    return;
  }
  if (pid != null) {
    console.log(`Daemon: not running (stale pid file, pid=${pid})`);
    clearPid();
    return;
  }
  console.log('Daemon: not running');
}

/** `conductor daemon start` — spawn detached, wait for pipe. */
export async function start(): Promise<void> {
  const ds = await getDaemonStatus();
  if (ds.reachable) {
    console.log('Daemon already running.');
    return;
  }
  if (!fs.existsSync(paths.daemonScript)) {
    console.error(`Daemon script not found: ${paths.daemonScript}`);
    console.error('Run `npm run build:daemon` first.');
    process.exit(1);
  }
  const env = { ...process.env, CONDUCTOR_AGENTS_CONFIG: paths.agentsJson };
  const child = spawn(process.execPath, [paths.daemonScript], {
    detached: true,
    windowsHide: true,
    stdio: 'ignore',
    cwd: paths.packageRoot,
    env,
  });
  child.unref();
  if (child.pid) writePid(child.pid);
  console.log(`Starting daemon (pid=${child.pid})...`);
  // Poll for the pipe to come up (up to ~8s).
  for (let i = 0; i < 40; i++) {
    await new Promise((r) => setTimeout(r, 200));
    const check = await getDaemonStatus();
    if (check.reachable) {
      console.log(`Daemon ready (protocol v${check.protocolVersion}).`);
      return;
    }
  }
  console.error('Daemon started but pipe did not come up within 8s. Check conductor-daemon.log.');
  process.exit(1);
}

/** `conductor daemon stop` — SIGTERM via PID file. */
export async function stop(): Promise<void> {
  const pid = readPid();
  if (pid == null) {
    console.log('Daemon not running (no pid file).');
    return;
  }
  if (!isAlive(pid)) {
    console.log(`Daemon not running (stale pid file, pid=${pid}).`);
    clearPid();
    return;
  }
  try {
    process.kill(pid, 'SIGTERM');
    console.log(`Sent SIGTERM to daemon (pid=${pid}).`);
  } catch (e) {
    console.error(`Failed to stop daemon: ${(e as Error).message}`);
    process.exit(1);
  }
  // Wait for it to actually exit (the Electron app will auto-reconnect+respawn).
  for (let i = 0; i < 25; i++) {
    await new Promise((r) => setTimeout(r, 200));
    if (!isAlive(pid)) { clearPid(); console.log('Daemon stopped.'); return; }
  }
  clearPid();
  console.log('Daemon did not exit within 5s (may still be shutting down).');
}

/** `conductor daemon restart` */
export async function restart(): Promise<void> {
  await stop();
  await new Promise((r) => setTimeout(r, 500));
  await start();
}

/** `conductor daemon logs [--follow]` */
export async function logs(follow: boolean): Promise<void> {
  const logPath = paths.daemonLog;
  if (!fs.existsSync(logPath)) {
    console.error(`Log file not found: ${logPath}`);
    process.exit(1);
  }
  // Print the last 50 lines first.
  const lines = fs.readFileSync(logPath, 'utf-8').split(/\r?\n/);
  const tail = lines.slice(-50).join('\n');
  if (tail.trim()) process.stdout.write(tail.endsWith('\n') ? tail : tail + '\n');

  if (!follow) return;

  let size = fs.statSync(logPath).size;
  console.log('--- following (Ctrl+C to stop) ---');
  fs.watch(logPath, () => {
    fs.stat(logPath, (err, st) => {
      if (err || st.size <= size) return;
      const stream = fs.createReadStream(logPath, { start: size, end: st.size });
      stream.on('data', (d) => process.stdout.write(d));
      size = st.size;
    });
  });
}
