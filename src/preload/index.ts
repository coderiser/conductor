import { contextBridge, ipcRenderer } from 'electron';

contextBridge.exposeInMainWorld('electronAPI', {
  // Request/response: renderer → main → daemon
  invoke: (channel: string, ...args: any[]) => ipcRenderer.invoke(channel, ...args),

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

  // Window controls
  closeWindow: () => ipcRenderer.send('window-close'),
});
