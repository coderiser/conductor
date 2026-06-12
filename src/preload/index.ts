import { contextBridge, ipcRenderer } from 'electron';

contextBridge.exposeInMainWorld('electronAPI', {
  // Request/response: renderer → main → daemon
  invoke: (channel: string, ...args: any[]) => ipcRenderer.invoke(channel, ...args),

  // The directory where Conductor was launched (main process cwd)
  projectDir: () => ipcRenderer.sendSync('get_project_dir'),

  // Event subscriptions: daemon → main → renderer
  onOutput: (id: string, callback: (data: string) => void) => {
    const listener = (_event: any, msg: { data: string }) => callback(msg.data);
    ipcRenderer.on(`pty-output-${id}`, listener);
    return () => ipcRenderer.removeListener(`pty-output-${id}`, listener);
  },

  onExit: (id: string, callback: (code: number) => void) => {
    const listener = (_event: any, msg: { exitCode: number }) => callback(msg.exitCode);
    ipcRenderer.on(`pty-exit-${id}`, listener);
    return () => ipcRenderer.removeListener(`pty-exit-${id}`, listener);
  },

  onSessionIdChanged: (id: string, callback: (agentSessionId: string) => void) => {
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

  onNotification: (callback: (notification: any) => void) => {
    const listener = (_event: any, notification: any) => callback(notification);
    ipcRenderer.on('notification', listener);
    return () => ipcRenderer.removeListener('notification', listener);
  },

  // Window controls
  closeWindow: () => ipcRenderer.send('window-close'),
});
