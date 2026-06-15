// src/main/notify-center.ts
// Parses PTY output for attention patterns and manages a notification queue.
// Runs in the Electron main process.

import { AgentNotification, ATTENTION_PATTERNS } from '../common/stats-types';
import crypto from 'crypto';

const COOLDOWN_MS = 30_000;  // Same pattern suppressed for 30s
const MAX_NOTIFICATIONS = 200;

export class NotifyCenter {
  private notifications: AgentNotification[] = [];
  private lastFired = new Map<string, number>();  // dedupKey → timestamp

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

      // Dedup: same session + same level + same label within cooldown
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
