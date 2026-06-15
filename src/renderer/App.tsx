import { useCallback, useEffect, useRef, useState } from 'react';
import { TerminalPanel } from './components/TerminalPanel';
import { Sidebar, type SessionMeta, type LogEntry } from './components/Sidebar';
import { AgentDashboard } from './components/AgentDashboard';
import { NotifyPanel } from './components/NotifyPanel';
import { TaskPanel } from './components/TaskPanel';
import { ContextFeed } from './components/ContextFeed';
import { ToastContainer } from './components/Toast';
import { useSessionStore } from './store/sessions';
import { pty } from './lib/pty-ipc';
import type { WorktreeInfo, ConflictReport } from '../common/worktree-types';

interface PanelEntry { id: string; agent: string; dockId: string; ptyId?: string; cwd: string; createdAt: number; running: boolean; status: string; gitBranch?: string; needsAttention: boolean; exited: boolean; resumeId?: string; isRestored?: boolean; deferred?: boolean; }
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
  const [stats, setStats] = useState({ tasks: 0, tokens: 0, running: 0, failed: 0, duration: '0m' });
  const [logs, setLogs] = useState<LogEntry[]>([]);
  const failedRef = useRef(0);
  const tokensRef = useRef(0);
  const [showDashboard, setShowDashboard] = useState(false);
  const [showNotify, setShowNotify] = useState(false);
  const [showTasks, setShowTasks] = useState(false);
  const [showContext, setShowContext] = useState(false);

  // Toggle overlay panels with mutual exclusion
  const toggleDashboard = () => {
    setShowDashboard(v => !v);
    setShowNotify(false);
    setShowTasks(false);
    setShowContext(false);
  };
  const toggleNotify = () => {
    setShowNotify(v => !v);
    setShowDashboard(false);
    setShowTasks(false);
    setShowContext(false);
  };
  const toggleTasks = () => {
    setShowTasks(v => !v);
    setShowDashboard(false);
    setShowNotify(false);
    setShowContext(false);
  };
  const toggleContext = () => {
    setShowContext(v => !v);
    setShowDashboard(false);
    setShowNotify(false);
    setShowTasks(false);
  };
  const [notificationCount, setNotificationCount] = useState(0);
  const [worktrees, setWorktrees] = useState<WorktreeInfo[]>([]);
  const [conflicts, setConflicts] = useState<ConflictReport | null>(null);
  const [agentStats, setAgentStats] = useState<any[]>([]);
  const [availableEditor, setAvailableEditor] = useState<string | null>(null);
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false);
  const [dragIdx, setDragIdx] = useState<number | null>(null);
  const [overIdx, setOverIdx] = useState<number | null>(null);
  // Custom panel sizes (fractions of available space, default 1)
  const [colSizes, setColSizes] = useState<number[]>([]);
  const [rowSizes, setRowSizes] = useState<number[]>([]);
  const [resizing, setResizing] = useState<{ type: 'col' | 'row'; index: number; start: number; startPos: number } | null>(null);

  const addLog = useCallback((text: string, color: string) => {
    setLogs((prev) => [...prev.slice(-99), { time: now(), text, color }]);
  }, []);

  // Handle panel drag-and-drop reorder
  const handlePanelDragStart = (idx: number) => {
    setDragIdx(idx);
  };
  const handlePanelDragOver = (e: React.DragEvent, idx: number) => {
    e.preventDefault();
    setOverIdx(idx);
  };
  const handlePanelDrop = (e: React.DragEvent, targetIdx: number) => {
    e.preventDefault();
    if (dragIdx !== null && dragIdx !== targetIdx) {
      setPanels(prev => {
        const newPanels = [...prev];
        const [dragged] = newPanels.splice(dragIdx, 1);
        newPanels.splice(targetIdx, 0, dragged);
        return newPanels;
      });
      // Update active index if needed
      if (activeIdx === dragIdx) setActiveIdx(targetIdx);
      else if (dragIdx < activeIdx && targetIdx >= activeIdx) setActiveIdx(activeIdx - 1);
      else if (dragIdx > activeIdx && targetIdx <= activeIdx) setActiveIdx(activeIdx + 1);
    }
    setDragIdx(null);
    setOverIdx(null);
  };
  const handlePanelDragEnd = () => {
    setDragIdx(null);
    setOverIdx(null);
  };

  // Handle panel resize
  const handleResizeStart = (e: React.MouseEvent, type: 'col' | 'row', index: number) => {
    e.preventDefault();
    e.stopPropagation();
    setResizing({
      type,
      index,
      start: type === 'col' ? (colSizes[index] || 1) : (rowSizes[index] || 1),
      startPos: type === 'col' ? e.clientX : e.clientY,
    });
  };

  useEffect(() => {
    if (!resizing) return;
    const handleMouseMove = (e: MouseEvent) => {
      const delta = resizing.type === 'col' ? e.clientX - resizing.startPos : e.clientY - resizing.startPos;
      const containerSize = resizing.type === 'col'
        ? (document.querySelector('[data-grid-container]') as HTMLElement)?.offsetWidth || 1000
        : (document.querySelector('[data-grid-container]') as HTMLElement)?.offsetHeight || 800;
      const deltaFrac = delta / containerSize;
      const newSize = Math.max(0.2, Math.min(3, resizing.start + deltaFrac));

      if (resizing.type === 'col') {
        setColSizes(prev => {
          const next = [...prev];
          next[resizing.index] = newSize;
          return next;
        });
      } else {
        setRowSizes(prev => {
          const next = [...prev];
          next[resizing.index] = newSize;
          return next;
        });
      }
    };
    const handleMouseUp = () => setResizing(null);
    window.addEventListener('mousemove', handleMouseMove);
    window.addEventListener('mouseup', handleMouseUp);
    return () => {
      window.removeEventListener('mousemove', handleMouseMove);
      window.removeEventListener('mouseup', handleMouseUp);
    };
  }, [resizing, colSizes, rowSizes]);

  // Startup: load from SQLite, or create default
  useEffect(() => {
    (async () => {
      try {
        const layout = await window.electronAPI.invoke('load_layout');
        if (layout?.sessions?.length > 0) {
          const restored: PanelEntry[] = layout.sessions.map((s: any, i: number) => {
            const id = `term-${nextN++}`;
            // Resume if agent has a saved session ID + it was actually passed to the agent
            // Codex's create_template is empty, so we never set its --session flag.
            // Trying to resume codex with our UUID would fail: "No saved session found".
            const canResume = !!s.agent_session_id && s.agent !== 'codex';
            // Lazy restore: only start the first session immediately, defer others
            const isDeferred = i > 0;
            return { id, dockId: id, agent: s.agent, cwd: s.cwd || projectDir(), createdAt: Date.now(),
              running: !isDeferred, status: isDeferred ? 'deferred' : 'starting', needsAttention: false, exited: false,
              resumeId: canResume ? s.agent_session_id : undefined,
              isRestored: !!canResume,
              deferred: isDeferred };
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
      setStats({ tasks: panels.length, tokens: tokensRef.current, running: panels.filter(p => p.running).length, failed: failedRef.current, duration: `${Math.floor((Date.now() - startTime.current) / 60000)}m` });
    }, 1000);
    return () => clearInterval(iv);
  }, [panels]);

  // Poll notification count, agent stats, and editor detection from main process
  useEffect(() => {
    const refresh = async () => {
      try {
        const count = await window.electronAPI.getNotificationCount();
        setNotificationCount(count);
      } catch { /* ignore */ }
      try {
        const stats = await window.electronAPI.getAgentStats();
        if (Array.isArray(stats)) setAgentStats(stats);
      } catch { /* ignore */ }
    };
    refresh();
    const iv = setInterval(refresh, 3000);
    return () => clearInterval(iv);
  }, []);

  // One-time editor detection
  useEffect(() => {
    (async () => {
      try {
        const r = await window.electronAPI.detectEditor();
        if (r?.editor) setAvailableEditor(r.editor);
      } catch { /* ignore */ }
    })();
  }, []);

  // Poll worktree status and conflicts from main process
  useEffect(() => {
    const refresh = async () => {
      try {
        const wts = await window.electronAPI.listWorktrees();
        if (Array.isArray(wts)) setWorktrees(wts);
        const cr = await window.electronAPI.getWorktreeConflicts();
        if (cr) setConflicts(cr);
      } catch { /* ignore */ }
    };
    refresh();
    const iv = setInterval(refresh, 5000);
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
      if (e.altKey && e.key >= 'F1' && e.key <= 'F9') {
        e.preventDefault();
        const idx = parseInt(e.key[1]) - 1;
        if (idx < panels.length) {
          setActiveIdx(idx);
          // Activate deferred panel on shortcut
          const panel = panels[idx];
          if (panel.deferred) {
            setPanels(prev => prev.map((p, i) => i === idx ? { ...p, deferred: false, running: true, status: 'starting' } : p));
          }
        }
      }
      if (e.key === 'F10') { e.preventDefault(); window.electronAPI.closeWindow(); }
      if (e.ctrlKey && e.key === 'n') { e.preventDefault(); addTerminal('cmd.exe'); }
      if (e.ctrlKey && e.key === 'w') { e.preventDefault(); killCurrent(); }
      if (e.ctrlKey && e.key === 'd') { e.preventDefault(); toggleDashboard(); }
      if (e.ctrlKey && e.key === 't') { e.preventDefault(); toggleTasks(); }
      if (e.ctrlKey && e.key === 'g') { e.preventDefault(); toggleContext(); }
      if (e.ctrlKey && e.key === 'b') { e.preventDefault(); setSidebarCollapsed(v => !v); }
    };
    window.addEventListener('keydown', h, { capture: true });
    return () => window.removeEventListener('keydown', h, { capture: true });
  }, [addTerminal, killCurrent, panels.length]);

  return (
    <div style={{ display: 'flex', height: '100vh', width: '100vw' }}>
      <div style={{ width: sidebarCollapsed ? 0 : 320, overflow: 'hidden', transition: 'width 0.2s', flexShrink: 0 }}>
      <Sidebar onAddTerminal={addTerminal} onKillCurrent={killCurrent} onBroadcast={handleBroadcast}
        onSelectSession={(id) => {
          const idx = panels.findIndex(p => p.dockId === id);
          if (idx >= 0) {
            setActiveIdx(idx);
            // Activate deferred panel on click
            const panel = panels[idx];
            if (panel.deferred) {
              setPanels(prev => prev.map((p, i) => i === idx ? { ...p, deferred: false, running: true, status: 'starting' } : p));
            }
          }
        }}
        onToggleCollapse={() => setSidebarCollapsed(true)}
        stats={stats}
        sessions={panels.map((p): SessionMeta => ({ id: p.dockId, agent: p.agent, cwd: p.cwd, elapsed: Math.floor((Date.now() - p.createdAt) / 1000), running: p.running, status: p.status, needsAttention: p.needsAttention, gitBranch: p.gitBranch, exited: p.exited, ptyId: p.ptyId }))}
        logs={logs}
        notificationCount={notificationCount}
        onShowDashboard={toggleDashboard}
        onShowNotifications={toggleNotify}
        onShowTasks={toggleTasks}
        onShowContext={toggleContext}
        worktrees={worktrees}
        conflicts={conflicts}
        agentStats={agentStats}
        availableEditor={availableEditor} />
      </div>
      {sidebarCollapsed && (
        <button onClick={() => setSidebarCollapsed(false)} title="Show sidebar (Ctrl+B)" style={{
          position: 'absolute', left: 0, top: '50%', transform: 'translateY(-50%)',
          background: 'var(--canvas-deep)', border: '1px solid var(--hairline)', borderLeft: 'none',
          borderRadius: '0 4px 4px 0', color: 'var(--body)', cursor: 'pointer',
          padding: '8px 4px', fontSize: 14, zIndex: 10, opacity: 0.8,
        }}>▶</button>
      )}
      <div data-grid-container style={{
        flex: 1, display: 'grid', position: 'relative',
        gridTemplateColumns: colSizes.length >= gridCols
          ? colSizes.slice(0, gridCols).map(s => `${s}fr`).join(' ')
          : `repeat(${gridCols}, 1fr)`,
        gridTemplateRows: rowSizes.length >= totalRows
          ? rowSizes.slice(0, totalRows).map(s => `${s}fr`).join(' ')
          : `repeat(${totalRows}, 1fr)`,
        background: '#1a1a1e', minWidth: 0, minHeight: 0, overflow: 'hidden'
      }}>
        {cells.map((c) => {
          const p = panels[c.idx];
          if (!p) return null;
          const isDragging = dragIdx === c.idx;
          const isOver = overIdx === c.idx;
          return (
            <div key={p.dockId}
              draggable
              onDragStart={() => handlePanelDragStart(c.idx)}
              onDragOver={(e) => handlePanelDragOver(e, c.idx)}
              onDrop={(e) => handlePanelDrop(e, c.idx)}
              onDragEnd={handlePanelDragEnd}
              onMouseDown={() => {
                setActiveIdx(c.idx);
                // Activate deferred panel on click
                if (p.deferred) {
                  setPanels(prev => prev.map((pp, i) => i === c.idx ? { ...pp, deferred: false, running: true, status: 'starting' } : pp));
                }
              }}
              style={{
                gridRow: c.row + 1, gridColumn: `${c.colStart} / span ${c.colSpan}`,
                border: c.idx === activeIdx ? '2px solid var(--accent)' : (p.needsAttention ? '2px solid var(--accent)' : '1px solid var(--hairline)'),
                position: 'relative', overflow: 'hidden', minWidth: 0, minHeight: 0,
                opacity: isDragging ? 0.5 : 1,
                outline: isOver ? '2px dashed var(--accent)' : 'none',
                transition: 'opacity 0.15s, outline 0.15s',
              }}>
              {/* Drag handle */}
              <div style={{
                position: 'absolute', top: 4, right: 4, width: 16, height: 16,
                cursor: 'grab', zIndex: 5, opacity: 0.4, fontSize: 10,
                display: 'flex', alignItems: 'center', justifyContent: 'center',
                background: 'rgba(0,0,0,0.3)', borderRadius: 2,
              }} title="Drag to reorder">⋮⋮</div>
              {/* Vertical resize handle (right edge) */}
              {c.colStart + c.colSpan - 1 < gridCols && (
                <div
                  onMouseDown={(e) => handleResizeStart(e, 'col', Math.floor(c.idx % gridCols))}
                  style={{
                    position: 'absolute', top: 0, right: 0, width: 4, height: '100%',
                    cursor: 'col-resize', zIndex: 6,
                    background: resizing?.type === 'col' && resizing.index === Math.floor(c.idx % gridCols) ? 'var(--accent)' : 'transparent',
                  }}
                  onMouseEnter={(e) => (e.currentTarget.style.background = 'rgba(94,106,210,0.3)')}
                  onMouseLeave={(e) => {
                    if (!(resizing?.type === 'col' && resizing.index === Math.floor(c.idx % gridCols))) {
                      e.currentTarget.style.background = 'transparent';
                    }
                  }}
                />
              )}
              {/* Horizontal resize handle (bottom edge) */}
              {c.row < totalRows - 1 && (
                <div
                  onMouseDown={(e) => handleResizeStart(e, 'row', c.row)}
                  style={{
                    position: 'absolute', bottom: 0, left: 0, width: '100%', height: 4,
                    cursor: 'row-resize', zIndex: 6,
                    background: resizing?.type === 'row' && resizing.index === c.row ? 'var(--accent)' : 'transparent',
                  }}
                  onMouseEnter={(e) => (e.currentTarget.style.background = 'rgba(94,106,210,0.3)')}
                  onMouseLeave={(e) => {
                    if (!(resizing?.type === 'row' && resizing.index === c.row)) {
                      e.currentTarget.style.background = 'transparent';
                    }
                  }}
                />
              )}
              {p.deferred ? (
                <div style={{ width: '100%', height: '100%', display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', background: '#1a1a1e', color: '#888', cursor: 'pointer' }}
                  onClick={() => {
                    setActiveIdx(c.idx);
                    setPanels(prev => prev.map((pp, i) => i === c.idx ? { ...pp, deferred: false, running: true, status: 'starting' } : pp));
                  }}>
                  <div style={{ fontSize: 24, marginBottom: 12 }}>⏸</div>
                  <div style={{ fontSize: 14, fontWeight: 600, color: '#ccc' }}>{p.agent}</div>
                  <div style={{ fontSize: 11, marginTop: 6, color: '#666' }}>Click to start session</div>
                </div>
              ) : (
                <TerminalPanel agent={p.agent} cwd={p.cwd || '.'} resumeId={p.resumeId} isRestore={!!p.isRestored}
                onFocus={() => setActiveIdx(c.idx)} focused={c.idx === activeIdx}
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
              )}
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
      <TaskPanel visible={showTasks} onClose={() => setShowTasks(false)} />
      <ContextFeed visible={showContext} onClose={() => setShowContext(false)} />
      <ToastContainer />
    </div>
  );
}
