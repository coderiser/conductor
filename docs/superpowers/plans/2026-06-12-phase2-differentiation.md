# Phase 2 — 差异化能力 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build Agent 通知系统、健康评分、Token/Cost 统计、仪表盘 UI、崩溃自动恢复 — 将 Conductor 从"能用的终端管理器"升级为"智能 Agent 运维平台"。

**Architecture:** 新增 `StatsCollector`（主进程）集中管理每个 Agent 的 token/cost/health 数据，`NotifyCenter`（主进程）解析 PTY 输出生成通知，daemon 新增 `Watchdog` 监控进程健康。渲染进程新增 `AgentDashboard.tsx` 和 `NotifyPanel.tsx` 两个组件，Sidebar 增加 cost 行和通知角标。SQLite 新增 `agent_stats` 表持久化统计数据。

**Tech Stack:** TypeScript 5.x, better-sqlite3, Electron Notification API, vitest

---

## File Structure

```
NEW FILES:
  src/common/stats-types.ts        — AgentStats, Notification, HealthScore 类型 + 定价数据
  src/main/stats-collector.ts      — 每 Agent token/cost/health 追踪，定时刷新
  src/main/notify-center.ts        — PTY 输出解析 → 通知队列，Windows 原生通知
  src/main/agent-watchdog.ts       — Daemon 层进程健康监控（通过 IPC 与主进程协作）
  src/renderer/components/AgentDashboard.tsx — Agent 状态表格 + 健康指示灯 + Token 趋势
  src/renderer/components/NotifyPanel.tsx    — 通知列表 + Jump-to + Dismiss
  src/renderer/lib/format-utils.ts — formatCost(), formatTokens(), formatUptime()
  tests/stats-collector.test.ts    — StatsCollector 单元测试
  tests/notify-center.test.ts      — NotifyCenter 单元测试

MODIFIED FILES:
  src/main/database.ts             — 新增 agent_stats 表 + save/loadAgentStats
  src/main/ipc-handlers.ts         — 新增 get_agent_stats, get_notifications, dismiss_notification
  src/main/index.ts                — 初始化 StatsCollector + NotifyCenter，连接 daemon output
  src/preload/index.ts             — 新增 onNotification, getAgentStats 等 API
  src/renderer/global.d.ts         — 新增 ElectronAPI 类型
  src/renderer/App.tsx             — 集成 Dashboard/NotifyPanel，per-agent token 追踪
  src/renderer/components/Sidebar.tsx — Stats 区增加 Cost 行，Sessions 区增加通知角标
  src/daemon/server.ts             — 处理 stats-query / watchdog 消息
  src/daemon/protocol/messages.ts  — 新增 stats-update, agent-unhealthy 消息类型
  src/renderer/styles/tokens.css   — 新增通知面板/仪表盘 CSS 变量
```

---

### Task 1: 共享类型 + 定价数据

**Files:**
- Create: `src/common/stats-types.ts`

- [ ] **Step 1: Create stats-types.ts with all shared types and pricing**

```typescript
// src/common/stats-types.ts

/** Per-agent runtime statistics */
export interface AgentStats {
  sessionId: string;
  agentId: string;            // 'claude' | 'opencode' | 'codex' | 'cmd'
  agentType: string;          // display name
  status: 'starting' | 'running' | 'thinking' | 'waiting' | 'error' | 'done';

  // Token tracking
  tokenCount: number;
  tokenRate: number;           // tokens/min (computed over last 5min window)
  tokenHistory: { ts: number; count: number }[];  // last 30min of samples

  // Cost
  estimatedCost: number;       // USD
  costModel: string;           // e.g. 'claude-sonnet-4-20250514'

  // Health (0-100)
  healthScore: number;
  lastActivity: number;        // Date.now() timestamp
  startTime: number;           // Date.now() timestamp
  errorCount: number;
  respawnCount: number;

  // Session info
  cwd: string;
  branch?: string;
}

/** Notification levels */
export type NotificationLevel = 'info' | 'warning' | 'error' | 'success';

/** A single notification entry */
export interface AgentNotification {
  id: string;                  // auto-generated
  sessionId: string;
  agent: string;
  level: NotificationLevel;
  message: string;
  timestamp: number;
  dismissed: boolean;
}

/** Cost model pricing (USD per 1M tokens) */
export interface PricingEntry {
  inputPer1M: number;
  outputPer1M: number;
}

/** Known agent pricing (approximate, as of 2026-06) */
export const AGENT_PRICING: Record<string, PricingEntry> = {
  claude: { inputPer1M: 3.0, outputPer1M: 15.0 },      // Sonnet 4
  opencode: { inputPer1M: 3.0, outputPer1M: 15.0 },     // Default to Sonnet pricing
  codex: { inputPer1M: 2.5, outputPer1M: 10.0 },        // o4-mini approx
  cmd: { inputPer1M: 0, outputPer1M: 0 },               // Free
};

/** Attention patterns for notification trigger */
export const ATTENTION_PATTERNS: { pattern: RegExp; level: NotificationLevel; label: string }[] = [
  { pattern: /needs?\s+input/i, level: 'warning', label: 'Needs input' },
  { pattern: /permission/i, level: 'warning', label: 'Permission required' },
  { pattern: /approval/i, level: 'warning', label: 'Approval required' },
  { pattern: /confirm/i, level: 'warning', label: 'Confirmation needed' },
  { pattern: /y\/n/i, level: 'warning', label: 'Waiting for response' },
  { pattern: /press any key/i, level: 'warning', label: 'Waiting for keypress' },
  { pattern: /waiting for/i, level: 'warning', label: 'Waiting' },
  { pattern: /error:|failed:|exception:/i, level: 'error', label: 'Error detected' },
  { pattern: /completed|done|finished|success/i, level: 'success', label: 'Task completed' },
];

/** Health score thresholds */
export const HEALTH_THRESHOLDS = {
  EXCELLENT: 80,
  GOOD: 60,
  FAIR: 40,
  POOR: 20,
  // Below POOR = critical, may need auto-restart
};

/** Calculate health score from agent stats */
export function calculateHealth(stats: AgentStats): number {
  let score = 100;

  // Error rate penalty (each error -5, max -30)
  score -= Math.min(stats.errorCount * 5, 30);

  // Idle penalty
  const idleSeconds = (Date.now() - stats.lastActivity) / 1000;
  if (idleSeconds > 300) score -= 15;    // 5min idle
  if (idleSeconds > 600) score -= 20;    // 10min idle
  if (idleSeconds > 1800) score -= 15;   // 30min idle

  // Respawn penalty
  score -= Math.min(stats.respawnCount * 10, 30);

  return Math.max(0, Math.min(100, score));
}

/** Estimate cost from token count (simple: assume 60% input / 40% output split) */
export function estimateCost(agentId: string, tokenCount: number): number {
  const pricing = AGENT_PRICING[agentId];
  if (!pricing || tokenCount === 0) return 0;
  const inputTokens = tokenCount * 0.6;
  const outputTokens = tokenCount * 0.4;
  return (inputTokens / 1_000_000) * pricing.inputPer1M
       + (outputTokens / 1_000_000) * pricing.outputPer1M;
}
```

