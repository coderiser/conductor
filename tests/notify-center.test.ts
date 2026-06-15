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
