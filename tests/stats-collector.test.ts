import { describe, it, expect, beforeEach } from 'vitest';
import { StatsCollector } from '../src/main/stats-collector';

describe('StatsCollector', () => {
  let collector: StatsCollector;

  beforeEach(() => {
    collector = new StatsCollector();
  });

  it('should track a new agent session', () => {
    collector.trackSession('S1', 'claude', 'E:\\workspace\\test');
    const stats = collector.getStats('S1');
    expect(stats).toBeDefined();
    expect(stats!.agentId).toBe('claude');
    expect(stats!.sessionId).toBe('S1');
    expect(stats!.tokenCount).toBe(0);
    expect(stats!.healthScore).toBe(100);
    expect(stats!.status).toBe('starting');
  });

  it('should update token count and compute cost', () => {
    collector.trackSession('S1', 'claude', '.');
    collector.updateTokens('S1', 45200);
    const stats = collector.getStats('S1');
    expect(stats!.tokenCount).toBe(45200);
    expect(stats!.estimatedCost).toBeGreaterThan(0);
  });

  it('should update status and lastActivity', () => {
    collector.trackSession('S1', 'claude', '.');
    const before = collector.getStats('S1')!.lastActivity;
    collector.updateStatus('S1', 'thinking');
    const after = collector.getStats('S1')!.lastActivity;
    expect(after).toBeGreaterThanOrEqual(before);
    expect(collector.getStats('S1')!.status).toBe('thinking');
  });

  it('should compute token rate >= 0', () => {
    collector.trackSession('S1', 'claude', '.');
    collector.updateTokens('S1', 1000);
    const stats = collector.getStats('S1');
    expect(stats!.tokenRate).toBeGreaterThanOrEqual(0);
  });

  it('should remove session on untrack', () => {
    collector.trackSession('S1', 'claude', '.');
    collector.untrackSession('S1');
    expect(collector.getStats('S1')).toBeUndefined();
  });

  it('should return all stats', () => {
    collector.trackSession('S1', 'claude', '.');
    collector.trackSession('S2', 'opencode', '.');
    const all = collector.getAllStats();
    expect(all.length).toBe(2);
  });

  it('should increment error count and reduce health', () => {
    collector.trackSession('S1', 'claude', '.');
    collector.recordError('S1');
    collector.recordError('S1');
    const stats = collector.getStats('S1');
    expect(stats!.errorCount).toBe(2);
    expect(stats!.healthScore).toBeLessThan(100);
  });

  it('should calculate health based on idle time', () => {
    collector.trackSession('S1', 'claude', '.');
    const stats = collector.getStats('S1')!;
    stats.lastActivity = Date.now() - 360_000; // 6 min ago
    const health = collector.getStats('S1')!.healthScore;
    expect(health).toBeLessThan(100);
  });

  it('should return empty array when no sessions', () => {
    expect(collector.getAllStats()).toEqual([]);
  });

  it('should return totals across all sessions', () => {
    collector.trackSession('S1', 'claude', '.');
    collector.trackSession('S2', 'opencode', '.');
    collector.updateTokens('S1', 10000);
    collector.updateTokens('S2', 5000);
    collector.updateStatus('S1', 'running');
    collector.updateStatus('S2', 'error');
    const totals = collector.getTotals();
    expect(totals.tokens).toBe(15000);
    expect(totals.running).toBe(1);
    expect(totals.failed).toBe(1);
    expect(totals.cost).toBeGreaterThan(0);
  });

  it('should restore historical sessions into getAllStats', () => {
    collector.restoreHistorical([
      {
        session_id: 'OLD1', agent: 'claude', token_count: 100000,
        estimated_cost: 0.5, health_score: 90, status: 'done',
        error_count: 0, started_at: '2026-06-10T10:00:00.000Z',
        last_activity: '2026-06-10T10:30:00.000Z',
      },
    ]);
    const all = collector.getAllStats();
    expect(all.length).toBe(1);
    expect(all[0].sessionId).toBe('OLD1');
    expect(all[0].tokenCount).toBe(100000);
    expect(all[0].status).toBe('done');
  });

  it('should include historical tokens/cost in totals but not running', () => {
    collector.restoreHistorical([
      {
        session_id: 'OLD1', agent: 'claude', token_count: 100000,
        estimated_cost: 0.5, health_score: 90, status: 'done',
        error_count: 0, started_at: '2026-06-10T10:00:00.000Z',
        last_activity: '2026-06-10T10:30:00.000Z',
      },
    ]);
    collector.trackSession('S1', 'claude', '.');
    collector.updateTokens('S1', 20000);

    const totals = collector.getTotals();
    expect(totals.tokens).toBe(120000); // 100000 historical + 20000 live
    expect(totals.running).toBe(1);     // only live S1 counts
    expect(totals.failed).toBe(0);
  });

  it('should let a live session supersede a same-id historical entry', () => {
    collector.restoreHistorical([
      {
        session_id: 'S1', agent: 'claude', token_count: 80000,
        estimated_cost: 0.4, health_score: 90, status: 'done',
        error_count: 0, started_at: '2026-06-10T10:00:00.000Z',
        last_activity: '2026-06-10T10:30:00.000Z',
      },
    ]);
    collector.trackSession('S1', 'claude', '.');

    const all = collector.getAllStats();
    const s1s = all.filter(s => s.sessionId === 'S1');
    expect(s1s.length).toBe(1);            // live wins, historical not duplicated
    expect(s1s[0].tokenCount).toBe(0);     // live entry starts fresh

    const totals = collector.getTotals();
    expect(totals.tokens).toBe(0);         // historical S1 excluded (now live)
  });
});
