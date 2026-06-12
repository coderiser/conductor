import { useState, useEffect } from 'react';

interface Props {
  visible: boolean;
  onClose: () => void;
}

export function TaskPanel({ visible, onClose }: Props) {
  const [tasks, setTasks] = useState<any[]>([]);
  const [title, setTitle] = useState('');
  const [description, setDescription] = useState('');
  const [priority, setPriority] = useState('normal');
  const [caps, setCaps] = useState<string[]>(['code-gen']);
  const [stats, setStats] = useState<any>({});

  useEffect(() => {
    if (!visible) return;
    refresh();
    const iv = setInterval(refresh, 2000);
    return () => clearInterval(iv);
  }, [visible]);

  const refresh = async () => {
    try {
      setTasks(await window.electronAPI.listTasks() || []);
      setStats(await window.electronAPI.getTaskStats() || {});
    } catch { /* ignore */ }
  };

  const handleSubmit = async () => {
    if (!title.trim()) return;
    await window.electronAPI.enqueueTask({
      title: title.trim(),
      description: description.trim(),
      priority,
      requiredCapabilities: caps,
    });
    setTitle('');
    setDescription('');
    refresh();
  };

  const statusColor = (s: string) =>
    s === 'done' ? 'var(--running)' : s === 'failed' ? 'var(--failed)' :
    s === 'running' ? 'var(--accent)' : s === 'queued' ? 'var(--pending)' : 'var(--caption)';

  if (!visible) return null;

  return (
    <div style={{
      position:'fixed', right:0, top:0, bottom:0, width:360,
      background:'var(--canvas-deep)', borderLeft:'1px solid var(--hairline)',
      zIndex:100, display:'flex', flexDirection:'column', fontFamily:'var(--font-sans)',
    }}>
      <div style={{ padding:'12px 14px', borderBottom:'1px solid var(--hairline)', display:'flex', justifyContent:'space-between', alignItems:'center' }}>
        <div>
          <div style={{ color:'var(--ink)', fontWeight:700, fontSize:14 }}>Task Queue</div>
          <div style={{ color:'var(--caption)', fontSize:10, marginTop:2 }}>
            {stats.total || 0} total · {stats.pending || 0} pending · {stats.running || 0} running
          </div>
        </div>
        <button onClick={onClose} style={{ background:'none', border:'none', color:'var(--caption)', cursor:'pointer', fontSize:18 }}>✕</button>
      </div>

      <div style={{ padding:'10px 14px', borderBottom:'1px solid var(--hairline)' }}>
        <input value={title} onChange={e => setTitle(e.target.value)} placeholder="Task title..."
          style={{ width:'100%', background:'var(--canvas)', border:'1px solid var(--hairline)', borderRadius:3, color:'var(--ink)', padding:'6px 8px', fontSize:12, fontFamily:'var(--font-sans)', outline:'none', marginBottom:6 }} />
        <textarea value={description} onChange={e => setDescription(e.target.value)} placeholder="Description (optional)..." rows={2}
          style={{ width:'100%', background:'var(--canvas)', border:'1px solid var(--hairline)', borderRadius:3, color:'var(--ink)', padding:'6px 8px', fontSize:11, fontFamily:'var(--font-sans)', outline:'none', marginBottom:6, resize:'vertical' }} />
        <div style={{ display:'flex', gap:6, alignItems:'center' }}>
          <select value={priority} onChange={e => setPriority(e.target.value)}
            style={{ background:'var(--canvas)', border:'1px solid var(--hairline)', borderRadius:3, color:'var(--ink)', padding:'4px 6px', fontSize:11 }}>
            <option value="low">Low</option>
            <option value="normal">Normal</option>
            <option value="high">High</option>
          </select>
          <div style={{ display:'flex', gap:3, flexWrap:'wrap', flex:1 }}>
            {['code-gen','code-review','debugging','shell','web','file-ops'].map(c => (
              <label key={c} style={{ fontSize:10, color: caps.includes(c)?'var(--accent)':'var(--caption)', cursor:'pointer', display:'flex', alignItems:'center', gap:2 }}>
                <input type="checkbox" checked={caps.includes(c)} onChange={() => setCaps(p => p.includes(c)?p.filter(x=>x!==c):[...p,c])}
                  style={{ width:10, height:10, accentColor:'var(--accent)' }} />
                {c}
              </label>
            ))}
          </div>
          <button onClick={handleSubmit}
            style={{ background:'var(--accent)', border:'none', borderRadius:3, color:'#fff', padding:'4px 10px', cursor:'pointer', fontSize:11, fontWeight:600 }}>
            Enqueue
          </button>
        </div>
      </div>

      <div style={{ flex:1, overflow:'auto', padding:'6px 14px' }}>
        {tasks.length === 0 ? (
          <div style={{ color:'var(--caption)', fontSize:11, fontStyle:'italic', padding:'20px 0', textAlign:'center' }}>No tasks yet. Submit a task above.</div>
        ) : tasks.map((t: any) => (
          <div key={t.id} style={{ background:'var(--canvas-soft)', borderRadius:4, padding:'8px 10px', marginBottom:6, border:'1px solid var(--hairline)' }}>
            <div style={{ display:'flex', justifyContent:'space-between', alignItems:'center', marginBottom:4 }}>
              <span style={{ color:'var(--ink)', fontWeight:600, fontSize:12 }}>{t.title}</span>
              <span style={{ color:statusColor(t.status), fontSize:10, fontWeight:600, textTransform:'uppercase' }}>{t.status}</span>
            </div>
            {t.description && <div style={{ color:'var(--caption)', fontSize:10, marginBottom:4 }}>{t.description}</div>}
            <div style={{ display:'flex', gap:8, fontSize:10, color:'var(--caption)' }}>
              <span>{t.priority}</span>
              {t.assignedAgent && <span>→ {t.assignedAgent}</span>}
              {t.requiredCapabilities?.length > 0 && <span>{t.requiredCapabilities.join(', ')}</span>}
            </div>
            {t.status === 'running' && (
              <div style={{ marginTop:6, height:3, background:'var(--hairline)', borderRadius:2 }}>
                <div style={{ height:'100%', width:`${(t.progress||0)*100}%`, background:'var(--accent)', borderRadius:2, transition:'width 0.3s' }} />
              </div>
            )}
          </div>
        ))}
      </div>
    </div>
  );
}
