import { useCallback, useEffect, useRef, useState } from 'react';
import { TerminalPanel } from './components/TerminalPanel';
import { Sidebar, type SessionMeta, type LogEntry } from './components/Sidebar';
import { AgentDashboard } from './components/AgentDashboard';
import { NotifyPanel } from './components/NotifyPanel';
import { useSessionStore } from './store/sessions';
import { pty } from './lib/pty-ipc';

interface PanelEntry { id: string; agent: string; dockId: string; ptyId?: string; cwd: string; createdAt: number; running: boolean; status: string; gitBranch?: string; needsAttention: boolean; exited: boolean; resumeId?: string; isRestored?: boolean; }
let nextN = 1;
const genUUID = () => crypto.randomUUID?.() || 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, c => { const r = Math.random()*16|0; return (c==='x'?r:r&0x3|0x8).toString(16); });
const now = () => new Date().toLocaleTimeString('en-US', { hour12: false });
const projectDir = () => (window as any).electronAPI?.projectDir?.() || '.';

// Save panels to SQLite on every change (real-time persistence)
function savePanelsToDb(panels: PanelEntry[]) {
  window.electronAPI.invoke('save_layout', {
    dockviewJson: '[]',
    sessions: panels.map(p => {
      // Don't save session IDs for cmd (no session concept)
      const isCmd = p.agent === 'cmd' || p.agent === 'cmd.exe';
      let sid = isCmd ? '' : (p.resumeId || '');
      if (p.agent === 'opencode' && sid && !sid.startsWith('ses_')) sid = '';
      return { id: p.dockId, agent: p.agent || '', cwd: p.cwd || '.', agent_session_id: sid || '' };
    }),
    windowWidth: window.innerWidth, windowHeight: window.innerHeight,
  }).catch((err) => { console.error('Failed to save layout:', err); });
}

