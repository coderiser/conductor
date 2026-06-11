import { useState, useEffect, useRef } from 'react';

export interface SessionMeta { id: string; agent: string; cwd: string; branch?: string; gitBranch?: string; elapsed: number; running: boolean; status?: string; needsAttention?: boolean; exited?: boolean; }
export interface LogEntry { time: string; text: string; color: string; }

interface Props {
  onAddTerminal: (a: string, cwd?: string) => void;
  onKillCurrent: () => void;
  onBroadcast: (data: string) => void;
  stats: { tasks: number; tokens: number; running: number; failed: number; duration: string };
  sessions: SessionMeta[];
  logs: LogEntry[];
}

export function Sidebar({ onAddTerminal, onKillCurrent, onBroadcast, stats, sessions, logs }: Props) {
  const [detected, setDetected] = useState<Array<{id:string;name:string;installed:boolean}>>([
    { id: 'cmd', name: 'Command Prompt', installed: true },
  ]);
  const [broadcast, setBroadcast] = useState(false);
  const [input, setInput] = useState('');
  const [cwdInput, setCwdInput] = useState('');
  const [collapsed, setCollapsed] = useState<Record<string, boolean>>({});
  const logEndRef = useRef<HTMLDivElement>(null);

  // TODO: Wire up detect_agents IPC handler (Task 9: Agent config loading)
  useEffect(() => {
    (async () => {
      try {
        const agents = await window.electronAPI.invoke('detect_agents');
        if (Array.isArray(agents)) setDetected(agents);
      } catch { /* IPC handler not yet implemented */ }
    })();
  }, []);

  useEffect(() => { logEndRef.current?.scrollIntoView({ behavior: 'smooth' }); }, [logs.length]);

  const handleSend = () => {
    if (!input.trim()) return;
    if (broadcast) {
      onBroadcast(input);
    }
    setInput('');
  };

  const toggle = (k: string) => setCollapsed((c) => ({ ...c, [k]: !c[k] }));

  // Build dynamic agent commands from config (non-builtin agents)
  const agentCmds = detected.filter((a) => !a.id.startsWith('cmd')).slice(0, 4).map((a, i) => ({
    key: `${i + 1}`,
    label: a.name,
    avail: a.installed,
    action: () => onAddTerminal(a.id, cwdInput || undefined),
  }));
  const [killConfirm, setKillConfirm] = useState(false);
  const doKill = () => {
    if (!killConfirm) { setKillConfirm(true); setTimeout(() => setKillConfirm(false), 3000); return; }
    setKillConfirm(false);
    onKillCurrent();
  };
  const killCmd = {
    key: `${agentCmds.length + 1}`,
    label: killConfirm ? 'confirm kill?' : 'kill current',
    avail: true,
    action: doKill,
    isKill: true,
  };
  const cmds = [...agentCmds, killCmd];

  const section = (title: string, key: string, content: React.ReactNode) => (
    <div>
      <div onClick={() => toggle(key)} style={{ cursor:'pointer', display:'flex', alignItems:'center', gap:4, padding:'4px 10px', userSelect:'none' }}>
        <span style={{ fontSize:10, color:'var(--caption)', transition:'0.2s', transform: collapsed[key] ? 'rotate(-90deg)' : '' }}>▼</span>
        <span style={{ fontSize:10, fontWeight:600, color:'var(--secondary)', textTransform:'uppercase', letterSpacing:'0.06em' }}>{title}</span>
      </div>
      {!collapsed[key] && <div style={{ padding:'0 10px' }}>{content}</div>}
    </div>
  );

  const dot = (running: boolean) => running
    ? <span style={{ color:'var(--running)', fontSize:10 }}>●</span>
    : <span style={{ color:'var(--caption)', fontSize:10 }}>○</span>;

  const fmtElapsed = (s: number) => s < 60 ? `${s}s` : s < 3600 ? `${Math.floor(s/60)}m` : `${Math.floor(s/3600)}h`;

  return (
    <div style={{ width:'25%', minWidth:250, maxWidth:340, background:'var(--canvas-deep)', borderRight:'1px solid var(--hairline)', display:'flex', flexDirection:'column', overflow:'hidden', fontFamily:'var(--font-sans)' }}>
      {/* Header */}
      <div style={{ padding:'12px 10px' }}>
        <div style={{ display:'flex', alignItems:'center', gap:10 }}>
          <div>
            <div style={{ color:'var(--ink)', fontWeight:700, fontSize:14, letterSpacing:'-0.2px' }}>Conductor</div>
            <div style={{ color:'var(--caption)', fontSize:10, marginTop:1 }}>Agent Workbench</div>
          </div>
        </div>
      </div>

      {/* Scrollable body */}
      <div style={{ flex:1, overflow:'auto', padding:'4px 0' }}>
        {/* Stats */}
        {section('Stats', 'stats',
          <div style={{ fontSize:11, color:'var(--body)', lineHeight:'18px' }}>
            <div style={{ display:'flex', justifyContent:'space-between' }}><span>Tasks</span><span style={{ color:'var(--pending)' }}>{stats.tasks}</span></div>
            <div style={{ display:'flex', justifyContent:'space-between' }}><span>Tokens</span><span style={{ color:'var(--pending)' }}>{stats.tokens.toLocaleString()}</span></div>
            <div style={{ display:'flex', justifyContent:'space-between' }}><span>Running</span><span style={{ color:'var(--running)' }}>{stats.running}</span></div>
            <div style={{ display:'flex', justifyContent:'space-between' }}><span>Failed</span><span style={{ color: stats.failed > 0 ? 'var(--failed)' : 'var(--caption)' }}>{stats.failed}</span></div>
            <div style={{ display:'flex', justifyContent:'space-between' }}><span>Duration</span><span style={{ color:'var(--caption)' }}>{stats.duration}</span></div>
          </div>
        )}

        <div style={{ borderBottom:'1px solid var(--hairline)', margin:'4px 0' }} />

        {/* Commands */}
        {section('Commands', 'cmds',
          <div style={{ display:'flex', flexDirection:'column', gap:1 }}>
            <button onClick={() => onAddTerminal('cmd.exe', cwdInput || undefined)}
              style={{ background:'var(--accent)', border:'none', borderRadius:3, color:'#fff', padding:'4px 0', cursor:'pointer', fontSize:11, fontWeight:600, fontFamily:'var(--font-sans)', marginBottom:2 }}>
              + New Terminal
            </button>
            <input value={cwdInput} onChange={(e) => setCwdInput(e.target.value)}
              placeholder="working dir (optional)..."
              style={{
                background:'var(--canvas)', border:'1px solid var(--hairline)', borderRadius:3,
                color:'var(--caption)', padding:'2px 6px', fontSize:10, fontFamily:'var(--font-mono)',
                outline:'none', marginBottom:2, width:'100%',
              }} />
            {cmds.map((c) => {
              const isKill = (c as any).isKill;
              const confirming = isKill && killConfirm;
              return (
                <button key={c.key} onClick={c.action} disabled={!c.avail}
                  style={{
                    background: confirming ? 'var(--failed)' : isKill ? 'rgba(248,113,113,0.12)' : 'var(--canvas-soft)',
                    border: confirming ? '1px solid var(--failed)' : '1px solid var(--hairline)',
                    borderRadius:3,
                    color: confirming ? '#fff' : isKill ? 'var(--failed)' : c.avail ? 'var(--ink)' : 'var(--caption)',
                    padding:'3px 8px', cursor: c.avail ? 'pointer' : 'default',
                    fontSize:11, textAlign:'left', display:'flex', gap:6, alignItems:'center',
                    opacity: c.avail ? 1 : 0.4, fontFamily:'var(--font-sans)',
                    transition: 'all 0.15s',
                  }}>
                  <span style={{ color: confirming ? '#fff' : isKill ? 'var(--failed)' : 'var(--accent)', fontWeight:600, fontSize:10, minWidth:16 }}>[{c.key}]</span>
                  {c.label}
                </button>
              );
            })}
          </div>
        )}

        <div style={{ borderBottom:'1px solid var(--hairline)', margin:'4px 0' }} />

        {/* Sessions */}
        {section('Sessions', 'sessions',
          sessions.length === 0
            ? <div style={{ fontSize:11, color:'var(--caption)', fontStyle:'italic', padding:'4px 0' }}>No active sessions</div>
            : <div style={{ display:'flex', flexDirection:'column', gap:2 }}>
                {sessions.map((s) => (
                  <div key={s.id} style={{
                    background: s.needsAttention ? 'rgba(94,106,210,0.12)' : 'var(--canvas-soft)',
                    borderRadius:3, padding:'5px 8px',
                    border: s.needsAttention ? '1px solid var(--accent)' : '1px solid var(--hairline)',
                    fontSize:11, transition:'all 0.2s',
                  }}>
                    <div style={{ display:'flex', alignItems:'center', gap:6 }}>
                      {s.status === 'thinking' ? <span style={{ color:'var(--pending)', fontSize:10 }}>◉</span>
                       : s.status === 'waiting' ? <span style={{ color:'var(--accent)', fontSize:10, animation:'pulse 1s infinite' }}>⚡</span>
                       : s.status === 'error' ? <span style={{ color:'var(--failed)', fontSize:10 }}>✕</span>
                       : s.status === 'done' ? <span style={{ color:'var(--running)', fontSize:10 }}>✓</span>
                       : s.exited ? <span style={{ color:'var(--caption)', fontSize:10 }}>○</span>
                       : dot(s.running)}
                      <span style={{ color:'var(--ink)', fontWeight:500 }}>{s.agent}</span>
                      {s.status && s.status !== 'running' && (
                        <span style={{
                          color: s.status === 'waiting' ? '#fff' : s.status === 'error' ? '#fff' : 'var(--caption)',
                          background: s.status === 'waiting' ? 'var(--accent)' : s.status === 'error' ? 'var(--failed)' : s.status === 'thinking' ? 'var(--pending)' : 'transparent',
                          borderRadius:2, padding:'0 4px', fontSize:9, fontWeight:600,
                        }}>{s.status}</span>
                      )}
                      <span style={{ color:'var(--caption)', fontSize:10, marginLeft:'auto', fontVariantNumeric:'tabular-nums' }}>{fmtElapsed(s.elapsed)}</span>
                    </div>
                    <div style={{ color:'var(--caption)', fontSize:10, marginTop:3, paddingLeft:14, overflow:'hidden', textOverflow:'ellipsis', whiteSpace:'nowrap' }}>
                      {s.cwd !== '.' ? s.cwd : ''}
                      {s.gitBranch && <span style={{ color:'var(--accent)', marginLeft:4 }}> {s.gitBranch}</span>}
                    </div>
                  </div>
                ))}
              </div>
        )}

        <div style={{ borderBottom:'1px solid var(--hairline)', margin:'4px 0' }} />

        {/* Input */}
        {section('Input', 'input',
          <div>
            <label style={{ display:'flex', alignItems:'center', gap:4, marginBottom:4, cursor:'pointer', fontSize:10, userSelect:'none',
              color: broadcast ? 'var(--running)' : 'var(--caption)', fontWeight: broadcast ? 600 : 400 }}>
              <input type="checkbox" checked={broadcast} onChange={(e) => setBroadcast(e.target.checked)}
                style={{ accentColor:'var(--accent)', cursor:'pointer', width:12, height:12 }} />
              broadcast
            </label>
            <div style={{ display:'flex', gap:4 }}>
              <input value={input} onChange={(e) => setInput(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter') handleSend(); }}
                placeholder="type command..."
                style={{ flex:1, background:'var(--canvas)', border:`1px solid ${broadcast ? 'var(--running)' : 'var(--hairline)'}`,
                  borderRadius:3, color:'var(--ink)', padding:'4px 8px', fontSize:11, fontFamily:'var(--font-mono)',
                  outline:'none', minWidth:0 }} />
              <button onClick={handleSend}
                style={{ background: broadcast ? 'var(--running)' : 'var(--accent)', border:'none', borderRadius:3,
                  color:'#fff', padding:'4px 8px', cursor:'pointer', fontSize:11, fontWeight:600 }}>▶</button>
            </div>
          </div>
        )}

        <div style={{ borderBottom:'1px solid var(--hairline)', margin:'4px 0' }} />

        {/* Log */}
        {section('Log', 'log',
          <div style={{ maxHeight:120, overflow:'auto', fontSize:10, fontFamily:'var(--font-mono)', color:'var(--caption)', lineHeight:'16px' }}>
            {logs.length === 0
              ? <div style={{ fontStyle:'italic', fontFamily:'var(--font-sans)' }}>Waiting for events...</div>
              : logs.map((l, i) => (
                  <div key={i} style={{ color: l.color, whiteSpace:'nowrap', overflow:'hidden', textOverflow:'ellipsis' }}>
                    <span style={{ color:'var(--caption)', marginRight:4 }}>{l.time}</span>{l.text}
                  </div>
                ))
            }
            <div ref={logEndRef} />
          </div>
        )}
      </div>

      {/* Hints */}
      <div style={{ padding:'8px 10px', borderTop:'1px solid var(--hairline)', fontSize:10, color:'var(--caption)', lineHeight:'16px', flexShrink:0 }}>
        <span style={{ color:'var(--ink)' }}>F1-F9</span> pane &nbsp;
        <span style={{ color:'var(--ink)' }}>Ctrl+N</span> new &nbsp;
        <span style={{ color:'var(--ink)' }}>Ctrl+W</span> close &nbsp;
        <span style={{ color:'var(--ink)' }}>F10</span> quit
      </div>
    </div>
  );
}
