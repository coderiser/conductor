import { useState, useEffect } from 'react';

interface Props {
  visible: boolean;
  onClose: () => void;
}

export function ContextFeed({ visible, onClose }: Props) {
  const [entries, setEntries] = useState<any[]>([]);
  const [filter, setFilter] = useState('');

  useEffect(() => {
    if (!visible) return;
    window.electronAPI.listContext().then(setEntries).catch(() => {});
    const unsub = window.electronAPI.onNewContext((entry: any) => {
      setEntries(prev => [entry, ...prev]);
    });
    return () => { unsub?.(); };
  }, [visible]);

  const filtered = filter
    ? entries.filter((e: any) =>
        e.title.toLowerCase().includes(filter.toLowerCase()) ||
        e.tags?.some((t: string) => t.toLowerCase().includes(filter.toLowerCase())))
    : entries;

  const typeIcon = (t: string) =>
    t === 'summary' ? '📋' : t === 'finding' ? '🔍' : t === 'file-diff' ? '📝' : t === 'code-snippet' ? '💻' : t === 'link' ? '🔗' : '📌';

  const priorityColor = (p: string) =>
    p === 'high' ? 'var(--failed)' : p === 'normal' ? 'var(--pending)' : 'var(--caption)';

  if (!visible) return null;

  return (
    <div style={{
      position:'fixed', right:0, top:0, bottom:0, width:340,
      background:'var(--canvas-deep)', borderLeft:'1px solid var(--hairline)',
      zIndex:100, display:'flex', flexDirection:'column', fontFamily:'var(--font-sans)',
    }}>
      <div style={{ padding:'12px 14px', borderBottom:'1px solid var(--hairline)', display:'flex', justifyContent:'space-between', alignItems:'center' }}>
        <div>
          <div style={{ color:'var(--ink)', fontWeight:700, fontSize:14 }}>Context Feed</div>
          <div style={{ color:'var(--caption)', fontSize:10, marginTop:2 }}>{entries.length} entries</div>
        </div>
        <button onClick={onClose} style={{ background:'none', border:'none', color:'var(--caption)', cursor:'pointer', fontSize:18 }}>✕</button>
      </div>

      <div style={{ padding:'8px 14px', borderBottom:'1px solid var(--hairline)' }}>
        <input value={filter} onChange={e => setFilter(e.target.value)} placeholder="Search by title or tag..."
          style={{ width:'100%', background:'var(--canvas)', border:'1px solid var(--hairline)', borderRadius:3, color:'var(--ink)', padding:'4px 8px', fontSize:11, fontFamily:'var(--font-sans)', outline:'none' }} />
      </div>

      <div style={{ flex:1, overflow:'auto', padding:'6px 14px' }}>
        {filtered.length === 0 ? (
          <div style={{ color:'var(--caption)', fontSize:11, fontStyle:'italic', padding:'20px 0', textAlign:'center' }}>
            {filter ? 'No matching entries' : 'No context shared yet'}
          </div>
        ) : filtered.map((e: any) => (
          <div key={e.id} style={{
            background: e.consumed ? 'var(--canvas-soft)' : 'rgba(94,106,210,0.08)',
            borderRadius:4, padding:'8px 10px', marginBottom:6,
            border: e.consumed ? '1px solid var(--hairline)' : '1px solid var(--accent)',
            opacity: e.consumed ? 0.7 : 1,
          }}>
            <div style={{ display:'flex', alignItems:'center', gap:6, marginBottom:4 }}>
              <span>{typeIcon(e.contextType)}</span>
              <span style={{ color:'var(--ink)', fontWeight:600, fontSize:12, flex:1 }}>{e.title}</span>
              <span style={{ color:priorityColor(e.priority), fontSize:9, fontWeight:600 }}>{e.priority}</span>
            </div>
            <div style={{ color:'var(--caption)', fontSize:10, marginBottom:4, paddingLeft:22 }}>{e.body}</div>
            <div style={{ display:'flex', gap:4, alignItems:'center', paddingLeft:22 }}>
              <span style={{ color:'var(--accent)', fontSize:9 }}>{e.agentId}</span>
              {e.tags?.map((t: string) => (
                <span key={t} style={{ color:'var(--caption)', fontSize:9, background:'var(--canvas)', borderRadius:2, padding:'0 4px' }}>{t}</span>
              ))}
              <span style={{ color:'var(--caption)', fontSize:9, marginLeft:'auto' }}>
                {new Date(e.timestamp).toLocaleTimeString('en-US', { hour12: false })}
              </span>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
