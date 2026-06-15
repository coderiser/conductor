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
    // Both match, agent-b has more total capabilities
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
    const _t2 = queue.enqueue({ title: 'B', description: '', priority: 'low', requiredCapabilities: ['shell'] });
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

  it('should record worktree path on dispatch', () => {
    const task = queue.enqueue({
      title: 'Isolated task',
      description: '',
      priority: 'normal',
      requiredCapabilities: ['code-gen'],
    });
    queue.dispatch(task.id, 'S1', '/home/user/.conductor/worktrees/abc123/claude-20260612-a1b2');
    const t = queue.get(task.id);
    expect(t!.worktreePath).toBe('/home/user/.conductor/worktrees/abc123/claude-20260612-a1b2');
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
