import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import path from 'path';
import fs from 'fs';
import os from 'os';
import simpleGit from 'simple-git';
import { WorktreeManager } from '../src/main/worktree-manager';

describe('WorktreeManager', () => {
  let manager: WorktreeManager;
  let testRepo: string;
  let git: ReturnType<typeof simpleGit>;

  beforeEach(async () => {
    testRepo = path.join(os.tmpdir(), 'conductor-wt-' + Math.random().toString(36).slice(2, 8));
    fs.mkdirSync(testRepo, { recursive: true });
    git = simpleGit(testRepo);
    await git.init();
    await git.addConfig('user.name', 'test');
    await git.addConfig('user.email', 'test@test.com');
    fs.writeFileSync(path.join(testRepo, 'README.md'), '# Test');
    await git.add('README.md');
    await git.commit('initial');
    manager = new WorktreeManager();
  });

  afterEach(() => {
    manager.dispose();
    try { fs.rmSync(testRepo, { recursive: true, force: true }); } catch {}
  });

  it('should create a worktree for an agent', async () => {
    const info = await manager.createForAgent('S1', 'claude', testRepo, 'main');
    expect(info.sessionId).toBe('S1');
    expect(info.status).toBe('ready');
    expect(fs.existsSync(info.worktreePath)).toBe(true);
    expect(info.worktreePath).toContain(path.join(os.homedir(), '.conductor', 'worktrees'));
    expect(info.branch).toMatch(/^conductor\/claude\//);
  });

  it('should create worktrees with unique paths and branches', async () => {
    const a = await manager.createForAgent('S1', 'claude', testRepo, 'main');
    const b = await manager.createForAgent('S2', 'opencode', testRepo, 'main');
    expect(a.worktreePath).not.toBe(b.worktreePath);
    expect(a.branch).not.toBe(b.branch);
  });

  it('should return empty list when no worktrees', () => {
    expect(manager.list()).toEqual([]);
  });

  it('should list all active worktrees', async () => {
    await manager.createForAgent('S1', 'claude', testRepo, 'main');
    await manager.createForAgent('S2', 'opencode', testRepo, 'main');
    expect(manager.list().length).toBe(2);
  });

  it('should get worktree by session id', async () => {
    const info = await manager.createForAgent('S1', 'claude', testRepo, 'main');
    const found = manager.getBySession('S1');
    expect(found).toBeDefined();
    expect(found!.branch).toBe(info.branch);
  });

  it('should return undefined for unknown session', () => {
    expect(manager.getBySession('unknown')).toBeUndefined();
  });

  it('should create branch from base commit', async () => {
    const info = await manager.createForAgent('S1', 'claude', testRepo, 'main');
    const wtGit = simpleGit(info.worktreePath);
    const log = await wtGit.log();
    expect(log.all.length).toBeGreaterThanOrEqual(1);
    const branches = await git.branch();
    expect(branches.all).toContain(info.branch);
  });

  // ── Cleanup tests ───────────────────────────────────────────────────────

  it('should cleanup a worktree (remove dir + branch, prune)', async () => {
    const info = await manager.createForAgent('S1', 'claude', testRepo, 'main');
    await manager.cleanup('S1', { keepBranch: false, force: false });
    expect(manager.getBySession('S1')).toBeUndefined();
    expect(fs.existsSync(info.worktreePath)).toBe(false);
    const branches = await git.branch();
    expect(branches.all).not.toContain(info.branch);
  });

  it('should cleanup with keepBranch option', async () => {
    const info = await manager.createForAgent('S1', 'claude', testRepo, 'main');
    await manager.cleanup('S1', { keepBranch: true, force: false });
    expect(manager.getBySession('S1')).toBeUndefined();
    expect(fs.existsSync(info.worktreePath)).toBe(false);
    const branches = await git.branch();
    expect(branches.all).toContain(info.branch);
  });

  it('should cleanup with force option for dirty worktree', async () => {
    const info = await manager.createForAgent('S1', 'claude', testRepo, 'main');
    // Make the worktree dirty
    fs.writeFileSync(path.join(info.worktreePath, 'dirty.txt'), 'unstaged');
    await manager.cleanup('S1', { keepBranch: false, force: true });
    expect(manager.getBySession('S1')).toBeUndefined();
    expect(fs.existsSync(info.worktreePath)).toBe(false);
  });

  it('should throw when cleaning up unknown session', async () => {
    await expect(
      manager.cleanup('unknown', { keepBranch: false, force: false })
    ).rejects.toThrow(/unknown/);
  });

  it('should be idempotent when worktree dir is already gone', async () => {
    const info = await manager.createForAgent('S1', 'claude', testRepo, 'main');
    fs.rmSync(info.worktreePath, { recursive: true, force: true });
    // Should not throw — just remove from map
    await manager.cleanup('S1', { keepBranch: false, force: false });
    expect(manager.getBySession('S1')).toBeUndefined();
  });

  // ── Conflict detection tests ────────────────────────────────────────────

  it('should detect no conflicts when worktrees are clean', async () => {
    await manager.createForAgent('S1', 'claude', testRepo, 'main');
    await manager.createForAgent('S2', 'opencode', testRepo, 'main');
    const report = await manager.detectConflicts();
    expect(report.hasConflicts).toBe(false);
    expect(report.conflicts).toEqual([]);
  });

  it('should detect conflict when same file modified in multiple worktrees', async () => {
    const a = await manager.createForAgent('S1', 'claude', testRepo, 'main');
    const b = await manager.createForAgent('S2', 'opencode', testRepo, 'main');
    // Modify README.md in both worktrees (unstaged diff)
    fs.writeFileSync(path.join(a.worktreePath, 'README.md'), '# Changed by claude');
    fs.writeFileSync(path.join(b.worktreePath, 'README.md'), '# Changed by opencode');
    const report = await manager.detectConflicts();
    expect(report.hasConflicts).toBe(true);
    expect(report.conflicts.length).toBeGreaterThanOrEqual(1);
    expect(report.conflicts[0].file).toBe('README.md');
    expect(report.conflicts[0].worktrees.length).toBeGreaterThanOrEqual(2);
  });
});
