import { app, BrowserWindow, globalShortcut } from 'electron';
import fs from 'node:fs';
import path from 'node:path';
import { DaemonClient } from './daemon-client.js';
import { setupIpcHandlers, setupDatabaseIpcHandlers, setupWorktreeIpcHandlers } from './ipc-handlers.js';
import { initDatabase, saveAgentStats, loadAgentStats, loadWorktrees, deleteWorktree, loadContextEntries } from './database.js';
import { StatsCollector } from './stats-collector.js';
import { NotifyCenter } from './notify-center.js';
import { AgentWatchdog } from './agent-watchdog.js';
import { TaskQueue } from './task-queue.js';
import { ContextShare } from './context-share.js';
import { WorktreeManager } from './worktree-manager.js';
import { WorktreeWatcher } from './worktree-watcher.js';
import { loadAgentConfig } from './agent-config.js';

let mainWindow: BrowserWindow | null = null;
let daemonClient: DaemonClient | null = null;
let statsCollector: StatsCollector | null = null;
let notifyCenter: NotifyCenter | null = null;
let watchdog: AgentWatchdog | null = null;
let taskQueue: TaskQueue | null = null;
let contextShare: ContextShare | null = null;
let worktreeManager: WorktreeManager | null = null;
let worktreeWatcher: WorktreeWatcher | null = null;
const sessionAgentMap = new Map<string, string>(); // daemonSessionId -> agentId
const worktreeSessionMap = new Map<string, string>(); // daemonSessionId -> worktreeSessionId (UUID)

async function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1400,
    height: 900,
    icon: path.join(__dirname, '../renderer/logo.png'),
    title: 'Conductor - Multi-Agent Terminal Workbench',
    webPreferences: {
      preload: path.join(__dirname, '../preload/index.js'),
      nodeIntegration: false,
      contextIsolation: true
    }
  });

  // Ensure title is set (some systems may not respect the constructor title)
  mainWindow.setTitle('Conductor - Multi-Agent Terminal Workbench');

  // Connect to PTY daemon (auto-spawns if not running)
  daemonClient = new DaemonClient();
  await daemonClient.connect();

  // Initialize stats and notification systems
  statsCollector = new StatsCollector();
  statsCollector.restoreHistorical(loadAgentStats());
  notifyCenter = new NotifyCenter();

  // ── Phase 4: Agent Watchdog ────────────────────────────────────────────
  watchdog = new AgentWatchdog({ checkIntervalMs: 30_000, unhealthyThreshold: 20 });

  watchdog.on('agent-unhealthy', (event: any) => {
    console.log(`[watchdog] Agent ${event.agentId} (${event.sessionId}) unhealthy: score ${event.health}`);
    mainWindow?.webContents.send('agent-unhealthy', event);
  });

  watchdog.on('agent-restart', (event: any) => {
    console.log(`[watchdog] Auto-restarting agent ${event.agentId} (${event.sessionId})`);
    try {
      daemonClient!.send({ type: 'kill', sessionId: event.sessionId });
    } catch (err) {
      console.error(`[watchdog] Restart failed:`, err);
    }
  });

  // ── Phase 4: Task Queue & Context Sharing ──────────────────────────────
  taskQueue = new TaskQueue();
  contextShare = new ContextShare();

  // Restore persisted context entries so ctx_list returns history across restarts.
  try {
    const saved = loadContextEntries();
    contextShare.restore(saved);
    console.log(`[ContextShare] restored ${saved.length} entries`);
  } catch (e) {
    console.error('[ContextShare] restore failed:', e);
  }

  // ── Phase 5: Worktree Isolation ───────────────────────────────────────
  worktreeManager = new WorktreeManager();
  worktreeWatcher = new WorktreeWatcher({ debounceMs: 300 });

  // Clean persisted worktrees from previous sessions (daemon sessions don't survive restart)
  try {
    const rows = loadWorktrees();
    for (const row of rows) {
      try { fs.rmSync(row.worktree_path, { recursive: true, force: true }); } catch {}
      deleteWorktree(row.id);
    }
    // Also clean any orphaned directories on disk (no DB entry)
    const wtRoot = WorktreeManager.worktreesRoot();
    if (fs.existsSync(wtRoot)) {
      try {
        const entries = fs.readdirSync(wtRoot, { withFileTypes: true });
        for (const entry of entries) {
          if (entry.isDirectory()) {
            const projectDir = path.join(wtRoot, entry.name);
            try {
              const agentDirs = fs.readdirSync(projectDir, { withFileTypes: true });
              for (const ad of agentDirs) {
                if (ad.isDirectory()) {
                  try { fs.rmSync(path.join(projectDir, ad.name), { recursive: true, force: true }); } catch {}
                }
              }
            } catch {}
            // Remove empty project dir
            try { fs.rmdirSync(projectDir); } catch {}
          }
        }
      } catch { /* best effort */ }
    }

    if (rows.length > 0) console.log(`[Worktree] Cleaned ${rows.length} worktree(s) from previous session`);
  } catch (err) {
    console.error('[Worktree] Failed to clean persisted worktrees:', err);
  }

  // Set up IPC bridge between renderer and daemon
  setupIpcHandlers(daemonClient, mainWindow, statsCollector, notifyCenter, taskQueue, contextShare, worktreeManager, worktreeSessionMap);
  setupWorktreeIpcHandlers(worktreeManager!, worktreeWatcher!);

  // Wire daemon events to stats collector and notify center
  daemonClient.on('spawned', (msg: any) => {
    if (msg.sessionId && msg.agent) {
      sessionAgentMap.set(msg.sessionId, msg.agent);
    }
    if (statsCollector && msg.sessionId) {
      statsCollector.trackSession(msg.sessionId, msg.agent || '', '');
      statsCollector.updateStatus(msg.sessionId, 'running');
    }
    if (watchdog && msg.sessionId) {
      watchdog.register(msg.sessionId, msg.agent || '', { autoRestart: false });
    }
  });

  daemonClient.on('output', (msg: any) => {
    if (!msg.sessionId || !msg.data) return;

    // Update watchdog activity
    if (watchdog) watchdog.updateActivity(msg.sessionId);

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
    if (watchdog && msg.sessionId) {
      watchdog.unregister(msg.sessionId);
    }
    // Auto-cleanup worktree based on agent's configured cleanup policy
    handleWorktreeCleanup(msg.sessionId, msg.agent);
    // Clean up the mapping
    worktreeSessionMap.delete(msg.sessionId);
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
  watchdog?.stop();
  worktreeWatcher?.dispose();
  worktreeManager?.dispose();
  persistStats();
  statsCollector?.dispose();
  daemonClient?.destroy();
  app.quit();
});

