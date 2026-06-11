export const PROTOCOL_VERSION = 1;

export type ClientMessage =
  | { type: 'hello'; version: number }
  | { type: 'spawn'; agent: string; cwd: string; cols: number; rows: number; agentSessionId?: string; isRestore: boolean }
  | { type: 'write'; sessionId: string; data: string }
  | { type: 'resize'; sessionId: string; cols: number; rows: number }
  | { type: 'kill'; sessionId: string }
  | { type: 'list' }
  | { type: 'set-agent-session-id'; sessionId: string; agentSessionId: string };

export type DaemonMessage =
  | { type: 'hello-ack'; version: number }
  | { type: 'spawned'; sessionId: string; pid: number; agent: string; agentSessionId: string }
  | { type: 'output'; sessionId: string; data: string }
  | { type: 'exit'; sessionId: string; code: number }
  | { type: 'session-id-changed'; sessionId: string; agentSessionId: string }
  | { type: 'list-response'; sessions: SessionInfo[] }
  | { type: 'error'; message: string };

export interface SessionInfo {
  sessionId: string;
  agent: string;
  cwd: string;
  pid: number;
  running: boolean;
  agentSessionId: string;
}
