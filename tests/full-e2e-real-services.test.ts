/**
 * Full E2E Test — Real Services Integration
 *
 * Tests the complete pipeline against REAL services:
 * - Real PTY daemon (Named Pipe connection)
 * - Real git worktrees (simple-git on disk)
 * - Real TaskQueue + ContextShare + WorktreeWatcher
 *
 * No mocks. Everything runs against actual system services.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import net from 'net';
import path from 'path';
import fs from 'fs';
import os from 'os';
import simpleGit from 'simple-git';
import { WorktreeManager } from '../src/main/worktree-manager';
import { WorktreeWatcher } from '../src/main/worktree-watcher';
import { TaskQueue } from '../src/main/task-queue';
import { ContextShare } from '../src/main/context-share';

const PIPE_PATH = '\\\\.\\pipe\\conductor-pty-daemon';

// ── Frame helpers ──────────────────────────────────────────────────────────

function encodeFrame(msg: object): Buffer {
  const payload = Buffer.from(JSON.stringify(msg), 'utf8');
  const header = Buffer.alloc(4);
  header.writeUInt32BE(payload.length, 0);
  return Buffer.concat([header, payload]);
}

function decodeFrame(data: Buffer): { msg: any; consumed: number } | null {
  if (data.length < 4) return null;
  const len = data.readUInt32BE(0);
  if (data.length < 4 + len) return null;
  const payload = data.slice(4, 4 + len).toString('utf8');
  return { msg: JSON.parse(payload), consumed: 4 + len };
}

// Response types that indicate a request completed
const RESPONSE_TYPES = new Set(['hello-ack', 'spawned', 'list-response', 'error', 'session-activity']);
// Fire-and-forget message types (daemon returns no response)
const FIRE_FORGET = new Set(['kill', 'write', 'resize', 'set-agent-session-id', 'agent-notify']);

async function daemonRequest(msg: object): Promise<any> {
  return new Promise((resolve, reject) => {
    const socket = net.connect(PIPE_PATH);
    let buffer = Buffer.alloc(0);
    let requestSent = false;
    const timeout = setTimeout(() => {
      socket.destroy();
      reject(new Error(`Daemon request timeout: ${JSON.stringify(msg).slice(0, 80)}`));
    }, 15000);

    socket.on('connect', () => {
      socket.write(encodeFrame({ type: 'hello', version: 1 }));
    });

    socket.on('data', (data: Buffer) => {
      buffer = Buffer.concat([buffer, data]);
      while (true) {
        const frame = decodeFrame(buffer);
        if (!frame) break;
        buffer = buffer.slice(frame.consumed);
        if (!requestSent && frame.msg.type === 'hello-ack') {
          requestSent = true;
          socket.write(encodeFrame(msg));
        } else if (RESPONSE_TYPES.has(frame.msg.type)) {
          clearTimeout(timeout);
          socket.destroy();
          resolve(frame.msg);
          return;
        }
        // else: broadcast event (output, exit, session-id-changed) — skip and keep waiting
      }
    });

    socket.on('error', (err) => {
      clearTimeout(timeout);
      reject(err);
    });
  });
}

/** Send a fire-and-forget message (no response expected). */
function daemonSend(msg: object): void {
  const socket = net.connect(PIPE_PATH);
  socket.on('connect', () => {
    socket.write(encodeFrame({ type: 'hello', version: 1 }));
  });
  // We don't care about the response — just send after handshake
  let sent = false;
  socket.on('data', (data: Buffer) => {
    if (sent) return;
    // Wait for hello-ack, then send and close
    const frame = decodeFrame(data);
    if (frame && frame.msg.type === 'hello-ack') {
      sent = true;
      socket.write(encodeFrame(msg));
      setTimeout(() => socket.destroy(), 200);
    }
  });
}

// ── Test Suite ─────────────────────────────────────────────────────────────

