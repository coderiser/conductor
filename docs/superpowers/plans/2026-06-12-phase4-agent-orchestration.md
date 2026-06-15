# Phase 4: Agent 编排 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build agent orchestration capabilities: a typed Agent Protocol for structured communication, a task queue with smart routing, inter-agent context sharing, and an embedded browser for web-capable agents.

**Architecture:** Four independent subsystems layered on the existing daemon-client architecture. The Agent Protocol extends the existing ClientMessage/DaemonMessage types with structured agent-to-system messages. TaskQueue runs in the main process, persisting tasks via SQLite and routing based on agent capabilities defined in agents.json. ContextShare provides a publish/subscribe bus between agent sessions. EmbeddedBrowser uses Electron's BrowserView API to give agents a web surface.

**Tech Stack:** TypeScript, Electron BrowserView, better-sqlite3 (new tables), React (new UI components)

---

## File Structure

```
Create:
  src/common/agent-protocol.ts          — Shared protocol types (OSC parsing, structured messages)
  src/main/task-queue.ts                — Task queue manager + smart router
  src/main/context-share.ts             — Inter-agent context publish/subscribe
  src/main/agent-watchdog.ts            — Health monitoring + auto-restart
  src/main/embedded-browser.ts          — BrowserView lifecycle manager
  src/renderer/components/TaskPanel.tsx — Task queue UI (submit, list, route)
  src/renderer/components/BrowserPanel.tsx — Embedded browser UI wrapper
  src/renderer/components/ContextFeed.tsx — Context sharing feed
  src/renderer/lib/osc-parser.ts        — OSC escape sequence decoder
  tests/agent-protocol.test.ts
  tests/task-queue.test.ts
  tests/context-share.test.ts
  tests/agent-watchdog.test.ts

Modify:
  src/common/agent-config.ts            — Add 'capabilities' field to AgentConfig
  src/common/stats-types.ts             — Add TaskRecord, ContextEntry types
  src/daemon/protocol/messages.ts       — Add agent-notify, osc-message types
  src/main/database.ts                  — New tables: task_queue, context_entries
  src/main/ipc-handlers.ts             — Register task/context/browser IPC handlers
  src/main/index.ts                     — Init TaskQueue, ContextShare, Watchdog, EmbeddedBrowser
  src/preload/index.ts                  — Expose task/context/browser APIs
  src/renderer/global.d.ts              — Update ElectronAPI with new methods
  src/renderer/App.tsx                  — Add TaskPanel, ContextFeed, BrowserPanel integrations
  src/renderer/components/Sidebar.tsx   — Add "Tasks" and "Context" buttons
```

---

### Task 1: Agent Protocol — Shared Type System

**Files:**
- Create: `src/common/agent-protocol.ts`
- Modify: `src/daemon/protocol/messages.ts`
- Test: `tests/agent-protocol.test.ts`

- [ ] **Step 1: Write tests for Agent Protocol types**

```typescript
// tests/agent-protocol.test.ts
import { describe, it, expect } from 'vitest';
import {
  AgentProtocolMessage,
  parseProtocolMessage,
  serializeProtocolMessage,
  extractProtocolMessage,
} from '../src/common/agent-protocol';

describe('AgentProtocol', () => {
  it('should validate protocol message structure', () => {
    const msg: AgentProtocolMessage = {
      type: 'task-progress',
      agentId: 'claude',
      sessionId: 'S1',
      timestamp: Date.now(),
      payload: { taskId: 'T1', status: 'running', progress: 0.5, message: 'Working...' },
    };
    expect(msg.type).toBe('task-progress');
    expect(msg.agentId).toBe('claude');
  });

  it('should parse task progress from PTY marker', () => {
    const line = '[TASK:T1] progress=50% status=running message=Analyzing code';
    const result = extractProtocolMessage('S1', 'claude', line);
    expect(result).toBeDefined();
    expect(result!.type).toBe('task-progress');
    expect(result!.payload.taskId).toBe('T1');
    expect(result!.payload.progress).toBe(0.5);
  });

  it('should parse context-share from PTY marker', () => {
    const line = '[CTX:summary] {"title":"Code Review","body":"3 bugs found in auth.ts"}';
    const result = extractProtocolMessage('S1', 'claude', line);
    expect(result?.type).toBe('context-share');
  });

  it('should return null for non-protocol output lines', () => {
    expect(extractProtocolMessage('S1', 'claude', 'normal terminal output')).toBeNull();
    expect(extractProtocolMessage('S1', 'claude', '')).toBeNull();
  });

  it('should serialize and parse OSC escape sequence round-trip', () => {
    const msg: AgentProtocolMessage = {
      type: 'need-attention',
      agentId: 'claude',
      sessionId: 'S1',
      timestamp: 1700000000000,
      payload: { reason: 'permission required', urgency: 'critical' },
    };
    const osc = serializeProtocolMessage(msg);
    expect(osc).toMatch(/^\x1b\]9999;/);
    expect(osc).toContain('conductor:');
    const parsed = parseProtocolMessage(osc);
    expect(parsed?.type).toBe('need-attention');
    expect(parsed?.payload.reason).toBe('permission required');
  });

  it('should parse complete task payload', () => {
    const line = '[TASK:T2] progress=100% status=done message=Completed. files=3 tokens=45000';
    const result = extractProtocolMessage('S1', 'claude', line);
    expect(result?.payload.status).toBe('done');
    expect(result?.payload.progress).toBe(1);
  });

  it('should handle malformed OSC sequences gracefully', () => {
    expect(parseProtocolMessage('not an OSC sequence')).toBeNull();
    expect(parseProtocolMessage('\x1b]9999;conductor:invalid-json\x07')).toBeNull();
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run tests/agent-protocol.test.ts`
Expected: FAIL — module not found

- [ ] **Step 3: Create shared protocol types**

```typescript
// src/common/agent-protocol.ts
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
const OSC_PREFIX = '\x1b]9999;conductor:';
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
        status: (statusMatch?.[1] as string) || 'running',
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
        contextType: ctxType,
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
  const { type, agentId, sessionId, timestamp, payload } = msg;
  const json = JSON.stringify({ type, agentId, sessionId, timestamp, payload });
  return `${OSC_PREFIX}${json}\x07`;
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
```

- [ ] **Step 4: Extend daemon protocol messages**

Edit `src/daemon/protocol/messages.ts` — add two new message types to the existing unions:

```typescript
// Append to ClientMessage union:
  | { type: 'agent-notify'; sessionId: string; agentId: string; payload: unknown }

// Append to DaemonMessage union:
  | { type: 'agent-notify'; sessionId: string; agentId: string; payload: unknown }
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `npx vitest run tests/agent-protocol.test.ts`
Expected: All 7 tests passing

- [ ] **Step 6: Commit**

```bash
git add src/common/agent-protocol.ts src/daemon/protocol/messages.ts tests/agent-protocol.test.ts
git commit -m "feat(phase4): add Agent Protocol types with PTY marker and OSC parser

- AgentProtocolMessage union type with 6 message kinds
- extractProtocolMessage parses [TASK:id], [CTX:type] markers and OSC 9999
- serializeProtocolMessage / parseProtocolMessage for OSC round-trip
- AgentCapability type for task routing
- Extends daemon protocol with agent-notify message type

Co-Authored-By: Claude <noreply@anthropic.com>"
```

---

### Task 2: Extend AgentConfig with Capabilities

**Files:**
- Modify: `src/common/agent-config.ts`

- [ ] **Step 1: Add capabilities field to AgentConfig**

Edit `src/common/agent-config.ts`:

```typescript
// Add import at top:
import type { AgentCapability } from './agent-protocol';

// Extend the AgentConfig interface — add after 'builtin' field:
  capabilities: AgentCapability[];
  worktree?: {
    enabled: boolean;
    baseBranch: string;
    cleanup: 'merge' | 'keep' | 'ask';
  };

// Update DEFAULT_AGENTS — each agent gets a capabilities array:
  // cmd:
  capabilities: ['shell', 'file-ops'],

  // claude:
  capabilities: ['code-gen', 'code-review', 'debugging', 'shell', 'file-ops'],

  // opencode:
  capabilities: ['code-gen', 'code-review', 'debugging', 'shell', 'file-ops'],

  // codex:
  capabilities: ['code-gen', 'code-review', 'debugging', 'shell', 'file-ops'],

