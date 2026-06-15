// `conductor version|status|doctor|open` — app-level info & launch.
import fs from 'node:fs';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { paths } from '../paths';
import { getDaemonStatus } from '../daemon-client';
import { readPid, isAlive } from '../pid';
import { PROTOCOL_VERSION } from '../../daemon/protocol/messages';

function readPackage(): { version: string; name: string } {
  try {
    const pkg = JSON.parse(fs.readFileSync(path.join(paths.packageRoot, 'package.json'), 'utf-8'));
    return { version: pkg.version || '?', name: pkg.name || 'conductor' };
  } catch {
    return { version: '?', name: 'conductor' };
  }
}

/** `conductor version` */
export function version(): void {
  const pkg = readPackage();
  console.log(`conductor ${pkg.version} (protocol v${PROTOCOL_VERSION})`);
}

/** `conductor status` — overall: daemon + version. */
export async function status(): Promise<void> {
  version();
  const pid = readPid();
  const ds = await getDaemonStatus();
  if (ds.reachable) {
    console.log(`Daemon: running (pid=${pid ?? '?'}, ${ds.sessions.length} session(s))`);
  } else if (pid != null && isAlive(pid)) {
    console.log(`Daemon: pid=${pid} alive but pipe unreachable (${ds.error})`);
  } else {
    console.log('Daemon: not running');
  }
}

/** `conductor doctor` — environment health check. */
export async function doctor(): Promise<void> {
  const pkg = readPackage();
  const check = (label: string, ok: boolean, detail: string): void => {
    console.log(`  [${ok ? 'OK' : '  '}] ${label}: ${detail}`);
  };

  console.log(`conductor ${pkg.version} doctor`);
  check('node', true, process.version);
  check('package', !!pkg.version && pkg.version !== '?', `v${pkg.version} at ${paths.packageRoot}`);

  // agents.json
  let agentsOk = false, agentsDetail = 'missing';
  if (fs.existsSync(paths.agentsJson)) {
    try {
      const cfg = JSON.parse(fs.readFileSync(paths.agentsJson, 'utf-8'));
      const n = Array.isArray(cfg.agents) ? cfg.agents.length : 0;
      agentsOk = n > 0;
      agentsDetail = `${n} agent(s) at ${paths.agentsJson}`;
    } catch (e) { agentsDetail = `invalid JSON: ${(e as Error).message}`; }
  }
  check('agents.json', agentsOk, agentsDetail);

  // daemon
  const ds = await getDaemonStatus();
  check('daemon', ds.reachable, ds.reachable ? `running, ${ds.sessions.length} session(s)` : `not reachable (${ds.error})`);

  // git
  let gitOk = false, gitDetail = 'not found';
  try {
    const r = spawnSync('git', ['--version'], { windowsHide: true, encoding: 'utf-8' });
    if (r.status === 0) { gitOk = true; gitDetail = r.stdout.trim(); }
  } catch { /* leave default */ }
  check('git', gitOk, gitDetail);

  // worktrees dir
  let wtCount = 0;
  if (fs.existsSync(paths.worktreesRoot)) {
    try {
      for (const proj of fs.readdirSync(paths.worktreesRoot)) {
        const p = path.join(paths.worktreesRoot, proj);
        if (fs.statSync(p).isDirectory()) wtCount += fs.readdirSync(p).length;
      }
    } catch { /* ignore */ }
  }
  check('worktrees', true, `${wtCount} worktree(s) under ${paths.worktreesRoot}`);

  // electron (for `open`)
  check('electron', fs.existsSync(paths.electronBin), fs.existsSync(paths.electronBin) ? 'found (dev)' : 'not found — `open` needs `npm install` or npx');
}

/** `conductor open` — launch the Electron app (dev: electron .). */
export function open(): void {
  if (!fs.existsSync(paths.electronBin)) {
    // Fallback: npx electron (downloads if needed).
    console.log('Local electron not found; trying npx electron...');
    const child = spawn(process.platform === 'win32' ? 'npx.cmd' : 'npx', ['electron', '.'], {
      detached: true, stdio: 'inherit', cwd: paths.packageRoot, shell: process.platform === 'win32',
    });
    child.unref();
    return;
  }
  const child = spawn(paths.electronBin, ['.'], {
    detached: true, stdio: 'ignore', cwd: paths.packageRoot, shell: process.platform === 'win32',
  });
  child.unref();
  console.log(`Launching Conductor (electron . in ${paths.packageRoot})...`);
}
