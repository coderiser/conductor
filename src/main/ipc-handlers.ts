import { ipcMain, BrowserWindow } from 'electron';
import { DaemonClient } from './daemon-client.js';
import { saveLayout, loadLayout, saveTask } from './database.js';
import { loadAgentConfig, isAgentInstalled } from './agent-config.js';
import { getGitStatus } from './git-integration.js';
import { StatsCollector } from './stats-collector.js';
import { NotifyCenter } from './notify-center.js';
import type { DaemonMessage } from '../daemon/protocol/messages.js';
import type { TaskQueue } from './task-queue.js';
import type { TaskRecord } from '../common/stats-types';
import type { AgentCapability } from '../common/agent-protocol';

export function setupIpcHandlers(daemonClient: DaemonClient, mainWindow: BrowserWindow, statsCollector: StatsCollector, notifyCenter: NotifyCenter, taskQueue: TaskQueue): void {
  // Return the project directory (main process cwd) to the renderer
  ipcMain.on('get_project_dir', (event) => {
    event.returnValue = process.cwd();
  });

  // Request/response: renderer → main → daemon
  ipcMain.handle('pty_spawn', async (_, args: { agent: string; cwd: string; cols: number; rows: number; agentSessionId?: string; isRestore: boolean }) => {
    return daemonClient.request({ type: 'spawn', ...args });
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

  ipcMain.handle('task_stats', () => {
    return taskQueue.stats();
  });

  ipcMain.handle('task_complete', (_e, taskId: string, result: string) => {
    taskQueue.complete(taskId, result);
    const task = taskQueue.get(taskId);
    if (task) saveTask(task);
  });

  ipcMain.handle('task_fail', (_e, taskId: string, error: string) => {
    taskQueue.fail(taskId, error);
    const task = taskQueue.get(taskId);
    if (task) saveTask(task);
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