// Update mapAgentEntry to include new fields:
    capabilities: entry.capabilities ?? ['code-gen', 'code-review', 'shell', 'file-ops'],
    worktree: entry.worktree,
```

- [ ] **Step 2: Verify build**

Run: `npx tsc --noEmit`
Expected: No errors

- [ ] **Step 3: Commit**

```bash
git add src/common/agent-config.ts
git commit -m "feat(phase4): extend AgentConfig with capabilities and worktree fields

Co-Authored-By: Claude <noreply@anthropic.com>"
```

---

### Task 3: Task Queue + Smart Router

**Files:**
- Create: `src/main/task-queue.ts`
- Create: `src/renderer/components/TaskPanel.tsx`
- Modify: `src/common/stats-types.ts` (add TaskRecord)
- Modify: `src/main/database.ts` (add task_queue table)
- Modify: `src/main/ipc-handlers.ts` (add task handlers)
- Modify: `src/preload/index.ts` (expose task APIs)
- Modify: `src/renderer/global.d.ts` (type declarations)
- Test: `tests/task-queue.test.ts`

- [ ] **Step 1: Add TaskRecord type**

Append to `src/common/stats-types.ts`:

```typescript
/** Task record in the orchestration queue */
export interface TaskRecord {
  id: string;
  title: string;
  description: string;
  priority: 'low' | 'normal' | 'high';
  requiredCapabilities: string[];
  assignedAgent?: string;
  assignedSession?: string;
  status: 'pending' | 'queued' | 'running' | 'done' | 'failed';
  progress: number;
  createdAt: number;
  startedAt?: number;
  completedAt?: number;
  result?: string;
  error?: string;
}
```

- [ ] **Step 2: Write tests for TaskQueue**

```typescript
// tests/task-queue.test.ts
import { describe, it, expect, beforeEach } from 'vitest';
import { TaskQueue } from '../src/main/task-queue';

describe('TaskQueue', () => {
  let queue: TaskQueue;

  beforeEach(() => { queue = new TaskQueue(); });

  it('should enqueue a task with generated id', () => {
    const task = queue.enqueue({
      title: 'Fix login bug',
      description: 'Users cannot log in with SSO',
      priority: 'high',
      requiredCapabilities: ['debugging', 'code-gen'],
    });
    expect(task.id).toMatch(/^task-/);
    expect(task.status).toBe('pending');
    expect(task.progress).toBe(0);
  });

  it('should route task to agent with all required capabilities', () => {
    const task = queue.enqueue({
      title: 'Build REST API',
      description: '',
      priority: 'normal',
      requiredCapabilities: ['code-gen'],
    });
    const routed = queue.tryRoute(task.id, [
      { id: 'cmd', capabilities: ['shell', 'file-ops'] },
      { id: 'claude', capabilities: ['code-gen', 'code-review', 'debugging', 'shell', 'file-ops'] },
    ]);
    expect(routed).toBe('claude');
  });

  it('should return null when no agent matches all capabilities', () => {
    const task = queue.enqueue({
      title: 'Web test',
      description: '',
      priority: 'normal',
      requiredCapabilities: ['web'],
    });
    const routed = queue.tryRoute(task.id, [
      { id: 'cmd', capabilities: ['shell', 'file-ops'] },
    ]);
    expect(routed).toBeNull();
  });

  it('should pick agent with most matching capabilities when tied', () => {
    const task = queue.enqueue({
      title: 'Debug and fix',
      description: '',
      priority: 'normal',
      requiredCapabilities: ['debugging', 'code-gen'],
    });
    // Both match, claude has more total capabilities
    const routed = queue.tryRoute(task.id, [
      { id: 'agent-a', capabilities: ['debugging', 'code-gen'] },
      { id: 'agent-b', capabilities: ['debugging', 'code-gen', 'code-review', 'shell'] },
    ]);
    // Both match all required; agent-b has higher total
    expect(routed).toBe('agent-b');
  });

  it('should update task progress and status', () => {
    const task = queue.enqueue({
      title: 'Refactor',
      description: '',
      priority: 'low',
      requiredCapabilities: ['code-gen'],
    });
    queue.updateProgress(task.id, 0.5, 'Half done');
    const t = queue.get(task.id);
    expect(t!.progress).toBe(0.5);
    expect(t!.status).toBe('running');
  });

  it('should complete a task', () => {
    const task = queue.enqueue({
      title: 'Add tests',
      description: '',
      priority: 'normal',
      requiredCapabilities: ['code-gen'],
    });
    queue.complete(task.id, 'All tests passing, 95% coverage');
    const t = queue.get(task.id);
    expect(t!.status).toBe('done');
    expect(t!.result).toBe('All tests passing, 95% coverage');
    expect(t!.completedAt).toBeGreaterThan(0);
  });

  it('should fail a task', () => {
    const task = queue.enqueue({
      title: 'Deploy',
      description: '',
      priority: 'high',
      requiredCapabilities: ['shell'],
    });
    queue.fail(task.id, 'Connection refused');
    const t = queue.get(task.id);
    expect(t!.status).toBe('failed');
    expect(t!.error).toBe('Connection refused');
  });

  it('should list tasks filtered by status', () => {
    const t1 = queue.enqueue({ title: 'A', description: '', priority: 'low', requiredCapabilities: ['shell'] });
    const t2 = queue.enqueue({ title: 'B', description: '', priority: 'low', requiredCapabilities: ['shell'] });
    queue.complete(t1.id, 'done');
    expect(queue.list('done').length).toBe(1);
    expect(queue.list('pending').length).toBe(1);
    expect(queue.list().length).toBe(2);
  });

  it('should dispatch task to a session', () => {
    const task = queue.enqueue({
      title: 'Run tests',
      description: '',
      priority: 'normal',
      requiredCapabilities: ['shell'],
    });
    queue.dispatch(task.id, 'S1');
    const t = queue.get(task.id);
    expect(t!.assignedSession).toBe('S1');
    expect(t!.status).toBe('running');
    expect(t!.startedAt).toBeGreaterThan(0);
  });

  it('should return stats summary', () => {
    queue.enqueue({ title: 'A', description: '', priority: 'high', requiredCapabilities: ['shell'] });
    queue.enqueue({ title: 'B', description: '', priority: 'normal', requiredCapabilities: ['code-gen'] });
    queue.enqueue({ title: 'C', description: '', priority: 'low', requiredCapabilities: ['debugging'] });
    const stats = queue.stats();
    expect(stats.total).toBe(3);
    expect(stats.pending).toBe(3);
    expect(stats.byPriority.high).toBe(1);
    expect(stats.byPriority.normal).toBe(1);
    expect(stats.byPriority.low).toBe(1);
  });
});
```

- [ ] **Step 3: Run tests to verify they fail**

Run: `npx vitest run tests/task-queue.test.ts`
Expected: FAIL — module not found

- [ ] **Step 4: Implement TaskQueue**

```typescript
// src/main/task-queue.ts
import type { TaskRecord } from '../common/stats-types';
import type { AgentCapability } from '../common/agent-protocol';

const genId = () => 'task-' + Math.random().toString(36).slice(2, 10);

interface EnqueueInput {
  title: string;
  description: string;
  priority: TaskRecord['priority'];
  requiredCapabilities: AgentCapability[];
}

interface AgentInfo {
  id: string;
  capabilities: AgentCapability[];
}

export class TaskQueue {
  private tasks = new Map<string, TaskRecord>();

  enqueue(input: EnqueueInput): TaskRecord {
    const task: TaskRecord = {
      id: genId(),
      title: input.title,
      description: input.description,
      priority: input.priority,
      requiredCapabilities: input.requiredCapabilities,
      status: 'pending',
      progress: 0,
      createdAt: Date.now(),
    };
    this.tasks.set(task.id, task);
    return task;
  }

  /** Match a task to the best agent. Returns agent id or null. */
  tryRoute(taskId: string, agents: AgentInfo[]): string | null {
    const task = this.tasks.get(taskId);
    if (!task || task.status !== 'pending') return null;

    let bestAgent: string | null = null;
    let bestScore = -1;

    for (const agent of agents) {
      if (!task.requiredCapabilities.every(c => agent.capabilities.includes(c))) continue;

      const score = task.requiredCapabilities.filter(c => agent.capabilities.includes(c)).length;
      if (score > bestScore) {
        bestScore = score;
        bestAgent = agent.id;
      }
    }

    if (bestAgent) {
      task.assignedAgent = bestAgent;
      task.status = 'queued';
    }
    return bestAgent;
  }