export default function App() {
  const [panels, setPanels] = useState<PanelEntry[]>([]);
  const [activeIdx, setActiveIdx] = useState(0);
  const startTime = useRef(Date.now());
  const { add, remove, updateId, sessions } = useSessionStore();
  const [stats, setStats] = useState({ tasks: 0, tokens: 0, running: 0, failed: 0, duration: '0m', cost: 0 });
  const [logs, setLogs] = useState<LogEntry[]>([]);
  const failedRef = useRef(0);
  const tokensRef = useRef(0);
  const [showDashboard, setShowDashboard] = useState(false);
  const [showNotify, setShowNotify] = useState(false);
  const [notificationCount, setNotificationCount] = useState(0);
  const [totalCost, setTotalCost] = useState(0);

  const addLog = useCallback((text: string, color: string) => {
    setLogs((prev) => [...prev.slice(-99), { time: now(), text, color }]);
  }, []);

  // Startup: load from SQLite, or create default
  useEffect(() => {
    (async () => {
      try {
        const layout = await window.electronAPI.invoke('load_layout');
        if (layout?.sessions?.length > 0) {
          const restored: PanelEntry[] = layout.sessions.map((s: any) => {
            const id = `term-${nextN++}`;
            // Resume if we have a saved session ID (usePty has fallback detection
            // for failed resumes — detects "No conversation found" and starts fresh).
            const canResume = !!s.agent_session_id;
            return { id, dockId: id, agent: s.agent, cwd: s.cwd || projectDir(), createdAt: Date.now(), running: true,
              status: 'starting', needsAttention: false, exited: false,
              resumeId: canResume ? s.agent_session_id : undefined,
              isRestored: !!canResume };
          });
          restored.forEach((r) => add({ id: `S${nextN++}`, agent: r.agent, dockviewId: r.dockId, ptyId: '' }));
          setPanels(restored);
          addLog(`Restored ${restored.length} session(s)`, 'var(--running)');
          return;
        }
      } catch (err) { console.error('Failed to load layout:', err); }
      createDefault();
    })();
  }, []);

  const createDefault = () => {
    const id = `term-${nextN++}`;
    const rid = genUUID();
    const dir = projectDir();
    setPanels([{ id, agent: 'cmd.exe', dockId: id, cwd: dir, createdAt: Date.now(), running: true, status: 'starting', needsAttention: false, exited: false, resumeId: rid }]);
    add({ id: 'S1', agent: 'cmd.exe', dockviewId: id, ptyId: '' });
    addLog('cmd.exe started', 'var(--running)');
  };

  // Auto-save to SQLite on every change (immediate — SQLite writes are fast)
  useEffect(() => {
    if (panels.length === 0) return;
    savePanelsToDb(panels);
  }, [panels]);

  // Stats
  useEffect(() => {
    const iv = setInterval(() => {
      setStats({ tasks: panels.length, tokens: tokensRef.current, running: panels.filter(p => p.running).length, failed: failedRef.current, duration: `${Math.floor((Date.now() - startTime.current) / 60000)}m`, cost: totalCost });
    }, 1000);
    return () => clearInterval(iv);
  }, [panels, totalCost]);

  // Poll notification count and cost from main process
  useEffect(() => {
    const refresh = async () => {
      try {
        const count = await window.electronAPI.getNotificationCount();
        setNotificationCount(count);
      } catch { /* ignore */ }
      try {
        const totals = await window.electronAPI.getStatsTotals();
        setTotalCost(totals?.cost ?? 0);
      } catch { /* ignore */ }
    };
    refresh();
    const iv = setInterval(refresh, 3000);
    return () => clearInterval(iv);
  }, []);

  const addTerminal = useCallback((agent: string, cwd?: string) => {
    const id = `term-${nextN++}`;
    const dir = cwd || projectDir();
    const resumeId = genUUID();
    setPanels((prev) => [...prev, { id, agent, dockId: id, cwd: dir, createdAt: Date.now(), running: true, status: 'starting', needsAttention: false, exited: false, resumeId }]);
    setActiveIdx(panels.length);
    add({ id: `S${nextN}`, agent, dockviewId: id });
    addLog(`${agent} started [sid: ${resumeId.slice(0, 8)}]`, 'var(--running)');
  }, [panels.length, add, addLog]);

  const killCurrent = useCallback(() => {
    if (panels.length <= 1) return;
    const target = panels[activeIdx];
    setPanels((prev) => { const idx = Math.min(activeIdx, prev.length - 2); setActiveIdx(idx); return prev.filter((_, i) => i !== activeIdx); });
    remove(target?.dockId);
    addLog(`${target?.agent} killed`, 'var(--failed)');
  }, [activeIdx, panels, remove, addLog]);

  const handleBroadcast = useCallback((data: string) => {
    sessions.forEach((s) => { if (s.ptyId) pty.write(s.ptyId, data + '\r\n'); });
  }, [sessions]);

  // Dynamic grid
  const n = panels.length;
  const cols = n <= 1 ? 1 : n <= 5 ? 2 : 3;
  const rem = n % cols;
  const baseRows = Math.floor(n / cols);
  const hasSpan = (rem === 1 && n > 2) || (rem === 2 && cols === 3);
  const fracBottom = rem === 2 && cols === 3;
  const totalRows = hasSpan ? baseRows + 1 : Math.ceil(n / cols);
  const gridCols = fracBottom ? cols * rem : cols;
  const cellSpan = fracBottom ? rem : 1;

  interface Cell { idx: number; row: number; colStart: number; colSpan: number; }
  const cells: Cell[] = [];
  if (rem === 1 && baseRows > 1) {
    const tc = (baseRows - 1) * cols;
    for (let i = 0; i < tc; i++) cells.push({ idx: i, row: Math.floor(i / cols), colStart: (i % cols) * cellSpan + 1, colSpan: cellSpan });
    cells.push({ idx: tc, row: baseRows - 1, colStart: 1, colSpan: gridCols });
    for (let i = tc + 1; i < n; i++) cells.push({ idx: i, row: baseRows, colStart: (i - tc - 1) * cellSpan + 1, colSpan: cellSpan });
  } else if (hasSpan && rem === 1) {
    const fc = baseRows * cols;
    for (let i = 0; i < fc; i++) cells.push({ idx: i, row: Math.floor(i / cols), colStart: (i % cols) * cellSpan + 1, colSpan: cellSpan });
    cells.push({ idx: fc, row: baseRows, colStart: 1, colSpan: gridCols });
  } else if (fracBottom) {
    const fc = baseRows * cols;
    for (let i = 0; i < fc; i++) cells.push({ idx: i, row: Math.floor(i / cols), colStart: (i % cols) * cellSpan + 1, colSpan: cellSpan });
    for (let i = fc; i < n; i++) cells.push({ idx: i, row: baseRows, colStart: (i - fc) * (gridCols / rem) + 1, colSpan: gridCols / rem });
  } else {
    for (let i = 0; i < n; i++) cells.push({ idx: i, row: Math.floor(i / cols), colStart: (i % cols) * cellSpan + 1, colSpan: cellSpan });
  }

  useEffect(() => {
    const h = (e: KeyboardEvent) => {
      if (e.key >= 'F1' && e.key <= 'F9') { e.preventDefault(); const idx = parseInt(e.key[1]) - 1; if (idx < panels.length) setActiveIdx(idx); }
      if (e.key === 'F10') { e.preventDefault(); window.electronAPI.closeWindow(); }
      if (e.ctrlKey && e.key === 'n') { e.preventDefault(); addTerminal('cmd.exe'); }
      if (e.ctrlKey && e.key === 'w') { e.preventDefault(); killCurrent(); }
      if (e.ctrlKey && e.key === 'd') { e.preventDefault(); setShowDashboard((v) => !v); }
    };
    window.addEventListener('keydown', h, { capture: true });
    return () => window.removeEventListener('keydown', h, { capture: true });
  }, [addTerminal, killCurrent, panels.length]);

  return (
    <div style={{ display: 'flex', height: '100vh', width: '100vw' }}>
      <Sidebar onAddTerminal={addTerminal} onKillCurrent={killCurrent} onBroadcast={handleBroadcast} stats={stats}
        sessions={panels.map((p): SessionMeta => ({ id: p.dockId, agent: p.agent, cwd: p.cwd, elapsed: Math.floor((Date.now() - p.createdAt) / 1000), running: p.running, status: p.status, needsAttention: p.needsAttention, gitBranch: p.gitBranch, exited: p.exited }))}
        logs={logs}
        notificationCount={notificationCount}
        onShowDashboard={() => setShowDashboard(true)}
        onShowNotifications={() => setShowNotify(true)} />
      <div style={{ flex: 1, display: 'grid', gridTemplateColumns: `repeat(${gridCols}, 1fr)`, gridTemplateRows: `repeat(${totalRows}, 1fr)`, background: '#1a1a1e', minWidth: 0, minHeight: 0, overflow: 'hidden' }}>
        {cells.map((c) => {
          const p = panels[c.idx];
          if (!p) return null;
          return (
            <div key={p.dockId} onClick={() => setActiveIdx(c.idx)}
              style={{ gridRow: c.row + 1, gridColumn: `${c.colStart} / span ${c.colSpan}`, border: c.idx === activeIdx ? '2px solid var(--accent)' : (p.needsAttention ? '2px solid var(--accent)' : '1px solid var(--hairline)'), position: 'relative', overflow: 'hidden', minWidth: 0, minHeight: 0 }}>
              <TerminalPanel agent={p.agent} cwd={p.cwd || '.'} resumeId={p.resumeId} isRestore={!!p.isRestored}
                onFocus={() => setActiveIdx(c.idx)}
                onSessionId={(sid) => {
                  setPanels((prev) => prev.map((pp) => pp.dockId === p.dockId ? { ...pp, resumeId: sid } : pp));
                }}
                onReady={(info) => {
                  updateId(p.dockId, info.sessionId);
                  setPanels((prev) => prev.map((pp) => pp.dockId === p.dockId ? { ...pp, ptyId: info.sessionId, cwd: info.cwd || pp.cwd, status: 'running', needsAttention: false, resumeId: info.agentSessionId || pp.resumeId } : pp));
                  // Fetch Git branch and dirty status for the panel
                  window.electronAPI.invoke('get_git_status', { path: info.cwd || p.cwd }).then((git: any) => {
                    if (git?.branch) setPanels((prev) => prev.map((pp) => pp.dockId === p.dockId ? { ...pp, gitBranch: git.branch + (git.dirty ? ' *' : '') } : pp));
                  }).catch(() => {});
                }}
                onToken={(n) => { tokensRef.current = Math.max(tokensRef.current, n); }}
                onStatus={(s) => { setPanels((prev) => prev.map((pp) => pp.dockId === p.dockId ? { ...pp, status: s, needsAttention: s === 'waiting' || s === 'error' } : pp)); }}
                onExit={(code) => {
                  setPanels((prev) => prev.map((pp) => pp.dockId === p.dockId ? { ...pp, running: false, exited: true, status: code === 0 ? 'done' : 'error', needsAttention: code !== 0 } : pp));
                  if (code !== 0) { failedRef.current += 1; }
                  addLog(`${p.agent} ${code === 0 ? 'completed' : 'failed'} (${code})`, code === 0 ? 'var(--running)' : 'var(--failed)');
                }} />
            </div>
          );
        })}
      </div>
      <AgentDashboard visible={showDashboard} onClose={() => setShowDashboard(false)} />
      <NotifyPanel visible={showNotify} onClose={() => setShowNotify(false)}
        onJumpToSession={(sessionId) => {
          const idx = panels.findIndex(p => p.dockId === sessionId || p.ptyId === sessionId);
          if (idx >= 0) setActiveIdx(idx);
        }}
      />
    </div>
  );
}
