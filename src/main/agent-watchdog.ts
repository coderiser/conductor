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
    const s = this.sessions.get(sessionId);
    if (s) s.lastActivity = Date.now();
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
