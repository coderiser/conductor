import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import path from 'path';
import fs from 'fs';
import os from 'os';
import simpleGit from 'simple-git';
import { WorktreeManager } from '../src/main/worktree-manager';
import { WorktreeWatcher } from '../src/main/worktree-watcher';
import { TaskQueue } from '../src/main/task-queue';
import { ContextShare } from '../src/main/context-share';

describe('Phase 4 E2E — Worktree + Task + Context', () => {
  let manager: WorktreeManager;
  let watcher: WorktreeWatcher;
  let taskQueue: TaskQueue;
  let contextShare: ContextShare;
  let testRepo: string;
  let git: ReturnType<typeof simpleGit>;

  beforeEach(async () => {
    testRepo = path.join(os.tmpdir(), 'conductor-e2e-' + Math.random().toString(36).slice(2, 8));
    fs.mkdirSync(testRepo, { recursive: true });
    git = simpleGit(testRepo);
    await git.init();
    await git.addConfig('user.name', 'e2e');
    await git.addConfig('user.email', 'e2e@test.com');
    fs.writeFileSync(path.join(testRepo, 'src.ts'), '// main source');
    await git.add('src.ts');
    await git.commit('initial');
    manager = new WorktreeManager();
    watcher = new WorktreeWatcher({ debounceMs: 50 });
    taskQueue = new TaskQueue();
    contextShare = new ContextShare();
  });

  afterEach(() => {
    watcher.dispose();
    manager.dispose();
    try { fs.rmSync(testRepo, { recursive: true, force: true }); } catch {}
  });

  it('should run full pipeline: create worktree -> task dispatch -> context share -> cleanup', async () => {
    // Step 1: Create a worktree for the agent session
    const info = await manager.createForAgent('S-E2E', 'claude', testRepo, 'main');
    expect(info.status).toBe('ready');
    expect(fs.existsSync(info.worktreePath)).toBe(true);

    // Step 2: Make a change in the worktree
    fs.writeFileSync(path.join(info.worktreePath, 'feature.ts'), '// new feature');
    const wtGit = simpleGit(info.worktreePath);
    await wtGit.add('feature.ts');
    await wtGit.commit('add feature');

    // Step 3: Enqueue and dispatch a task linked to this worktree
    const task = taskQueue.enqueue({
      title: 'Build feature X',
      description: 'Implement feature X in isolated worktree',
      priority: 'high',
      requiredCapabilities: ['code-gen', 'shell'],
    });
    taskQueue.dispatch(task.id, 'S-E2E', info.worktreePath);
    const dispatched = taskQueue.get(task.id);
    expect(dispatched!.status).toBe('running');
    expect(dispatched!.worktreePath).toBe(info.worktreePath);

    // Step 4: Share context from this session
    const entry = contextShare.publish('S-E2E', 'claude', {
      contextType: 'finding',
      title: 'Feature X ready',
      body: 'Implemented feature X in isolated worktree. Branch: ' + info.branch,
      tags: ['feature', 'done'],
      priority: 'high',
    });
    expect(entry.sessionId).toBe('S-E2E');
    expect(entry.agentId).toBe('claude');

    // Verify context is searchable
    const results = contextShare.search({ contextType: 'finding' });
    expect(results.length).toBe(1);

    // Step 5: Verify worktree list
    const all = manager.list();
    expect(all.length).toBe(1);
    expect(all[0].branch).toBe(info.branch);

    // Step 6: Clean up the worktree
    await manager.cleanup('S-E2E', { keepBranch: false, force: false });
    expect(manager.getBySession('S-E2E')).toBeUndefined();
    expect(fs.existsSync(info.worktreePath)).toBe(false);
  });

  it('should create two worktrees and detect conflicts', async () => {
    const a = await manager.createForAgent('S-A', 'claude', testRepo, 'main');
    const b = await manager.createForAgent('S-B', 'opencode', testRepo, 'main');

    // Modify the same file in both worktrees (unstaged diff)
    fs.writeFileSync(path.join(a.worktreePath, 'src.ts'), '// changed by claude');
    fs.writeFileSync(path.join(b.worktreePath, 'src.ts'), '// changed by opencode');

    const report = await manager.detectConflicts();
    expect(report.hasConflicts).toBe(true);
    expect(report.conflicts.length).toBe(1);
    expect(report.conflicts[0].file).toBe('src.ts');

    // Clean up both
    await manager.cleanup('S-A', { keepBranch: false, force: true });
    await manager.cleanup('S-B', { keepBranch: false, force: true });
    expect(manager.list().length).toBe(0);
  });

  it('should persist worktree to row and restore', () => {
    // Simulate a restored row from database
    const row = {
      id: 'wt-001', session_id: 'S-RESTORE', agent_id: 'claude',
      worktree_path: '/tmp/fake-worktree', branch: 'conductor/claude/abc',
      base_branch: 'main', project_path: testRepo,
      created_at: Date.now(), status: 'ready',
    };
    manager.restoreFromRow(row);
    const restored = manager.getBySession('S-RESTORE');
    expect(restored).toBeDefined();
    expect(restored!.branch).toBe('conductor/claude/abc');
  });

  it('should track watcher events when file changes', async () => {
    const info = await manager.createForAgent('S-W', 'claude', testRepo, 'main');
    watcher.watch('S-W', info.worktreePath);

    const events: any[] = [];
    watcher.on('change', (e) => events.push(e));

    // Modify a file — should trigger watcher after debounce
    fs.writeFileSync(path.join(info.worktreePath, 'watched.ts'), '// watched');
    await new Promise(r => setTimeout(r, 150));

    expect(events.length).toBeGreaterThanOrEqual(1);
    if (events.length > 0) {
      expect(events[0].sessionId).toBe('S-W');
      expect(events[0].files).toContain('watched.ts');
    }

    watcher.unwatch('S-W');
    await manager.cleanup('S-W', { keepBranch: false, force: true });
  });
});
