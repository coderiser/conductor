/**
 * US-04: Agent Context Sharing
 *
 * User Stories: CS-1 ~ CS-4
 *   CS-1: Agent shares findings so others don't duplicate work
 *   CS-2: User sees real-time feed of shared context
 *   CS-3: User can search context by title or tag
 *   CS-4: Agent can mark context as consumed
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { ContextShare } from '../../src/main/context-share';

describe('US-04: Agent Context Sharing', () => {
  let ctx: ContextShare;

  beforeEach(() => { ctx = new ContextShare(); });

  // ── CS-1: Agent publishes findings ────────────────────────────────────────

  describe('CS-1: Agent shares findings with other agents', () => {
    it('should publish context entry with unique ctx-* id', () => {
      const entry = ctx.publish('S-1', 'claude', {
        contextType: 'finding',
        title: 'SQL injection in auth.ts',
        body: 'Found at line 42, parameter `username` is not sanitized',
        tags: ['security', 'critical'],
        priority: 'high',
      });

      expect(entry.id).toMatch(/^ctx-/);
      expect(entry.sessionId).toBe('S-1');
      expect(entry.agentId).toBe('claude');
      expect(entry.contextType).toBe('finding');
      expect(entry.title).toBe('SQL injection in auth.ts');
      expect(entry.consumed).toBe(false);
      expect(entry.timestamp).toBeGreaterThan(0);
    });

    it('should support all 5 context types', () => {
      const types = ['summary', 'finding', 'file-diff', 'code-snippet', 'link'] as const;
      for (const type of types) {
        const entry = ctx.publish('S-1', 'claude', {
          contextType: type,
          title: `${type} entry`,
          body: 'body',
          tags: [],
          priority: 'normal',
        });
        expect(entry.contextType).toBe(type);
      }
    });

    it('should allow multiple agents to publish to the same feed', () => {
      const e1 = ctx.publish('S-1', 'claude', {
        contextType: 'finding', title: 'Bug A', body: '', tags: [], priority: 'normal',
      });
      const e2 = ctx.publish('S-2', 'opencode', {
        contextType: 'finding', title: 'Bug B', body: '', tags: [], priority: 'normal',
      });

      const all = ctx.list();
      expect(all).toHaveLength(2);
      expect(all.some(e => e.id === e1.id)).toBe(true);
      expect(all.some(e => e.id === e2.id)).toBe(true);
    });
  });

  // ── CS-2: Real-time feed ──────────────────────────────────────────────────

  describe('CS-2: Real-time context feed', () => {
    it('should list entries sorted by timestamp descending (newest first)', () => {
      ctx.publish('S-1', 'claude', { contextType: 'finding', title: 'First', body: '', tags: [], priority: 'normal' });
      // Small delay to ensure different timestamps
      ctx.publish('S-1', 'claude', { contextType: 'finding', title: 'Second', body: '', tags: [], priority: 'normal' });
      ctx.publish('S-2', 'opencode', { contextType: 'summary', title: 'Third', body: '', tags: [], priority: 'normal' });

      const entries = ctx.list();
      expect(entries.length).toBe(3);
      // Newest first
      for (let i = 0; i < entries.length - 1; i++) {
        expect(entries[i].timestamp).toBeGreaterThanOrEqual(entries[i + 1].timestamp);
      }
    });

    it('should filter by session for per-session views', () => {
      ctx.publish('S-1', 'claude', { contextType: 'finding', title: 'For S-1', body: '', tags: [], priority: 'normal' });
      ctx.publish('S-2', 'opencode', { contextType: 'finding', title: 'For S-2', body: '', tags: [], priority: 'normal' });
      ctx.publish('S-1', 'claude', { contextType: 'summary', title: 'Also S-1', body: '', tags: [], priority: 'normal' });

      const s1Entries = ctx.listForSession('S-1');
      expect(s1Entries).toHaveLength(2);
      expect(s1Entries.every(e => e.sessionId === 'S-1')).toBe(true);

      const s2Entries = ctx.listForSession('S-2');
      expect(s2Entries).toHaveLength(1);
    });
  });

  // ── CS-3: Search by title or tag ──────────────────────────────────────────

  describe('CS-3: Search context by title or tag', () => {
    beforeEach(() => {
      ctx.publish('S-1', 'claude', {
        contextType: 'finding', title: 'Auth bug',
        body: 'Login issue', tags: ['security', 'auth'], priority: 'high',
      });
      ctx.publish('S-2', 'opencode', {
        contextType: 'code-snippet', title: 'API pattern',
        body: 'REST best practice', tags: ['api', 'pattern'], priority: 'normal',
      });
      ctx.publish('S-3', 'codex', {
        contextType: 'finding', title: 'Performance issue',
        body: 'Slow query', tags: ['performance', 'database'], priority: 'high',
      });
    });

    it('should search by contextType', () => {
      const findings = ctx.search({ contextType: 'finding' });
      expect(findings).toHaveLength(2);
      expect(findings.every(e => e.contextType === 'finding')).toBe(true);
    });

    it('should search by tags (any match)', () => {
      const security = ctx.search({ tags: ['security'] });
      expect(security).toHaveLength(1);
      expect(security[0].title).toBe('Auth bug');
    });

    it('should search by multiple tags (OR logic)', () => {
      const results = ctx.search({ tags: ['security', 'performance'] });
      expect(results).toHaveLength(2);
    });

    it('should search by sessionId', () => {
      const results = ctx.search({ sessionId: 'S-2' });
      expect(results).toHaveLength(1);
      expect(results[0].title).toBe('API pattern');
    });

    it('should search by agentId', () => {
      const results = ctx.search({ agentId: 'claude' });
      expect(results).toHaveLength(1);
      expect(results[0].title).toBe('Auth bug');
    });

    it('should combine multiple filters', () => {
      const results = ctx.search({ contextType: 'finding', tags: ['security'] });
      expect(results).toHaveLength(1);
      expect(results[0].title).toBe('Auth bug');
    });

    it('should return empty for non-matching filter', () => {
      const results = ctx.search({ tags: ['nonexistent'] });
      expect(results).toHaveLength(0);
    });
  });

  // ── CS-4: Mark context as consumed ────────────────────────────────────────

  describe('CS-4: Mark context as consumed', () => {
    it('should mark entry as consumed', () => {
      const entry = ctx.publish('S-1', 'claude', {
        contextType: 'finding', title: 'Known issue',
        body: 'Being tracked', tags: [], priority: 'normal',
      });

      expect(ctx.get(entry.id)!.consumed).toBe(false);

      ctx.markConsumed(entry.id);
      expect(ctx.get(entry.id)!.consumed).toBe(true);
    });

    it('should filter consumed vs unconsumed', () => {
      const e1 = ctx.publish('S-1', 'claude', {
        contextType: 'finding', title: 'Read', body: '', tags: [], priority: 'normal',
      });
      ctx.publish('S-1', 'claude', {
        contextType: 'finding', title: 'Unread', body: '', tags: [], priority: 'normal',
      });

      ctx.markConsumed(e1.id);

      const unconsumed = ctx.search({ consumed: false });
      expect(unconsumed).toHaveLength(1);
      expect(unconsumed[0].title).toBe('Unread');

      const consumed = ctx.search({ consumed: true });
      expect(consumed).toHaveLength(1);
      expect(consumed[0].title).toBe('Read');
    });

    it('should handle markConsumed on unknown id gracefully', () => {
      // Should not throw
      ctx.markConsumed('ctx-nonexistent');
    });
  });
});