// Also kill daemon on app quit (e.g., F10 shortcut, macOS Cmd+Q)
app.on('before-quit', () => {
  watchdog?.stop();
  worktreeWatcher?.dispose();
  worktreeManager?.dispose();
  persistStats();
  statsCollector?.dispose();
  daemonClient?.destroy();
});

async function handleWorktreeCleanup(sessionId: string, agentId?: string): Promise<void> {
  if (!worktreeManager || !worktreeWatcher) return;
  // Resolve daemon session ID → worktree UUID (worktree was created with renderer UUID)
  const wtSessionId = worktreeSessionMap.get(sessionId) || sessionId;
  const info = worktreeManager.getBySession(wtSessionId);
  if (!info) return;

  // Resolve cleanup policy from agent config
  const effectiveAgent = agentId || sessionAgentMap.get(sessionId);
  const agents = loadAgentConfig();
  const cfg = agents.find(a => a.id === effectiveAgent);
  const cleanup = cfg?.worktree?.cleanup ?? 'keep';

  if (cleanup === 'keep') {
    console.log(`[Worktree] Keeping worktree for ${wtSessionId} (policy: keep)`);
    return;
  }

  if (cleanup === 'ask') {
    mainWindow?.webContents.send('worktree-cleanup-ask', {
      sessionId: wtSessionId,
      agentId: effectiveAgent,
      worktreePath: info.worktreePath,
      branch: info.branch,
      baseBranch: info.baseBranch,
    });
    return;
  }

  // cleanup === 'merge'
  if (cleanup === 'merge') {
    try {
      const simpleGit = await import('simple-git');
      const git = simpleGit.default(info.projectPath);
      // Checkout base branch and merge the worktree branch
      await git.raw(['checkout', info.baseBranch]).catch(() => {});
      const mergeResult = await git.raw(['merge', info.branch, '--no-edit']);
      console.log(`[Worktree] Merged ${info.branch} into ${info.baseBranch}:`, mergeResult.trim().slice(0, 120));

      // Clean up the worktree
      await worktreeManager.cleanup(wtSessionId, { keepBranch: false, force: true });
      worktreeWatcher.unwatch(wtSessionId);
      deleteWorktree(info.id);
      worktreeSessionMap.delete(sessionId);
      mainWindow?.webContents.send('worktree-merged', {
        sessionId: wtSessionId, branch: info.branch, baseBranch: info.baseBranch,
      });
    } catch (err) {
      console.warn(`[Worktree] Merge failed for ${wtSessionId}, keeping worktree:`, err);
      mainWindow?.webContents.send('worktree-merge-conflict', {
        sessionId: wtSessionId,
        agentId: effectiveAgent,
        worktreePath: info.worktreePath,
        branch: info.branch,
        baseBranch: info.baseBranch,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }
}

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
