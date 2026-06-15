import { describe, it, expect, beforeEach } from 'vitest';
import { ContextShare } from '../src/main/context-share';
import type { ContextEntry } from '../src/common/stats-types';

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

  // ── Reload on startup (Gap 1) ─────────────────────────────────────────────
  it('should restore previously-persisted entries so history survives restart', () => {
    const persisted: ContextEntry[] = [
      { id: 'ctx-old1', sessionId: 'S1', agentId: 'claude', contextType: 'summary', title: 'Old finding', body: 'historical', tags: ['review'], priority: 'normal', timestamp: 1000, consumed: false },
      { id: 'ctx-old2', sessionId: 'S2', agentId: 'codex', contextType: 'task-summary', title: 'Old task', body: 'done', tags: ['task'], priority: 'high', timestamp: 2000, consumed: true },
    ];
    ctx.restore(persisted);
    // Restored entries appear in list → ctx_list returns history across restarts
    expect(ctx.list().length).toBe(2);
    expect(ctx.get('ctx-old1')!.title).toBe('Old finding');
    // Consumed state is preserved across reload
    expect(ctx.get('ctx-old2')!.consumed).toBe(true);
  });

  // ── Task producer (Gap 2) ─────────────────────────────────────────────────
  it('should produce a normal task-summary entry on task completion', () => {
    // Mirrors the task_complete IPC handler's publish call exactly.
    const task = { assignedSession: 'S1', assignedAgent: 'claude', title: 'Fix bug' };
    const entry = ctx.publish(task.assignedSession || '', task.assignedAgent || '', {
      contextType: 'task-summary',
      title: `Task done: ${task.title}`,
      body: 'patch applied',
      tags: ['task', 'complete'],
      priority: 'normal',
    });
    expect(entry.contextType).toBe('task-summary');
    expect(entry.title).toBe('Task done: Fix bug');
    expect(entry.tags).toEqual(['task', 'complete']);
    expect(entry.priority).toBe('normal');
    expect(entry.sessionId).toBe('S1');
  });

  it('should produce a high-priority task-error entry on task failure', () => {
    const task = { assignedSession: 'S2', assignedAgent: 'codex', title: 'Deploy' };
    const entry = ctx.publish(task.assignedSession || '', task.assignedAgent || '', {
      contextType: 'task-error',
      title: `Task failed: ${task.title}`,
      body: 'connection refused',
      tags: ['task', 'failed'],
      priority: 'high',
    });
    expect(entry.contextType).toBe('task-error');
    expect(entry.priority).toBe('high');
    expect(entry.body).toBe('connection refused');
  });
});
