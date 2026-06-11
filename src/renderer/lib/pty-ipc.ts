import type { ElectronAPI } from '../global';

function getAPI(): ElectronAPI {
  if (!window.electronAPI) {
    throw new Error('electronAPI not available — preload script may not have loaded');
  }
  return window.electronAPI;
}

export interface SessionInfo {
  sessionId: string;
  agent: string;
  cwd: string;
  pid: number;
  running: boolean;
  agentSessionId: string;
}

export const pty = {
  spawn: (agent: string, cwd: string, cols: number, rows: number, agentSessionId?: string, isRestore?: boolean): Promise<SessionInfo> =>
    getAPI().invoke('pty_spawn', { agent, cwd: cwd || '', cols, rows, agentSessionId: agentSessionId || '', isRestore: isRestore || false }),

  write: (sessionId: string, data: string): Promise<void> =>
    getAPI().invoke('pty_write', { sessionId, data }),

  resize: (sessionId: string, cols: number, rows: number): Promise<void> =>
    getAPI().invoke('pty_resize', { sessionId, cols, rows }),

  kill: (sessionId: string): Promise<void> =>
    getAPI().invoke('pty_kill', { sessionId }),

  setAgentSessionId: (sessionId: string, agentSessionId: string): Promise<void> =>
    getAPI().invoke('pty_set_agent_session_id', { sessionId, agentSessionId }),

  onOutput: (id: string, handler: (data: string) => void): (() => void) =>
    getAPI().onOutput(id, handler),

  onExit: (id: string, handler: (code: number) => void): (() => void) =>
    getAPI().onExit(id, handler),

  onSessionIdChanged: (id: string, handler: (agentSessionId: string) => void): (() => void) =>
    getAPI().onSessionIdChanged(id, handler),
};
