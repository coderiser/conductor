import { app, BrowserWindow, globalShortcut } from 'electron';
import path from 'path';
import { DaemonClient } from './daemon-client.js';
import { setupIpcHandlers, setupDatabaseIpcHandlers } from './ipc-handlers.js';
import { initDatabase } from './database.js';

let mainWindow: BrowserWindow | null = null;
let daemonClient: DaemonClient | null = null;

async function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1400,
    height: 900,
    webPreferences: {
      preload: path.join(__dirname, '../preload/index.js'),
      nodeIntegration: false,
      contextIsolation: true
    }
  });

  // Connect to PTY daemon (auto-spawns if not running)
  daemonClient = new DaemonClient();
  await daemonClient.connect();

  // Set up IPC bridge between renderer and daemon
  setupIpcHandlers(daemonClient, mainWindow);

  if (MAIN_WINDOW_VITE_DEV_SERVER_URL) {
    await mainWindow.loadURL(MAIN_WINDOW_VITE_DEV_SERVER_URL);
  } else {
    await mainWindow.loadFile(path.join(__dirname, '../renderer/index.html'));
  }

  // Global shortcut to quit
  globalShortcut.register('F10', () => {
    app.quit();
  });

  mainWindow.on('closed', () => {
    mainWindow = null;
  });
}

app.whenReady().then(async () => {
  initDatabase();
  setupDatabaseIpcHandlers();
  await createWindow();
}).catch((err) => {
  console.error('[App] Failed to start:', err);
  app.quit();
});

app.on('window-all-closed', () => {
  daemonClient?.disconnect();
  app.quit();
});
