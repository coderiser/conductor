// src/renderer/lib/format-utils.ts
// Formatting utilities for the dashboard, sidebar, and notification panel.

/** Format token count: 1234 → "1.2k", 1234567 → "1.23M" */
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

/** Get health color based on score */
export function healthColor(score: number): string {
  if (score >= 80) return 'var(--running)';
  if (score >= 60) return 'var(--pending)';
  if (score >= 40) return '#f59e0b';
  if (score >= 20) return 'var(--failed)';
  return '#dc2626';
}

/** Format time ago: timestamp from 2 minutes ago → "2m ago" */
export function formatTimeAgo(timestamp: number): string {
  const diff = Math.floor((Date.now() - timestamp) / 1000);
  if (diff < 10) return 'just now';
  if (diff < 60) return `${diff}s ago`;
  if (diff < 3600) return `${Math.floor(diff / 60)}m ago`;
  if (diff < 86400) return `${Math.floor(diff / 3600)}h ago`;
  return `${Math.floor(diff / 86400)}d ago`;
}
