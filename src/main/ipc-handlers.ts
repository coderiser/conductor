import { ipcMain, BrowserWindow } from 'electron';
import { execFileSync } from 'child_process';
import { spawn } from 'child_process';
import { DaemonClient } from './daemon-client.js';
import { saveLayout, loadLayout, saveTask, saveContextEntry, saveWorktree, loadWorktrees, deleteWorktree } from './database.js';
import { loadAgentConfig, isAgentInstalled } from './agent-config.js';
import { getGitStatus } from './git-integration.js';
import { StatsCollector } from './stats-collector.js';
import { NotifyCenter } from './notify-center.js';
import type { DaemonMessage } from '../daemon/protocol/messages.js';
import type { TaskQueue } from './task-queue.js';
import type { ContextShare } from './context-share.js';
import type { TaskRecord } from '../common/stats-types';
import type { AgentCapability } from '../common/agent-protocol';
import type { WorktreeManager } from './worktree-manager.js';
import type { WorktreeWatcher } from './worktree-watcher.js';

export function setupIpcHandlers(daemonClient: DaemonClient, mainWindow: BrowserWindow, statsCollector: StatsCollector, notifyCenter: NotifyCenter, taskQueue: TaskQueue, contextShare: ContextShare, worktreeManager?: WorktreeManager, worktreeSessionMap?: Map<string, string>): void {
  // Return the project directory (main process cwd) to the renderer
  ipcMain.on('get_project_dir', (event) => {
    event.returnValue = process.cwd();
  });

  // Request/response: renderer → main → daemon
  ipcMain.handle('pty_spawn', async (_, args: {
    agent: string; cwd: string; cols: number; rows: number;
    agentSessionId?: string; isRestore: boolean;
    useWorktree?: boolean; sessionId?: string; agentId?: string;
  }) => {
    let spawnCwd = args.cwd;
    // Create isolated worktree if requested AND agent config allows it
    console.log('[pty_spawn] wt check: useWorktree=%s hasManager=%s sessionId=%s agentId=%s',
      args.useWorktree, !!worktreeManager, args.sessionId?.slice(0,8), args.agentId);
    if (args.useWorktree && worktreeManager && args.sessionId && args.agentId) {
      const agents = loadAgentConfig();
      const cfg = agents.find(a => a.id === args.agentId || a.id === args.agent);
      console.log('[pty_spawn] cfg: found=%s worktree=%s agentIds=%s',
        !!cfg, JSON.stringify(cfg?.worktree), agents.map(a=>a.id).join(','));
      const wtCfg = cfg?.worktree;
      // Only create worktree if explicitly enabled (opt-in for safety)
      if (wtCfg?.enabled) {
        try {
          const baseBranch = wtCfg.baseBranch || 'main';
          const info = await worktreeManager.createForAgent(
            args.sessionId, args.agentId, args.cwd, baseBranch,
          );
          spawnCwd = info.worktreePath;
          // Persist
          saveWorktree({
            id: info.id, session_id: info.sessionId,
            agent_id: info.agentId, worktree_path: info.worktreePath,
            branch: info.branch, base_branch: info.baseBranch,
            project_path: info.projectPath, created_at: info.createdAt,
            status: info.status,
          });
          mainWindow.webContents.send(`worktree-created-${args.sessionId}`, info);
        } catch (err) {
          console.error('[Worktree] Failed to create worktree for spawn:', err);
          // Continue with original cwd — graceful degradation
        }
      }
    }
    const result = await daemonClient.request({
      type: 'spawn',
      agent: args.agent,
      cwd: spawnCwd,
      cols: args.cols,
      rows: args.rows,
      agentSessionId: args.agentSessionId,
      isRestore: args.isRestore,
    });
    // Map daemon session ID → worktree session ID for cleanup lookup
    if (args.sessionId && result?.sessionId && worktreeSessionMap) {
      worktreeSessionMap.set(result.sessionId, args.sessionId);
    }
    return result;
  });

  // Fire-and-forget: renderer → main → daemon
  ipcMain.handle('pty_write', async (_, args: { sessionId: string; data: string }) => {
    daemonClient.send({ type: 'write', ...args });
  });

  ipcMain.handle('pty_resize', async (_, args: { sessionId: string; cols: number; rows: number }) => {
    daemonClient.send({ type: 'resize', ...args });
  });

  ipcMain.handle('pty_kill', async (_, args: { sessionId: string }) => {
    daemonClient.send({ type: 'kill', ...args });
  });

  ipcMain.handle('pty_set_agent_session_id', async (_, args: { sessionId: string; agentSessionId: string }) => {
    daemonClient.send({ type: 'set-agent-session-id', ...args });
  });

  // Agent config: list agents with installed status
  ipcMain.handle('detect_agents', async () => {
    const agents = loadAgentConfig();
    return agents.map((a) => ({
      id: a.id,
      name: a.name,
      installed: isAgentInstalled(a.command),
    }));
  });

  // Git status
  ipcMain.handle('get_git_status', async (_, args: { path: string }) => {
    return getGitStatus(args.path);
  });

  // Stats
  ipcMain.handle('get_agent_stats', async () => {
    return statsCollector.getAllStats();
  });

  ipcMain.handle('get_stats_totals', async () => {
    return statsCollector.getTotals();
  });

  // Notifications
  ipcMain.handle('get_notifications', async (_, includeDismissed?: boolean) => {
    return notifyCenter.getNotifications(includeDismissed);
  });

  ipcMain.handle('dismiss_notification', async (_, id: string) => {
    notifyCenter.dismiss(id);
  });

  ipcMain.handle('dismiss_session_notifications', async (_, sessionId: string) => {
    notifyCenter.dismissAllForSession(sessionId);
  });

  ipcMain.handle('get_notification_count', async () => {
    return notifyCenter.getTotalUnread();
  });

  // Window controls
  ipcMain.on('window-close', () => {
    mainWindow.close();
  });

  // ── External Editor ───────────────────────────────────────────────────────

  /** Detect the best available external editor. Returns null if none found. */
  function detectEditor(): string | null {
    const candidates = [
      { cmd: 'cursor', label: 'Cursor' },
      { cmd: 'code', label: 'VS Code' },
      { cmd: 'code-insiders', label: 'VS Code Insiders' },
      { cmd: 'windsurf', label: 'Windsurf' },
    ];
    for (const c of candidates) {
      try {
        if (process.platform === 'win32') {
          execFileSync('where', [c.cmd], { stdio: 'ignore', windowsHide: true });
        } else {
          execFileSync('command', ['-v', c.cmd], { stdio: 'ignore' });
        }
        return c.cmd;
      } catch { /* not found, try next */ }
    }
    return null;
  }

  // Cache editor detection result
  let detectedEditor: string | null | undefined;

  ipcMain.handle('open_in_editor', async (_e, args: { path: string; editor?: string }) => {
    try {
      if (detectedEditor === undefined) {
        detectedEditor = detectEditor();
      }
      const editor = args.editor || detectedEditor;
      if (!editor) {
        return { success: false, error: 'No editor found (tried: cursor, code, code-insiders, windsurf)' };
      }
      spawn(editor, [args.path], {
        detached: true,
        stdio: 'ignore',
        windowsHide: true,
        shell: process.platform === 'win32',
      });
      return { success: true, editor };
    } catch (err) {
      return { success: false, error: err instanceof Error ? err.message : String(err) };
    }
  });

  ipcMain.handle('detect_editor', async () => {
    if (detectedEditor === undefined) {
      detectedEditor = detectEditor();
    }
    return { editor: detectedEditor };
  });

  // Event forwarding: daemon → main → renderer
  daemonClient.on('output', (msg: DaemonMessage) => {
    const m = msg as DaemonMessage & { type: 'output' };
    mainWindow.webContents.send(`pty-output-${m.sessionId}`, { data: m.data });
  });

  daemonClient.on('exit', (msg: DaemonMessage) => {
    const m = msg as DaemonMessage & { type: 'exit' };
    mainWindow.webContents.send(`pty-exit-${m.sessionId}`, { exitCode: m.code });
  });

  daemonClient.on('session-id-changed', (msg: DaemonMessage) => {
    const m = msg as DaemonMessage & { type: 'session-id-changed' };
    mainWindow.webContents.send(`pty-session-id-changed-${m.sessionId}`, { agentSessionId: m.agentSessionId });
  });

  // ── Task Queue handlers (Phase 4) ──────────────────────────────────────

  ipcMain.handle('task_enqueue', (_e, input: { title: string; description: string; priority: string; requiredCapabilities: string[] }) => {
    const task = taskQueue.enqueue({
      title: input.title,
      description: input.description,
      priority: input.priority as TaskRecord['priority'],
      requiredCapabilities: input.requiredCapabilities as AgentCapability[],
    });
    const agents = loadAgentConfig().map(a => ({ id: a.id, capabilities: a.capabilities }));
    taskQueue.tryRoute(task.id, agents);
    saveTask(task);
    return task;
  });

  ipcMain.handle('task_list', (_e, status?: string) => {
    return taskQueue.list(status as TaskRecord['status'] | undefined);
  });

  ipcMain.handle('task_dispatch', (_e, taskId: string, sessionId: string) => {
    // Look up worktree path from manager if available
    const wtPath = worktreeManager?.getBySession(sessionId)?.worktreePath;
    taskQueue.dispatch(taskId, sessionId, wtPath);
    const task = taskQueue.get(taskId);
    if (task) saveTask(task);
  });

  ipcMain.handle('task_stats', () => {
    return taskQueue.stats();
  });

  ipcMain.handle('task_complete', (_e, taskId: string, result: string) => {
    taskQueue.complete(taskId, result);
    const task = taskQueue.get(taskId);
    if (task) saveTask(task);
    // Publish task result to the Context Feed (producer wiring).
    if (task) {
      const entry = contextShare.publish(task.assignedSession || '', task.assignedAgent || '', {
        contextType: 'task-summary',
        title: `Task done: ${task.title}`,
        body: result,
        tags: ['task', 'complete'],
        priority: 'normal',
      });
      saveContextEntry(entry);
      mainWindow.webContents.send('ctx_new_entry', entry);
    }
  });

  ipcMain.handle('task_fail', (_e, taskId: string, error: string) => {
    taskQueue.fail(taskId, error);
    const task = taskQueue.get(taskId);
    if (task) saveTask(task);
    // Publish failure to the Context Feed so other agents can react.
    if (task) {
      const entry = contextShare.publish(task.assignedSession || '', task.assignedAgent || '', {
        contextType: 'task-error',
        title: `Task failed: ${task.title}`,
        body: error,
        tags: ['task', 'failed'],
        priority: 'high',
      });
      saveContextEntry(entry);
      mainWindow.webContents.send('ctx_new_entry', entry);
    }
  });

  // ── Context Sharing handlers (Phase 4) ──────────────────────────────────

  ipcMain.handle('ctx_publish', (_e, sessionId: string, agentId: string, input: any) => {
    const entry = contextShare.publish(sessionId, agentId, input);
    saveContextEntry(entry);
    mainWindow.webContents.send('ctx_new_entry', entry);
    return entry;
  });

  ipcMain.handle('ctx_list', (_e, filter?: any) => {
    if (filter && Object.keys(filter).length > 0) return contextShare.search(filter);
    return contextShare.list();
  });

  ipcMain.handle('ctx_mark_consumed', (_e, id: string) => {
    contextShare.markConsumed(id);
    const entry = contextShare.get(id);
    if (entry) saveContextEntry(entry);
  });
}