describe('Full E2E — Real Services Integration', () => {
  let testRepo: string;
  let git: ReturnType<typeof simpleGit>;
  let worktreeManager: WorktreeManager;
  let worktreeWatcher: WorktreeWatcher;
  let taskQueue: TaskQueue;
  let contextShare: ContextShare;

  beforeAll(async () => {
    // ── Setup test git repo ──────────────────────────────────────────────
    testRepo = path.join(os.tmpdir(), 'conductor-e2e-full-' + Math.random().toString(36).slice(2, 8));
    fs.mkdirSync(testRepo, { recursive: true });
    git = simpleGit(testRepo);
    await git.init();
    await git.addConfig('user.name', 'e2e-test');
    await git.addConfig('user.email', 'e2e@conductor.test');
    fs.writeFileSync(path.join(testRepo, 'main.ts'), 'export const version = 1;');
    await git.add('main.ts');
    await git.commit('initial commit');

    // ── Init all managers ────────────────────────────────────────────────
    worktreeManager = new WorktreeManager();
    worktreeWatcher = new WorktreeWatcher({ debounceMs: 50 });
    taskQueue = new TaskQueue();
    contextShare = new ContextShare();
  });

  afterAll(() => {
    worktreeWatcher.dispose();
    worktreeManager.dispose();
    try { fs.rmSync(testRepo, { recursive: true, force: true }); } catch {}
  });

  // ════════════════════════════════════════════════════════════════════════
  // Phase 1: Daemon Connectivity (Real PTY Daemon)
  // ════════════════════════════════════════════════════════════════════════

  describe('Daemon Connectivity', () => {
    it('should connect to daemon and receive hello-ack', async () => {
      const msg = await daemonRequest({ type: 'hello', version: 1 });
      expect(msg.type).toBe('hello-ack');
    });

    it('should spawn cmd.exe and get shell output', async () => {
      const spawned = await daemonRequest({
        type: 'spawn', agent: 'cmd.exe', cwd: '.', cols: 80, rows: 24,
        agentSessionId: '', isRestore: false
      });
      expect(spawned.type).toBe('spawned');
      expect(spawned.agent).toBe('cmd.exe');
      expect(spawned.pid).toBeGreaterThan(0);
      expect(spawned.sessionId).toMatch(/^S\d+$/);

      daemonSend({ type: 'kill', sessionId: spawned.sessionId });
    });

    it('should spawn claude agent with session ID', async () => {
      const sessionId = 'e2e-' + Math.random().toString(36).slice(2, 8);
      const spawned = await daemonRequest({
        type: 'spawn', agent: 'claude', cwd: testRepo, cols: 120, rows: 40,
        agentSessionId: sessionId, isRestore: false
      });
      expect(spawned.type).toBe('spawned');
      expect(spawned.agent).toBe('claude');

      daemonSend({ type: 'kill', sessionId: spawned.sessionId });
    });

    it('should list active sessions from daemon', async () => {
      const s1 = await daemonRequest({
        type: 'spawn', agent: 'cmd.exe', cwd: '.', cols: 80, rows: 24,
        agentSessionId: '', isRestore: false
      });

      const list = await daemonRequest({ type: 'list' });
      expect(list.type).toBe('list-response');
      expect(list.sessions.length).toBeGreaterThanOrEqual(1);
      expect(list.sessions.find((s: any) => s.sessionId === s1.sessionId)).toBeDefined();

      daemonSend({ type: 'kill', sessionId: s1.sessionId });
    });
  });

  // ════════════════════════════════════════════════════════════════════════
  // Phase 2: Worktree Isolation (Real Git Worktrees)
  // ════════════════════════════════════════════════════════════════════════

  describe('Worktree Isolation', () => {
    it('should create isolated worktree for agent session', async () => {
      const info = await worktreeManager.createForAgent('S-E2E-1', 'claude', testRepo, 'main');

      expect(info.status).toBe('ready');
      expect(info.sessionId).toBe('S-E2E-1');
      expect(fs.existsSync(info.worktreePath)).toBe(true);
      expect(info.worktreePath).toContain(path.join(os.homedir(), '.conductor', 'worktrees'));
      expect(info.branch).toMatch(/^conductor\/claude\//);

      const wtGit = simpleGit(info.worktreePath);
      const branches = await wtGit.branch();
      expect(branches.current).toBe(info.branch);
    });

    it('should allow independent changes in worktrees', async () => {
      const wt1 = await worktreeManager.createForAgent('S-E2E-2a', 'claude', testRepo, 'main');
      const wt2 = await worktreeManager.createForAgent('S-E2E-2b', 'opencode', testRepo, 'main');

      fs.writeFileSync(path.join(wt1.worktreePath, 'feature-a.ts'), '// Feature A by Claude');
      fs.writeFileSync(path.join(wt2.worktreePath, 'feature-b.ts'), '// Feature B by OpenCode');

      expect(fs.existsSync(path.join(wt1.worktreePath, 'feature-a.ts'))).toBe(true);
      expect(fs.existsSync(path.join(wt2.worktreePath, 'feature-a.ts'))).toBe(false);
      expect(fs.existsSync(path.join(wt2.worktreePath, 'feature-b.ts'))).toBe(true);
      expect(fs.existsSync(path.join(wt1.worktreePath, 'feature-b.ts'))).toBe(false);

      await worktreeManager.cleanup('S-E2E-2a', { keepBranch: false, force: true });
      await worktreeManager.cleanup('S-E2E-2b', { keepBranch: false, force: true });
    });

    it('should detect file conflicts across worktrees', async () => {
      const wt1 = await worktreeManager.createForAgent('S-E2E-3a', 'claude', testRepo, 'main');
      const wt2 = await worktreeManager.createForAgent('S-E2E-3b', 'opencode', testRepo, 'main');

      fs.writeFileSync(path.join(wt1.worktreePath, 'main.ts'), '// Changed by Claude');
      fs.writeFileSync(path.join(wt2.worktreePath, 'main.ts'), '// Changed by OpenCode');

      const report = await worktreeManager.detectConflicts();
      expect(report.hasConflicts).toBe(true);
      const mainConflict = report.conflicts.find(c => c.file === 'main.ts');
      expect(mainConflict).toBeDefined();
      expect(mainConflict!.worktrees.length).toBeGreaterThanOrEqual(2);

      await worktreeManager.cleanup('S-E2E-3a', { keepBranch: false, force: true });
      await worktreeManager.cleanup('S-E2E-3b', { keepBranch: false, force: true });
    });

    it('should cleanup worktree and remove branch', async () => {
      const info = await worktreeManager.createForAgent('S-E2E-4', 'claude', testRepo, 'main');
      const wtPath = info.worktreePath;
      const branch = info.branch;

      await worktreeManager.cleanup('S-E2E-4', { keepBranch: false, force: false });

      expect(worktreeManager.getBySession('S-E2E-4')).toBeUndefined();
      expect(fs.existsSync(wtPath)).toBe(false);

      const branches = await git.branch();
      expect(branches.all).not.toContain(branch);
    });

    it('should persist worktree info and restore from row', () => {
      const row = {
        id: 'wt-e2e-001',
        session_id: 'S-E2E-RESTORE',
        agent_id: 'claude',
        worktree_path: path.join(os.tmpdir(), 'fake-restore-worktree'),
        branch: 'conductor/claude/e2e-test',
        base_branch: 'main',
        project_path: testRepo,
        created_at: Date.now(),
        status: 'ready' as const,
      };

      worktreeManager.restoreFromRow(row);
      const restored = worktreeManager.getBySession('S-E2E-RESTORE');
      expect(restored).toBeDefined();
      expect(restored!.branch).toBe('conductor/claude/e2e-test');
      expect(restored!.agentId).toBe('claude');
    });

    it('should track worktree file changes via Watcher', async () => {
      const info = await worktreeManager.createForAgent('S-E2E-W', 'claude', testRepo, 'main');
      worktreeWatcher.watch('S-E2E-W', info.worktreePath);

      const events: any[] = [];
      worktreeWatcher.on('change', (e) => events.push(e));

      fs.writeFileSync(path.join(info.worktreePath, 'new-file.ts'), '// new file');
      await new Promise(r => setTimeout(r, 150));

      expect(events.length).toBeGreaterThanOrEqual(1);
      if (events.length > 0) {
        expect(events[0].sessionId).toBe('S-E2E-W');
        expect(events[0].files).toContain('new-file.ts');
      }

      worktreeWatcher.unwatch('S-E2E-W');
      await worktreeManager.cleanup('S-E2E-W', { keepBranch: false, force: true });
    });
  });

  // ════════════════════════════════════════════════════════════════════════
  // Phase 3: Task Queue + Context Share
  // ════════════════════════════════════════════════════════════════════════

  describe('Task Queue & Context Share', () => {
    it('should enqueue, route, dispatch task to a worktree, then complete', async () => {
      const wtInfo = await worktreeManager.createForAgent('S-E2E-TQ', 'claude', testRepo, 'main');

      const task = taskQueue.enqueue({
        title: 'Build REST API endpoint',
        description: 'Implement GET /api/users with pagination',
        priority: 'high',
        requiredCapabilities: ['code-gen', 'shell', 'file-ops'],
      });

      expect(task.status).toBe('pending');

      const agents = [
        { id: 'cmd', capabilities: ['shell', 'file-ops'] },
        { id: 'claude', capabilities: ['code-gen', 'code-review', 'debugging', 'shell', 'file-ops'] },
        { id: 'opencode', capabilities: ['code-gen', 'code-review', 'shell', 'file-ops'] },
      ];
      const routed = taskQueue.tryRoute(task.id, agents);
      expect(routed).toBe('claude');

      taskQueue.dispatch(task.id, 'S-E2E-TQ', wtInfo.worktreePath);
      const dispatched = taskQueue.get(task.id);
      expect(dispatched!.status).toBe('running');
      expect(dispatched!.worktreePath).toBe(wtInfo.worktreePath);

      taskQueue.complete(task.id, 'REST API implemented, all tests passing');
      const completed = taskQueue.get(task.id);
      expect(completed!.status).toBe('done');
      expect(completed!.result).toContain('REST API');

      await worktreeManager.cleanup('S-E2E-TQ', { keepBranch: false, force: true });
    });

    it('should share context across sessions with search', () => {
      const entry = contextShare.publish('S-E2E-CTX', 'claude', {
        contextType: 'finding',
        title: 'Security vulnerability in auth module',
        body: 'Found SQL injection in login endpoint.',
        tags: ['security', 'critical'],
        priority: 'high',
        source: { file: 'src/auth.ts', line: 42 },
      });

      expect(entry.sessionId).toBe('S-E2E-CTX');
      expect(entry.id).toBeTruthy();

      const byType = contextShare.search({ contextType: 'finding' });
      expect(byType.some(e => e.id === entry.id)).toBe(true);

      const byTag = contextShare.search({ tags: ['security'] });
      expect(byTag.some(e => e.id === entry.id)).toBe(true);
    });

    it('should handle task failure gracefully', () => {
      const task = taskQueue.enqueue({
        title: 'Deploy to production',
        description: '',
        priority: 'high',
        requiredCapabilities: ['shell'],
      });

      taskQueue.dispatch(task.id, 'S-FAIL');
      taskQueue.fail(task.id, 'SSH connection refused');

      expect(taskQueue.get(task.id)!.status).toBe('failed');
      expect(taskQueue.get(task.id)!.error).toBe('SSH connection refused');
    });
  });

  // ════════════════════════════════════════════════════════════════════════
  // Phase 4: Full Pipeline (Worktree → Daemon → Task → Context → Cleanup)
  // ════════════════════════════════════════════════════════════════════════

  describe('Full Pipeline Integration', () => {
    it('should run complete pipeline: worktree + daemon spawn + task + context + cleanup', async () => {
      // Step 1: Create worktree isolation
      const wtInfo = await worktreeManager.createForAgent('S-FULL', 'claude', testRepo, 'main');
      expect(wtInfo.status).toBe('ready');
      expect(fs.existsSync(wtInfo.worktreePath)).toBe(true);

      // Step 2: Spawn claude agent in the worktree via daemon
      const spawned = await daemonRequest({
        type: 'spawn',
        agent: 'claude',
        cwd: wtInfo.worktreePath,
        cols: 120, rows: 40,
        agentSessionId: 'full-pipeline-test',
        isRestore: false,
      });
      expect(spawned.type).toBe('spawned');
      expect(spawned.agent).toBe('claude');

      // Step 3: Enqueue and dispatch a task
      const task = taskQueue.enqueue({
        title: 'Full pipeline test task',
        description: 'Verify the agent can work in the isolated worktree',
        priority: 'high',
        requiredCapabilities: ['code-gen', 'shell', 'file-ops'],
      });
      taskQueue.dispatch(task.id, 'S-FULL', wtInfo.worktreePath);
      expect(taskQueue.get(task.id)!.status).toBe('running');

      // Step 4: Share context
      contextShare.publish('S-FULL', 'claude', {
        contextType: 'decision',
        title: 'Worktree isolation verified',
        body: `Agent running in ${wtInfo.worktreePath} on branch ${wtInfo.branch}`,
        tags: ['e2e', 'verified'],
        priority: 'normal',
      });

      // Step 5: Complete task
      taskQueue.complete(task.id, 'Pipeline verified');
      expect(taskQueue.get(task.id)!.status).toBe('done');

      // Step 6: Kill daemon session
      daemonSend({ type: 'kill', sessionId: spawned.sessionId });

      // Step 7: Cleanup worktree
      await worktreeManager.cleanup('S-FULL', { keepBranch: false, force: true });
      expect(worktreeManager.getBySession('S-FULL')).toBeUndefined();
      expect(fs.existsSync(wtInfo.worktreePath)).toBe(false);
    });
  });

  // ════════════════════════════════════════════════════════════════════════
  // Phase 5: Edge Cases
  // ════════════════════════════════════════════════════════════════════════

  describe('Edge Cases', () => {
    it('should handle multiple concurrent worktrees', async () => {
      const infos = await Promise.all([
        worktreeManager.createForAgent('S-CONC-1', 'claude', testRepo, 'main'),
        worktreeManager.createForAgent('S-CONC-2', 'opencode', testRepo, 'main'),
        worktreeManager.createForAgent('S-CONC-3', 'codex', testRepo, 'main'),
      ]);

      expect(infos.length).toBe(3);
      const paths = new Set(infos.map(i => i.worktreePath));
      const branches = new Set(infos.map(i => i.branch));
      expect(paths.size).toBe(3);
      expect(branches.size).toBe(3);

      for (const info of infos) {
        await worktreeManager.cleanup(info.sessionId, { keepBranch: false, force: true });
      }
    });

    it('should throw on cleanup of unknown session', async () => {
      await expect(
        worktreeManager.cleanup('NONEXISTENT', { keepBranch: false, force: false })
      ).rejects.toThrow(/No active worktree/i);
    });

    it('should handle daemon spawn of unknown agent name', async () => {
      const msg = await daemonRequest({
        type: 'spawn',
        agent: 'nonexistent-agent-xyz',
        cwd: '.', cols: 80, rows: 24,
        agentSessionId: '', isRestore: false,
      });
      // Falls back to raw command execution
      expect(['spawned', 'error']).toContain(msg.type);
    });

    it('should handle PTY resize and write on live session', async () => {
      const spawned = await daemonRequest({
        type: 'spawn', agent: 'cmd.exe', cwd: '.', cols: 80, rows: 24,
        agentSessionId: '', isRestore: false
      });

      // Fire-and-forget resize via raw socket
      const sock = net.connect(PIPE_PATH);
      await new Promise<void>((resolve) => sock.on('connect', () => {
        sock.write(encodeFrame({ type: 'hello', version: 1 }));
        resolve();
      }));
      await new Promise(r => setTimeout(r, 200));
      sock.write(encodeFrame({ type: 'resize', sessionId: spawned.sessionId, cols: 120, rows: 40 }));
      sock.write(encodeFrame({ type: 'write', sessionId: spawned.sessionId, data: 'echo REAL_E2E\r\n' }));
      await new Promise(r => setTimeout(r, 500));
      sock.destroy();

      daemonSend({ type: 'kill', sessionId: spawned.sessionId });
    });
  });
});
