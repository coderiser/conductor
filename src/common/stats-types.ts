// src/common/stats-types.ts
// Shared types and utilities for agent stats, notifications, and health monitoring.
// Used by both the Electron main process and (potentially) the renderer.

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
  id: string;                  // auto-generated UUID
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

/** Task record in the orchestration queue */
export interface TaskRecord {
  id: string;
  title: string;
  description: string;
  priority: 'low' | 'normal' | 'high';
  requiredCapabilities: string[];
  assignedAgent?: string;
  assignedSession?: string;
  status: 'pending' | 'queued' | 'running' | 'done' | 'failed';
  progress: number;
  createdAt: number;
  startedAt?: number;
  completedAt?: number;
  result?: string;
  error?: string;
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