  dispatch(taskId: string, sessionId: string): void {
    const task = this.tasks.get(taskId);
    if (!task) return;
    task.assignedSession = sessionId;
    task.status = 'running';
    task.startedAt = Date.now();
  }

  updateProgress(taskId: string, progress: number, message: string): void {
    const task = this.tasks.get(taskId);
    if (!task) return;
    task.progress = Math.min(1, Math.max(0, progress));
    task.status = 'running';
  }

  complete(taskId: string, result: string): void {
    const task = this.tasks.get(taskId);
    if (!task) return;
    task.status = 'done';
    task.progress = 1;
    task.result = result;
    task.completedAt = Date.now();
  }

  fail(taskId: string, error: string): void {
    const task = this.tasks.get(taskId);
    if (!task) return;
    task.status = 'failed';
    task.error = error;
    task.completedAt = Date.now();
  }

  get(taskId: string): TaskRecord | undefined {
    return this.tasks.get(taskId);
  }

  list(status?: TaskRecord['status']): TaskRecord[] {
    const all = Array.from(this.tasks.values()).sort((a, b) => b.createdAt - a.createdAt);
    if (status) return all.filter(t => t.status === status);
    return all;
  }

  stats() {
    const all = Array.from(this.tasks.values());
    const byStatus: Record<string, number> = { pending: 0, queued: 0, running: 0, done: 0, failed: 0 };
    const byPriority: Record<string, number> = { high: 0, normal: 0, low: 0 };
    for (const t of all) {
      byStatus[t.status] = (byStatus[t.status] || 0) + 1;
      byPriority[t.priority] = (byPriority[t.priority] || 0) + 1;
    }
    return { total: all.length, ...byStatus, byPriority };
  }
}
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `npx vitest run tests/task-queue.test.ts`
Expected: All 10 tests passing

- [ ] **Step 6: Add SQLite persistence for tasks**

Append to `src/main/database.ts`:

```typescript
// --- Task Queue table (Phase 4) ---
db.exec(`
  CREATE TABLE IF NOT EXISTS task_queue (
    id TEXT PRIMARY KEY,
    title TEXT NOT NULL,
    description TEXT DEFAULT '',
    priority TEXT NOT NULL DEFAULT 'normal',
    required_capabilities TEXT NOT NULL DEFAULT '[]',
    assigned_agent TEXT,
    assigned_session TEXT,
    status TEXT NOT NULL DEFAULT 'pending',
    progress REAL DEFAULT 0,
    created_at INTEGER NOT NULL,
    started_at INTEGER,
    completed_at INTEGER,
    result TEXT,
    error TEXT
  );
`);

// In Database class:
saveTask(task: TaskRecord): void {
  const stmt = db.prepare(`
    INSERT OR REPLACE INTO task_queue
      (id, title, description, priority, required_capabilities, assigned_agent,
       assigned_session, status, progress, created_at, started_at, completed_at, result, error)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  stmt.run(
    task.id, task.title, task.description, task.priority,
    JSON.stringify(task.requiredCapabilities), task.assignedAgent ?? null,
    task.assignedSession ?? null, task.status, task.progress, task.createdAt,
    task.startedAt ?? null, task.completedAt ?? null, task.result ?? null, task.error ?? null
  );
}

loadTasks(): TaskRecord[] {
  const rows = db.prepare('SELECT * FROM task_queue ORDER BY created_at DESC').all() as any[];
  return rows.map((r: any) => ({
    id: r.id, title: r.title, description: r.description,
    priority: r.priority, requiredCapabilities: JSON.parse(r.required_capabilities),
    assignedAgent: r.assigned_agent, assignedSession: r.assigned_session,
    status: r.status, progress: r.progress, createdAt: r.created_at,
    startedAt: r.started_at, completedAt: r.completed_at,
    result: r.result, error: r.error,
  }));
}
```

- [ ] **Step 7: Register IPC handlers for tasks**

Add to `src/main/ipc-handlers.ts`:

```typescript
// --- Task Queue handlers (Phase 4) ---

ipcMain.handle('task_enqueue', (_e, input: { title: string; description: string; priority: string; requiredCapabilities: string[] }) => {
  const task = taskQueue.enqueue({
    title: input.title,
    description: input.description,
    priority: input.priority as TaskRecord['priority'],
    requiredCapabilities: input.requiredCapabilities as AgentCapability[],
  });
  const agents = agentConfig.list().map(a => ({ id: a.id, capabilities: a.capabilities }));
  taskQueue.tryRoute(task.id, agents);
  db.saveTask(task);
  return task;
});

ipcMain.handle('task_list', (_e, status?: string) => {
  return taskQueue.list(status as TaskRecord['status'] | undefined);
});

ipcMain.handle('task_stats', () => {
  return taskQueue.stats();
});

ipcMain.handle('task_complete', (_e, taskId: string, result: string) => {
  taskQueue.complete(taskId, result);
  const task = taskQueue.get(taskId);
  if (task) db.saveTask(task);
});

ipcMain.handle('task_fail', (_e, taskId: string, error: string) => {
  taskQueue.fail(taskId, error);
  const task = taskQueue.get(taskId);
  if (task) db.saveTask(task);
});
```

- [ ] **Step 8: Expose task APIs in preload**

Add to `src/preload/index.ts`:

```typescript
// Task Queue APIs
enqueueTask: (input: { title: string; description: string; priority: string; requiredCapabilities: string[] }) =>
  ipcRenderer.invoke('task_enqueue', input),
listTasks: (status?: string) => ipcRenderer.invoke('task_list', status),
getTaskStats: () => ipcRenderer.invoke('task_stats'),
completeTask: (taskId: string, result: string) => ipcRenderer.invoke('task_complete', taskId, result),
failTask: (taskId: string, error: string) => ipcRenderer.invoke('task_fail', taskId, error),
```

Update `src/renderer/global.d.ts` with matching type declarations in the `ElectronAPI` interface.

- [ ] **Step 9: Create TaskPanel UI**

```typescript
// src/renderer/components/TaskPanel.tsx
import { useState, useEffect } from 'react';

interface Props {
  visible: boolean;
  onClose: () => void;
}

