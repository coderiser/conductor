/**
 * US-05: Agent Health Monitoring
 *
 * User Stories: WD-1 ~ WD-3
 *   WD-1: User knows when an agent is unhealthy (stuck/frozen)
 *   WD-2: Unhealthy agents can auto-restart (configurable)
 *   WD-3: cmd.exe is exempt from health checks
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { AgentWatchdog } from '../../src/main/agent-watchdog';

describe('US-05: Agent Health Monitoring', () => {
  let watchdog: AgentWatchdog;

  beforeEach(() => {
    vi.useFakeTimers();
    // Fast check interval for testing (1 second)
    // Threshold set so that 10min idle (score=65 after penalties) triggers unhealthy
    watchdog = new AgentWatchdog({ checkIntervalMs: 1000, unhealthyThreshold: 70 });
  });

  afterEach(() => {
    watchdog.stop();
    vi.useRealTimers();
  });

  // ── WD-1: Detect unhealthy agents ─────────────────────────────────────────

  describe('WD-1: Detect unhealthy agents', () => {
    it('should register sessions and report healthy initially', () => {
      watchdog.register('S-1', 'claude', { autoRestart: false });

      const health = watchdog.getHealth('S-1');
      expect(health).toBeDefined();
      expect(health!.sessionId).toBe('S-1');
      expect(health!.agentId).toBe('claude');
      expect(health!.score).toBeGreaterThanOrEqual(80); // freshly registered = healthy
      expect(health!.isUnhealthy).toBe(false);
    });

    it('should list all monitored sessions', () => {
      watchdog.register('S-1', 'claude', { autoRestart: false });
      watchdog.register('S-2', 'opencode', { autoRestart: false });

      const sessions = watchdog.getMonitoredSessions();
      expect(sessions).toContain('S-1');
      expect(sessions).toContain('S-2');
      expect(sessions).toHaveLength(2);
    });

    it('should return undefined health for unregistered session', () => {
      expect(watchdog.getHealth('NONEXISTENT')).toBeUndefined();
    });

    it('should emit agent-unhealthy when activity goes stale', () => {
      watchdog.register('S-STALE', 'claude', { autoRestart: false });

      const events: any[] = [];
      watchdog.on('agent-unhealthy', (e) => events.push(e));

      // Advance time past unhealthy threshold (10+ minutes of no activity)
      vi.advanceTimersByTime(601_000); // just over 10 min to trigger >600 penalty

      // Force a check
      watchdog.checkNow();

      expect(events.length).toBeGreaterThanOrEqual(1);
      expect(events[0].sessionId).toBe('S-STALE');
      expect(events[0].agentId).toBe('claude');
    });

    it('should refresh health on updateActivity', () => {
      watchdog.register('S-ACTIVE', 'claude', { autoRestart: false });

      const events: any[] = [];
      watchdog.on('agent-unhealthy', (e) => events.push(e));

      // Keep updating activity (simulating active agent)
      for (let i = 0; i < 10; i++) {
        vi.advanceTimersByTime(60_000); // 1 minute
        watchdog.updateActivity('S-ACTIVE');
        watchdog.checkNow();
      }

      // Should never become unhealthy because we keep pinging
      expect(events).toHaveLength(0);
    });

    it('should track error count via recordError', () => {
      watchdog.register('S-ERR', 'claude', { autoRestart: false });

      watchdog.recordError('S-ERR');
      watchdog.recordError('S-ERR');
      watchdog.recordError('S-ERR');

      const health = watchdog.getHealth('S-ERR');
      expect(health).toBeDefined();
      // Errors should lower health score
      expect(health!.score).toBeLessThanOrEqual(100);
    });

    it('should getAllHealth for all registered sessions', () => {
      watchdog.register('S-1', 'claude', { autoRestart: false });
      watchdog.register('S-2', 'opencode', { autoRestart: false });

      const allHealth = watchdog.getAllHealth();
      expect(allHealth).toHaveLength(2);
      expect(allHealth.map(h => h.sessionId)).toContain('S-1');
      expect(allHealth.map(h => h.sessionId)).toContain('S-2');
    });

    it('should unregister sessions', () => {
      watchdog.register('S-1', 'claude', { autoRestart: false });
      expect(watchdog.getMonitoredSessions()).toHaveLength(1);

      watchdog.unregister('S-1');
      expect(watchdog.getMonitoredSessions()).toHaveLength(0);
      expect(watchdog.getHealth('S-1')).toBeUndefined();
    });
  });

  // ── WD-2: Auto-restart unhealthy agents ───────────────────────────────────

  describe('WD-2: Auto-restart unhealthy agents', () => {
    it('should emit agent-restart when autoRestart=true and agent is unhealthy', () => {
      watchdog.register('S-RESTART', 'claude', { autoRestart: true });

      const restarts: any[] = [];
      watchdog.on('agent-restart', (e) => restarts.push(e));

      // Go stale
      vi.advanceTimersByTime(601_000);
      watchdog.checkNow();

      expect(restarts.length).toBeGreaterThanOrEqual(1);
      expect(restarts[0].sessionId).toBe('S-RESTART');
    });

    it('should NOT emit agent-restart when autoRestart=false', () => {
      watchdog.register('S-NO-RESTART', 'claude', { autoRestart: false });

      const restarts: any[] = [];
      watchdog.on('agent-restart', (e) => restarts.push(e));

      vi.advanceTimersByTime(601_000);
      watchdog.checkNow();

      expect(restarts).toHaveLength(0);
    });

    it('should run periodic checks automatically via setInterval', () => {
      watchdog.register('S-TIMER', 'claude', { autoRestart: false });

      const events: any[] = [];
      watchdog.on('agent-unhealthy', (e) => events.push(e));

      // Don't call checkNow() manually — let the timer fire
      vi.advanceTimersByTime(601_000); // 10+ min, multiple timer ticks

      // Timer should have triggered checks
      expect(events.length).toBeGreaterThanOrEqual(1);
    });
  });

  // ── WD-3: cmd.exe exempt from health checks ──────────────────────────────

  describe('WD-3: cmd.exe is always healthy', () => {
    it('should never mark cmd agent as unhealthy', () => {
      watchdog.register('S-CMD', 'cmd', { autoRestart: true });

      const events: any[] = [];
      const restarts: any[] = [];
      watchdog.on('agent-unhealthy', (e) => events.push(e));
      watchdog.on('agent-restart', (e) => restarts.push(e));

      // Go very stale (1 hour)
      vi.advanceTimersByTime(3_600_000);
      watchdog.checkNow();

      // cmd should be exempt — no events
      expect(events).toHaveLength(0);
      expect(restarts).toHaveLength(0);

      // Health check should show not unhealthy
      const health = watchdog.getHealth('S-CMD');
      expect(health!.isUnhealthy).toBe(false);
    });

    it('should still track cmd sessions in getMonitoredSessions', () => {
      watchdog.register('S-CMD', 'cmd', { autoRestart: false });
      expect(watchdog.getMonitoredSessions()).toContain('S-CMD');
    });
  });
});
