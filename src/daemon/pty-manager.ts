import * as pty from 'node-pty';
import path from 'path';
import fs from 'fs';
import os from 'os';
import crypto from 'crypto';
import { execFileSync } from 'child_process';
import { SessionStore } from './session-store.js';
import { SessionInfo } from './protocol/messages.js';
import { loadAgentConfig, type AgentConfig } from './agent-config.js';
import { discoverSessionIds } from './session-recovery.js';
import { resolveSafeLocalDir } from '../common/platform.js';

const DEBUG_LOG = path.join(process.env.USERPROFILE || process.env.TEMP || 'C:\\', 'conductor-daemon.log');

/**
 * Resolve a .cmd batch file to its real executable.
 * npm-installed tools (claude, opencode, codex) use .cmd wrappers that
 * CreateProcessW executes via cmd.exe /c, which flashes a visible window.
 * We parse the .cmd to extract the real .exe (or node script) and call it directly.
 */
function resolveCmdFile(command: string): { exe: string; extraArgs: string[] } | null {
  if (process.platform !== 'win32') return null;

  // Find the .cmd file using `where`
  let cmdPath: string | null = null;
  try {
    const out = execFileSync('where', [command + '.cmd'], {
      stdio: ['ignore', 'pipe', 'ignore'],
      windowsHide: true,
      timeout: 3000,
    }).toString().trim();
    const lines = out.split('\n').map((s: string) => s.trim()).filter(Boolean);
    cmdPath = lines[0] || null;
  } catch {
    return null;
  }
  if (!cmdPath || !fs.existsSync(cmdPath)) return null;

  // Parse the .cmd shim robustly. Two npm shim formats exist:
  //   Classic:  "%dp0%\node_modules\pkg\bin\app.exe"   %*
  //   Modern:   IF EXIST "%dp0%\node.exe" (SET _prog=...) ... "%_prog%" "%dp0%\...\app.js" %*
  //             (the actual launch line starts with `endLocal & goto ...`, which the
  //              old line-based parser mis-read as the executable — see codex.cmd)
  // Strategy: collect every quoted "%dp0%\..." path; the LAST one that exists on
  // disk is the real launch target (an .exe for classic shims, a .js for modern).
  // For .js targets, run them with node (%dp0%\node.exe if present, else `node`).
  try {
    const content = fs.readFileSync(cmdPath, 'utf-8');
    const dp0 = path.dirname(cmdPath);
    const matches = [...content.matchAll(/"%dp0%\\([^"]+)"/g)].map((m) => m[1]);
    let target: string | null = null;
    for (const rel of matches) {
      const abs = path.join(dp0, rel);
      if (fs.existsSync(abs)) target = abs; // last existing path wins
    }
    if (!target) return null;

    if (target.toLowerCase().endsWith('.exe')) {
      debugLog(`resolveCmdFile: ${command} → exe=${target}`);
      return { exe: target, extraArgs: [] };
    }
    // .js target → needs node. node-pty/conPTY CANNOT resolve a bare "node"
    // (no .exe, no full path) — it throws "File not found:" (codex hit this:
    // its npm shim targets codex.js, and the npm global dir has no node.exe).
    // Use the daemon's own node executable as the fallback.
    const nodeExe = path.join(dp0, 'node.exe');
    const exe = fs.existsSync(nodeExe) ? nodeExe : process.execPath;
    debugLog(`resolveCmdFile: ${command} → ${exe} ${target}`);
    return { exe, extraArgs: [target] };
  } catch {
    return null;
  }
}

function debugLog(msg: string) {
  const line = `${new Date().toISOString()} ${msg}\n`;
  process.stderr.write(`[DEBUG] ${line}`);
  try { fs.appendFileSync(DEBUG_LOG, line); } catch { /* ignore */ }
}

/**
 * Check whether claude has actually persisted a conversation for the given
 * session ID. claude only writes `~/.claude/projects/<dir>/<uuid>.jsonl` AFTER the
 * first user message — a window that was opened but never used has NO file.
 *
 * Conductor saves the `--session-id` UUID at spawn time, before any message is
 * sent. On restart it would then `claude --resume <uuid>` an ID that was never
 * persisted, producing "No conversation found with session ID". This check lets
 * the caller fall back to a fresh session instead of surfacing that error.
 *
 * The project dir name encodes the cwd (and may be a worktree path), so we glob
 * across all project dirs — the UUID is globally unique.
 */