export function TaskPanel({ visible, onClose }: Props) {
  const [tasks, setTasks] = useState<any[]>([]);
  const [title, setTitle] = useState('');
  const [description, setDescription] = useState('');
  const [priority, setPriority] = useState('normal');
  const [caps, setCaps] = useState<string[]>(['code-gen']);
  const [stats, setStats] = useState<any>({});

  useEffect(() => {
    if (!visible) return;
    refresh();
    const iv = setInterval(refresh, 2000);
    return () => clearInterval(iv);
  }, [visible]);

  const refresh = async () => {
    try {
      setTasks(await window.electronAPI.invoke('task_list') || []);
      setStats(await window.electronAPI.invoke('task_stats') || {});
    } catch { /* ignore */ }
  };

  const handleSubmit = async () => {
    if (!title.trim()) return;
    await window.electronAPI.invoke('task_enqueue', {
      title: title.trim(),
      description: description.trim(),
      priority,
      requiredCapabilities: caps,
    });
    setTitle('');
    setDescription('');
    refresh();
  };

  const statusColor = (s: string) =>
    s === 'done' ? 'var(--running)' : s === 'failed' ? 'var(--failed)' :
    s === 'running' ? 'var(--accent)' : s === 'queued' ? 'var(--pending)' : 'var(--caption)';

  if (!visible) return null;

  return (
    <div style={{
      position:'fixed', right:0, top:0, bottom:0, width:360,
      background:'var(--canvas-deep)', borderLeft:'1px solid var(--hairline)',
      zIndex:100, display:'flex', flexDirection:'column', fontFamily:'var(--font-sans)',
    }}>
      <div style={{ padding:'12px 14px', borderBottom:'1px solid var(--hairline)', display:'flex', justifyContent:'space-between', alignItems:'center' }}>
        <div>
          <div style={{ color:'var(--ink)', fontWeight:700, fontSize:14 }}>Task Queue</div>
          <div style={{ color:'var(--caption)', fontSize:10, marginTop:2 }}>
            {stats.total || 0} total · {stats.pending || 0} pending · {stats.running || 0} running
          </div>
        </div>
        <button onClick={onClose} style={{ background:'none', border:'none', color:'var(--caption)', cursor:'pointer', fontSize:18 }}>✕</button>
      </div>

      <div style={{ padding:'10px 14px', borderBottom:'1px solid var(--hairline)' }}>
        <input value={title} onChange={e => setTitle(e.target.value)} placeholder="Task title..."
          style={{ width:'100%', background:'var(--canvas)', border:'1px solid var(--hairline)', borderRadius:3, color:'var(--ink)', padding:'6px 8px', fontSize:12, fontFamily:'var(--font-sans)', outline:'none', marginBottom:6 }} />
        <textarea value={description} onChange={e => setDescription(e.target.value)} placeholder="Description (optional)..." rows={2}
          style={{ width:'100%', background:'var(--canvas)', border:'1px solid var(--hairline)', borderRadius:3, color:'var(--ink)', padding:'6px 8px', fontSize:11, fontFamily:'var(--font-sans)', outline:'none', marginBottom:6, resize:'vertical' }} />
        <div style={{ display:'flex', gap:6, alignItems:'center' }}>
          <select value={priority} onChange={e => setPriority(e.target.value)}
            style={{ background:'var(--canvas)', border:'1px solid var(--hairline)', borderRadius:3, color:'var(--ink)', padding:'4px 6px', fontSize:11 }}>
            <option value="low">Low</option>
            <option value="normal">Normal</option>
            <option value="high">High</option>
          </select>
          <div style={{ display:'flex', gap:3, flexWrap:'wrap', flex:1 }}>
            {['code-gen','code-review','debugging','shell','web','file-ops'].map(c => (
              <label key={c} style={{ fontSize:10, color: caps.includes(c)?'var(--accent)':'var(--caption)', cursor:'pointer', display:'flex', alignItems:'center', gap:2 }}>
                <input type="checkbox" checked={caps.includes(c)} onChange={() => setCaps(p => p.includes(c)?p.filter(x=>x!==c):[...p,c])}
                  style={{ width:10, height:10, accentColor:'var(--accent)' }} />
                {c}
              </label>
            ))}
          </div>
          <button onClick={handleSubmit}
            style={{ background:'var(--accent)', border:'none', borderRadius:3, color:'#fff', padding:'4px 10px', cursor:'pointer', fontSize:11, fontWeight:600 }}>
            Enqueue
          </button>
        </div>
      </div>

      <div style={{ flex:1, overflow:'auto', padding:'6px 14px' }}>
        {tasks.length === 0 ? (
          <div style={{ color:'var(--caption)', fontSize:11, fontStyle:'italic', padding:'20px 0', textAlign:'center' }}>No tasks yet. Submit a task above.</div>
        ) : tasks.map((t: any) => (
          <div key={t.id} style={{ background:'var(--canvas-soft)', borderRadius:4, padding:'8px 10px', marginBottom:6, border:'1px solid var(--hairline)' }}>
            <div style={{ display:'flex', justifyContent:'space-between', alignItems:'center', marginBottom:4 }}>
              <span style={{ color:'var(--ink)', fontWeight:600, fontSize:12 }}>{t.title}</span>
              <span style={{ color:statusColor(t.status), fontSize:10, fontWeight:600, textTransform:'uppercase' }}>{t.status}</span>
            </div>
            {t.description && <div style={{ color:'var(--caption)', fontSize:10, marginBottom:4 }}>{t.description}</div>}
            <div style={{ display:'flex', gap:8, fontSize:10, color:'var(--caption)' }}>
              <span>{t.priority}</span>
              {t.assignedAgent && <span>→ {t.assignedAgent}</span>}
              {t.requiredCapabilities?.length > 0 && <span>{t.requiredCapabilities.join(', ')}</span>}
            </div>
            {t.status === 'running' && (
              <div style={{ marginTop:6, height:3, background:'var(--hairline)', borderRadius:2 }}>
                <div style={{ height:'100%', width:`${(t.progress||0)*100}%`, background:'var(--accent)', borderRadius:2, transition:'width 0.3s' }} />
              </div>
            )}
          </div>
        ))}
      </div>
    </div>
  );
}
```

- [ ] **Step 10: Verify build**

Run: `npx tsc --noEmit`
Expected: No errors

- [ ] **Step 11: Commit**

```bash
git add src/main/task-queue.ts src/renderer/components/TaskPanel.tsx src/common/stats-types.ts src/main/database.ts src/main/ipc-handlers.ts src/preload/index.ts src/renderer/global.d.ts tests/task-queue.test.ts
git commit -m "feat(phase4): add task queue with smart routing, persistence, and UI

- TaskQueue class: enqueue, route by capabilities, track progress/status
- SQLite task_queue table for persistence
- IPC handlers: task_enqueue, task_list, task_stats, task_complete, task_fail
- TaskPanel UI: submit form, filterable task list, progress bars

Co-Authored-By: Claude <noreply@anthropic.com>"
```

---

### Task 4: Context Sharing

**Files:**
- Create: `src/main/context-share.ts`
- Create: `src/renderer/components/ContextFeed.tsx`
- Modify: `src/common/stats-types.ts` (add ContextEntry)
- Modify: `src/main/database.ts` (add context_entries table)
- Modify: `src/main/ipc-handlers.ts` (add ctx handlers)
- Modify: `src/preload/index.ts` (expose ctx APIs)
- Modify: `src/renderer/global.d.ts` (type declarations)
- Test: `tests/context-share.test.ts`

- [ ] **Step 1: Add ContextEntry type**

Append to `src/common/stats-types.ts`:

```typescript
/** Context entry shared by an agent, visible to other agents */
export interface ContextEntry {
  id: string;
  sessionId: string;
  agentId: string;
  contextType: string;
  title: string;
  body: string;
  tags: string[];
  priority: 'low' | 'normal' | 'high';
  timestamp: number;
  consumed: boolean;
}
```

- [ ] **Step 2: Write tests for ContextShare**

```typescript
// tests/context-share.test.ts
import { describe, it, expect, beforeEach } from 'vitest';
import { ContextShare } from '../src/main/context-share';

describe('ContextShare', () => {
  let ctx: ContextShare;

  beforeEach(() => { ctx = new ContextShare(); });

  it('should publish and return a context entry', () => {
    const entry = ctx.publish('S1', 'claude', {
      contextType: 'summary',
      title: 'Code review findings',
      body: 'Found 3 issues in auth.ts',
      tags: ['review', 'security'],
      priority: 'high',
    });
    expect(entry.id).toMatch(/^ctx-/);
    expect(entry.sessionId).toBe('S1');
    expect(entry.consumed).toBe(false);
  });

  it('should list all entries sorted by timestamp desc', () => {
    ctx.publish('S1', 'claude', { contextType: 'finding', title: 'A', body: '', tags: [], priority: 'normal' });
    ctx.publish('S2', 'opencode', { contextType: 'finding', title: 'B', body: '', tags: [], priority: 'normal' });
    expect(ctx.list().length).toBe(2);
  });

  it('should list entries for a specific session', () => {
    ctx.publish('S1', 'claude', { contextType: 'finding', title: 'A', body: '', tags: [], priority: 'normal' });
    ctx.publish('S2', 'opencode', { contextType: 'finding', title: 'B', body: '', tags: [], priority: 'normal' });
    expect(ctx.listForSession('S1').length).toBe(1);
  });

  it('should filter entries by tags', () => {
    ctx.publish('S1', 'claude', { contextType: 'finding', title: 'A', body: '', tags: ['security'], priority: 'high' });
    ctx.publish('S2', 'opencode', { contextType: 'finding', title: 'B', body: '', tags: ['performance'], priority: 'normal' });
    expect(ctx.search({ tags: ['security'] }).length).toBe(1);
  });

  it('should filter entries by contextType', () => {
    ctx.publish('S1', 'claude', { contextType: 'summary', title: 'A', body: '', tags: [], priority: 'normal' });
    ctx.publish('S2', 'opencode', { contextType: 'file-diff', title: 'B', body: '', tags: [], priority: 'normal' });
    expect(ctx.search({ contextType: 'file-diff' }).length).toBe(1);
  });

  it('should mark entries as consumed', () => {
    const entry = ctx.publish('S1', 'claude', { contextType: 'finding', title: 'X', body: '', tags: [], priority: 'normal' });
    ctx.markConsumed(entry.id);
    expect(ctx.get(entry.id)!.consumed).toBe(true);
  });

  it('should return undefined for unknown entry', () => {
    expect(ctx.get('nonexistent')).toBeUndefined();
  });

  it('should return empty list when no entries', () => {
    expect(ctx.list()).toEqual([]);
    expect(ctx.search({ tags: ['none'] })).toEqual([]);
  });
});
```

- [ ] **Step 3: Run tests to verify they fail**

Run: `npx vitest run tests/context-share.test.ts`
Expected: FAIL — module not found

- [ ] **Step 4: Implement ContextShare**

```typescript
// src/main/context-share.ts
import type { ContextEntry } from '../common/stats-types';

