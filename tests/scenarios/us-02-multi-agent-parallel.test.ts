/**
 * US-02: Multi-Agent Parallel Execution
 *
 * Scenario: Multiple AI agents work on the same project simultaneously,
 * each in their own isolated worktree. They never interfere with each other.
 *
 * Stories: WT-1 (isolation), edge cases for concurrency.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import fs from 'fs';
import path from 'path';
import simpleGit from 'simple-git';
import { WorktreeManager } from '../../src/main/worktree-manager';
import { TaskQueue } from '../../src/main/task-queue';
import { createTestGitRepo, cleanupTestRepo, sid, daemonRequest, daemonSend, PIPE_PATH } from './helpers';
import net from 'net';

/** Check if daemon is reachable before running daemon-dependent tests */
async function isDaemonRunning(): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = net.connect(PIPE_PATH);
    socket.on('connect', () => { socket.destroy(); resolve(true); });
    socket.on('error', () => { resolve(false); });
  });
}

describe('US-02: Multi-Agent Parallel Execution', () => {
  let repo: string;
  let manager: WorktreeManager;
  let taskQueue: TaskQueue;

  const AGENTS = [
    { id: 'claude', capabilities: ['code-gen', 'code-review', 'debugging', 'shell', 'file-ops'] as const },
    { id: 'opencode', capabilities: ['code-gen', 'code-review', 'shell', 'file-ops'] as const },
    { id: 'codex', capabilities: ['code-gen', 'shell', 'file-ops'] as const },
  ];

  beforeAll(async () => {
    repo = await createTestGitRepo();
    manager = new WorktreeManager();
    taskQueue = new TaskQueue();
  });

  afterAll(() => {
    manager.dispose();
    cleanupTestRepo(repo);
  });

  // ── Scenario: 3 agents spawn concurrently ────────────────────────────────

  describe('Scenario: 3 agents work simultaneously on one project', () => {
    it('should give each agent a unique worktree path and branch', async () => {
      const sessions = AGENTS.map(a => sid(`multi-${a.id}`));

      const worktrees = await Promise.all(
        AGENTS.map((a, i) => manager.createForAgent(sessions[i], a.id, repo, 'main'))
      );

      // All paths unique
      const paths = new Set(worktrees.map(w => w.worktreePath));
      expect(paths.size).toBe(3);

      // All branches unique
      const branches = new Set(worktrees.map(w => w.branch));
      expect(branches.size).toBe(3);

      // Each branch matches its agent
      for (let i = 0; i < AGENTS.length; i++) {
        expect(worktrees[i].branch).toContain(AGENTS[i].id);
      }

      // Cleanup
      for (const s of sessions) {
        await manager.cleanup(s, { keepBranch: false, force: true });
      }
    });

    it('should allow independent file changes across worktrees', async () => {
      const s1 = sid('indep-a'), s2 = sid('indep-b'), s3 = sid('indep-c');
      const wt1 = await manager.createForAgent(s1, 'claude', repo, 'main');
      const wt2 = await manager.createForAgent(s2, 'opencode', repo, 'main');
      const wt3 = await manager.createForAgent(s3, 'codex', repo, 'main');

      // Each agent creates their own files
      fs.writeFileSync(path.join(wt1.worktreePath, 'claude-feature.ts'), '// Claude work');
      fs.writeFileSync(path.join(wt2.worktreePath, 'opencode-feature.ts'), '// OpenCode work');
      fs.writeFileSync(path.join(wt3.worktreePath, 'codex-feature.ts'), '// Codex work');

      // Files are only visible in their own worktree
      expect(fs.existsSync(path.join(wt1.worktreePath, 'claude-feature.ts'))).toBe(true);
      expect(fs.existsSync(path.join(wt2.worktreePath, 'claude-feature.ts'))).toBe(false);
      expect(fs.existsSync(path.join(wt3.worktreePath, 'claude-feature.ts'))).toBe(false);

      expect(fs.existsSync(path.join(wt2.worktreePath, 'opencode-feature.ts'))).toBe(true);
      expect(fs.existsSync(path.join(wt1.worktreePath, 'opencode-feature.ts'))).toBe(false);

      expect(fs.existsSync(path.join(wt3.worktreePath, 'codex-feature.ts'))).toBe(true);
      expect(fs.existsSync(path.join(wt1.worktreePath, 'codex-feature.ts'))).toBe(false);

      // Cleanup
      for (const s of [s1, s2, s3]) {
        await manager.cleanup(s, { keepBranch: false, force: true });
      }
    });

    it('should route different tasks to different agents', () => {
      const task1 = taskQueue.enqueue({
        title: 'Debug auth module',
        description: 'Fix login timeout',
        priority: 'high',
        requiredCapabilities: ['debugging', 'code-gen'],
      });

      const task2 = taskQueue.enqueue({
        title: 'Write unit tests',
        description: 'Add tests for API layer',
        priority: 'normal',
        requiredCapabilities: ['code-gen', 'shell'],
      });

      // Task 1 needs 'debugging' — only claude has it
      const routed1 = taskQueue.tryRoute(task1.id, AGENTS);
      expect(routed1).toBe('claude');

      // Task 2 can go to any agent, but claude has most capabilities (wins tie)
      const routed2 = taskQueue.tryRoute(task2.id, AGENTS);
      expect(routed2).toBe('claude'); // highest score (5 caps)

      // Verify tasks are queued
      expect(taskQueue.get(task1.id)!.status).toBe('queued');
      expect(taskQueue.get(task2.id)!.status).toBe('queued');
    });
  });

  // ── Scenario: Daemon-level multi-session ──────────────────────────────────

  describe('Scenario: Daemon manages multiple concurrent sessions', () => {
    it('should list all active sessions', async () => {
      if (!(await isDaemonRunning())) {
        return; // Skip if daemon not available
      }

      const spawned1 = await daemonRequest({
        type: 'spawn', agent: 'cmd.exe', cwd: '.', cols: 80, rows: 24,
        agentSessionId: '', isRestore: false,
      });
      const spawned2 = await daemonRequest({
        type: 'spawn', agent: 'cmd.exe', cwd: '.', cols: 80, rows: 24,
        agentSessionId: '', isRestore: false,
      });

      const list = await daemonRequest({ type: 'list' });
      expect(list.type).toBe('list-response');
      expect(list.sessions.length).toBeGreaterThanOrEqual(2);

      const ids = list.sessions.map((s: any) => s.sessionId);
      expect(ids).toContain(spawned1.sessionId);
      expect(ids).toContain(spawned2.sessionId);

      daemonSend({ type: 'kill', sessionId: spawned1.sessionId });
      daemonSend({ type: 'kill', sessionId: spawned2.sessionId });
    });
  });
});
