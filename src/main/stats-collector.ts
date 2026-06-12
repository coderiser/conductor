// src/main/stats-collector.ts
// Tracks per-agent token usage, cost, health score, and status.
// Runs in the Electron main process. Data persisted to SQLite on exit.

import { AgentStats, calculateHealth, estimateCost, AGENT_PRICING } from '../common/stats-types';

const MAX_HISTORY = 36;  // 30 min at ~50s intervals
const TOKEN_SAMPLE_INTERVAL = 50_000; // 50s

export class StatsCollector {
  private sessions = new Map<string, AgentStats>();
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
    return result;
  }

  /** Get aggregate totals across all sessions */
  getTotals(): { tokens: number; cost: number; running: number; failed: number } {
    let tokens = 0, cost = 0, running = 0, failed = 0;
    for (const [, s] of this.sessions) {
      tokens += s.tokenCount;
      cost += s.estimatedCost;
      if (s.status !== 'done' && s.status !== 'error') running++;
      if (s.status === 'error') failed++;
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
