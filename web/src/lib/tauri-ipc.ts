import { invoke } from '@tauri-apps/api/core';
import { listen, type UnlistenFn } from '@tauri-apps/api/event';

export interface SessionInfo { id: string; agent: string; cwd: string; pid: number; running: boolean; agent_session_id: string; }

export const pty = {
  spawn: (agent: string, cwd: string, cols: number, rows: number, agentSessionId?: string, isRestore?: boolean) =>
    invoke<SessionInfo>('pty_spawn', { agent, cwd: cwd || '', cols, rows, agentSessionId: agentSessionId || '', isRestore: isRestore || false }),
  write: (sessionId: string, data: string) =>
    invoke<void>('pty_write', { sessionId, data }),
  resize: (sessionId: string, cols: number, rows: number) =>
    invoke<void>('pty_resize', { sessionId, cols, rows }),
  kill: (sessionId: string) => invoke<void>('pty_kill', { sessionId }),
  setAgentSessionId: (sessionId: string, agentSessionId: string) => invoke<void>('pty_set_agent_session_id', { sessionId, agentSessionId }),
  list: () => invoke<SessionInfo[]>('pty_list'),
  onOutput: (id: string, h: (d: string) => void): Promise<UnlistenFn> =>
    listen<{id:string;data:string}>(`pty-output-${id}`, (e) => h(e.payload.data)),
  onExit: (id: string, h: (c: number) => void): Promise<UnlistenFn> =>
    listen<{id:string;exitCode:number}>(`pty-exit-${id}`, (e) => h(e.payload.exitCode)),
  onSessionIdChanged: (id: string, h: (sid: string) => void): Promise<UnlistenFn> =>
    listen<{id:string;sessionId:string}>(`pty-session-id-changed-${id}`, (e) => h(e.payload.sessionId)),
};