- [ ] **Step 2: Verify compilation**

Run: `npx tsc --noEmit src/common/stats-types.ts --moduleResolution node --target ES2022 --module commonjs --strict --esModuleInterop --skipLibCheck`
Expected: No errors

- [ ] **Step 3: Commit**

```bash
git add src/common/stats-types.ts
git commit -m "feat: add shared stats types, pricing data, health calculation"
```

---

### Task 2: Format Utilities

**Files:**
- Create: `src/renderer/lib/format-utils.ts`

- [ ] **Step 1: Create format-utils.ts**

```typescript
// src/renderer/lib/format-utils.ts

/** Format token count: 1234 → "1.2k", 1234567 → "1.2M" */
export function formatTokens(count: number): string {
  if (count === 0) return '—';
  if (count < 1000) return count.toString();
  if (count < 1_000_000) return (count / 1000).toFixed(1) + 'k';
  return (count / 1_000_000).toFixed(2) + 'M';
}

/** Format cost: 0.34 → "$0.34", 12.5 → "$12.50" */
export function formatCost(usd: number): string {
  if (usd === 0) return '—';
  if (usd < 0.01) return '<$0.01';
  return '$' + usd.toFixed(2);
}

/** Format uptime: 125 → "2m 5s", 3661 → "1h 1m" */
export function formatUptime(seconds: number): string {
  if (seconds < 0) return '—';
  if (seconds < 60) return `${Math.floor(seconds)}s`;
  if (seconds < 3600) {
    const m = Math.floor(seconds / 60);
    const s = Math.floor(seconds % 60);
    return s > 0 ? `${m}m ${s}s` : `${m}m`;
  }
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  return m > 0 ? `${h}h ${m}m` : `${h}h`;
}

/** Format health score to colored dots: 85 → "●●●●○" */
export function formatHealthDots(score: number): string {
  const filled = Math.round(score / 20);
  return '●'.repeat(filled) + '○'.repeat(5 - filled);
}

/** Get health color: 85 → "var(--running)", 30 → "var(--failed)" */
export function healthColor(score: number): string {
  if (score >= 80) return 'var(--running)';
  if (score >= 60) return 'var(--pending)';
  if (score >= 40) return '#f59e0b';
  if (score >= 20) return 'var(--failed)';
  return '#dc2626';
}

/** Format time ago: Date.now() - 120000 → "2m ago" */
export function formatTimeAgo(timestamp: number): string {
  const diff = Math.floor((Date.now() - timestamp) / 1000);
  if (diff < 10) return 'just now';
  if (diff < 60) return `${diff}s ago`;
  if (diff < 3600) return `${Math.floor(diff / 60)}m ago`;
  if (diff < 86400) return `${Math.floor(diff / 3600)}h ago`;
  return `${Math.floor(diff / 86400)}d ago`;
}
```

- [ ] **Step 2: Commit**

```bash
git add src/renderer/lib/format-utils.ts
git commit -m "feat: add format utilities for tokens, cost, uptime, health"
```

---

### Task 3: StatsCollector (主进程)

**Files:**
- Create: `src/main/stats-collector.ts`
- Test: `tests/stats-collector.test.ts`

- [ ] **Step 1: Write failing test for StatsCollector**

```typescript
// tests/stats-collector.test.ts
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

    // Simulate time passing
    collector.updateStatus('S1', 'thinking');
    const after = collector.getStats('S1')!.lastActivity;
    expect(after).toBeGreaterThanOrEqual(before);
    expect(collector.getStats('S1')!.status).toBe('thinking');
  });

  it('should compute token rate from history', () => {
    collector.trackSession('S1', 'claude', '.');
    collector.updateTokens('S1', 1000);
    // Token rate should be >= 0
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

  it('should increment error count', () => {
    collector.trackSession('S1', 'claude', '.');
    collector.recordError('S1');
    collector.recordError('S1');
    const stats = collector.getStats('S1');
    expect(stats!.errorCount).toBe(2);
    expect(stats!.healthScore).toBeLessThan(100);
  });

  it('should calculate health based on idle time', () => {
    collector.trackSession('S1', 'claude', '.');
    // Force lastActivity to 6 minutes ago
    const stats = collector.getStats('S1')!;
    stats.lastActivity = Date.now() - 360_000;
    const health = collector.getStats('S1')!.healthScore;
    expect(health).toBeLessThan(100);
  });

  it('should return empty array when no sessions', () => {
    expect(collector.getAllStats()).toEqual([]);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/stats-collector.test.ts`
Expected: FAIL — `Cannot find module '../src/main/stats-collector'`

- [ ] **Step 3: Implement StatsCollector**

```typescript
// src/main/stats-collector.ts
import { AgentStats, calculateHealth, estimateCost, AGENT_PRICING } from '../common/stats-types';

const MAX_HISTORY = 36;  // 30 min at 50s intervals
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
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/stats-collector.test.ts`
Expected: All 9 tests PASS

- [ ] **Step 5: Commit**

```bash
git add src/main/stats-collector.ts tests/stats-collector.test.ts
git commit -m "feat: add StatsCollector with per-agent token/cost/health tracking"
```

---

### Task 4: NotifyCenter (主进程)

**Files:**
- Create: `src/main/notify-center.ts`
- Test: `tests/notify-center.test.ts`

- [ ] **Step 1: Write failing test for NotifyCenter**