function claudeConversationExists(sessionId: string): boolean {
  // Defensive: only build a path from safe ID characters (UUIDs are [0-9a-f-]).
  if (!/^[a-zA-Z0-9_-]+$/.test(sessionId)) return false;
  try {
    const projectsDir = path.join(os.homedir(), '.claude', 'projects');
    for (const proj of fs.readdirSync(projectsDir)) {
      try {
        if (fs.existsSync(path.join(projectsDir, proj, `${sessionId}.jsonl`))) return true;
      } catch { /* skip unreadable project dir */ }
    }
  } catch { /* projects dir missing/unreadable — treat as "not persisted" */ }
  return false;
}

/* eslint-disable no-unused-vars */
export type OutputCallback = (sessionId: string, data: string) => void;
export type ExitCallback = (sessionId: string, code: number) => void;
export type SessionIdDiscoveredCallback = (sessionId: string, agentSessionId: string) => void;
/* eslint-enable no-unused-vars */

export class PtyManager {
  private sessionStore = new SessionStore();
  private ptyProcesses = new Map<string, pty.IPty>();
  private lastOutputTime = new Map<string, number>();
  private nextId = 1;
  private agentConfigs = new Map<string, AgentConfig>();

  /* eslint-disable no-unused-vars */
  constructor(
    private onOutput: OutputCallback,
    private onExit: ExitCallback,
    private onSessionIdDiscovered?: SessionIdDiscoveredCallback
  ) {
  /* eslint-enable no-unused-vars */
    // CRITICAL: Ensure the daemon's own cwd is never a UNC path.
    debugLog(`PtyManager constructor: process.cwd()=${process.cwd()}, pid=${process.pid}`);
    // cmd.exe cannot start with a UNC current directory ("CMD 不支持将 UNC 路径作为当前目录").
    // The daemon inherits its cwd from the Electron main process (see daemon-client.ts spawn).
    // If Electron was launched from a UNC location, the daemon's process.cwd() is UNC,
    // and node-pty/ConPTY on Windows may pass that to child processes regardless of
    // the explicit cwd option. Change to a safe local directory before any spawns.
    if (process.platform === 'win32') {
      try {
        const cwdStr = process.cwd();
        if (cwdStr.startsWith('\\\\')) {
          const safeDir = resolveSafeLocalDir();
          console.log(`[PtyManager] Daemon cwd is UNC (${cwdStr}), changing to ${safeDir}`);
          debugLog(`[PtyManager] Daemon cwd is UNC (${cwdStr}), changing to ${safeDir}`);
          process.chdir(safeDir);
        }
      } catch (_e) {
        // process.cwd() can throw if the current directory was deleted
        // process.chdir can throw if the target doesn't exist
        const safeDir = resolveSafeLocalDir();
        console.log(`[PtyManager] process.cwd() failed, changing to ${safeDir}`);
        debugLog(`[PtyManager] process.cwd() failed, changing to ${safeDir}`);
        try { process.chdir(safeDir); } catch { /* non-fatal */ }
      }
    }

    for (const cfg of loadAgentConfig()) {
      this.agentConfigs.set(cfg.id, cfg);
    }
  }

