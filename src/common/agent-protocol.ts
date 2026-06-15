// Agent Protocol — structured communication channel between AI agents and Conductor.
// Two transport channels:
//   1. PTY inline markers: [TASK:id] ... and [CTX:type] ... in terminal output
//   2. OSC 9999 escape sequences: ESC ] 9999 ; conductor:<json> BEL

/** Capability tags for task routing */
export type AgentCapability = 'code-gen' | 'code-review' | 'debugging' | 'shell' | 'web' | 'file-ops';

/** Structured message from an agent to the system */
export interface AgentProtocolMessage {
  type: 'task-progress' | 'task-complete' | 'task-error' | 'context-share' | 'need-attention' | 'agent-ready';
  agentId: string;
  sessionId: string;
  timestamp: number;
  payload: Record<string, unknown>;
}

export interface TaskProgressPayload {
  taskId: string;
  status: 'queued' | 'running' | 'done' | 'failed';
  progress: number; // 0–1
  message: string;
}

export interface TaskCompletePayload {
  taskId: string;
  summary: string;
  filesChanged?: string[];
  tokensUsed?: number;
  duration?: number; // ms
}

export interface TaskErrorPayload {
  taskId: string;
  error: string;
  stack?: string;
}

export interface ContextSharePayload {
  contextType: 'summary' | 'finding' | 'file-diff' | 'code-snippet' | 'link';
  title: string;
  body: string;
  tags: string[];
  priority: 'low' | 'normal' | 'high';
}

export interface NeedAttentionPayload {
  reason: string;
  urgency: 'low' | 'normal' | 'critical';
}

export interface AgentReadyPayload {
  capabilities: AgentCapability[];
  version: string;
}

/** PTY output marker regexes */
const MARKER_TASK = /\[TASK:([^\]]+)\]\s*(.*)/;
const MARKER_CTX = /\[CTX:(\w+)\]\s*(.*)/;

/** OSC 9999: ESC ] 9999 ; conductor:<json> BEL or ST */
const OSC_REGEX = /\x1b\]9999;conductor:(.+?)(?:\x07|\x1b\\)/;

/** Extract a protocol message from a line of PTY output.
 *  Returns null if no marker or OSC sequence detected. */
export function extractProtocolMessage(
  sessionId: string,
  agentId: string,
  line: string
): AgentProtocolMessage | null {
  // Try OSC escape sequence first (more reliable, carries full JSON)
  const oscMatch = line.match(OSC_REGEX);
  if (oscMatch) {
    try {
      const parsed = JSON.parse(oscMatch[1]);
      return { ...parsed, sessionId, agentId, timestamp: Date.now() };
    } catch { /* invalid JSON — ignore */ }
  }

  // Try [TASK:id] marker — lightweight inline format
  const taskMatch = line.match(MARKER_TASK);
  if (taskMatch) {
    const taskId = taskMatch[1];
    const rest = taskMatch[2];

    const progressMatch = rest.match(/progress[=:](\d+)%?/i);
    const statusMatch = rest.match(/status[=:](\w+)/i);
    const msgMatch = rest.match(/message[=:](.+)/i);

    return {
      type: 'task-progress',
      agentId,
      sessionId,
      timestamp: Date.now(),
      payload: {
        taskId,
        status: (statusMatch?.[1] as TaskProgressPayload['status']) || 'running',
        progress: progressMatch ? parseInt(progressMatch[1]) / 100 : 0,
        message: msgMatch?.[1]?.trim() || rest.trim() || 'Working...',
      } satisfies TaskProgressPayload,
    } as AgentProtocolMessage;
  }

  // Try [CTX:type] marker — shared context from agent
  const ctxMatch = line.match(MARKER_CTX);
  if (ctxMatch) {
    const ctxType = ctxMatch[1];
    const rest = ctxMatch[2];
    let body = rest;
    let title = ctxType;
    try {
      const parsed = JSON.parse(rest);
      body = parsed.body ?? parsed.summary ?? rest;
      title = parsed.title ?? ctxType;
    } catch { /* not JSON — treat raw text as body */ }

    return {
      type: 'context-share',
      agentId,
      sessionId,
      timestamp: Date.now(),
      payload: {
        contextType: ctxType as ContextSharePayload['contextType'],
        title,
        body,
        tags: [],
        priority: 'normal',
      } satisfies ContextSharePayload,
    } as AgentProtocolMessage;
  }

  return null;
}

/** Serialize an AgentProtocolMessage to an OSC escape sequence string.
 *  Agents can write this to stdout for structured communication. */
export function serializeProtocolMessage(msg: AgentProtocolMessage): string {
  const json = JSON.stringify({
    type: msg.type,
    agentId: msg.agentId,
    sessionId: msg.sessionId,
    timestamp: msg.timestamp,
    payload: msg.payload,
  });
  return `\x1b]9999;conductor:${json}\x07`;
}

/** Parse an OSC escape sequence string into an AgentProtocolMessage (or null) */
export function parseProtocolMessage(osc: string): AgentProtocolMessage | null {
  const match = osc.match(OSC_REGEX);
  if (!match) return null;
  try {
    return JSON.parse(match[1]) as AgentProtocolMessage;
  } catch {
    return null;
  }
}

/** Human-readable capability definitions */
export const CAPABILITY_DEFINITIONS: Record<AgentCapability, { label: string; icon: string; description: string }> = {
  'code-gen': { label: 'Code Gen', icon: '⚡', description: 'Generate and write code' },
  'code-review': { label: 'Code Review', icon: '🔍', description: 'Review and critique code' },
  'debugging': { label: 'Debugging', icon: '🐛', description: 'Diagnose and fix bugs' },
  'shell': { label: 'Shell', icon: '💻', description: 'Execute shell commands' },
  'web': { label: 'Web', icon: '🌐', description: 'Browse and test web apps' },
  'file-ops': { label: 'File Ops', icon: '📁', description: 'Read/write files' },
};
