import * as pty from 'node-pty';
import { SessionStore } from './session-store.js';
import { SessionInfo } from './protocol/messages.js';
import { loadAgentConfig, type AgentConfig } from './agent-config.js';
import { discoverSessionIds } from './session-recovery.js';

export type OutputCallback = (sessionId: string, data: string) => void;
export type ExitCallback = (sessionId: string, code: number) => void;
export type SessionIdDiscoveredCallback = (sessionId: string, agentSessionId: string) => void;

export class PtyManager {
  private sessionStore = new SessionStore();
  private ptyProcesses = new Map<string, pty.IPty>();
  private nextId = 1;
  private agentConfigs = new Map<string, AgentConfig>();

  constructor(
    private onOutput: OutputCallback,
    private onExit: ExitCallback,
    private onSessionIdDiscovered?: SessionIdDiscoveredCallback
  ) {
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
    let finalCommand = command;
    let finalArgs = args;

    if (process.platform === 'win32' && command !== 'cmd.exe') {
      const cmdline = `pushd "${cwd}" && ${command} ${args.join(' ')}`;
      finalCommand = 'cmd.exe';
      finalArgs = ['/k', cmdline];
    }

    let ptyProcess: pty.IPty;
    try {
      ptyProcess = pty.spawn(finalCommand, finalArgs, {
        name: 'xterm-256color',
        cols,
        rows,
        cwd,
        env: process.env as { [key: string]: string }
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
      this.onOutput(sessionId, data);
    });

    ptyProcess.onExit(({ exitCode }) => {
      this.sessionStore.delete(sessionId);
      this.ptyProcesses.delete(sessionId);
      this.onExit(sessionId, exitCode);
    });

    // Session Recovery: before/after snapshot diff for opencode/codex
    if ((agent === 'opencode' || agent === 'codex') && !agentSessionId) {
      const prevIds = new Set(discoverSessionIds(agent, cwd));
      setTimeout(() => {
        try {
          const currentIds = discoverSessionIds(agent, cwd);
          const newId = currentIds.find((id: string) => !prevIds.has(id));
          if (newId) {
            this.sessionStore.setAgentSessionId(sessionId, newId);
            this.onSessionIdDiscovered?.(sessionId, newId);
          }
        } catch {
          // Discovery failure is non-fatal
        }
      }, 3000);
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

  private getAgentConfig(agent: string): AgentConfig {
    const config = this.agentConfigs.get(agent);
    if (config) return config;
    // Fallback: treat unknown agent as raw command with no templates
    return { id: agent, name: agent, command: agent, args: [], createTemplate: '', resumeTemplate: '', setup: [], builtin: false };
  }
}