```typescript
// tests/notify-center.test.ts
import { describe, it, expect, beforeEach } from 'vitest';
import { NotifyCenter } from '../src/main/notify-center';

describe('NotifyCenter', () => {
  let center: NotifyCenter;

  beforeEach(() => {
    center = new NotifyCenter();
  });

  it('should detect error pattern in output', () => {
    const notifications = center.parseOutput('S1', 'claude', 'Error: TypeScript compilation failed');
    expect(notifications.length).toBe(1);
    expect(notifications[0].level).toBe('error');
    expect(notifications[0].message).toContain('Error detected');
  });

  it('should detect permission pattern', () => {
    const notifications = center.parseOutput('S1', 'claude', 'Permission required to write file');
    expect(notifications.length).toBeGreaterThanOrEqual(1);
    const perm = notifications.find(n => n.level === 'warning');
    expect(perm).toBeDefined();
  });

  it('should detect completion pattern', () => {
    const notifications = center.parseOutput('S1', 'claude', 'Task completed successfully');
    expect(notifications.length).toBeGreaterThanOrEqual(1);
    const success = notifications.find(n => n.level === 'success');
    expect(success).toBeDefined();
  });

  it('should not generate notification for normal output', () => {
    const notifications = center.parseOutput('S1', 'claude', 'Reading file src/index.ts...');
    expect(notifications.length).toBe(0);
  });

  it('should deduplicate notifications within cooldown', () => {
    center.parseOutput('S1', 'claude', 'Error: something failed');
    const second = center.parseOutput('S1', 'claude', 'Error: something failed');
    // Same pattern within cooldown should be suppressed
    expect(second.length).toBe(0);
  });

  it('should store notifications and allow retrieval', () => {
    center.parseOutput('S1', 'claude', 'Error: fail');
    center.parseOutput('S2', 'opencode', 'Needs input');
    const all = center.getNotifications();
    expect(all.length).toBe(2);
  });

  it('should dismiss notification by id', () => {
    const notifs = center.parseOutput('S1', 'claude', 'Error: fail');
    center.dismiss(notifs[0].id);
    const all = center.getNotifications();
    expect(all[0].dismissed).toBe(true);
  });

  it('should dismiss all for a session', () => {
    center.parseOutput('S1', 'claude', 'Error: fail');
    center.parseOutput('S1', 'claude', 'Needs input');
    center.dismissAllForSession('S1');
    const all = center.getNotifications();
    expect(all.every(n => n.dismissed)).toBe(true);
  });

  it('should strip ANSI codes before pattern matching', () => {
    const ansi = '\x1B[31mError: something failed\x1B[0m';
    const notifications = center.parseOutput('S1', 'claude', ansi);
    expect(notifications.length).toBe(1);
  });

  it('should return empty for empty string', () => {
    expect(center.parseOutput('S1', 'claude', '')).toEqual([]);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/notify-center.test.ts`
Expected: FAIL — `Cannot find module '../src/main/notify-center'`

- [ ] **Step 3: Implement NotifyCenter**

```typescript
// src/main/notify-center.ts
import { AgentNotification, NotificationLevel, ATTENTION_PATTERNS } from '../common/stats-types';
import crypto from 'crypto';

const COOLDOWN_MS = 30_000;  // Same pattern suppressed for 30s
const MAX_NOTIFICATIONS = 200;

export class NotifyCenter {
  private notifications: AgentNotification[] = [];
  private lastFired = new Map<string, number>();  // pattern+session → timestamp

  /** Parse PTY output for attention patterns, return new notifications */
  parseOutput(sessionId: string, agent: string, rawData: string): AgentNotification[] {
    if (!rawData || rawData.length < 3) return [];

    // Strip ANSI escape codes
    const clean = rawData.replace(/\x1B\[[0-9;]*[a-zA-Z]/g, '');
    if (clean.length < 3) return [];

    const results: AgentNotification[] = [];
    const now = Date.now();

    for (const { pattern, level, label } of ATTENTION_PATTERNS) {
      if (!pattern.test(clean)) continue;

      // Dedup: same session + same level within cooldown
      const dedupKey = `${sessionId}:${level}:${label}`;
      const lastTime = this.lastFired.get(dedupKey) || 0;
      if (now - lastTime < COOLDOWN_MS) continue;

      this.lastFired.set(dedupKey, now);

      const notification: AgentNotification = {
        id: crypto.randomUUID(),
        sessionId,
        agent,
        level,
        message: label,
        timestamp: now,
        dismissed: false,
      };

      results.push(notification);
      this.notifications.push(notification);
    }

    // Trim to max
    if (this.notifications.length > MAX_NOTIFICATIONS) {
      this.notifications = this.notifications.slice(-MAX_NOTIFICATIONS);
    }

    return results;
  }

  /** Get all notifications (newest first) */
  getNotifications(includeDismissed = true): AgentNotification[] {
    const all = [...this.notifications].reverse();
    return includeDismissed ? all : all.filter(n => !n.dismissed);
  }

  /** Get unread count for a session */
  getUnreadCount(sessionId: string): number {
    return this.notifications.filter(n => n.sessionId === sessionId && !n.dismissed).length;
  }

  /** Get total unread count */
  getTotalUnread(): number {
    return this.notifications.filter(n => !n.dismissed).length;
  }

  /** Dismiss a single notification */
  dismiss(id: string): void {
    const n = this.notifications.find(n => n.id === id);
    if (n) n.dismissed = true;
  }

  /** Dismiss all notifications for a session */
  dismissAllForSession(sessionId: string): void {
    for (const n of this.notifications) {
      if (n.sessionId === sessionId) n.dismissed = true;
    }
  }

  /** Dismiss all */
  dismissAll(): void {
    for (const n of this.notifications) n.dismissed = true;
  }

  /** Remove old dismissed notifications (cleanup) */
  prune(olderThanMs = 3600_000): void {
    const cutoff = Date.now() - olderThanMs;
    this.notifications = this.notifications.filter(
      n => !n.dismissed || n.timestamp > cutoff
    );
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/notify-center.test.ts`
Expected: All 10 tests PASS

- [ ] **Step 5: Commit**

```bash
git add src/main/notify-center.ts tests/notify-center.test.ts
git commit -m "feat: add NotifyCenter with PTY output parsing and dedup"
```

---

### Task 5: Database Extension — agent_stats 表

**Files:**
- Modify: `src/main/database.ts`

- [ ] **Step 1: Add agent_stats table to initDatabase**

在 `src/main/database.ts` 的 `initDatabase()` 函数中，在现有 `db.exec(...)` 的 SQL 末尾追加新表：

```sql
CREATE TABLE IF NOT EXISTS agent_stats (
  session_id TEXT PRIMARY KEY,
  agent TEXT NOT NULL,
  token_count INTEGER DEFAULT 0,
  estimated_cost REAL DEFAULT 0,
  health_score INTEGER DEFAULT 100,
  status TEXT NOT NULL DEFAULT 'starting',
  error_count INTEGER DEFAULT 0,
  started_at TEXT NOT NULL,
  last_activity TEXT NOT NULL
);
```

- [ ] **Step 2: Add saveAgentStats and loadAgentStats functions**

