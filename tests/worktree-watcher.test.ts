import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import path from 'path';
import fs from 'fs';
import os from 'os';
import { WorktreeWatcher } from '../src/main/worktree-watcher';

/** Wait for the next 'change' event (or timeout after ms) */
function waitForChange(watcher: WorktreeWatcher, timeoutMs = 5000): Promise<any> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('Timeout waiting for change event')), timeoutMs);
    watcher.once('change', (event) => {
      clearTimeout(timer);
      resolve(event);
    });
  });
}

describe('WorktreeWatcher', () => {
  let watcher: WorktreeWatcher;
  let testDir: string;

  beforeEach(() => {
    testDir = path.join(os.tmpdir(), 'conductor-ww-' + Math.random().toString(36).slice(2, 8));
    fs.mkdirSync(testDir, { recursive: true });
    fs.writeFileSync(path.join(testDir, '.git'), 'gitdir: /fake/main/.git/worktrees/test\n');
    // Short debounce for fast tests
    watcher = new WorktreeWatcher({ debounceMs: 50 });
  });

  afterEach(() => {
    watcher.dispose();
    try { fs.rmSync(testDir, { recursive: true, force: true }); } catch {}
  });

  it('should register a watch session', () => {
    watcher.watch('S1', testDir);
    expect(watcher.getWatchedSessions()).toContain('S1');
  });

  it('should emit change event when file is modified in worktree', async () => {
    const eventPromise = waitForChange(watcher, 5000);
    watcher.watch('S1', testDir);

    // Small delay to ensure watcher is set up, then modify
    await new Promise(r => setTimeout(r, 20));
    fs.writeFileSync(path.join(testDir, 'README.md'), '# Updated');

    const event = await eventPromise;
    expect(event.sessionId).toBe('S1');
    expect(event.worktreePath).toBe(testDir);
    expect(event.files.length).toBeGreaterThanOrEqual(1);
  });

  it('should debounce rapid changes into a single event', async () => {
    watcher.watch('S1', testDir);
    await new Promise(r => setTimeout(r, 30));

    const onChanged = vi.fn();
    watcher.on('change', onChanged);

    // Rapid modifications within debounce window
    fs.writeFileSync(path.join(testDir, 'a.ts'), '// a');
    await new Promise(r => setTimeout(r, 10));
    fs.writeFileSync(path.join(testDir, 'b.ts'), '// b');
    await new Promise(r => setTimeout(r, 10));
    fs.writeFileSync(path.join(testDir, 'c.ts'), '// c');

    // Wait for debounce to settle
    await new Promise(r => setTimeout(r, 150));

    // Should only have 1 change event (all batched)
    expect(onChanged).toHaveBeenCalledTimes(1);
  });

  it('should stop emitting after unwatch', async () => {
    watcher.watch('S1', testDir);
    await new Promise(r => setTimeout(r, 30));

    const onChanged = vi.fn();
    watcher.on('change', onChanged);

    fs.writeFileSync(path.join(testDir, 'x.ts'), '// x');
    await new Promise(r => setTimeout(r, 100));
    expect(onChanged).toHaveBeenCalledTimes(1);

    watcher.unwatch('S1');
    expect(watcher.getWatchedSessions()).not.toContain('S1');

    fs.writeFileSync(path.join(testDir, 'y.ts'), '// y');
    await new Promise(r => setTimeout(r, 200));
    // No additional events after unwatch
    expect(onChanged).toHaveBeenCalledTimes(1);
  });

  it('should clear all watchers on dispose', () => {
    watcher.watch('S1', testDir);
    watcher.watch('S2', testDir);
    expect(watcher.getWatchedSessions().length).toBe(2);
    watcher.dispose();
    expect(watcher.getWatchedSessions().length).toBe(0);
  });
});
