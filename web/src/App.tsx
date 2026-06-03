import { useCallback, useEffect, useRef, useState } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { TerminalPanel } from './components/TerminalPanel';
import { Sidebar, type SessionMeta, type LogEntry } from './components/Sidebar';
import { useSessionStore } from './store/sessions';
import { pty } from './lib/tauri-ipc';

interface PanelEntry { id: string; agent: string; dockId: string; ptyId?: string; cwd: string; createdAt: number; running: boolean; status: string; gitBranch?: string; needsAttention: boolean; exited: boolean; }
let nextN = 1;

const now = () => new Date().toLocaleTimeString('en-US', { hour12: false });

export default function App() {
  const [panels, setPanels] = useState<PanelEntry[]>([]);
  const [activeIdx, setActiveIdx] = useState(0);
  const startTime = useRef(Date.now());
  const { add, remove, updateId, sessions } = useSessionStore();
  const [stats, setStats] = useState({ tasks: 0, tokens: 0, running: 0, failed: 0, duration: '0m' });
  const [logs, setLogs] = useState<LogEntry[]>([]);
  const failedRef = useRef(0);
  const tokensRef = useRef(0);

  const addLog = useCallback((text: string, color: string) => {
    setLogs((prev) => [...prev.slice(-99), { time: now(), text, color }]);
  }, []);

  // Startup: restore saved session or create default
  useEffect(() => {
    (async () => {
      try {
        const layout = await invoke<any>('load_layout');
        if (layout?.sessions?.length > 0) {
          const restored: PanelEntry[] = layout.sessions.map((s: any) => ({
            id: `term-${nextN++}`, agent: s.agent, dockId: `term-${nextN}`,
            cwd: s.cwd || '.', createdAt: Date.now(), running: true,
            status: 'starting', needsAttention: false, exited: false,
          }));
          restored.forEach((r) => add({ id: `S${nextN}`, agent: r.agent, dockviewId: r.dockId, ptyId: '' }));
          setPanels(restored);
          addLog(`Restored ${restored.length} session(s)`, 'var(--running)');
          return;
        }
      } catch {}
      const id = `term-${nextN++}`;
      setPanels([{ id, agent: 'cmd.exe', dockId: id, cwd: '.', createdAt: Date.now(), running: true, status: 'starting', needsAttention: false, exited: false }]);
      add({ id: 'S1', agent: 'cmd.exe', dockviewId: id, ptyId: '' });
      addLog('cmd.exe started', 'var(--running)');
    })();
  }, []);

  // Save layout on Tauri window close (use ref to capture latest panels)
  const panelsRef = useRef(panels);
  panelsRef.current = panels;

  useEffect(() => {
    import('@tauri-apps/api/window').then(({ getCurrentWindow }) => {
      getCurrentWindow().onCloseRequested(async () => {
        const p = panelsRef.current;
        await invoke('save_layout', {
          dockviewJson: '[]',
          sessions: p.map(pp => ({ id: pp.dockId, agent: pp.agent, cwd: pp.cwd })),
          windowWidth: window.innerWidth, windowHeight: window.innerHeight,
        });
      });
    }).catch(() => {});
  }, []);

  // Stats
  useEffect(() => {
    const iv = setInterval(() => {
      setStats({ tasks: panels.length, tokens: tokensRef.current, running: panels.filter(p => p.running).length, failed: failedRef.current, duration: `${Math.floor((Date.now() - startTime.current) / 60000)}m` });
    }, 1000);
    return () => clearInterval(iv);
  }, [panels]);

  const addTerminal = useCallback((agent: string, cwd?: string) => {
    const id = `term-${nextN++}`;
    const dir = cwd || '.';
    setPanels((prev) => [...prev, { id, agent, dockId: id, cwd: dir, createdAt: Date.now(), running: true, status: 'starting', needsAttention: false, exited: false }]);
    setActiveIdx(panels.length);
    add({ id: `S${nextN}`, agent, dockviewId: id });
    addLog(`${agent} started [cwd: ${dir}]`, 'var(--running)');
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

  // Grid layout
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
    const topCells = (baseRows - 1) * cols;
    for (let i = 0; i < topCells; i++) { cells.push({ idx: i, row: Math.floor(i / cols), colStart: (i % cols) * cellSpan + 1, colSpan: cellSpan }); }
    cells.push({ idx: topCells, row: baseRows - 1, colStart: 1, colSpan: gridCols });
    for (let i = topCells + 1; i < n; i++) { const bi = i - (topCells + 1); cells.push({ idx: i, row: baseRows, colStart: bi * cellSpan + 1, colSpan: cellSpan }); }
  } else if (hasSpan && rem === 1) {
    const fc = baseRows * cols;
    for (let i = 0; i < fc; i++) { cells.push({ idx: i, row: Math.floor(i / cols), colStart: (i % cols) * cellSpan + 1, colSpan: cellSpan }); }
    cells.push({ idx: fc, row: baseRows, colStart: 1, colSpan: gridCols });
  } else if (fracBottom) {
    const fc = baseRows * cols;
    for (let i = 0; i < fc; i++) { cells.push({ idx: i, row: Math.floor(i / cols), colStart: (i % cols) * cellSpan + 1, colSpan: cellSpan }); }
    for (let i = fc; i < n; i++) { const bi = i - fc; const s = gridCols / rem; cells.push({ idx: i, row: baseRows, colStart: bi * s + 1, colSpan: s }); }
  } else {
    for (let i = 0; i < n; i++) { cells.push({ idx: i, row: Math.floor(i / cols), colStart: (i % cols) * cellSpan + 1, colSpan: cellSpan }); }
  }

  useEffect(() => {
    const h = (e: KeyboardEvent) => {
      if (e.key >= 'F1' && e.key <= 'F9') { e.preventDefault(); const idx = parseInt(e.key[1]) - 1; if (idx < panels.length) setActiveIdx(idx); }
      if (e.key === 'F10') { e.preventDefault(); window.close(); }
      if (e.ctrlKey && e.key === 'n') { e.preventDefault(); addTerminal('cmd.exe'); }
      if (e.ctrlKey && e.key === 'w') { e.preventDefault(); killCurrent(); }
    };
    window.addEventListener('keydown', h);
    return () => window.removeEventListener('keydown', h);
  }, [addTerminal, killCurrent, panels.length]);

  return (
    <div style={{ display: 'flex', height: '100vh', width: '100vw' }}>
      <Sidebar onAddTerminal={addTerminal} onKillCurrent={killCurrent} onBroadcast={handleBroadcast} stats={stats}
        sessions={panels.map((p): SessionMeta => ({ id: p.dockId, agent: p.agent, cwd: p.cwd, elapsed: Math.floor((Date.now() - p.createdAt) / 1000), running: p.running, status: p.status, needsAttention: p.needsAttention, gitBranch: p.gitBranch, exited: p.exited }))}
        logs={logs} />
      <div style={{ flex: 1, display: 'grid', gridTemplateColumns: `repeat(${gridCols}, 1fr)`, gridTemplateRows: `repeat(${totalRows}, 1fr)`, background: '#1a1a1e', minWidth: 0, minHeight: 0, overflow: 'hidden' }}>
        {cells.map((c) => {
          const p = panels[c.idx];
          if (!p) return null;
          return (
            <div key={p.dockId} onClick={() => setActiveIdx(c.idx)}
              style={{ gridRow: c.row + 1, gridColumn: `${c.colStart} / span ${c.colSpan}`, border: c.idx === activeIdx ? '2px solid var(--accent)' : (p.needsAttention ? '2px solid var(--accent)' : '1px solid var(--hairline)'), position: 'relative', overflow: 'hidden', minWidth: 0, minHeight: 0 }}>
              <TerminalPanel agent={p.agent} cwd={p.cwd !== '.' ? p.cwd : undefined}
                onFocus={() => setActiveIdx(c.idx)}
                onReady={(info) => {
                  updateId(p.dockId, info.id);
                  setPanels((prev) => prev.map((pp) => pp.dockId === p.dockId ? { ...pp, ptyId: info.id, cwd: info.cwd || pp.cwd, status: 'running', needsAttention: false } : pp));
                  invoke('get_git_status', { path: info.cwd || p.cwd }).then((git: any) => {
                    if (git.branch) setPanels((prev) => prev.map((pp) => pp.dockId === p.dockId ? { ...pp, gitBranch: git.branch + (git.dirty ? ' *' : '') } : pp));
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
    </div>
  );
}