```typescript
// 在 database.ts 文件末尾追加:

interface AgentStatsRow {
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

export function saveAgentStats(stats: Array<{
  sessionId: string;
  agent: string;
  tokenCount: number;
  estimatedCost: number;
  healthScore: number;
  status: string;
  errorCount: number;
  startTime: number;
  lastActivity: number;
}>) {
  if (!db) return;
  const conn = db;

  const saveAll = conn.transaction((rows: typeof stats) => {
    for (const r of rows) {
      conn.prepare(`
        INSERT OR REPLACE INTO agent_stats
        (session_id, agent, token_count, estimated_cost, health_score, status, error_count, started_at, last_activity)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        r.sessionId ?? '',
        r.agent ?? '',
        r.tokenCount ?? 0,
        r.estimatedCost ?? 0,
        r.healthScore ?? 100,
        r.status ?? 'starting',
        r.errorCount ?? 0,
        new Date(r.startTime).toISOString(),
        new Date(r.lastActivity).toISOString()
      );
    }
  });
  saveAll(stats);
}

export function loadAgentStats(): AgentStatsRow[] {
  if (!db) return [];
  return db.prepare('SELECT * FROM agent_stats ORDER BY started_at DESC').all() as AgentStatsRow[];
}
```

- [ ] **Step 3: Commit**

```bash
git add src/main/database.ts
git commit -m "feat: add agent_stats SQLite table for persistent stats"
```

---

### Task 6: Protocol Extension — stats + watchdog 消息

**Files:**
- Modify: `src/daemon/protocol/messages.ts`

- [ ] **Step 1: Add new message types to messages.ts**

在 `src/daemon/protocol/messages.ts` 中：

**ClientMessage** 联合类型新增：
```typescript
  | { type: 'get-session-activity'; sessionId: string }
```

**DaemonMessage** 联合类型新增：
```typescript
  | { type: 'session-activity'; sessionId: string; hasRecentOutput: boolean; lastOutputAt: number }
```

在 `src/daemon/server.ts` 的 `handleMessage` switch 中新增处理：
```typescript
      case 'get-session-activity': {
        const activity = this.ptyManager.getSessionActivity(msg.sessionId);
        response = { type: 'session-activity', sessionId: msg.sessionId, hasRecentOutput: activity.hasRecentOutput, lastOutputAt: activity.lastOutputAt };
        break;
      }
```

在 `src/daemon/pty-manager.ts` 中添加：
```typescript
  // 在 PtyManager 类中新增:
  private lastOutputTime = new Map<string, number>();

  // 在现有的 ptyProcess.onData 回调中添加:
  this.lastOutputTime.set(sessionId, Date.now());

  // 新增方法:
  getSessionActivity(sessionId: string): { hasRecentOutput: boolean; lastOutputAt: number } {
    const last = this.lastOutputTime.get(sessionId) || 0;
    return { hasRecentOutput: Date.now() - last < 30_000, lastOutputAt: last };
  }
