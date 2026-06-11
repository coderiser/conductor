import { ipcMain, BrowserWindow } from 'electron';
import { DaemonClient } from './daemon-client.js';
import { saveLayout, loadLayout } from './database.js';
import type { DaemonMessage } from '../daemon/protocol/messages.js';

export function setupIpcHandlers(daemonClient: DaemonClient, mainWindow: BrowserWindow): void {
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
}

export function setupDatabaseIpcHandlers() {
  ipcMain.handle('save_layout', async (_, layout) => {
    saveLayout(layout);
  });

  ipcMain.handle('load_layout', async () => {
    return loadLayout();
  });
}
