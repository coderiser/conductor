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