const genId = () => 'ctx-' + Math.random().toString(36).slice(2, 10);

interface PublishInput {
  contextType: string;
  title: string;
  body: string;
  tags: string[];
  priority: ContextEntry['priority'];
}

interface SearchFilter {
  contextType?: string;
  tags?: string[];
  sessionId?: string;
  agentId?: string;
  consumed?: boolean;
}

export class ContextShare {
  private entries = new Map<string, ContextEntry>();

  publish(sessionId: string, agentId: string, input: PublishInput): ContextEntry {
    const entry: ContextEntry = {
      id: genId(),
      sessionId,
      agentId,
      contextType: input.contextType,
      title: input.title,
      body: input.body,
      tags: input.tags,
      priority: input.priority,
      timestamp: Date.now(),
      consumed: false,
    };
    this.entries.set(entry.id, entry);
    return entry;
  }

  get(id: string): ContextEntry | undefined {
    return this.entries.get(id);
  }

  list(): ContextEntry[] {
    return Array.from(this.entries.values()).sort((a, b) => b.timestamp - a.timestamp);
  }

  listForSession(sessionId: string): ContextEntry[] {
    return this.list().filter(e => e.sessionId === sessionId);
  }

  search(filter: SearchFilter): ContextEntry[] {
    let results = this.list();
    if (filter.contextType) results = results.filter(e => e.contextType === filter.contextType);
    if (filter.tags?.length) results = results.filter(e => filter.tags!.some(t => e.tags.includes(t)));
    if (filter.sessionId) results = results.filter(e => e.sessionId === filter.sessionId);
    if (filter.agentId) results = results.filter(e => e.agentId === filter.agentId);
    if (filter.consumed !== undefined) results = results.filter(e => e.consumed === filter.consumed);
    return results;
  }

  markConsumed(id: string): void {
    const entry = this.entries.get(id);
    if (entry) entry.consumed = true;
  }
}
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `npx vitest run tests/context-share.test.ts`
Expected: All 8 tests passing

- [ ] **Step 6: Add SQLite persistence for context entries**

Append to `src/main/database.ts`:

```typescript
// --- Context Sharing table (Phase 4) ---
db.exec(`
  CREATE TABLE IF NOT EXISTS context_entries (
    id TEXT PRIMARY KEY,
    session_id TEXT NOT NULL,
    agent_id TEXT NOT NULL,
    context_type TEXT NOT NULL,
    title TEXT NOT NULL,
    body TEXT DEFAULT '',
    tags TEXT DEFAULT '[]',
    priority TEXT DEFAULT 'normal',
    timestamp INTEGER NOT NULL,
    consumed INTEGER DEFAULT 0
  );
`);

// In Database class:
saveContextEntry(entry: ContextEntry): void {
  const stmt = db.prepare(`
    INSERT OR REPLACE INTO context_entries
      (id, session_id, agent_id, context_type, title, body, tags, priority, timestamp, consumed)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  stmt.run(entry.id, entry.sessionId, entry.agentId, entry.contextType,
    entry.title, entry.body, JSON.stringify(entry.tags), entry.priority,
    entry.timestamp, entry.consumed ? 1 : 0);
}

loadContextEntries(): ContextEntry[] {
  const rows = db.prepare('SELECT * FROM context_entries ORDER BY timestamp DESC').all() as any[];
  return rows.map((r: any) => ({
    id: r.id, sessionId: r.session_id, agentId: r.agent_id,
    contextType: r.context_type, title: r.title, body: r.body,
    tags: JSON.parse(r.tags), priority: r.priority,
    timestamp: r.timestamp, consumed: r.consumed === 1,
  }));
}
```

- [ ] **Step 7: Register IPC handlers for context sharing**

Add to `src/main/ipc-handlers.ts`:

```typescript
// --- Context Sharing handlers (Phase 4) ---

ipcMain.handle('ctx_publish', (_e, sessionId: string, agentId: string, input: any) => {
  const entry = contextShare.publish(sessionId, agentId, input);
  db.saveContextEntry(entry);
  mainWindow?.webContents.send('ctx_new_entry', entry);
  return entry;
});

ipcMain.handle('ctx_list', (_e, filter?: any) => {
  if (filter && Object.keys(filter).length > 0) return contextShare.search(filter);
  return contextShare.list();
});

ipcMain.handle('ctx_mark_consumed', (_e, id: string) => {
  contextShare.markConsumed(id);
  const entry = contextShare.get(id);
  if (entry) db.saveContextEntry(entry);
});
```

- [ ] **Step 8: Expose context APIs in preload**

Add to `src/preload/index.ts`:

```typescript
// Context Sharing APIs
publishContext: (sessionId: string, agentId: string, input: any) =>
  ipcRenderer.invoke('ctx_publish', sessionId, agentId, input),
listContext: (filter?: any) => ipcRenderer.invoke('ctx_list', filter),
markContextConsumed: (id: string) => ipcRenderer.invoke('ctx_mark_consumed', id),
onNewContext: (callback: (entry: any) => void) => {
  const handler = (_e: any, entry: any) => callback(entry);
  ipcRenderer.on('ctx_new_entry', handler);
  return () => ipcRenderer.removeListener('ctx_new_entry', handler);
},
```

Update `src/renderer/global.d.ts` with matching type declarations.

- [ ] **Step 9: Create ContextFeed UI**

```typescript
// src/renderer/components/ContextFeed.tsx
import { useState, useEffect } from 'react';

interface Props {
  visible: boolean;
  onClose: () => void;
}

