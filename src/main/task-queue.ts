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
      if (!task.requiredCapabilities.every(c => agent.capabilities.includes(c as AgentCapability))) continue;

      const score = agent.capabilities.length;
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
