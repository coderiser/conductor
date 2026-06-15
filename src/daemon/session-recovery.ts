// src/daemon/session-recovery.ts

import { spawnSync } from 'child_process';
import { existsSync, readdirSync, readFileSync, appendFileSync } from 'fs';
import path from 'path';
import os from 'os';

const DEBUG_LOG = path.join(process.env.USERPROFILE || process.env.TEMP || 'C:\\', 'conductor-daemon.log');

/**
 * Resolve an npm-installed command to its real executable by parsing the .cmd shim.
 * npm shims (`opencode.cmd`, `claude.cmd`) are batch files; spawning them makes
 * CreateProcessW invoke `cmd.exe /c`, which allocates a VISIBLE console window
 * when the parent (the daemon) has no console. Parsing the shim lets us spawn the
 * real `.exe` directly with `windowsHide`, so no window ever appears.
 *
 * Handles both the classic shim (`"%dp0%\...\exe" %*`) and the modern one
 * (`endLocal & goto ... | "%_prog%" ...`).
 */
function resolveNpmExe(command: string): string | null {
  if (process.platform !== 'win32') return null;
  let cmdPath: string | null = null;
  try {
    const out = spawnSync('where', [command + '.cmd'], {
      windowsHide: true,
      timeout: 3000,
      stdio: ['ignore', 'pipe', 'ignore'],
    }).stdout?.toString().trim();
    cmdPath = out ? out.split('\n').map((s) => s.trim()).filter(Boolean)[0] || null : null;
  } catch {
    return null;
  }
  if (!cmdPath || !existsSync(cmdPath)) return null;

  try {
    const content = readFileSync(cmdPath, 'utf-8');
    const dp0 = path.dirname(cmdPath);
    for (const line of content.split('\n')) {
      const t = line.trim();
      if (!t || t.startsWith('@') || t.startsWith('SET') || t.startsWith('GOTO') ||
          t.startsWith('CALL') || t.startsWith('IF') || t.startsWith('SETLOCAL') ||
          t.startsWith('ENDLOCAL') || t.startsWith('endLocal') || // modern shim (case varies)
          t.startsWith('EXIT') || t.startsWith(':')) {
        continue;
      }
      if (!t.includes('%dp0%')) continue;
      // Classic shim line: "%dp0%\node_modules\opencode-ai\bin\opencode.exe"   %*
      let resolved = t.replace(/%dp0%/g, dp0).replace(/\s*%(\*|\d+)\s*$/, '').trim();
      if (resolved.startsWith('"') && resolved.includes('"', 1)) {
        resolved = resolved.slice(1, resolved.indexOf('"', 1));
      }
      if (resolved && existsSync(resolved)) return resolved;
    }
  } catch {
    /* fall through */
  }
  return null;
}

export function discoverSessionIds(agent: string, cwd: string): string[] {
  if (agent === 'opencode') {
    return discoverOpenCodeSessions(cwd);
  }
  if (agent === 'codex') {
    return discoverCodexSessions();
  }
  return [];
}

function discoverOpenCodeSessions(cwd: string): string[] {
  try {
    // Resolve opencode's real .exe and spawn it directly with windowsHide.
    // Going through `cmd.exe /c opencode ...` allocates a visible console window
    // (the daemon has no console), which is the source of the cmd-window flash.
    let exe = 'opencode';
    if (process.platform === 'win32') {
      const resolved = resolveNpmExe('opencode');
      if (resolved) exe = resolved;
    }
    const result = spawnSync(exe, ['session', 'list', '--format', 'json'], {
      cwd,
      timeout: 5000,
      windowsHide: true,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    if (result.error) {
      try { appendFileSync(DEBUG_LOG, `${new Date().toISOString()} discovery error: ${result.error.message}\n`); } catch {}
      return [];
    }
    const output = result.stdout.toString();
    if (!output.trim()) {
      const stderr = result.stderr.toString().trim();
      if (stderr) {
        try { appendFileSync(DEBUG_LOG, `${new Date().toISOString()} discovery stderr: ${stderr.slice(0, 200)}\n`); } catch {}
      }
      return [];
    }
    const sessions = JSON.parse(output);
    const ids = sessions.map((s: { id: string }) => s.id).filter((id: string) => id.startsWith('ses_'));
    try { appendFileSync(DEBUG_LOG, `${new Date().toISOString()} discovery found ${ids.length} sessions: ${ids.join(', ')}\n`); } catch {}
    return ids;
  } catch (e) {
    try { appendFileSync(DEBUG_LOG, `${new Date().toISOString()} discovery exception: ${(e as Error).message}\n`); } catch {}
    return [];
  }
}

function discoverCodexSessions(): string[] {
  const dir = path.join(os.homedir(), '.codex', 'sessions');
  if (!existsSync(dir)) return [];

  const files = readdirSync(dir);
  const sessionIds: string[] = [];

  for (const file of files) {
    if (file.startsWith('rollout-') && file.endsWith('.jsonl')) {
      const match = file.match(/rollout-(\d+)-(.+)\.jsonl/);
      if (match) {
        sessionIds.push(match[2]);
      }
    }
  }

  return sessionIds;
}