export function setupDatabaseIpcHandlers() {
  ipcMain.handle('save_layout', async (_, layout) => {
    saveLayout(layout);
  });

  ipcMain.handle('load_layout', async () => {
    return loadLayout();
  });
}

export function setupWorktreeIpcHandlers(manager: WorktreeManager, watcher: WorktreeWatcher) {
  // 1. Create worktree for an agent session
  ipcMain.handle('worktree_create', async (_e, args: {
    sessionId: string; agentId: string; projectPath: string; baseBranch?: string;
  }) => {
    const info = await manager.createForAgent(
      args.sessionId, args.agentId, args.projectPath, args.baseBranch ?? 'main',
    );
    // Persist to database
    saveWorktree({
      id: info.id,
      session_id: info.sessionId,
      agent_id: info.agentId,
      worktree_path: info.worktreePath,
      branch: info.branch,
      base_branch: info.baseBranch,
      project_path: info.projectPath,
      created_at: info.createdAt,
      status: info.status,
    });
    // Start watching for changes
    watcher.watch(info.sessionId, info.worktreePath);
    return info;
  });

  // 2. List all active worktrees
  ipcMain.handle('worktree_list', async () => {
    return manager.list();
  });

  // 3. Get worktree by session id
  ipcMain.handle('worktree_get', async (_e, sessionId: string) => {
    return manager.getBySession(sessionId) ?? null;
  });

  // 4. Cleanup worktree
  ipcMain.handle('worktree_cleanup', async (_e, args: {
    sessionId: string; keepBranch?: boolean; force?: boolean;
  }) => {
    await manager.cleanup(args.sessionId, {
      keepBranch: args.keepBranch ?? false,
      force: args.force ?? false,
    });
    // Remove from database (look up by session_id since cleanup removes from active map)
    try {
      const wts = loadWorktrees();
      const row = wts.find(w => w.session_id === args.sessionId);
      if (row) deleteWorktree(row.id);
    } catch { /* best-effort */ }
    watcher.unwatch(args.sessionId);
  });

  // 5. Detect conflicts across all active worktrees
  ipcMain.handle('worktree_conflicts', async () => {
    return manager.detectConflicts();
  });
}
