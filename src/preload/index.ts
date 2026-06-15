import { contextBridge, ipcRenderer } from 'electron';

contextBridge.exposeInMainWorld('electronAPI', {
  // Request/response: renderer → main → daemon
  invoke: (channel: string, ...args: any[]) => ipcRenderer.invoke(channel, ...args),

  // The directory where Conductor was launched (main process cwd)
  projectDir: () => ipcRenderer.sendSync('get_project_dir'),

  // Event subscriptions: daemon → main → renderer
  onOutput: (id: string, callback: (_data: string) => void) => {
    const listener = (_event: any, msg: { data: string }) => callback(msg.data);
    ipcRenderer.on(`pty-output-${id}`, listener);
    return () => ipcRenderer.removeListener(`pty-output-${id}`, listener);
  },

  onExit: (id: string, callback: (_code: number) => void) => {
    const listener = (_event: any, msg: { exitCode: number }) => callback(msg.exitCode);
    ipcRenderer.on(`pty-exit-${id}`, listener);
    return () => ipcRenderer.removeListener(`pty-exit-${id}`, listener);
  },

  onSessionIdChanged: (id: string, callback: (_agentSessionId: string) => void) => {
    const listener = (_event: any, msg: { agentSessionId: string }) => callback(msg.agentSessionId);
    ipcRenderer.on(`pty-session-id-changed-${id}`, listener);
    return () => ipcRenderer.removeListener(`pty-session-id-changed-${id}`, listener);
  },

  // Stats
  getAgentStats: () => ipcRenderer.invoke('get_agent_stats'),
  getStatsTotals: () => ipcRenderer.invoke('get_stats_totals'),

  // Notifications
  getNotifications: (includeDismissed?: boolean) => ipcRenderer.invoke('get_notifications', includeDismissed),
  dismissNotification: (id: string) => ipcRenderer.invoke('dismiss_notification', id),
  dismissSessionNotifications: (sessionId: string) => ipcRenderer.invoke('dismiss_session_notifications', sessionId),
  getNotificationCount: () => ipcRenderer.invoke('get_notification_count'),

  onNotification: (callback: (_notification: any) => void) => {
    const listener = (_event: any, notification: any) => callback(notification);
    ipcRenderer.on('notification', listener);
    return () => ipcRenderer.removeListener('notification', listener);
  },

  // Task Queue APIs
  enqueueTask: (input: { title: string; description: string; priority: string; requiredCapabilities: string[] }) =>
    ipcRenderer.invoke('task_enqueue', input),
  listTasks: (status?: string) => ipcRenderer.invoke('task_list', status),
  getTaskStats: () => ipcRenderer.invoke('task_stats'),
  completeTask: (taskId: string, result: string) => ipcRenderer.invoke('task_complete', taskId, result),
  failTask: (taskId: string, error: string) => ipcRenderer.invoke('task_fail', taskId, error),

  // Context Sharing APIs
  publishContext: (sessionId: string, agentId: string, input: any) =>
    ipcRenderer.invoke('ctx_publish', sessionId, agentId, input),
  listContext: (filter?: any) => ipcRenderer.invoke('ctx_list', filter),
  markContextConsumed: (id: string) => ipcRenderer.invoke('ctx_mark_consumed', id),
  onNewContext: (callback: (_entry: any) => void) => {
    const handler = (_e: any, entry: any) => callback(entry);
    ipcRenderer.on('ctx_new_entry', handler);
    return () => { ipcRenderer.removeListener('ctx_new_entry', handler); };
  },

  // Worktree APIs
  createWorktree: (args: { sessionId: string; agentId: string; projectPath: string; baseBranch?: string }) =>
    ipcRenderer.invoke('worktree_create', args),
  listWorktrees: () => ipcRenderer.invoke('worktree_list'),
  getWorktree: (sessionId: string) => ipcRenderer.invoke('worktree_get', sessionId),
  cleanupWorktree: (args: { sessionId: string; keepBranch?: boolean; force?: boolean }) =>
    ipcRenderer.invoke('worktree_cleanup', args),
  getWorktreeConflicts: () => ipcRenderer.invoke('worktree_conflicts'),

  // Window controls
  closeWindow: () => ipcRenderer.send('window-close'),

  // External editor
  openInEditor: (path: string, editor?: string) => ipcRenderer.invoke('open_in_editor', { path, editor }),
  detectEditor: () => ipcRenderer.invoke('detect_editor'),
});
