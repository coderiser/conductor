/**
 * US-03: Task Submission and Smart Routing
 *
 * User Stories: TQ-1 ~ TQ-4
 *   TQ-1: User submits task with required capabilities → auto-routed
 *   TQ-2: System picks agent with most matching capabilities
 *   TQ-3: Task progress visible in real-time
 *   TQ-4: Tasks persist across restarts
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { TaskQueue } from '../../src/main/task-queue';
import type { AgentCapability } from '../../src/common/agent-protocol';

const AGENTS = [
  { id: 'cmd', capabilities: ['shell', 'file-ops'] as AgentCapability[] },
  { id: 'claude', capabilities: ['code-gen', 'code-review', 'debugging', 'shell', 'file-ops', 'web'] as AgentCapability[] },
  { id: 'opencode', capabilities: ['code-gen', 'code-review', 'shell', 'file-ops'] as AgentCapability[] },
  { id: 'codex', capabilities: ['code-gen', 'shell', 'file-ops'] as AgentCapability[] },
];

describe('US-03: Task Submission and Smart Routing', () => {
  let queue: TaskQueue;

  beforeEach(() => { queue = new TaskQueue(); });

  // ── TQ-1: Submit task → auto-route ───────────────────────────────────────

  describe('TQ-1: Task submission generates ID and auto-routes', () => {
    it('should generate task-* id with status=pending and progress=0', () => {
      const task = queue.enqueue({
        title: 'Fix login bug',
        description: 'Users report timeout on mobile',
        priority: 'high',
        requiredCapabilities: ['debugging'],
      });

      expect(task.id).toMatch(/^task-/);
      expect(task.status).toBe('pending');
      expect(task.progress).toBe(0);
      expect(task.createdAt).toBeGreaterThan(0);
      expect(task.title).toBe('Fix login bug');
    });

    it('should route to the only agent with required capability', () => {
      const task = queue.enqueue({
        title: 'Debug memory leak',
        description: '',
        priority: 'high',
        requiredCapabilities: ['debugging'],
      });

      // Only claude has 'debugging'
      const routed = queue.tryRoute(task.id, AGENTS);
      expect(routed).toBe('claude');
      expect(queue.get(task.id)!.status).toBe('queued');
      expect(queue.get(task.id)!.assignedAgent).toBe('claude');
    });

    it('should return null when no agent has all required capabilities', () => {
      const task = queue.enqueue({
        title: 'Browse and debug web app',
        description: '',
        priority: 'normal',
        requiredCapabilities: ['web', 'debugging'], // only claude has both
      });

      const routed = queue.tryRoute(task.id, [
        { id: 'cmd', capabilities: ['shell'] as AgentCapability[] },
        { id: 'codex', capabilities: ['code-gen', 'shell'] as AgentCapability[] },
      ]);
      expect(routed).toBeNull();
      expect(queue.get(task.id)!.status).toBe('pending'); // stays pending
    });
  });

  // ── TQ-2: Best-fit routing ────────────────────────────────────────────────

  describe('TQ-2: Route picks agent with most capabilities', () => {
    it('should prefer claude (6 caps) over opencode (4 caps) when both match', () => {
      const task = queue.enqueue({
        title: 'Build API endpoint',
        description: '',
        priority: 'normal',
        requiredCapabilities: ['code-gen', 'shell'],
      });

      const routed = queue.tryRoute(task.id, AGENTS);
      // claude: 6 caps, opencode: 4 caps, codex: 3 caps — all match, claude wins
      expect(routed).toBe('claude');
    });

    it('should route shell-only task to any agent but prefer most capable', () => {
      const task = queue.enqueue({
        title: 'Run tests',
        description: '',
        priority: 'low',
        requiredCapabilities: ['shell'],
      });

      const routed = queue.tryRoute(task.id, AGENTS);
      // All except cmd have 'shell', claude has most total caps
      expect(routed).toBe('claude');
    });

    it('should route to cmd when only shell+file-ops needed and claude unavailable', () => {
      const task = queue.enqueue({
        title: 'List files',
        description: '',
        priority: 'low',
        requiredCapabilities: ['shell', 'file-ops'],
      });

      // Without claude in the pool
      const routed = queue.tryRoute(task.id, [
        { id: 'cmd', capabilities: ['shell', 'file-ops'] as AgentCapability[] },
        { id: 'codex', capabilities: ['code-gen', 'shell', 'file-ops'] as AgentCapability[] },
      ]);
      // codex has 3 caps vs cmd's 2
      expect(routed).toBe('codex');
    });
  });

  // ── TQ-3: Real-time progress tracking ────────────────────────────────────

  describe('TQ-3: Task progress visible in real-time', () => {
    it('should track task through full lifecycle: pending → queued → running → done', () => {
      const task = queue.enqueue({
        title: 'Implement feature',
        description: '',
        priority: 'high',
        requiredCapabilities: ['code-gen'],
      });
      expect(queue.get(task.id)!.status).toBe('pending');

      queue.tryRoute(task.id, AGENTS);
      expect(queue.get(task.id)!.status).toBe('queued');

      queue.dispatch(task.id, 'S-123', '/path/to/worktree');
      const running = queue.get(task.id)!;
      expect(running.status).toBe('running');
      expect(running.assignedSession).toBe('S-123');
      expect(running.worktreePath).toBe('/path/to/worktree');
      expect(running.startedAt).toBeGreaterThan(0);

      queue.updateProgress(task.id, 0.5, 'Half done');
      expect(queue.get(task.id)!.progress).toBe(0.5);

      queue.complete(task.id, 'Feature implemented');
      const done = queue.get(task.id)!;
      expect(done.status).toBe('done');
      expect(done.progress).toBe(1);
      expect(done.result).toBe('Feature implemented');
      expect(done.completedAt).toBeGreaterThan(0);
    });

    it('should track task failure with error message', () => {
      const task = queue.enqueue({
        title: 'Deploy to prod',
        description: '',
        priority: 'high',
        requiredCapabilities: ['shell'],
      });

      queue.dispatch(task.id, 'S-FAIL');
      queue.fail(task.id, 'SSH connection refused');

      const failed = queue.get(task.id)!;
      expect(failed.status).toBe('failed');
      expect(failed.error).toBe('SSH connection refused');
      expect(failed.completedAt).toBeGreaterThan(0);
    });

    it('should list tasks filtered by status', () => {
      const t1 = queue.enqueue({ title: 'A', description: '', priority: 'high', requiredCapabilities: ['shell'] });
      const t2 = queue.enqueue({ title: 'B', description: '', priority: 'normal', requiredCapabilities: ['shell'] });
      const t3 = queue.enqueue({ title: 'C', description: '', priority: 'low', requiredCapabilities: ['shell'] });

      queue.dispatch(t1.id, 'S1');
      queue.complete(t1.id, 'done');
      queue.dispatch(t2.id, 'S2');

      expect(queue.list('done')).toHaveLength(1);
      expect(queue.list('running')).toHaveLength(1);
      expect(queue.list('pending')).toHaveLength(1);
      expect(queue.list()).toHaveLength(3);
    });

    it('should compute stats by status and priority', () => {
      queue.enqueue({ title: 'H1', description: '', priority: 'high', requiredCapabilities: [] });
      queue.enqueue({ title: 'H2', description: '', priority: 'high', requiredCapabilities: [] });
      queue.enqueue({ title: 'N1', description: '', priority: 'normal', requiredCapabilities: [] });
      queue.enqueue({ title: 'L1', description: '', priority: 'low', requiredCapabilities: [] });

      const stats = queue.stats();
      expect(stats.total).toBe(4);
      expect(stats.pending).toBe(4);
      expect(stats.byPriority.high).toBe(2);
      expect(stats.byPriority.normal).toBe(1);
      expect(stats.byPriority.low).toBe(1);
    });
  });

  // ── TQ-4: Task persistence ────────────────────────────────────────────────

  describe('TQ-4: Tasks can be persisted (SQLite integration point)', () => {
    it('should expose all task fields needed for SQLite serialization', () => {
      const task = queue.enqueue({
        title: 'Persisted task',
        description: 'Should survive restart',
        priority: 'high',
        requiredCapabilities: ['code-gen', 'debugging'],
      });

      // All fields that would be saved to SQLite task_queue table
      expect(task.id).toBeTruthy();
      expect(task.title).toBeTruthy();
      expect(task.description).toBeTruthy();
      expect(task.priority).toBe('high');
      expect(Array.isArray(task.requiredCapabilities)).toBe(true);
      expect(task.requiredCapabilities).toEqual(['code-gen', 'debugging']);
      expect(task.status).toBe('pending');
      expect(task.progress).toBe(0);
      expect(task.createdAt).toBeGreaterThan(0);
    });
  });
});