  spawn(agent: string, cwd: string, cols: number, rows: number, agentSessionId = '', isRestore = false): SessionInfo {
    const sessionId = `S${this.nextId++}`;

    // 解析 agent 命令
    const agentConfig = this.getAgentConfig(agent);
    let command = agentConfig.command;
    let args: string[] = [...agentConfig.args];

    // FIX: For new sessions (not restore), if the agent has a createTemplate but
    // no agentSessionId was provided, generate a UUID so the agent uses it.
    // This ensures we ALWAYS know the session ID for resume (no reliance on regex capture).
    // Without this, Claude Code creates its own UUID internally and we can't reliably
    // capture it from terminal output (ANSI codes, chunked delivery, format variations).
    if (!agentSessionId && !isRestore && agentConfig.createTemplate) {
      agentSessionId = crypto.randomUUID();
      debugLog(`Generated session ID for new ${agent} session: ${agentSessionId}`);
    }

    // Claude resume guard: claude honors --session-id and persists the conversation
    // to ~/.claude/projects/<dir>/<uuid>.jsonl, but ONLY after the first user message.
    // Conductor saved this UUID at spawn time — if the window was never used (no
    // message sent), the file was never written, and `claude --resume <uuid>` would
    // fail with "No conversation found with session ID". Verify the file exists;
    // if not, fall back to a fresh session (new UUID + create template) instead of
    // surfacing that error. Self-healing: the fallback is itself subject to the same
    // check on the next restart.
    if (isRestore && agent === 'claude' && agentSessionId && !claudeConversationExists(agentSessionId)) {
      debugLog(`claude resume: ${agentSessionId} has no persisted jsonl — falling back to new session`);
      isRestore = false;
      agentSessionId = crypto.randomUUID();
    }

    // 模板替换
    if (agentSessionId) {
      if (!/^[a-zA-Z0-9_-]+$/.test(agentSessionId)) {
        throw new Error(`Invalid agentSessionId: ${agentSessionId}`);
      }
      const template = isRestore ? agentConfig.resumeTemplate : agentConfig.createTemplate;
      if (template) {
        const arg = template.replace('{session_id}', agentSessionId);
        args.push(...arg.split(/\s+/).filter((s: string) => s));
      }
    }

    // Setup 命令注入
    if (agentConfig.setup.length > 0) {
      const setupChain = agentConfig.setup.join(' && ');
      args = ['/k', `${setupChain} && ${command} ${args.join(' ')}`];
      command = 'cmd.exe';
    }

    // Windows: 通过 cmd.exe 启动以设置 cwd
    // UNC paths (\\server\share) cannot be used as the process cwd on Windows —
    // CreateProcessW rejects them. Use a safe fallback for the OS-level cwd and
    // rely on pushd inside cmd.exe to navigate to the real target.
    //
    // CRITICAL: Resolve relative paths to absolute BEFORE checking for UNC.
    // A relative path like '.' resolves against process.cwd() — if the daemon's
    // cwd is UNC, '.' becomes a UNC path. node-pty passes cwd directly to
    // CreateProcessW, which rejects UNC paths on Windows.
    const safeHome = resolveSafeLocalDir();
    const resolvedCwd = path.resolve(cwd || '.');
    const isUNC = process.platform === 'win32' && resolvedCwd.startsWith('\\\\');
    const spawnCwd = (process.platform === 'win32' && isUNC)
      ? safeHome
      : resolvedCwd;

    let finalCommand = command;
    let finalArgs = args;

    if (process.platform === 'win32' && isUNC) {
      // UNC path: must use pushd because cmd.exe can't start with UNC cwd
      finalCommand = 'cmd.exe';
      if (command === 'cmd.exe' && args.length >= 2 && args[0] === '/k') {
        // Setup wrapping: inject pushd at the start of the existing /k chain
        // Use short name or avoid quotes if possible to prevent escaping issues
        finalArgs = ['/k', `pushd ${resolvedCwd} && ${args[1]}`];
      } else if (command === 'cmd.exe') {
        // Bare cmd.exe: just pushd into the UNC path (no nested cmd.exe)
        finalArgs = ['/k', `pushd ${resolvedCwd}`];
      } else {
        finalArgs = ['/k', `pushd ${resolvedCwd} && ${command} ${args.join(' ')}`];
      }
    } else if (process.platform === 'win32' && command !== 'cmd.exe') {
      // Resolve .cmd wrappers to their real executable to avoid the
      // intermediate cmd.exe process which flashes a visible console window.
      // npm-installed commands (claude, opencode, codex) are .cmd batch files
      // that CreateProcessW internally runs via cmd.exe /c.
      const resolved = resolveCmdFile(command);
      if (resolved) {
        finalCommand = resolved.exe;
        finalArgs = [...resolved.extraArgs, ...args];
        debugLog(`resolved ${command}.cmd → ${finalCommand} ${finalArgs.join(' ')}`);
      } else {
        finalCommand = command;
        finalArgs = args;
      }
    }

    // FIX: Capture prevIds BEFORE spawning to avoid race condition.
    // OpenCode can create its session file in milliseconds after starting.
    // If we capture prevIds after spawn, the new session may appear in both
    // prev and current snapshots, making the diff miss it entirely.
    let prevSessionIds: Set<string> | null = null;
    if (agent === 'opencode' || agent === 'codex') {
      prevSessionIds = new Set(discoverSessionIds(agent, resolvedCwd));
      debugLog(`discovery: prevIds for ${agent} = [${[...prevSessionIds].join(', ')}]`);
    }

    let ptyProcess: pty.IPty;
    try {
      console.log(`[PtyManager] spawn: agent=${agent}, rawCwd=${cwd}, resolvedCwd=${resolvedCwd}, isUNC=${isUNC}, spawnCwd=${spawnCwd}`);
      console.log(`[PtyManager] spawn: finalCommand=${finalCommand}, finalArgs=${JSON.stringify(finalArgs)}`);
      debugLog(`spawn: agent=${agent}, rawCwd=${cwd}, resolvedCwd=${resolvedCwd}, isUNC=${isUNC}, spawnCwd=${spawnCwd}`);
      debugLog(`spawn: finalCommand=${finalCommand}, finalArgs=${JSON.stringify(finalArgs)}`);

      ptyProcess = pty.spawn(finalCommand, finalArgs, {
        name: 'xterm-256color',
        cols,
        rows,
        cwd: spawnCwd,
        env: process.env as { [key: string]: string },
        useConpty: true,
        useConptyDll: true,
      });
    } catch (error) {
      throw new Error(`Failed to spawn PTY for ${agent}: ${(error as Error).message}`);
    }

    const info: SessionInfo = {
      sessionId,
      agent,
      cwd,
      pid: ptyProcess.pid,
      running: true,
      agentSessionId
    };

    this.sessionStore.set(sessionId, info);
    this.ptyProcesses.set(sessionId, ptyProcess);

    ptyProcess.onData((data) => {
      this.sessionStore.appendOutput(sessionId, data);
      this.lastOutputTime.set(sessionId, Date.now());
      this.onOutput(sessionId, data);
    });

    ptyProcess.onExit(({ exitCode }) => {
      this.sessionStore.delete(sessionId);
      this.ptyProcesses.delete(sessionId);
      this.lastOutputTime.delete(sessionId);
      this.onExit(sessionId, exitCode);
    });

    // Session Recovery: repeated snapshot diff for opencode/codex
    // OpenCode TUI only creates a session file after the user sends the first message,
    // not at startup. So a single 5s check may miss it. We retry every 10s for 60s.
    // prevSessionIds was captured before pty.spawn() to avoid the race condition.
    if ((agent === 'opencode' || agent === 'codex') && prevSessionIds !== null) {
      let discoveryAttempts = 0;
      const maxAttempts = 6; // 6 attempts × 10s = 60s window
      const tryDiscovery = () => {
        discoveryAttempts++;
        try {
          const currentIds = discoverSessionIds(agent, resolvedCwd);
          const newId = currentIds.find((id: string) => !prevSessionIds!.has(id));
          if (newId) {
            debugLog(`discovery: found new ${agent} session on attempt ${discoveryAttempts}: ${newId}`);
            this.sessionStore.setAgentSessionId(sessionId, newId);
            this.onSessionIdDiscovered?.(sessionId, newId);
            return; // found it — stop retrying
          }
        } catch (e) {
          debugLog(`discovery: error on attempt ${discoveryAttempts} for ${agent}: ${(e as Error).message}`);
        }
        if (discoveryAttempts < maxAttempts) {
          setTimeout(tryDiscovery, 10000);
        } else {
          debugLog(`discovery: gave up after ${maxAttempts} attempts for ${agent}`);
        }
      };
      // First check at 5s, then every 10s
      setTimeout(tryDiscovery, 5000);
    }

    return info;
  }

