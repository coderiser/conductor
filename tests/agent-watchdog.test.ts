import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';
import { AgentWatchdog } from '../src/main/agent-watchdog';

describe('AgentWatchdog', () => {
  let watchdog: AgentWatchdog;

  beforeEach(() => {
    vi.useFakeTimers();
    watchdog = new AgentWatchdog({ checkIntervalMs: 1000, unhealthyThreshold: 20 });
  });

  afterEach(() => {
    watchdog.stop();
    vi.useRealTimers();
  });

  it('should register and unregister sessions', () => {
    watchdog.register('S1', 'claude', { autoRestart: false });
    expect(watchdog.getMonitoredSessions()).toContain('S1');
    watchdog.unregister('S1');
    expect(watchdog.getMonitoredSessions()).not.toContain('S1');
  });

  it('should report health for a registered session', () => {
    watchdog.register('S1', 'claude', { autoRestart: false });
    const health = watchdog.getHealth('S1');
    expect(health).toBeDefined();
    expect(health!.score).toBeGreaterThanOrEqual(80);
    expect(health!.isUnhealthy).toBe(false);
  });

  it('should return undefined health for unregistered session', () => {
    expect(watchdog.getHealth('nonexistent')).toBeUndefined();
  });

  it('should list all health records', () => {
    watchdog.register('S1', 'claude', { autoRestart: false });
    watchdog.register('S2', 'opencode', { autoRestart: true });
    expect(watchdog.getAllHealth().length).toBe(2);
  });

  it('should not auto-restart when autoRestart is false', () => {
    const events: any[] = [];
    watchdog.on('agent-restart', e => events.push(e));
    watchdog.register('S1', 'claude', { autoRestart: false });
    watchdog.checkNow();
    expect(events.length).toBe(0);
  });

  it('should emit unhealthy event for low-health non-cmd agent', () => {
    const events: any[] = [];
    watchdog.on('agent-unhealthy', e => events.push(e));
    watchdog.register('S1', 'claude', { autoRestart: false });
    // Force idle: advance time by 10 minutes
    vi.advanceTimersByTime(600_000);
    // Activity is stale — health should be penalized
    const health = watchdog.getHealth('S1');
    expect(health!.score).toBeLessThan(100);
  });

  it('should skip health check for cmd.exe', () => {
    const events: any[] = [];
    watchdog.on('agent-unhealthy', e => events.push(e));
    watchdog.register('S1', 'cmd', { autoRestart: false });
    watchdog.checkNow();
    // cmd.exe is always "healthy" — no events emitted
    expect(watchdog.getHealth('S1')!.isUnhealthy).toBe(false);
  });

  it('should update activity timestamp', () => {
    watchdog.register('S1', 'claude', { autoRestart: false });
    const before = watchdog.getHealth('S1')!.lastActivity;
    vi.advanceTimersByTime(5000);
    watchdog.updateActivity('S1');
    const after = watchdog.getHealth('S1')!.lastActivity;
    expect(after).toBeGreaterThan(before);
  });
});
