import { app, BrowserWindow, globalShortcut } from 'electron';
import path from 'path';
import { DaemonClient } from './daemon-client.js';
import { setupIpcHandlers, setupDatabaseIpcHandlers } from './ipc-handlers.js';
import { initDatabase, saveAgentStats } from './database.js';
import { StatsCollector } from './stats-collector.js';
import { NotifyCenter } from './notify-center.js';

let mainWindow: BrowserWindow | null = null;
let daemonClient: DaemonClient | null = null;
let statsCollector: StatsCollector | null = null;
let notifyCenter: NotifyCenter | null = null;

async function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1400,
    height: 900,
    icon: path.join(__dirname, '../renderer/logo.png'),
    title: 'Conductor',
    webPreferences: {
      preload: path.join(__dirname, '../preload/index.js'),
      nodeIntegration: false,
      contextIsolation: true
    }
  });

  // Connect to PTY daemon (auto-spawns if not running)
  daemonClient = new DaemonClient();
  await daemonClient.connect();

  // Initialize stats and notification systems
  statsCollector = new StatsCollector();
  notifyCenter = new NotifyCenter();

  // Set up IPC bridge between renderer and daemon
  setupIpcHandlers(daemonClient, mainWindow, statsCollector, notifyCenter);

  // Wire daemon events to stats collector and notify center
  daemonClient.on('spawned', (msg: any) => {
    if (statsCollector && msg.sessionId) {
      statsCollector.trackSession(msg.sessionId, msg.agent || '', '');
      statsCollector.updateStatus(msg.sessionId, 'running');
    }
  });

  daemonClient.on('output', (msg: any) => {
    if (!msg.sessionId || !msg.data) return;

    // Parse tokens from output
    if (statsCollector) {
      const m = msg.data.match(/([\d,.]+[km]?)\s+tokens\b/i);
      if (m) {
        const s = m[1].toLowerCase().replace(',', '');
        const n = s.endsWith('k') ? parseFloat(s) * 1000 : s.endsWith('m') ? parseFloat(s) * 1000000 : parseInt(s);
        if (!isNaN(n) && n > 10) statsCollector.updateTokens(msg.sessionId, n);
      }
    }

    // Parse notifications
    if (notifyCenter) {
      const notifs = notifyCenter.parseOutput(msg.sessionId, '', msg.data);
      for (const n of notifs) {
        mainWindow?.webContents.send('notification', n);
      }
    }
  });

  daemonClient.on('exit', (msg: any) => {
    if (statsCollector && msg.sessionId) {
      statsCollector.updateStatus(msg.sessionId, msg.code === 0 ? 'done' : 'error');
    }
  });

  if (!app.isPackaged && process.env.ELECTRON_RENDERER_URL) {
    await mainWindow.loadURL(process.env.ELECTRON_RENDERER_URL);
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
  persistStats();
  statsCollector?.dispose();
  daemonClient?.destroy();
  app.quit();
});

// Also kill daemon on app quit (e.g., F10 shortcut, macOS Cmd+Q)
app.on('before-quit', () => {
  persistStats();
  statsCollector?.dispose();
  daemonClient?.destroy();
});

function persistStats() {
  if (statsCollector) {
    try {
      saveAgentStats(statsCollector.getAllStats().map(s => ({
        sessionId: s.sessionId,
        agent: s.agentId,
        tokenCount: s.tokenCount,
        estimatedCost: s.estimatedCost,
        healthScore: s.healthScore,
        status: s.status,
        errorCount: s.errorCount,
        startTime: s.startTime,
        lastActivity: s.lastActivity,
      })));
    } catch (e) {
      console.error('[App] Failed to persist stats:', e);
    }
  }
}
