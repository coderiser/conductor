import { useState, useCallback } from 'react';
import { usePty } from '../hooks/usePty';
import type { SessionInfo } from '../lib/tauri-ipc';

export function TerminalPanel({ agent, cwd, resumeId, isRestore, onFocus, onReady, onExit, onToken, onStatus, onSessionId }: {
  agent: string; cwd?: string; resumeId?: string; isRestore?: boolean; onFocus?: () => void; onReady?: (info: SessionInfo) => void; onExit?: (code: number) => void; onToken?: (n: number) => void; onStatus?: (s: string) => void; onSessionId?: (sid: string) => void;
}) {
  const [el, setEl] = useState<HTMLDivElement | null>(null);
  usePty(agent, cwd || '', el, onReady, onExit, onToken, onStatus, resumeId, isRestore, onSessionId);
  const ref = useCallback((n: HTMLDivElement | null) => setEl(n), []);
  return <div ref={ref} onClick={onFocus} style={{ width: '100%', height: '100%', background: '#1a1a1e', overflow: 'hidden', userSelect: 'text', WebkitUserSelect: 'text' }} />;
}
