import { useEffect, useRef } from 'react';
import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import { CanvasAddon } from '@xterm/addon-canvas';
import { ClipboardAddon } from '@xterm/addon-clipboard';
import { pty, type SessionInfo } from '../lib/tauri-ipc';
import { terminalTheme } from '../lib/terminal-theme';
import '@xterm/xterm/css/xterm.css';

export function usePty(agent: string, cwd: string, container: HTMLDivElement | null, onReady?: (info: SessionInfo) => void, onExit?: (code: number) => void, onToken?: (count: number) => void, onStatus?: (status: string) => void, resumeId?: string, isRestore?: boolean, onSessionId?: (sid: string) => void) {
  const sessionRef = useRef<SessionInfo | null>(null);
  const timerRef = useRef<ReturnType<typeof setTimeout>>();
  const statusTimerRef = useRef<ReturnType<typeof setTimeout>>();
  const cleanupRef = useRef<Array<() => void>>([]);

  useEffect(() => {
    if (!container) return;
    const term = new Terminal({
      cursorBlink: true, cursorStyle: 'block', fontSize: 13,
      fontFamily: "'Cascadia Code', Consolas, monospace",
      theme: terminalTheme, scrollback: 5000,
      allowProposedApi: true,
      allowTransparency: true,
      macOptionIsMeta: false,
    });
    const fit = new FitAddon();
    term.loadAddon(fit); term.loadAddon(new CanvasAddon()); term.loadAddon(new ClipboardAddon());
    term.open(container);
    fit.fit();
    term.write(`\x1b[36m● Starting ${agent}...\x1b[0m\r\n`);
    if (resumeId) term.write(`\x1b[35m  ${isRestore ? 'RESUME' : 'NEW'} session: ${resumeId.slice(0, 8)}...\x1b[0m\r\n`);

    // Clipboard: copy selection on Ctrl+Shift+C, Ctrl+Insert, or context menu
    const copySelection = () => {
      const sel = term.getSelection();
      if (sel) navigator.clipboard.writeText(sel).catch(() => {});
    };
    term.attachCustomKeyEventHandler((e) => {
      if ((e.ctrlKey && e.shiftKey && e.key === 'C') || (e.ctrlKey && e.key === 'Insert')) {
        copySelection(); return false;
      }
      return true;
    });
    // Right-click to copy
    container.addEventListener('contextmenu', (e) => {
      const sel = term.getSelection();
      if (sel) { navigator.clipboard.writeText(sel).catch(() => {}); e.preventDefault(); }
    });

    const focusIt = () => term.focus();
    focusIt();
    const t1 = setTimeout(focusIt, 50);
    const t2 = setTimeout(focusIt, 300);
    const t3 = setTimeout(focusIt, 1000);
    container.addEventListener('click', focusIt);

    // Register input BEFORE spawn — no gate on session state
    let pending = '';
    let sessionIdCaptured = false;
    let lastStatus = '';
    const onDataDisposable = term.onData((data) => {
      const s = sessionRef.current;
      if (s?.id) {
        pty.write(s.id, data).catch((e) => { term.write(`\x1b[31m[E:${e}]\x1b[0m`); });
      } else { pending += data; }
    });

    const ro = new ResizeObserver(() => {
      clearTimeout(timerRef.current);
      timerRef.current = setTimeout(() => {
        fit.fit(); const nd = fit.proposeDimensions();
        if (nd?.cols && nd?.rows && sessionRef.current?.id) {
          pty.resize(sessionRef.current.id, nd.cols, nd.rows).catch(() => {});
        }
      }, 150);
    });
    ro.observe(container);

    const d = fit.proposeDimensions();
    pty.spawn(agent, cwd, d?.cols ?? 80, d?.rows ?? 24, resumeId, isRestore)
      .then(async (info) => {
        sessionRef.current = info;
        // Post-spawn session ID capture for OpenCode/Codex (/rename flow)
        const unlistenSid = await pty.onSessionIdChanged(info.id, (sid) => {
          term.write(`\x1b[35m[Session: ${sid} — will resume on restart]\x1b[0m\r\n`);
          onSessionId?.(sid);
        });
        cleanupRef.current.push(unlistenSid);
        onReady?.(info);
        cleanupRef.current.push(await pty.onOutput(info.id, (data) => {
          term.write(data);
          // Parse token count: requires whitespace between number and "tokens"
          // Prevents ANSI escape '2mtokens' (dim mode) from matching
          const m = data.match(/([\d,.]+[km]?)\s+tokens\b/i);
          if (m && onToken) {
            const s = m[1].toLowerCase().replace(',', '');
            const n = s.endsWith('k') ? parseFloat(s) * 1000 : s.endsWith('m') ? parseFloat(s) * 1000000 : parseInt(s);
            if (!isNaN(n) && n > 10 && n < 100_000_000) onToken(n);
          }
          // Parse agent session ID from startup output (capture only once)
          // Only matches structured patterns like "Session ID: <id>" or "Session: <uuid>"
          // to avoid false positives from phrases like "session permissions"
          if (!sessionIdCaptured) {
            const sidMatch = data.match(/session\s*(?:id)?\s*[:：]\s*([a-f0-9\-]{8,}|ses_\w{8,}|[\w-]{20,})/i);
            if (sidMatch && sessionRef.current) {
              const sid = sidMatch[1];
              sessionIdCaptured = true;
              pty.setAgentSessionId(sessionRef.current.id, sid).then(() => {
                term.write(`\x1b[35m[Session: ${sid} — will resume on restart]\x1b[0m\r\n`);
                onSessionId?.(sid);
              }).catch(() => {
              }).catch(() => {
                term.write(`\x1b[31m[Session: ${sid} — FAILED to save]\x1b[0m\r\n`);
              });
            }
          }
          // Parse agent status from output (deduplicated — only update on change)
          if (onStatus) {
            if (data.length < 3) return;
            let newStatus = '';
            if (/prompt|ready|\$\s|>\s|done|complete|finished|result|answer/i.test(data) && data.length < 200) newStatus = 'running';
            else if (/thinking|analyzing|reasoning|processing|generating|executing|working/i.test(data)) newStatus = 'thinking';
            else if (/waiting|needs.?input|permission|approval|ask.?user|confirm|allow/i.test(data)) newStatus = 'waiting';
            else if (/error|failed|exception|panic|crash|fatal/i.test(data)) newStatus = 'error';
            if (newStatus && newStatus !== lastStatus) {
              lastStatus = newStatus;
              onStatus(newStatus);
              // Auto-reset to running after 5s if no update
              clearTimeout(statusTimerRef.current);
              if (newStatus !== 'running' && newStatus !== 'error') {
                statusTimerRef.current = setTimeout(() => { lastStatus = 'running'; onStatus('running'); }, 5000);
              }
            }
          }
        }));
        cleanupRef.current.push(await pty.onExit(info.id, (code) => {
          term.write(`\r\n\x1b[33m● Session ended (exit: ${code})\x1b[0m\r\n`);
          sessionRef.current = null;
          onExit?.(code);
        }));
        if (pending) { pty.write(info.id, pending).catch(() => {}); pending = ''; }
        term.write(`\x1b[32m● Ready (${info.id})\x1b[0m\r\n`);
      })
      .catch((err) => {
        term.write(`\r\n\x1b[31m● Failed: ${err}\x1b[0m\r\n`);
        sessionRef.current = null;
      });

    return () => {
      clearTimeout(t1); clearTimeout(t2); clearTimeout(t3);
      clearTimeout(timerRef.current); clearTimeout(statusTimerRef.current);
      container.removeEventListener('click', focusIt);
      onDataDisposable.dispose();
      ro.disconnect();
      cleanupRef.current.forEach((f) => f());
      if (sessionRef.current?.id) pty.kill(sessionRef.current.id).catch(() => {});
      term.dispose();
    };
  }, [agent, container]);
}
