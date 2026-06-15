// src/main/stats-collector.ts
// Tracks per-agent token usage, cost, health score, and status.
// Runs in the Electron main process. Data persisted to SQLite on exit.

import { AgentStats, calculateHealth, estimateCost, AGENT_PRICING } from '../common/stats-types';

const MAX_HISTORY = 36;  // 30 min at ~50s intervals
const TOKEN_SAMPLE_INTERVAL = 50_000; // 50s

/** Shape of a persisted agent_stats row, loaded from SQLite on startup. */
export interface AgentStatsHistoryRow {
  session_id: string;
  agent: string;
  token_count: number;
  estimated_cost: number;
  health_score: number;
  status: string;
  error_count: number;
  started_at: string;
  last_activity: string;
}

const VALID_STATUSES = new Set(['starting', 'running', 'thinking', 'waiting', 'error', 'done']);

export class StatsCollector {
  private sessions = new Map<string, AgentStats>();
  private historical: AgentStats[] = [];
  private sampleTimers = new Map<string, ReturnType<typeof setInterval>>();

  trackSession(sessionId: string, agentId: string, cwd: string): void {
    const pricing = AGENT_PRICING[agentId];
    const stats: AgentStats = {
      sessionId,
      agentId,
      agentType: agentId,
      status: 'starting',
      tokenCount: 0,
      tokenRate: 0,
      tokenHistory: [],
      estimatedCost: 0,
      costModel: pricing ? agentId : 'unknown',
      healthScore: 100,
      lastActivity: Date.now(),
      startTime: Date.now(),
      errorCount: 0,
      respawnCount: 0,
      cwd,
    };
    this.sessions.set(sessionId, stats);

    // Start periodic token rate sampling
    const timer = setInterval(() => this.sampleTokens(sessionId), TOKEN_SAMPLE_INTERVAL);
    this.sampleTimers.set(sessionId, timer);
  }

  untrackSession(sessionId: string): void {
    this.sessions.delete(sessionId);
    const timer = this.sampleTimers.get(sessionId);
    if (timer) {
      clearInterval(timer);
      this.sampleTimers.delete(sessionId);
    }
  }

  updateTokens(sessionId: string, count: number): void {
    const stats = this.sessions.get(sessionId);
    if (!stats) return;
    stats.tokenCount = Math.max(stats.tokenCount, count);
    stats.estimatedCost = estimateCost(stats.agentId, stats.tokenCount);
    stats.lastActivity = Date.now();
  }

  updateStatus(sessionId: string, status: AgentStats['status']): void {
    const stats = this.sessions.get(sessionId);
    if (!stats) return;
    stats.status = status;
    stats.lastActivity = Date.now();
    if (status === 'error') stats.errorCount++;
    stats.healthScore = calculateHealth(stats);
  }

  recordError(sessionId: string): void {
    const stats = this.sessions.get(sessionId);
    if (!stats) return;
    stats.errorCount++;
    stats.healthScore = calculateHealth(stats);
  }

  recordRespawn(sessionId: string): void {
    const stats = this.sessions.get(sessionId);
    if (!stats) return;
    stats.respawnCount++;
    stats.healthScore = calculateHealth(stats);
  }

  /**
   * Load persisted stats from SQLite on startup. Historical sessions that are
   * not currently live appear in getAllStats()/getTotals() so the Dashboard
   * retains token/cost history across restarts. Live sessions resumed this run
   * (same sessionId) take precedence — their historical row is excluded to
   * avoid double-counting. Replaces any previously restored history.
   */
  restoreHistorical(rows: AgentStatsHistoryRow[]): void {
    this.historical = rows.map(r => ({
      sessionId: r.session_id,
      agentId: r.agent,
      agentType: r.agent,
      status: (VALID_STATUSES.has(r.status) ? r.status : 'done') as AgentStats['status'],
      tokenCount: r.token_count || 0,
      tokenRate: 0,
      tokenHistory: [],
      estimatedCost: r.estimated_cost || 0,
      costModel: r.agent,
      healthScore: typeof r.health_score === 'number' ? r.health_score : 100,
      lastActivity: Date.parse(r.last_activity) || Date.now(),
      startTime: Date.parse(r.started_at) || Date.now(),
      errorCount: r.error_count || 0,
      respawnCount: 0,
      cwd: '',
    }));
  }

  getStats(sessionId: string): AgentStats | undefined {
    const stats = this.sessions.get(sessionId);
    if (!stats) return undefined;
    // Recompute health on every read (idle time changes continuously)
    stats.healthScore = calculateHealth(stats);
    return stats;
  }

  getAllStats(): AgentStats[] {
    const result: AgentStats[] = [];
    for (const [id] of this.sessions) {
      const s = this.getStats(id);
      if (s) result.push(s);
    }
    // Append historical snapshots that are not currently live.
    const liveIds = new Set(this.sessions.keys());
    for (const h of this.historical) {
      if (!liveIds.has(h.sessionId)) result.push(h);
    }
    return result;
  }

  /** Get aggregate totals across all sessions */
  getTotals(): { tokens: number; cost: number; running: number; failed: number } {
    let tokens = 0, cost = 0, running = 0, failed = 0;
    const liveIds = new Set(this.sessions.keys());
    for (const [, s] of this.sessions) {
      tokens += s.tokenCount;
      cost += s.estimatedCost;
      if (s.status !== 'done' && s.status !== 'error') running++;
      if (s.status === 'error') failed++;
    }
    // Cumulative tokens/cost from historical (non-live) sessions.
    // running/failed stay live-only — they describe the current run.
    for (const h of this.historical) {
      if (liveIds.has(h.sessionId)) continue;
      tokens += h.tokenCount;
      cost += h.estimatedCost;
    }
    return { tokens, cost, running, failed };
  }

  /** Clean up all timers (call on app exit) */
  dispose(): void {
    for (const [, timer] of this.sampleTimers) {
      clearInterval(timer);
    }
    this.sampleTimers.clear();
  }

  private sampleTokens(sessionId: string): void {
    const stats = this.sessions.get(sessionId);
    if (!stats) return;

    const now = Date.now();
    stats.tokenHistory.push({ ts: now, count: stats.tokenCount });

    // Keep only last 30 min
    const cutoff = now - 30 * 60 * 1000;
    stats.tokenHistory = stats.tokenHistory.filter(h => h.ts > cutoff).slice(-MAX_HISTORY);

    // Compute rate: tokens per minute over the history window
    if (stats.tokenHistory.length >= 2) {
      const first = stats.tokenHistory[0];
      const last = stats.tokenHistory[stats.tokenHistory.length - 1];
      const elapsedMin = (last.ts - first.ts) / 60_000;
      if (elapsedMin > 0) {
        stats.tokenRate = Math.round((last.count - first.count) / elapsedMin);
      }
    }
  }
}
