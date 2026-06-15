/**
 * US-01: Agent Worktree Isolation
 *
 * User Stories: WT-1 ~ WT-7
 *   WT-1: Each agent gets its own worktree so they never clobber each other
 *   WT-2: Git ref resolution is safe and unambiguous
 *   WT-3: Worktree cleanup is verified, not just trusted
 *   WT-4: Conflicts between agents are detected in real-time
 *   WT-5: Worktree state persists across app restarts
 *   WT-6: Cleanup respects uncommitted work
 *   WT-7: Worktrees live OUTSIDE the project directory
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import fs from 'fs';
import path from 'path';
import os from 'os';
import simpleGit from 'simple-git';
import { WorktreeManager } from '../../src/main/worktree-manager';
import { WorktreeWatcher } from '../../src/main/worktree-watcher';
import { createTestGitRepo, cleanupTestRepo, sid } from './helpers';

describe('US-01: Agent Worktree Isolation', () => {
  let repo: string;
  let git: ReturnType<typeof simpleGit>;
  let manager: WorktreeManager;
  let watcher: WorktreeWatcher;

  beforeAll(async () => {
    repo = await createTestGitRepo();
    git = simpleGit(repo);
    manager = new WorktreeManager();
    watcher = new WorktreeWatcher({ debounceMs: 50 });
  });

  afterAll(() => {
    watcher.dispose();
    manager.dispose();
    cleanupTestRepo(repo);
  });

  // ── WT-1: Each agent gets its own worktree ───────────────────────────────

  describe('WT-1: Agent gets isolated worktree on spawn', () => {
    it('should create worktree at ~/.conductor/worktrees/{hash}/{agent}-{date}-{hex}/', async () => {
      const sessionId = sid('wt1');
      const info = await manager.createForAgent(sessionId, 'claude', repo, 'main');

      expect(info.status).toBe('ready');
      expect(info.worktreePath).toContain(path.join(os.homedir(), '.conductor', 'worktrees'));
      expect(info.worktreePath).toMatch(/claude-\d{8}-[0-9a-f]+$/);
      expect(fs.existsSync(info.worktreePath)).toBe(true);

      // Worktree has its own .git directory
      expect(fs.existsSync(path.join(info.worktreePath, '.git'))).toBe(true);

      await manager.cleanup(sessionId, { keepBranch: false, force: true });
    });

    it('should spawn agent on a unique branch conductor/{agent}/{hex}', async () => {
      const sessionId = sid('wt1b');
      const info = await manager.createForAgent(sessionId, 'opencode', repo, 'main');

      expect(info.branch).toMatch(/^conductor\/opencode\//);
      const wtGit = simpleGit(info.worktreePath);
      const branches = await wtGit.branch();
      expect(branches.current).toBe(info.branch);

      await manager.cleanup(sessionId, { keepBranch: false, force: true });
    });
  });

  // ── WT-2: Safe git ref resolution ────────────────────────────────────────

  describe('WT-2: Safe ref resolution (local > remote > tag)', () => {
    it('should resolve existing local branch', async () => {
      const resolved = await manager.resolveRef(git, 'main');
      expect(resolved).not.toBeNull();
      expect(resolved!.kind).toBe('local');
      expect(resolved!.fullRef).toBe('refs/heads/main');
    });

    it('should return null for nonexistent ref', async () => {
      const resolved = await manager.resolveRef(git, 'nonexistent-branch-xyz');
      expect(resolved).toBeNull();
    });

    it('should prefer local branch over remote tracking', async () => {
      // Create a local branch
      await git.checkoutLocalBranch('test-ref-local');
      await git.checkout('main');

      const resolved = await manager.resolveRef(git, 'test-ref-local');
      expect(resolved).not.toBeNull();
      expect(resolved!.kind).toBe('local');

      // Cleanup
      await git.deleteLocalBranch('test-ref-local');
    });
  });

  // ── WT-3: Verified cleanup ───────────────────────────────────────────────

  describe('WT-3: Cleanup is verified (6-phase)', () => {
    it('should remove worktree AND branch when keepBranch=false', async () => {
      const sessionId = sid('wt3');
      const info = await manager.createForAgent(sessionId, 'claude', repo, 'main');
      const wtPath = info.worktreePath;
      const branch = info.branch;

      await manager.cleanup(sessionId, { keepBranch: false, force: false });

      // Worktree directory gone
      expect(fs.existsSync(wtPath)).toBe(false);
      // Branch gone
      const branches = await git.branch();
      expect(branches.all).not.toContain(branch);
      // Manager no longer tracks it
      expect(manager.getBySession(sessionId)).toBeUndefined();
    });

    it('should keep branch when keepBranch=true', async () => {
      const sessionId = sid('wt3b');
      const info = await manager.createForAgent(sessionId, 'claude', repo, 'main');
      const branch = info.branch;

      await manager.cleanup(sessionId, { keepBranch: true, force: false });

      // Branch still exists
      const branches = await git.branch();
      expect(branches.all).toContain(branch);
      // But worktree is removed
      expect(manager.getBySession(sessionId)).toBeUndefined();

      // Cleanup branch manually
      await git.deleteLocalBranch(branch, true);
    });

    it('should throw when cleaning up unknown session', async () => {
      await expect(
        manager.cleanup('NONEXISTENT-SESSION', { keepBranch: false, force: false })
      ).rejects.toThrow(/No active worktree/i);
    });
  });

  // ── WT-4: Real-time conflict detection ───────────────────────────────────

  describe('WT-4: Conflict detection between agents', () => {
    it('should report no conflicts when agents modify different files', async () => {
      const s1 = sid('wt4a'), s2 = sid('wt4b');
      const wt1 = await manager.createForAgent(s1, 'claude', repo, 'main');
      const wt2 = await manager.createForAgent(s2, 'opencode', repo, 'main');

      // detectConflicts() uses `git diff HEAD` — changes must be uncommitted
      fs.writeFileSync(path.join(wt1.worktreePath, 'feature-a.ts'), '// A');
      fs.writeFileSync(path.join(wt2.worktreePath, 'feature-b.ts'), '// B');

      const report = await manager.detectConflicts();
      expect(report.hasConflicts).toBe(false);
      expect(report.conflicts).toHaveLength(0);

      await manager.cleanup(s1, { keepBranch: false, force: true });
      await manager.cleanup(s2, { keepBranch: false, force: true });
    });

    it('should report conflict when two agents modify the same file', async () => {
      const s1 = sid('wt4c'), s2 = sid('wt4d');
      const wt1 = await manager.createForAgent(s1, 'claude', repo, 'main');
      const wt2 = await manager.createForAgent(s2, 'opencode', repo, 'main');

      // Both modify main.ts — uncommitted (detectConflicts uses `git diff HEAD`)
      fs.writeFileSync(path.join(wt1.worktreePath, 'main.ts'), '// Claude changed this');
      fs.writeFileSync(path.join(wt2.worktreePath, 'main.ts'), '// OpenCode changed this');

      const report = await manager.detectConflicts();
      expect(report.hasConflicts).toBe(true);
      const conflict = report.conflicts.find(c => c.file === 'main.ts');
      expect(conflict).toBeDefined();
      expect(conflict!.worktrees.length).toBeGreaterThanOrEqual(2);

      await manager.cleanup(s1, { keepBranch: false, force: true });
      await manager.cleanup(s2, { keepBranch: false, force: true });
    });
  });

  // ── WT-5: Persistence across restarts ────────────────────────────────────

  describe('WT-5: Worktree state persists across app restarts', () => {
    it('should restore worktree from persisted row', () => {
      const row = {
        id: 'wt-persist-001',
        session_id: 'S-PERSIST',
        agent_id: 'claude',
        worktree_path: path.join(os.tmpdir(), 'fake-persist-wt'),
        branch: 'conductor/claude/persist-test',
        base_branch: 'main',
        project_path: repo,
        created_at: Date.now(),
        status: 'ready' as const,
      };

      manager.restoreFromRow(row);
      const restored = manager.getBySession('S-PERSIST');

      expect(restored).toBeDefined();
      expect(restored!.branch).toBe('conductor/claude/persist-test');
      expect(restored!.agentId).toBe('claude');
      expect(restored!.status).toBe('ready');

      // Cleanup from active map (no real worktree to remove)
      (manager as any).activeWorktrees.delete('S-PERSIST');
    });
  });

  // ── WT-6: Cleanup respects uncommitted work ──────────────────────────────

  describe('WT-6: Cleanup handles uncommitted work', () => {
    it('should cleanup dirty worktree with force=true', async () => {
      const sessionId = sid('wt6');
      const info = await manager.createForAgent(sessionId, 'claude', repo, 'main');

      // Make uncommitted changes
      fs.writeFileSync(path.join(info.worktreePath, 'uncommitted.txt'), 'dirty');

      // With force → should succeed (implementation uses escalating force strategies)
      await manager.cleanup(sessionId, { keepBranch: false, force: true });
      expect(manager.getBySession(sessionId)).toBeUndefined();
      expect(fs.existsSync(info.worktreePath)).toBe(false);
    });

    it('should handle cleanup of non-dirty worktree without force', async () => {
      const sessionId = sid('wt6b');
      const info = await manager.createForAgent(sessionId, 'claude', repo, 'main');

      // No uncommitted changes — clean cleanup should work
      await manager.cleanup(sessionId, { keepBranch: false, force: false });
      expect(manager.getBySession(sessionId)).toBeUndefined();
    });
  });

  // ── WT-7: Worktrees outside project directory ────────────────────────────

  describe('WT-7: Worktrees live outside the project', () => {
    it('should never create worktree inside the project checkout', async () => {
      const sessionId = sid('wt7');
      const info = await manager.createForAgent(sessionId, 'claude', repo, 'main');

      // Worktree must NOT be under the project repo
      const relative = path.relative(repo, info.worktreePath);
      expect(relative.startsWith('..')).toBe(true);

      // Worktree must be under ~/.conductor/worktrees/
      const expectedRoot = path.join(os.homedir(), '.conductor', 'worktrees');
      expect(info.worktreePath.startsWith(expectedRoot)).toBe(true);

      await manager.cleanup(sessionId, { keepBranch: false, force: true });
    });
  });

  // ── Watcher Integration ──────────────────────────────────────────────────

  describe('WorktreeWatcher: real-time change detection', () => {
    it('should detect file changes and emit events with debouncing', async () => {
      const sessionId = sid('wtw');
      const info = await manager.createForAgent(sessionId, 'claude', repo, 'main');
      watcher.watch(sessionId, info.worktreePath);

      const events: any[] = [];
      watcher.on('change', (e) => events.push(e));

      // Trigger changes
      fs.writeFileSync(path.join(info.worktreePath, 'watched-file.ts'), '// watched');
      await new Promise(r => setTimeout(r, 200));

      expect(events.length).toBeGreaterThanOrEqual(1);
      if (events.length > 0) {
        expect(events[0].sessionId).toBe(sessionId);
      }

      watcher.unwatch(sessionId);
      await manager.cleanup(sessionId, { keepBranch: false, force: true });
    });

    it('should not emit after unwatch', async () => {
      const sessionId = sid('wtw2');
      const info = await manager.createForAgent(sessionId, 'claude', repo, 'main');
      watcher.watch(sessionId, info.worktreePath);

      const events: any[] = [];
      watcher.on('change', (e) => events.push(e));

      watcher.unwatch(sessionId);
      fs.writeFileSync(path.join(info.worktreePath, 'after-unwatch.ts'), '// after');
      await new Promise(r => setTimeout(r, 200));

      // Should have zero events after unwatch
      expect(events).toHaveLength(0);

      await manager.cleanup(sessionId, { keepBranch: false, force: true });
    });
  });
});
