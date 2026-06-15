/**
 * US-08: Full Pipeline — End-to-End User Journey
 *
 * Integration scenario: User spawns an agent → worktree created → task assigned
 * → agent reports progress → shares context → completes task → cleanup.
 *
 * This test validates the entire flow as a single user story.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import fs from 'fs';
import path from 'path';
import simpleGit from 'simple-git';
import { WorktreeManager } from '../../src/main/worktree-manager';
import { WorktreeWatcher } from '../../src/main/worktree-watcher';
import { TaskQueue } from '../../src/main/task-queue';
import { ContextShare } from '../../src/main/context-share';
import { AgentWatchdog } from '../../src/main/agent-watchdog';
import { extractProtocolMessage } from '../../src/common/agent-protocol';
import type { TaskProgressPayload, ContextSharePayload } from '../../src/common/agent-protocol';
import { createTestGitRepo, cleanupTestRepo, sid, daemonRequest, daemonSend, PIPE_PATH } from './helpers';
import net from 'net';

async function isDaemonRunning(): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = net.connect(PIPE_PATH);
    socket.on('connect', () => { socket.destroy(); resolve(true); });
    socket.on('error', () => { resolve(false); });
  });
}

describe('US-08: Full Pipeline — End-to-End User Journey', () => {
  let repo: string;
  let manager: WorktreeManager;
  let watcher: WorktreeWatcher;
  let taskQueue: TaskQueue;
  let contextShare: ContextShare;
  let watchdog: AgentWatchdog;
  let daemonAvailable: boolean;

  beforeAll(async () => {
    repo = await createTestGitRepo();
    manager = new WorktreeManager();
    watcher = new WorktreeWatcher({ debounceMs: 50 });
    taskQueue = new TaskQueue();
    contextShare = new ContextShare();
    watchdog = new AgentWatchdog({ checkIntervalMs: 60_000, unhealthyThreshold: 20 });
    daemonAvailable = await isDaemonRunning();
  });

  afterAll(() => {
    watchdog.stop();
    watcher.dispose();
    manager.dispose();
    cleanupTestRepo(repo);
  });

  it('should run complete user journey: spawn → worktree → task → progress → context → complete → cleanup', async () => {
    const sessionId = sid('journey');

    // ═══ Step 1: Create worktree isolation ══════════════════════════════════
    const wt = await manager.createForAgent(sessionId, 'claude', repo, 'main');
    expect(wt.status).toBe('ready');
    expect(fs.existsSync(wt.worktreePath)).toBe(true);

    // Register with watchdog
    watchdog.register(sessionId, 'claude', { autoRestart: false });

    // Start watching for changes
    watcher.watch(sessionId, wt.worktreePath);

    // ═══ Step 2: Spawn agent in worktree via daemon ════════════════════════
    let spawned: any = null;
    if (daemonAvailable) {
      spawned = await daemonRequest({
        type: 'spawn',
        agent: 'claude',
        cwd: wt.worktreePath,
        cols: 120, rows: 40,
        agentSessionId: sessionId,
        isRestore: false,
      });
      expect(spawned.type).toBe('spawned');
      expect(spawned.agent).toBe('claude');
    }

    // ═══ Step 3: Submit task and route to agent ════════════════════════════
    const task = taskQueue.enqueue({
      title: 'Implement user auth endpoint',
      description: 'Create POST /api/auth/login with JWT',
      priority: 'high',
      requiredCapabilities: ['code-gen', 'shell', 'file-ops'],
    });

    const agents = [
      { id: 'claude', capabilities: ['code-gen', 'code-review', 'debugging', 'shell', 'file-ops', 'web'] as any[] },
      { id: 'opencode', capabilities: ['code-gen', 'code-review', 'shell', 'file-ops'] as any[] },
    ];
    const routed = taskQueue.tryRoute(task.id, agents);
    expect(routed).toBe('claude');

    // Dispatch task to session
    taskQueue.dispatch(task.id, sessionId, wt.worktreePath);
    expect(taskQueue.get(task.id)!.status).toBe('running');

    // ═══ Step 4: Simulate agent reporting progress via protocol ════════════
    const progressLine = `[TASK:${task.id}] progress=50% status=running message=Writing auth module`;
    const progressMsg = extractProtocolMessage(sessionId, 'claude', progressLine);
    expect(progressMsg).not.toBeNull();
    expect(progressMsg!.type).toBe('task-progress');

    const progressPayload = progressMsg!.payload as TaskProgressPayload;
    expect(progressPayload.progress).toBe(0.5);

    // Update task queue with parsed progress
    taskQueue.updateProgress(task.id, progressPayload.progress, progressPayload.message);
    expect(taskQueue.get(task.id)!.progress).toBe(0.5);

    // ═══ Step 5: Agent shares context with other agents ════════════════════
    const ctxLine = '[CTX:finding] {"title":"JWT library selected","body":"Using jsonwebtoken@9"}';
    const ctxMsg = extractProtocolMessage(sessionId, 'claude', ctxLine);
    expect(ctxMsg).not.toBeNull();

    const ctxPayload = ctxMsg!.payload as ContextSharePayload;
    const entry = contextShare.publish(sessionId, 'claude', {
      contextType: ctxPayload.contextType,
      title: ctxPayload.title,
      body: ctxPayload.body,
      tags: ['jwt', 'auth'],
      priority: 'normal',
    });
    expect(entry.id).toMatch(/^ctx-/);

    // Another agent can search and find it
    const found = contextShare.search({ tags: ['jwt'] });
    expect(found).toHaveLength(1);
    expect(found[0].title).toBe('JWT library selected');

    // ═══ Step 6: Agent completes task ══════════════════════════════════════
    taskQueue.complete(task.id, 'Auth endpoint implemented with JWT, tests passing');
    const completed = taskQueue.get(task.id)!;
    expect(completed.status).toBe('done');
    expect(completed.progress).toBe(1);
    expect(completed.result).toContain('Auth endpoint');

    // Mark context as consumed
    contextShare.markConsumed(entry.id);
    expect(contextShare.get(entry.id)!.consumed).toBe(true);

    // ═══ Step 7: Verify agent health ═══════════════════════════════════════
    watchdog.updateActivity(sessionId);
    const health = watchdog.getHealth(sessionId);
    expect(health).toBeDefined();
    expect(health!.isUnhealthy).toBe(false);

    // ═══ Step 8: Simulate agent making changes in worktree ═════════════════
    fs.writeFileSync(
      path.join(wt.worktreePath, 'auth.ts'),
      'export function login(user: string, pass: string) { return "jwt-token"; }'
    );
    const wtGit = simpleGit(wt.worktreePath);
    await wtGit.add('.').commit('feat: auth endpoint');

    // ═══ Step 9: Kill daemon session ═══════════════════════════════════════
    if (spawned) {
      daemonSend({ type: 'kill', sessionId: spawned.sessionId });
    }

    // ═══ Step 10: Cleanup worktree ═════════════════════════════════════════
    watcher.unwatch(sessionId);
    watchdog.unregister(sessionId);
    await manager.cleanup(sessionId, { keepBranch: false, force: true });

    expect(manager.getBySession(sessionId)).toBeUndefined();
    expect(fs.existsSync(wt.worktreePath)).toBe(false);
  });

  it('should handle multi-agent pipeline: 2 agents work, conflict detected', async () => {
    const s1 = sid('multi-a'), s2 = sid('multi-b');

    // Create worktrees
    const wt1 = await manager.createForAgent(s1, 'claude', repo, 'main');
    const wt2 = await manager.createForAgent(s2, 'opencode', repo, 'main');

    // Submit 2 tasks
    const t1 = taskQueue.enqueue({
      title: 'Refactor auth module', description: '', priority: 'high',
      requiredCapabilities: ['code-gen'],
    });
    const t2 = taskQueue.enqueue({
      title: 'Fix auth tests', description: '', priority: 'normal',
      requiredCapabilities: ['code-gen'],
    });

    // Route to different agents
    taskQueue.tryRoute(t1.id, [
      { id: 'claude', capabilities: ['code-gen', 'debugging'] as any[] },
    ]);
    taskQueue.tryRoute(t2.id, [
      { id: 'opencode', capabilities: ['code-gen', 'shell'] as any[] },
    ]);

    taskQueue.dispatch(t1.id, s1, wt1.worktreePath);
    taskQueue.dispatch(t2.id, s2, wt2.worktreePath);

    // Both agents modify the same file → conflict (uncommitted for `git diff HEAD`)
    fs.writeFileSync(`${wt1.worktreePath}/main.ts`, '// Claude refactored');
    fs.writeFileSync(`${wt2.worktreePath}/main.ts`, '// OpenCode fixed');

    const conflicts = await manager.detectConflicts();
    expect(conflicts.hasConflicts).toBe(true);
    expect(conflicts.conflicts.some(c => c.file === 'main.ts')).toBe(true);

    // Complete tasks
    taskQueue.complete(t1.id, 'Refactored');
    taskQueue.complete(t2.id, 'Tests fixed');

    // Cleanup
    for (const s of [s1, s2]) {
      await manager.cleanup(s, { keepBranch: false, force: true });
    }
  });
});