```

- [ ] **Step 2: Rebuild daemon**

Run: `npm run build:daemon`
Expected: No errors

- [ ] **Step 3: Commit**

```bash
git add src/daemon/protocol/messages.ts src/daemon/server.ts src/daemon/pty-manager.ts
git commit -m "feat: add session-activity protocol message for health monitoring"
```

---

### Task 7: IPC + Preload 集成

**Files:**
- Modify: `src/main/ipc-handlers.ts`
- Modify: `src/main/index.ts`
- Modify: `src/preload/index.ts`
- Modify: `src/renderer/global.d.ts`

- [ ] **Step 1: Update ipc-handlers.ts with stats and notification handlers**

在 `src/main/ipc-handlers.ts` 中，修改 `setupIpcHandlers` 函数签名和添加新的 handlers：

```typescript
// 修改函数签名，增加 statsCollector 和 notifyCenter 参数:
export function setupIpcHandlers(
  daemonClient: DaemonClient,
  mainWindow: BrowserWindow,
  statsCollector: StatsCollector,
  notifyCenter: NotifyCenter
): void {
```

在函数体中添加新的 IPC handlers（在现有的 `get_git_status` 之后）：

```typescript
  // Stats
  ipcMain.handle('get_agent_stats', async () => {
    return statsCollector.getAllStats();
  });

  ipcMain.handle('get_stats_totals', async () => {
    return statsCollector.getTotals();
  });

  // Notifications
  ipcMain.handle('get_notifications', async (_, includeDismissed?: boolean) => {
    return notifyCenter.getNotifications(includeDismissed);
  });

  ipcMain.handle('dismiss_notification', async (_, id: string) => {
    notifyCenter.dismiss(id);
  });

  ipcMain.handle('dismiss_session_notifications', async (_, sessionId: string) => {
    notifyCenter.dismissAllForSession(sessionId);
  });

  ipcMain.handle('get_notification_count', async () => {
    return notifyCenter.getTotalUnread();
  });
```

在现有的 daemon 事件转发区域（文件末尾附近），添加通知转发：

```typescript
  // Forward stats-updates to renderer (periodic)
  // StatsCollector updates are pushed via webContents
```

修改文件顶部的 import，添加：
```typescript
import { StatsCollector } from './stats-collector';
import { NotifyCenter } from './notify-center';
```

- [ ] **Step 2: Update index.ts to initialize StatsCollector and NotifyCenter**

在 `src/main/index.ts` 中，修改相关部分：

添加 import：
```typescript
import { StatsCollector } from './stats-collector.js';
import { NotifyCenter } from './notify-center.js';
import { saveAgentStats } from './database.js';
```

在 `let daemonClient` 后面添加：
```typescript
let statsCollector: StatsCollector | null = null;
let notifyCenter: NotifyCenter | null = null;
```

修改 `createWindow()` 函数：
```typescript
  // 在 daemonClient.connect() 之后:
  statsCollector = new StatsCollector();
  notifyCenter = new NotifyCenter();

  // 修改 setupIpcHandlers 调用:
  setupIpcHandlers(daemonClient, mainWindow, statsCollector, notifyCenter);
```

在 daemon 事件监听区域（`setupIpcHandlers` 调用之后），添加：
```typescript
  // Track stats from daemon output
  daemonClient.on('output', (msg: any) => {
    if (statsCollector && msg.sessionId) {
      // Parse tokens from output (same regex as renderer)
      const m = msg.data?.match(/([\d,.]+[km]?)\s+tokens\b/i);
      if (m) {
        const s = m[1].toLowerCase().replace(',', '');
        const n = s.endsWith('k') ? parseFloat(s) * 1000 : s.endsWith('m') ? parseFloat(s) * 1000000 : parseInt(s);
        if (!isNaN(n) && n > 10) statsCollector.updateTokens(msg.sessionId, n);
      }
    }
    // Parse notifications
    if (notifyCenter && msg.sessionId && msg.data) {
      const notifs = notifyCenter.parseOutput(msg.sessionId, '', msg.data);
      if (notifs.length > 0) {
        mainWindow.webContents.send('notification', notifs[notifs.length - 1]);
      }
    }
  });

  daemonClient.on('exit', (msg: any) => {
    if (statsCollector && msg.sessionId) {
      statsCollector.updateStatus(msg.sessionId, msg.code === 0 ? 'done' : 'error');
      // Persist stats on exit
      saveAgentStats(statsCollector.getAllStats());
    }
  });

  daemonClient.on('spawned', (msg: any) => {
    if (statsCollector && msg.sessionId) {
      // Get cwd from the spawn request (we'd need to track this)
      statsCollector.trackSession(msg.sessionId, msg.agent || '', '');
    }
  });
```

在 `app.on('before-quit')` 中添加持久化：
```typescript
app.on('before-quit', () => {
  if (statsCollector) saveAgentStats(statsCollector.getAllStats());
  daemonClient?.destroy();
});
```

- [ ] **Step 3: Update preload/index.ts with new APIs**

在 `src/preload/index.ts` 的 `contextBridge.exposeInMainWorld` 中添加：

```typescript
  // Stats
  getAgentStats: () => ipcRenderer.invoke('get_agent_stats'),
  getStatsTotals: () => ipcRenderer.invoke('get_stats_totals'),

  // Notifications
  getNotifications: (includeDismissed?: boolean) => ipcRenderer.invoke('get_notifications', includeDismissed),
  dismissNotification: (id: string) => ipcRenderer.invoke('dismiss_notification', id),
  dismissSessionNotifications: (sessionId: string) => ipcRenderer.invoke('dismiss_session_notifications', sessionId),
  getNotificationCount: () => ipcRenderer.invoke('get_notification_count'),

  onNotification: (callback: (notification: any) => void) => {
    const listener = (_event: any, notification: any) => callback(notification);
    ipcRenderer.on('notification', listener);
    return () => ipcRenderer.removeListener('notification', listener);
  },
```

- [ ] **Step 4: Update global.d.ts with new types**

在 `src/renderer/global.d.ts` 的 `ElectronAPI` interface 中添加：

```typescript
  getAgentStats: () => Promise<any[]>;
  getStatsTotals: () => Promise<{ tokens: number; cost: number; running: number; failed: number }>;
  getNotifications: (includeDismissed?: boolean) => Promise<any[]>;
  dismissNotification: (id: string) => Promise<void>;
  dismissSessionNotifications: (sessionId: string) => Promise<void>;
  getNotificationCount: () => Promise<number>;
  onNotification: (callback: (notification: any) => void) => () => void;
```

- [ ] **Step 5: Verify full build succeeds**

Run: `npm run build:daemon`
Expected: No errors

- [ ] **Step 6: Commit**

```bash
git add src/main/ipc-handlers.ts src/main/index.ts src/preload/index.ts src/renderer/global.d.ts
git commit -m "feat: wire StatsCollector and NotifyCenter through IPC"
```

---

### Task 8: AgentDashboard 组件

**Files:**
- Create: `src/renderer/components/AgentDashboard.tsx`

- [ ] **Step 1: Create AgentDashboard component**

```tsx
// src/renderer/components/AgentDashboard.tsx
import { useState, useEffect } from 'react';
import { formatTokens, formatCost, formatUptime, formatHealthDots, healthColor } from '../lib/format-utils';

interface AgentStatsData {
  sessionId: string;
  agentId: string;
  agentType: string;
  status: string;
  tokenCount: number;
  tokenRate: number;
  estimatedCost: number;
  healthScore: number;
  lastActivity: number;
  startTime: number;
  errorCount: number;
  cwd: string;
  branch?: string;
}

interface Props {
  visible: boolean;
  onClose: () => void;
}

export function AgentDashboard({ visible, onClose }: Props) {
  const [stats, setStats] = useState<AgentStatsData[]>([]);
  const [totals, setTotals] = useState({ tokens: 0, cost: 0, running: 0, failed: 0 });

  useEffect(() => {
    if (!visible) return;
    const refresh = async () => {
      try {
        const s = await window.electronAPI.getAgentStats();
        setStats(s || []);
        const t = await window.electronAPI.getStatsTotals();
        setTotals(t || { tokens: 0, cost: 0, running: 0, failed: 0 });
      } catch { /* ignore */ }
    };
    refresh();
    const iv = setInterval(refresh, 2000);
    return () => clearInterval(iv);
  }, [visible]);

  if (!visible) return null;

  const statusIcon = (s: string) => {
    switch (s) {
      case 'thinking': return '◉';
      case 'waiting': return '⚡';
      case 'error': return '✕';
      case 'done': return '✓';
      default: return '●';
    }
  };

  const statusColor = (s: string) => {
    switch (s) {
      case 'thinking': return 'var(--pending)';
      case 'waiting': return 'var(--accent)';
      case 'error': return 'var(--failed)';
      case 'done': return 'var(--running)';
      default: return 'var(--running)';
    }
  };

  const uptime = (start: number) => formatUptime((Date.now() - start) / 1000);

  return (
    <div style={{
      position: 'fixed', top: 0, left: 0, right: 0, bottom: 0,
      background: 'rgba(0,0,0,0.6)', zIndex: 1000,
      display: 'flex', alignItems: 'center', justifyContent: 'center',
    }} onClick={onClose}>
      <div style={{
        background: 'var(--canvas-deep)', border: '1px solid var(--hairline)',
        borderRadius: 8, padding: 20, width: '90%', maxWidth: 800, maxHeight: '80vh',
        overflow: 'auto', fontFamily: 'var(--font-sans)',
      }} onClick={(e) => e.stopPropagation()}>
        {/* Header */}
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 16 }}>
          <h2 style={{ color: 'var(--ink)', fontSize: 16, fontWeight: 600, margin: 0 }}>Agent Dashboard</h2>
          <button onClick={onClose} style={{
            background: 'none', border: '1px solid var(--hairline)', borderRadius: 4,
            color: 'var(--caption)', cursor: 'pointer', padding: '2px 8px', fontSize: 12,
          }}>✕ Close</button>
        </div>

        {/* Table */}
        <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 12 }}>
          <thead>
            <tr style={{ borderBottom: '1px solid var(--hairline)' }}>
              {['Agent', 'Status', 'Health', 'Tokens', 'Cost', 'Errors', 'Uptime'].map(h => (
                <th key={h} style={{ textAlign: 'left', padding: '6px 8px', color: 'var(--caption)', fontWeight: 500, fontSize: 10, textTransform: 'uppercase', letterSpacing: '0.05em' }}>{h}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {stats.length === 0 ? (
              <tr><td colSpan={7} style={{ padding: 20, textAlign: 'center', color: 'var(--caption)', fontStyle: 'italic' }}>No active agents</td></tr>
            ) : stats.map((s) => (
              <tr key={s.sessionId} style={{ borderBottom: '1px solid var(--hairline)' }}>
                <td style={{ padding: '8px', color: 'var(--ink)', fontWeight: 500 }}>{s.agentId}</td>
                <td style={{ padding: '8px' }}>
                  <span style={{ color: statusColor(s.status), fontSize: 10, marginRight: 4 }}>{statusIcon(s.status)}</span>
                  <span style={{ color: 'var(--body)', fontSize: 11 }}>{s.status}</span>
                </td>
                <td style={{ padding: '8px', fontFamily: 'var(--font-mono)', fontSize: 11, color: healthColor(s.healthScore) }}>
                  {formatHealthDots(s.healthScore)} <span style={{ fontSize: 10 }}>{s.healthScore}</span>
                </td>
                <td style={{ padding: '8px', color: 'var(--pending)', fontVariantNumeric: 'tabular-nums' }}>
                  {formatTokens(s.tokenCount)}
                  {s.tokenRate > 0 && <span style={{ color: 'var(--caption)', fontSize: 10, marginLeft: 4 }}>({s.tokenRate}/min)</span>}
                </td>
                <td style={{ padding: '8px', color: 'var(--running)', fontVariantNumeric: 'tabular-nums' }}>{formatCost(s.estimatedCost)}</td>
                <td style={{ padding: '8px', color: s.errorCount > 0 ? 'var(--failed)' : 'var(--caption)' }}>{s.errorCount}</td>
                <td style={{ padding: '8px', color: 'var(--caption)', fontVariantNumeric: 'tabular-nums' }}>{uptime(s.startTime)}</td>
              </tr>
            ))}
          </tbody>
        </table>

        {/* Totals */}
        {stats.length > 0 && (
          <div style={{
            marginTop: 12, padding: '8px 12px', background: 'var(--canvas)',
            borderRadius: 4, display: 'flex', gap: 24, fontSize: 12, color: 'var(--body)',
          }}>
            <span>Total: <strong style={{ color: 'var(--ink)' }}>{stats.length}</strong> agents</span>
            <span>Tokens: <strong style={{ color: 'var(--pending)' }}>{formatTokens(totals.tokens)}</strong></span>
            <span>Cost: <strong style={{ color: 'var(--running)' }}>{formatCost(totals.cost)}</strong></span>
            <span>Running: <strong style={{ color: 'var(--running)' }}>{totals.running}</strong></span>
            {totals.failed > 0 && <span>Failed: <strong style={{ color: 'var(--failed)' }}>{totals.failed}</strong></span>}
          </div>
        )}
      </div>
    </div>
  );
}
```

- [ ] **Step 2: Commit**

```bash
git add src/renderer/components/AgentDashboard.tsx
git commit -m "feat: add AgentDashboard component with health/tokens/cost table"
```

---

### Task 9: NotifyPanel 组件

**Files:**
- Create: `src/renderer/components/NotifyPanel.tsx`

- [ ] **Step 1: Create NotifyPanel component**

```tsx
// src/renderer/components/NotifyPanel.tsx
import { useState, useEffect, useCallback } from 'react';
import { formatTimeAgo } from '../lib/format-utils';

interface Notification {
  id: string;
  sessionId: string;
  agent: string;
  level: 'info' | 'warning' | 'error' | 'success';
  message: string;
  timestamp: number;
  dismissed: boolean;
}

interface Props {
  visible: boolean;
  onClose: () => void;
  onJumpToSession: (sessionId: string) => void;
}

const levelConfig = {
  info: { icon: '🔵', color: 'var(--info)', bg: 'rgba(96,165,250,0.08)' },
  warning: { icon: '🟡', color: 'var(--pending)', bg: 'rgba(251,191,36,0.08)' },
  error: { icon: '🔴', color: 'var(--failed)', bg: 'rgba(248,113,113,0.08)' },
  success: { icon: '🟢', color: 'var(--running)', bg: 'rgba(74,222,128,0.08)' },
};

export function NotifyPanel({ visible, onClose, onJumpToSession }: Props) {
  const [notifications, setNotifications] = useState<Notification[]>([]);

  const refresh = useCallback(async () => {
    try {
      const n = await window.electronAPI.getNotifications(false);
      setNotifications(n || []);
    } catch { /* ignore */ }
  }, []);

  useEffect(() => {
    if (!visible) return;
    refresh();
    const iv = setInterval(refresh, 2000);
    return () => clearInterval(iv);
  }, [visible, refresh]);

  // Listen for new notifications in real-time
  useEffect(() => {
    const unsub = window.electronAPI.onNotification(() => {
      refresh();
    });
    return unsub;
  }, [refresh]);

  const handleDismiss = async (id: string) => {
    await window.electronAPI.dismissNotification(id);
    refresh();
  };

  const handleDismissAll = async () => {
    for (const n of notifications) {
      await window.electronAPI.dismissNotification(n.id);
    }
    refresh();
  };

  if (!visible) return null;

  return (
    <div style={{
      position: 'fixed', top: 0, right: 0, bottom: 0, width: 360,
      background: 'var(--canvas-deep)', borderLeft: '1px solid var(--hairline)',
      zIndex: 999, display: 'flex', flexDirection: 'column',
      fontFamily: 'var(--font-sans)',
    }}>
      {/* Header */}
      <div style={{ padding: '12px 14px', display: 'flex', justifyContent: 'space-between', alignItems: 'center', borderBottom: '1px solid var(--hairline)' }}>
        <h3 style={{ color: 'var(--ink)', fontSize: 14, fontWeight: 600, margin: 0 }}>
          Notifications {notifications.length > 0 && <span style={{ color: 'var(--accent)', fontSize: 11 }}>({notifications.length})</span>}
        </h3>
        <div style={{ display: 'flex', gap: 6 }}>
          {notifications.length > 0 && (
            <button onClick={handleDismissAll} style={{
              background: 'none', border: '1px solid var(--hairline)', borderRadius: 3,
              color: 'var(--caption)', cursor: 'pointer', padding: '2px 6px', fontSize: 10,
            }}>Dismiss all</button>
          )}
          <button onClick={onClose} style={{
            background: 'none', border: '1px solid var(--hairline)', borderRadius: 3,
            color: 'var(--caption)', cursor: 'pointer', padding: '2px 6px', fontSize: 10,
          }}>✕</button>
        </div>
      </div>

      {/* Notification list */}
      <div style={{ flex: 1, overflow: 'auto', padding: '4px 0' }}>
        {notifications.length === 0 ? (
          <div style={{ padding: 20, textAlign: 'center', color: 'var(--caption)', fontStyle: 'italic', fontSize: 12 }}>
            No notifications
          </div>
        ) : notifications.map((n) => {
          const cfg = levelConfig[n.level] || levelConfig.info;
          return (
            <div key={n.id} style={{
              padding: '8px 14px', background: cfg.bg,
              borderBottom: '1px solid var(--hairline)',
            }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 4 }}>
                <span style={{ fontSize: 10 }}>{cfg.icon}</span>
                <span style={{ color: 'var(--ink)', fontWeight: 500, fontSize: 11 }}>{n.agent}</span>
                <span style={{ color: 'var(--caption)', fontSize: 10, marginLeft: 'auto' }}>{formatTimeAgo(n.timestamp)}</span>
              </div>
              <div style={{ color: cfg.color, fontSize: 11, marginBottom: 6 }}>{n.message}</div>
              <div style={{ display: 'flex', gap: 6 }}>
                <button onClick={() => { onJumpToSession(n.sessionId); onClose(); }} style={{
                  background: 'var(--accent)', border: 'none', borderRadius: 3,
                  color: '#fff', cursor: 'pointer', padding: '2px 8px', fontSize: 10, fontWeight: 600,
                }}>Jump to →</button>
                <button onClick={() => handleDismiss(n.id)} style={{
                  background: 'none', border: '1px solid var(--hairline)', borderRadius: 3,
                  color: 'var(--caption)', cursor: 'pointer', padding: '2px 8px', fontSize: 10,
                }}>Dismiss</button>
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}
```

- [ ] **Step 2: Commit**

```bash
git add src/renderer/components/NotifyPanel.tsx
git commit -m "feat: add NotifyPanel with dismiss and jump-to-session"
```

---

### Task 10: Sidebar 集成 — Cost 行 + 通知角标

**Files:**
- Modify: `src/renderer/components/Sidebar.tsx`

- [ ] **Step 1: Update Sidebar Props interface**

在 `src/renderer/components/Sidebar.tsx` 中修改 Props：

```typescript
interface Props {
  onAddTerminal: (a: string, cwd?: string) => void;
  onKillCurrent: () => void;
  onBroadcast: (data: string) => void;
  stats: { tasks: number; tokens: number; running: number; failed: number; duration: string; cost: number };
  sessions: SessionMeta[];
  logs: LogEntry[];
  notificationCount?: number;
  onShowDashboard?: () => void;
  onShowNotifications?: () => void;
}
```

- [ ] **Step 2: Update function signature**

```typescript
export function Sidebar({ onAddTerminal, onKillCurrent, onBroadcast, stats, sessions, logs, notificationCount = 0, onShowDashboard, onShowNotifications }: Props) {
```

- [ ] **Step 3: Update Stats section to include Cost row and action buttons**

替换 Stats section 的内容（在 `{section('Stats', 'stats',` 内部）：

```tsx
{section('Stats', 'stats',
  <div style={{ fontSize:11, color:'var(--body)', lineHeight:'18px' }}>
    <div style={{ display:'flex', justifyContent:'space-between' }}><span>Tasks</span><span style={{ color:'var(--pending)' }}>{stats.tasks}</span></div>
    <div style={{ display:'flex', justifyContent:'space-between' }}><span>Tokens</span><span style={{ color:'var(--pending)' }}>{stats.tokens.toLocaleString()}</span></div>
    <div style={{ display:'flex', justifyContent:'space-between' }}><span>Cost</span><span style={{ color:'var(--running)' }}>{stats.cost > 0 ? '$' + stats.cost.toFixed(2) : '—'}</span></div>
    <div style={{ display:'flex', justifyContent:'space-between' }}><span>Running</span><span style={{ color:'var(--running)' }}>{stats.running}</span></div>
    <div style={{ display:'flex', justifyContent:'space-between' }}><span>Failed</span><span style={{ color: stats.failed > 0 ? 'var(--failed)' : 'var(--caption)' }}>{stats.failed}</span></div>
    <div style={{ display:'flex', justifyContent:'space-between' }}><span>Duration</span><span style={{ color:'var(--caption)' }}>{stats.duration}</span></div>
    <div style={{ display:'flex', gap:4, marginTop:6 }}>
      {onShowDashboard && (
        <button onClick={onShowDashboard} style={{
          flex:1, background:'var(--canvas-soft)', border:'1px solid var(--hairline)', borderRadius:3,
          color:'var(--body)', cursor:'pointer', padding:'3px 0', fontSize:10, fontFamily:'var(--font-sans)',
        }}>📊 Dashboard</button>
      )}
      {onShowNotifications && (
        <button onClick={onShowNotifications} style={{
          flex:1, background: notificationCount > 0 ? 'rgba(94,106,210,0.15)' : 'var(--canvas-soft)',
          border: notificationCount > 0 ? '1px solid var(--accent)' : '1px solid var(--hairline)',
          borderRadius:3,
          color: notificationCount > 0 ? 'var(--accent)' : 'var(--body)',
          cursor:'pointer', padding:'3px 0', fontSize:10, fontFamily:'var(--font-sans)',
        }}>🔔 {notificationCount > 0 ? `(${notificationCount})` : 'Notify'}</button>
      )}
    </div>
  </div>
)}
```

- [ ] **Step 4: Add notification badge to session cards**

在 session 卡片中的 `{s.gitBranch && ...}` 行之后，添加通知角标：

```tsx
{/* Notification badge — placeholder, actual count will come via props in future */}
```

Note: Full per-session notification badges require passing notification counts per session, which will be wired in Task 12.

- [ ] **Step 5: Commit**

```bash
git add src/renderer/components/Sidebar.tsx
git commit -m "feat: add cost row, dashboard/notify buttons to Sidebar stats"
```

---

### Task 11: App.tsx 集成 — Dashboard + NotifyPanel + Per-agent tokens

**Files:**
- Modify: `src/renderer/App.tsx`

- [ ] **Step 1: Add imports for new components**

在 `src/renderer/App.tsx` 顶部添加：

```typescript
import { AgentDashboard } from './components/AgentDashboard';
import { NotifyPanel } from './components/NotifyPanel';
```

- [ ] **Step 2: Add state for dashboard/notify visibility**

在 `App()` 函数内，在现有的 `const [stats, setStats]` 之后添加：

```typescript
  const [showDashboard, setShowDashboard] = useState(false);
  const [showNotify, setShowNotify] = useState(false);
  const [notificationCount, setNotificationCount] = useState(0);
  const [totalCost, setTotalCost] = useState(0);
```

- [ ] **Step 3: Add effects for notification count and cost polling**

在 stats useEffect 之后添加：

```typescript
  // Poll notification count and cost
  useEffect(() => {
    const refresh = async () => {
      try {
        const count = await window.electronAPI.getNotificationCount();
        setNotificationCount(count);
      } catch { /* ignore */ }
      try {
        const totals = await window.electronAPI.getStatsTotals();
        setTotalCost(totals?.cost ?? 0);
      } catch { /* ignore */ }
    };
    refresh();
    const iv = setInterval(refresh, 3000);
    return () => clearInterval(iv);
  }, []);
```

- [ ] **Step 4: Update stats object to include cost**

修改 `setStats({...})` 中的 stats 对象（在 setInterval 内）：

```typescript
    setStats({
      tasks: panels.length,
      tokens: tokensRef.current,
      running: panels.filter(p => p.running).length,
      failed: failedRef.current,
      duration: `${Math.floor((Date.now() - startTime.current) / 60000)}m`,
      cost: totalCost,
    });
```

注意：`stats` state 的类型声明也需要在顶部更新。找到：
```typescript
const [stats, setStats] = useState({ tasks: 0, tokens: 0, running: 0, failed: 0, duration: '0m' });
```
改为：
```typescript
const [stats, setStats] = useState({ tasks: 0, tokens: 0, running: 0, failed: 0, duration: '0m', cost: 0 });
```

- [ ] **Step 5: Add Dashboard and NotifyPanel to JSX**

在 return 语句的 `<div style={{ display: 'flex', ...}}>` 的结尾处（`</div>` 闭合标签之前），添加：

```tsx
      <AgentDashboard visible={showDashboard} onClose={() => setShowDashboard(false)} />
      <NotifyPanel visible={showNotify} onClose={() => setShowNotify(false)}
        onJumpToSession={(sessionId) => {
          // Find the panel index for this session and activate it
          const idx = panels.findIndex(p => p.dockId === sessionId || p.ptyId === sessionId);
          if (idx >= 0) setActiveIdx(idx);
        }}
      />
```

- [ ] **Step 6: Pass new props to Sidebar**

修改 `<Sidebar>` 组件调用，添加新 props：

```tsx
<Sidebar onAddTerminal={addTerminal} onKillCurrent={killCurrent} onBroadcast={handleBroadcast} stats={stats}
  sessions={panels.map((p): SessionMeta => ({ id: p.dockId, agent: p.agent, cwd: p.cwd, elapsed: Math.floor((Date.now() - p.createdAt) / 1000), running: p.running, status: p.status, needsAttention: p.needsAttention, gitBranch: p.gitBranch, exited: p.exited }))}
  logs={logs}
  notificationCount={notificationCount}
  onShowDashboard={() => setShowDashboard(true)}
  onShowNotifications={() => setShowNotify(true)}
/>
```

- [ ] **Step 7: Add keyboard shortcut for Dashboard (Ctrl+D)**

在现有的 `keydown` handler 中（`useEffect` with keyboard shortcuts），添加：

```typescript
      if (e.ctrlKey && e.key === 'd') { e.preventDefault(); setShowDashboard((v) => !v); }
```

- [ ] **Step 8: Commit**

```bash
git add src/renderer/App.tsx
git commit -m "feat: integrate AgentDashboard and NotifyPanel into App"
```

---

### Task 12: CSS 变量扩展

**Files:**
- Modify: `src/renderer/styles/tokens.css`

- [ ] **Step 1: Add notification-related CSS variables**

在 `tokens.css` 的 `:root` 块中追加：

```css
  /* Notification levels */
  --notify-info: #60a5fa;
  --notify-warning: #fbbf24;
  --notify-error: #f87171;
  --notify-success: #4ade80;

  /* Dashboard */
  --dashboard-bg: rgba(0,0,0,0.6);
```

- [ ] **Step 2: Commit**

```bash
git add src/renderer/styles/tokens.css
git commit -m "feat: add notification and dashboard CSS variables"
```

---

### Task 13: 端到端验证

**Files:** 无新文件

- [ ] **Step 1: Kill all existing processes**

```bash
powershell -Command "Get-Process | Where-Object { $_.ProcessName -match 'electron|node' } | Stop-Process -Force"
```

- [ ] **Step 2: Rebuild daemon and start app**

```bash
npm run build:daemon
npm run dev
```

- [ ] **Step 3: Verify Dashboard opens**

按 Ctrl+D 或点击 Sidebar 的 "📊 Dashboard" 按钮。
Expected: Dashboard 弹窗出现，显示当前运行的 Agent 列表（至少有 cmd.exe 或恢复的 session），健康评分为 100。

- [ ] **Step 4: Verify notifications**

在 Sidebar 点击 "🔔 Notify" 按钮。
Expected: 通知面板从右侧滑出，显示 "No notifications"（如果没有触发任何 attention 模式）。

- [ ] **Step 5: Verify cost tracking**

在 Dashboard 中查看 Cost 列。
Expected: cmd.exe 显示 "—"（无成本），如果有 Claude/OpenCode session 则显示 $ 金额。

- [ ] **Step 6: Run unit tests**

```bash
npx vitest run tests/stats-collector.test.ts tests/notify-center.test.ts
```

Expected: All tests pass.

- [ ] **Step 7: Final commit (if any adjustments needed)**

```bash
git add -A
git commit -m "fix: phase 2 adjustments after e2e verification"
```

---

## 完成标准

| 能力 | 验收条件 |
|------|---------|
| Token/Cost 统计 | Sidebar 显示 Cost 行（$USD），Dashboard 显示每 Agent 的 tokens/cost/tokens-per-min |
| 健康评分 | Dashboard 每行显示 ●●●●○ 健康指示 + 数字分数（0-100）|
| 通知系统 | PTY 输出中的 error/permission/completion 模式触发通知 → 通知面板显示 → 可 dismiss |
| 仪表盘 | Ctrl+D 打开 Dashboard 弹窗，显示 Agent 表格 + 汇总行 |
| 数据持久化 | agent_stats SQLite 表在 app 退出时写入，重启后可加载历史数据 |
