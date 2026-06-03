import { useEffect, useRef } from 'react';
import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import { CanvasAddon } from '@xterm/addon-canvas';
import { ClipboardAddon } from '@xterm/addon-clipboard';
import { pty, type SessionInfo } from '../lib/tauri-ipc';
import { terminalTheme } from '../lib/terminal-theme';
import '@xterm/xterm/css/xterm.css';

export function usePty(agent: string, cwd: string, container: HTMLDivElement | null, onReady?: (info: SessionInfo) => void, onExit?: (code: number) => void, onToken?: (count: number) => void, onStatus?: (status: string) => void) {
  const sessionRef = useRef<SessionInfo | null>(null);
  const timerRef = useRef<ReturnType<typeof setTimeout>>();
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
    pty.spawn(agent, cwd, d?.cols ?? 80, d?.rows ?? 24)
      .then(async (info) => {
        sessionRef.current = info;
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
          // Parse agent status from output
          if (onStatus) {
            if (data.match(/thinking|analyzing|reasoning/i)) onStatus('thinking');
            else if (data.match(/waiting|needs input|permission|approval|askuser/i)) onStatus('waiting');
            else if (data.match(/error|failed|exception|panic/i)) onStatus('error');
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
      clearTimeout(timerRef.current);
      container.removeEventListener('click', focusIt);
      onDataDisposable.dispose();
      ro.disconnect();
      cleanupRef.current.forEach((f) => f());
      if (sessionRef.current?.id) pty.kill(sessionRef.current.id).catch(() => {});
      term.dispose();
    };
  }, [agent, container]);
}