export function ContextFeed({ visible, onClose }: Props) {
  const [entries, setEntries] = useState<any[]>([]);
  const [filter, setFilter] = useState('');

  useEffect(() => {
    if (!visible) return;
    window.electronAPI.invoke('ctx_list').then(setEntries).catch(() => {});
    const unsub = window.electronAPI.onNewContext((entry: any) => {
      setEntries(prev => [entry, ...prev]);
    });
    return () => { unsub?.(); };
  }, [visible]);

  const filtered = filter
    ? entries.filter((e: any) =>
        e.title.toLowerCase().includes(filter.toLowerCase()) ||
        e.tags?.some((t: string) => t.toLowerCase().includes(filter.toLowerCase())))
    : entries;

  const typeIcon = (t: string) =>
    t === 'summary' ? '📋' : t === 'finding' ? '🔍' : t === 'file-diff' ? '📝' : t === 'code-snippet' ? '💻' : t === 'link' ? '🔗' : '📌';

  const priorityColor = (p: string) =>
    p === 'high' ? 'var(--failed)' : p === 'normal' ? 'var(--pending)' : 'var(--caption)';

  if (!visible) return null;

  return (
    <div style={{
      position:'fixed', right:0, top:0, bottom:0, width:340,
      background:'var(--canvas-deep)', borderLeft:'1px solid var(--hairline)',
      zIndex:100, display:'flex', flexDirection:'column', fontFamily:'var(--font-sans)',
    }}>
      <div style={{ padding:'12px 14px', borderBottom:'1px solid var(--hairline)', display:'flex', justifyContent:'space-between', alignItems:'center' }}>
        <div>
          <div style={{ color:'var(--ink)', fontWeight:700, fontSize:14 }}>Context Feed</div>
          <div style={{ color:'var(--caption)', fontSize:10, marginTop:2 }}>{entries.length} entries</div>
        </div>
        <button onClick={onClose} style={{ background:'none', border:'none', color:'var(--caption)', cursor:'pointer', fontSize:18 }}>✕</button>
      </div>

      <div style={{ padding:'8px 14px', borderBottom:'1px solid var(--hairline)' }}>
        <input value={filter} onChange={e => setFilter(e.target.value)} placeholder="Search by title or tag..."
          style={{ width:'100%', background:'var(--canvas)', border:'1px solid var(--hairline)', borderRadius:3, color:'var(--ink)', padding:'4px 8px', fontSize:11, fontFamily:'var(--font-sans)', outline:'none' }} />
      </div>

      <div style={{ flex:1, overflow:'auto', padding:'6px 14px' }}>
        {filtered.length === 0 ? (
          <div style={{ color:'var(--caption)', fontSize:11, fontStyle:'italic', padding:'20px 0', textAlign:'center' }}>
            {filter ? 'No matching entries' : 'No context shared yet'}
          </div>
        ) : filtered.map((e: any) => (
          <div key={e.id} style={{
            background: e.consumed ? 'var(--canvas-soft)' : 'rgba(94,106,210,0.08)',
            borderRadius:4, padding:'8px 10px', marginBottom:6,
            border: e.consumed ? '1px solid var(--hairline)' : '1px solid var(--accent)',
            opacity: e.consumed ? 0.7 : 1,
          }}>
            <div style={{ display:'flex', alignItems:'center', gap:6, marginBottom:4 }}>
              <span>{typeIcon(e.contextType)}</span>
              <span style={{ color:'var(--ink)', fontWeight:600, fontSize:12, flex:1 }}>{e.title}</span>
              <span style={{ color:priorityColor(e.priority), fontSize:9, fontWeight:600 }}>{e.priority}</span>
            </div>
            <div style={{ color:'var(--caption)', fontSize:10, marginBottom:4, paddingLeft:22 }}>{e.body}</div>
            <div style={{ display:'flex', gap:4, alignItems:'center', paddingLeft:22 }}>
              <span style={{ color:'var(--accent)', fontSize:9 }}>{e.agentId}</span>
              {e.tags?.map((t: string) => (
                <span key={t} style={{ color:'var(--caption)', fontSize:9, background:'var(--canvas)', borderRadius:2, padding:'0 4px' }}>{t}</span>
              ))}
              <span style={{ color:'var(--caption)', fontSize:9, marginLeft:'auto' }}>
                {new Date(e.timestamp).toLocaleTimeString('en-US', { hour12: false })}
              </span>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
```

- [ ] **Step 10: Verify build**

Run: `npx tsc --noEmit`
Expected: No errors

- [ ] **Step 11: Commit**

```bash
git add src/main/context-share.ts src/renderer/components/ContextFeed.tsx src/common/stats-types.ts src/main/database.ts src/main/ipc-handlers.ts src/preload/index.ts src/renderer/global.d.ts tests/context-share.test.ts
git commit -m "feat(phase4): add inter-agent context sharing with pub/sub and feed UI

- ContextShare class: publish, search by tags/type, mark consumed
- SQLite context_entries table for persistence
- IPC handlers: ctx_publish, ctx_list, ctx_mark_consumed
- ContextFeed UI: real-time stream, searchable, tag/type badges

Co-Authored-By: Claude <noreply@anthropic.com>"
```

---

### Task 5: Agent Watchdog — Health Monitoring + Auto-Restart

**Files:**
- Create: `src/main/agent-watchdog.ts`
- Modify: `src/main/index.ts`
- Test: `tests/agent-watchdog.test.ts`

- [ ] **Step 1: Write tests for AgentWatchdog**

```typescript
// tests/agent-watchdog.test.ts
import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';
import { AgentWatchdog } from '../src/main/agent-watchdog';

describe('AgentWatchdog', () => {
  let watchdog: AgentWatchdog;

  beforeEach(() => {
    vi.useFakeTimers();
    watchdog = new AgentWatchdog({ checkIntervalMs: 1000, unhealthyThreshold: 20 });
  });

  afterEach(() => {
    watchdog.stop();
    vi.useRealTimers();
  });

  it('should register and unregister sessions', () => {
    watchdog.register('S1', 'claude', { autoRestart: false });
    expect(watchdog.getMonitoredSessions()).toContain('S1');
    watchdog.unregister('S1');
    expect(watchdog.getMonitoredSessions()).not.toContain('S1');
  });

  it('should report health for a registered session', () => {
    watchdog.register('S1', 'claude', { autoRestart: false });
    const health = watchdog.getHealth('S1');
    expect(health).toBeDefined();
    expect(health!.score).toBeGreaterThanOrEqual(80);
    expect(health!.isUnhealthy).toBe(false);
  });

  it('should return undefined health for unregistered session', () => {
    expect(watchdog.getHealth('nonexistent')).toBeUndefined();
  });

  it('should list all health records', () => {
    watchdog.register('S1', 'claude', { autoRestart: false });
    watchdog.register('S2', 'opencode', { autoRestart: true });
    expect(watchdog.getAllHealth().length).toBe(2);
  });

  it('should not auto-restart when autoRestart is false', () => {
    const events: any[] = [];
    watchdog.on('agent-restart', e => events.push(e));
    watchdog.register('S1', 'claude', { autoRestart: false });
    watchdog.checkNow();
    expect(events.length).toBe(0);
  });

  it('should emit unhealthy event for low-health non-cmd agent', () => {
    const events: any[] = [];
    watchdog.on('agent-unhealthy', e => events.push(e));
    watchdog.register('S1', 'claude', { autoRestart: false });
    // Force idle: advance time by 10 minutes
    vi.advanceTimersByTime(600_000);
    // Activity is stale — health should be penalized
    const health = watchdog.getHealth('S1');
    expect(health!.score).toBeLessThan(100);
  });

  it('should skip health check for cmd.exe', () => {
    const events: any[] = [];
    watchdog.on('agent-unhealthy', e => events.push(e));
    watchdog.register('S1', 'cmd', { autoRestart: false });
    watchdog.checkNow();
    // cmd.exe is always "healthy" — no events emitted
    expect(watchdog.getHealth('S1')!.isUnhealthy).toBe(false);
  });

  it('should update activity timestamp', () => {
    watchdog.register('S1', 'claude', { autoRestart: false });
    const before = watchdog.getHealth('S1')!.lastActivity;
    vi.advanceTimersByTime(5000);
    watchdog.updateActivity('S1');
    const after = watchdog.getHealth('S1')!.lastActivity;
    expect(after).toBeGreaterThan(before);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run tests/agent-watchdog.test.ts`
Expected: FAIL — module not found

- [ ] **Step 3: Implement AgentWatchdog**

```typescript
// src/main/agent-watchdog.ts
import { EventEmitter } from 'events';
import { calculateHealth } from '../common/stats-types';
import type { AgentStats } from '../common/stats-types';

interface WatchdogConfig {
  checkIntervalMs: number;
  unhealthyThreshold: number;
}

interface SessionConfig {
  autoRestart: boolean;
}

interface HealthRecord {
  sessionId: string;
  agentId: string;
  score: number;
  lastActivity: number;
  isUnhealthy: boolean;
}

export class AgentWatchdog extends EventEmitter {
  private sessions = new Map<string, {
    agentId: string;
    config: SessionConfig;
    lastActivity: number;
    errorCount: number;
    respawnCount: number;
  }>();
  private timer: ReturnType<typeof setInterval> | null = null;
  private config: WatchdogConfig;

  constructor(config: Partial<WatchdogConfig> = {}) {
    super();
    this.config = { checkIntervalMs: 30_000, unhealthyThreshold: 20, ...config };
    this.start();
  }

  private start(): void {
    this.timer = setInterval(() => this.checkNow(), this.config.checkIntervalMs);
  }

  stop(): void {
    if (this.timer) { clearInterval(this.timer); this.timer = null; }
  }

  register(sessionId: string, agentId: string, config: SessionConfig): void {
    this.sessions.set(sessionId, {
      agentId, config,
      lastActivity: Date.now(),
      errorCount: 0,
      respawnCount: 0,
    });
  }

  unregister(sessionId: string): void {
    this.sessions.delete(sessionId);
  }

  updateActivity(sessionId: string): void {
    this.sessions.get(sessionId)?.lastActivity = Date.now();
  }

  recordError(sessionId: string): void {
    const s = this.sessions.get(sessionId);
    if (s) s.errorCount++;
  }

  getMonitoredSessions(): string[] {
    return Array.from(this.sessions.keys());
  }

  getHealth(sessionId: string): HealthRecord | undefined {
    const s = this.sessions.get(sessionId);
    if (!s) return undefined;

    const stats: AgentStats = {
      sessionId, agentId: s.agentId, agentType: s.agentId,
      status: 'running', tokenCount: 0, tokenRate: 0, tokenHistory: [],
      estimatedCost: 0, costModel: '', healthScore: 100,
      lastActivity: s.lastActivity, startTime: Date.now(),
      errorCount: s.errorCount, respawnCount: s.respawnCount, cwd: '.',
    };

    const score = calculateHealth(stats);
    return {
      sessionId, agentId: s.agentId, score,
      lastActivity: s.lastActivity,
      isUnhealthy: score < this.config.unhealthyThreshold && s.agentId !== 'cmd',
    };
  }

  getAllHealth(): HealthRecord[] {
    return Array.from(this.sessions.keys())
      .map(id => this.getHealth(id))
      .filter((h): h is HealthRecord => h !== undefined);
  }

  checkNow(): void {
    for (const [sessionId, s] of this.sessions) {
      if (s.agentId === 'cmd') continue;

      const health = this.getHealth(sessionId);
      if (!health?.isUnhealthy) continue;

      this.emit('agent-unhealthy', {
        sessionId, agentId: s.agentId, health: health.score,
      });

      if (s.config.autoRestart) {
        this.emit('agent-restart', {
          sessionId, agentId: s.agentId, health: health.score,
        });
        s.respawnCount++;
      }
    }
  }
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run tests/agent-watchdog.test.ts`
Expected: All 8 tests passing

- [ ] **Step 5: Integrate into main process**

In `src/main/index.ts`, initialize watchdog and wire events:

```typescript
import { AgentWatchdog } from './agent-watchdog';

const watchdog = new AgentWatchdog({ checkIntervalMs: 30_000, unhealthyThreshold: 20 });

watchdog.on('agent-unhealthy', (event: any) => {
  log.info(`[watchdog] Agent ${event.agentId} (${event.sessionId}) unhealthy: score ${event.health}`);
  mainWindow?.webContents.send('agent-unhealthy', event);
});

watchdog.on('agent-restart', async (event: any) => {
  log.info(`[watchdog] Auto-restarting agent ${event.agentId} (${event.sessionId})`);
  try {
    await daemonClient.killSession(event.sessionId);
    // Re-spawn would be handled by session lifecycle management
  } catch (err) {
    log.error(`[watchdog] Restart failed:`, err);
  }
});

// Register sessions on spawn, unregister on exit
// In spawn handler:
watchdog.register(sessionId, agentId, { autoRestart: config.autoRestart ?? false });
// In exit handler:
watchdog.unregister(sessionId);

app.on('before-quit', () => watchdog.stop());
```

- [ ] **Step 6: Commit**

```bash
git add src/main/agent-watchdog.ts src/main/index.ts tests/agent-watchdog.test.ts
git commit -m "feat(phase4): add agent watchdog with health monitoring and auto-restart

Co-Authored-By: Claude <noreply@anthropic.com>"
```

---

### Task 6: Embedded Browser

**Files:**
- Create: `src/main/embedded-browser.ts`
- Create: `src/renderer/components/BrowserPanel.tsx`
- Modify: `src/main/ipc-handlers.ts` (add browser handlers)
- Modify: `src/preload/index.ts` (expose browser APIs)
- Modify: `src/renderer/global.d.ts` (type declarations)

- [ ] **Step 1: Implement EmbeddedBrowser manager**

```typescript
// src/main/embedded-browser.ts
import { BrowserView, BrowserWindow } from 'electron';

interface BrowserSession {
  id: string;
  view: BrowserView;
  url: string;
  sessionId: string;
}

export class EmbeddedBrowser {
  private browsers = new Map<string, BrowserSession>();
  private mainWindow: BrowserWindow;
  private nextId = 1;

  constructor(mainWindow: BrowserWindow) {
    this.mainWindow = mainWindow;
  }

  create(url: string, sessionId: string): Omit<BrowserSession, 'view'> {
    const id = `browser-${this.nextId++}`;
    const view = new BrowserView({
      webPreferences: {
        nodeIntegration: false,
        contextIsolation: true,
        sandbox: true,
      },
    });

    this.mainWindow.addBrowserView(view);

    const bounds = this.mainWindow.getBounds();
    view.setBounds({
      x: Math.floor(bounds.width * 0.5),
      y: Math.floor(bounds.height * 0.5),
      width: Math.floor(bounds.width * 0.5),
      height: Math.floor(bounds.height * 0.5),
    });
    view.setAutoResize({ width: true, height: true, horizontal: true, vertical: true });

    view.webContents.loadURL(url);

    const session: BrowserSession = { id, view, url, sessionId };
    this.browsers.set(id, session);

    view.webContents.on('did-navigate', (_e, navUrl) => {
      session.url = navUrl;
    });

    return { id: session.id, url: session.url, sessionId: session.sessionId };
  }

  navigate(id: string, url: string): void {
    const session = this.browsers.get(id);
    if (session) {
      session.view.webContents.loadURL(url);
      session.url = url;
    }
  }

  async evaluate(id: string, code: string): Promise<unknown> {
    const session = this.browsers.get(id);
    if (!session) throw new Error(`Browser ${id} not found`);
    return session.view.webContents.executeJavaScript(code);
  }

  async screenshot(id: string): Promise<string> {
    const session = this.browsers.get(id);
    if (!session) throw new Error(`Browser ${id} not found`);
    const image = await session.view.webContents.capturePage();
    return image.toDataURL();
  }

  resize(id: string, bounds: { x: number; y: number; width: number; height: number }): void {
    const session = this.browsers.get(id);
    if (session) session.view.setBounds(bounds);
  }

  setVisible(id: string, visible: boolean): void {
    const session = this.browsers.get(id);
    if (!session) return;
    if (visible) {
      this.mainWindow.addBrowserView(session.view);
    } else {
      this.mainWindow.removeBrowserView(session.view);
    }
  }

  destroy(id: string): void {
    const session = this.browsers.get(id);
    if (!session) return;
    this.mainWindow.removeBrowserView(session.view);
    (session.view.webContents as any).destroy?.() ?? session.view.webContents.close();
    this.browsers.delete(id);
  }

  destroyAll(): void {
    for (const id of this.browsers.keys()) this.destroy(id);
  }

  get(id: string): Omit<BrowserSession, 'view'> | undefined {
    const s = this.browsers.get(id);
    if (!s) return undefined;
    return { id: s.id, url: s.url, sessionId: s.sessionId };
  }

  list(): Omit<BrowserSession, 'view'>[] {
    return Array.from(this.browsers.values()).map(s => ({
      id: s.id, url: s.url, sessionId: s.sessionId,
    }));
  }
}
```

- [ ] **Step 2: Register IPC handlers for browser**

Add to `src/main/ipc-handlers.ts`:

```typescript
// --- Embedded Browser handlers (Phase 4) ---

ipcMain.handle('browser_create', (_e, url: string, sessionId: string) => {
  return embeddedBrowser.create(url, sessionId);
});

ipcMain.handle('browser_navigate', (_e, id: string, url: string) => {
  embeddedBrowser.navigate(id, url);
});

ipcMain.handle('browser_evaluate', (_e, id: string, code: string) => {
  return embeddedBrowser.evaluate(id, code);
});

ipcMain.handle('browser_screenshot', (_e, id: string) => {
  return embeddedBrowser.screenshot(id);
});

ipcMain.handle('browser_destroy', (_e, id: string) => {
  embeddedBrowser.destroy(id);
});

ipcMain.handle('browser_list', () => {
  return embeddedBrowser.list();
});
```

- [ ] **Step 3: Expose browser APIs in preload**

Add to `src/preload/index.ts`:

```typescript
// Embedded Browser APIs
createBrowser: (url: string, sessionId: string) => ipcRenderer.invoke('browser_create', url, sessionId),
navigateBrowser: (id: string, url: string) => ipcRenderer.invoke('browser_navigate', id, url),
evaluateBrowser: (id: string, code: string) => ipcRenderer.invoke('browser_evaluate', id, code),
screenshotBrowser: (id: string) => ipcRenderer.invoke('browser_screenshot', id),
destroyBrowser: (id: string) => ipcRenderer.invoke('browser_destroy', id),
listBrowsers: () => ipcRenderer.invoke('browser_list'),
```

Update `src/renderer/global.d.ts` with matching type declarations.

- [ ] **Step 4: Create BrowserPanel UI**

```typescript
// src/renderer/components/BrowserPanel.tsx
import { useState } from 'react';

interface Props {
  sessionId?: string;
}

export function BrowserPanel({ sessionId }: Props) {
  const [url, setUrl] = useState('https://www.google.com');
  const [browsers, setBrowsers] = useState<any[]>([]);

  const handleOpen = async () => {
    if (!sessionId) return;
    try {
      const result = await window.electronAPI.invoke('browser_create', url, sessionId);
      setBrowsers(prev => [...prev, result]);
    } catch (err) {
      console.error('Failed to create browser:', err);
    }
  };

  const handleDestroy = async (id: string) => {
    await window.electronAPI.invoke('browser_destroy', id);
    setBrowsers(prev => prev.filter(b => b.id !== id));
  };

  return (
    <div style={{ padding:'8px', borderTop:'1px solid var(--hairline)' }}>
      <div style={{ display:'flex', gap:6, alignItems:'center' }}>
        <input value={url} onChange={e => setUrl(e.target.value)}
          placeholder="URL..."
          style={{ flex:1, background:'var(--canvas)', border:'1px solid var(--hairline)', borderRadius:3, color:'var(--ink)', padding:'4px 8px', fontSize:11, fontFamily:'var(--font-mono)', outline:'none' }} />
        <button onClick={handleOpen} disabled={!sessionId}
          style={{ background:'var(--accent)', border:'none', borderRadius:3, color:'#fff', padding:'4px 10px', cursor:'pointer', fontSize:11, fontFamily:'var(--font-sans)', opacity: sessionId?1:0.4 }}>
          🌐 Open
        </button>
      </div>
      {browsers.length > 0 && (
        <div style={{ marginTop:6, fontSize:10, color:'var(--caption)' }}>
          {browsers.map((b: any) => (
            <div key={b.id} style={{ display:'flex', justifyContent:'space-between', alignItems:'center', padding:'2px 0' }}>
              <span style={{ overflow:'hidden', textOverflow:'ellipsis', whiteSpace:'nowrap' }}>{b.url}</span>
              <button onClick={() => handleDestroy(b.id)}
                style={{ background:'none', border:'none', color:'var(--failed)', cursor:'pointer', fontSize:12 }}>✕</button>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
```

- [ ] **Step 5: Verify build**

Run: `npx tsc --noEmit`
Expected: No errors

- [ ] **Step 6: Commit**

```bash
git add src/main/embedded-browser.ts src/renderer/components/BrowserPanel.tsx src/main/ipc-handlers.ts src/preload/index.ts src/renderer/global.d.ts
git commit -m "feat(phase4): add embedded browser with BrowserView, IPC, and panel UI

Co-Authored-By: Claude <noreply@anthropic.com>"
```

---

### Task 7: Integration — Wire Everything Together

**Files:**
- Modify: `src/main/index.ts`
- Modify: `src/renderer/App.tsx`
- Modify: `src/renderer/components/Sidebar.tsx`

- [ ] **Step 1: Initialize Phase 4 modules in main process**

In `src/main/index.ts`, add after existing daemon/stats/notify initialization:

```typescript
// --- Phase 4: Agent Orchestration ---
import { TaskQueue } from './task-queue';
import { ContextShare } from './context-share';
import { AgentWatchdog } from './agent-watchdog';
import { EmbeddedBrowser } from './embedded-browser';

const taskQueue = new TaskQueue();
const contextShare = new ContextShare();
const watchdog = new AgentWatchdog({ checkIntervalMs: 30_000, unhealthyThreshold: 20 });
const embeddedBrowser = new EmbeddedBrowser(mainWindow!);

// Load persisted data
try {
  const savedTasks = db.loadTasks();
  for (const task of savedTasks) {
    // Re-hydrate into taskQueue internal map via enqueue + manual state restore
  }
} catch { /* ignore */ }

// Wire watchdog events
watchdog.on('agent-unhealthy', (event: any) => {
  log.info(`[watchdog] Agent ${event.agentId} unhealthy: score ${event.health}`);
  mainWindow?.webContents.send('agent-unhealthy', event);
});

watchdog.on('agent-restart', async (event: any) => {
  log.info(`[watchdog] Auto-restarting ${event.agentId}`);
  try {
    await daemonClient.killSession(event.sessionId);
  } catch (err) {
    log.error(`[watchdog] Restart failed:`, err);
  }
});

// Cleanup on quit
app.on('before-quit', () => {
  watchdog.stop();
  embeddedBrowser.destroyAll();
});
```

- [ ] **Step 2: Add panel state and keyboard shortcuts to App.tsx**

In `src/renderer/App.tsx`, add state variables:

```typescript
const [showTasks, setShowTasks] = useState(false);
const [showContext, setShowContext] = useState(false);
```

Add keyboard shortcut handlers (in the existing `useEffect` keyboard listener):

```typescript
if (e.ctrlKey && e.key === 't') { e.preventDefault(); setShowTasks(v => !v); }
if (e.ctrlKey && e.key === 'g') { e.preventDefault(); setShowContext(v => !v); }
```

Add panels to JSX (after the existing `<NotifyPanel />`):

```tsx
<TaskPanel visible={showTasks} onClose={() => setShowTasks(false)} />
<ContextFeed visible={showContext} onClose={() => setShowContext(false)} />
<BrowserPanel sessionId={panels[activeIdx]?.ptyId} />
```

- [ ] **Step 3: Add Sidebar buttons**

In `src/renderer/components/Sidebar.tsx`, add new props and buttons:

```typescript
// Add to Props interface:
onShowTasks?: () => void;
onShowContext?: () => void;

// Add buttons after the existing Dashboard/Notify buttons:
{onShowTasks && (
  <button onClick={onShowTasks} style={{
    flex:1, background:'var(--canvas-soft)', border:'1px solid var(--hairline)', borderRadius:3,
    color:'var(--body)', cursor:'pointer', padding:'3px 0', fontSize:10, fontFamily:'var(--font-sans)',
  }}>📋 Tasks</button>
)}
{onShowContext && (
  <button onClick={onShowContext} style={{
    flex:1, background:'var(--canvas-soft)', border:'1px solid var(--hairline)', borderRadius:3,
    color:'var(--body)', cursor:'pointer', padding:'3px 0', fontSize:10, fontFamily:'var(--font-sans)',
  }}>💬 Context</button>
)}
```

And pass the new props from App.tsx Sidebar usage:

```tsx
<Sidebar
  // ... existing props
  onShowTasks={() => setShowTasks(true)}
  onShowContext={() => setShowContext(true)}
/>
```

- [ ] **Step 4: Verify full build**

Run: `npm run build`
Expected: Build succeeds — daemon + Electron

- [ ] **Step 5: Run all tests**

Run: `npx vitest run`
Expected: All 46+ tests passing (20 existing + 26 new)

- [ ] **Step 6: Commit**

```bash
git add src/main/index.ts src/renderer/App.tsx src/renderer/components/Sidebar.tsx
git commit -m "feat(phase4): integrate task queue, context sharing, watchdog, and browser

- Wire TaskQueue, ContextShare, AgentWatchdog, EmbeddedBrowser into main process
- Add TaskPanel, ContextFeed, BrowserPanel to App with keyboard shortcuts
- Add Tasks and Context buttons to Sidebar
- Ctrl+T: toggle Task Queue, Ctrl+G: toggle Context Feed

Co-Authored-By: Claude <noreply@anthropic.com>"
```

---

## Phase 4 Completion Checklist

- [ ] Agent Protocol: types defined, PTY marker parsing, OSC parse/serialize round-trip
- [ ] agents.json: `capabilities` field on all agents
- [ ] TaskQueue: enqueue, route by capabilities, progress tracking, SQLite persistence
- [ ] TaskPanel: create task form, filterable list, progress bars, keyboard shortcut (Ctrl+T)
- [ ] ContextShare: publish, search by tags/type, mark consumed, SQLite persistence
- [ ] ContextFeed: real-time entry stream, searchable, tag/type badges (Ctrl+G)
- [ ] AgentWatchdog: health monitoring, unhealthy detection, auto-restart events
- [ ] EmbeddedBrowser: BrowserView create/navigate/evaluate/screenshot/destroy
- [ ] BrowserPanel: per-session URL bar, open/destroy controls
- [ ] Integration: all modules initialized, panels accessible, clean shutdown
- [ ] 26 new unit tests, all passing
- [ ] Full build (daemon + Electron) succeeds

### New Keyboard Shortcuts

| Shortcut | Action |
|----------|--------|
| Ctrl+D | Dashboard (existing) |
| **Ctrl+T** | Task Queue panel |
| **Ctrl+G** | Context Feed panel |
| Ctrl+N | New Terminal (existing) |
| Ctrl+W | Kill current (existing) |