  write(sessionId: string, data: string): boolean {
    const ptyProcess = this.ptyProcesses.get(sessionId);
    if (!ptyProcess) return false;
    ptyProcess.write(data);
    return true;
  }

  resize(sessionId: string, cols: number, rows: number): boolean {
    const ptyProcess = this.ptyProcesses.get(sessionId);
    if (!ptyProcess) return false;
    ptyProcess.resize(cols, rows);
    return true;
  }

  kill(sessionId: string): boolean {
    const ptyProcess = this.ptyProcesses.get(sessionId);
    if (!ptyProcess) return false;
    ptyProcess.kill();
    return true;
  }

  killAll() {
    for (const [sessionId] of this.ptyProcesses) {
      this.kill(sessionId);
    }
  }

  list(): SessionInfo[] {
    return this.sessionStore.list();
  }

  setAgentSessionId(sessionId: string, agentSessionId: string) {
    this.sessionStore.setAgentSessionId(sessionId, agentSessionId);
  }

  getSessionActivity(sessionId: string): { hasRecentOutput: boolean; lastOutputAt: number } {
    const last = this.lastOutputTime.get(sessionId) || 0;
    return { hasRecentOutput: Date.now() - last < 30_000, lastOutputAt: last };
  }

  private getAgentConfig(agent: string): AgentConfig {
    const config = this.agentConfigs.get(agent);
    if (config) return config;
    // Fallback: treat unknown agent as raw command with no templates
    return { id: agent, name: agent, command: agent, args: [], createTemplate: '', resumeTemplate: '', setup: [], builtin: false, capabilities: ['code-gen', 'code-review', 'shell', 'file-ops'] };
  }
}
