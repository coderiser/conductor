// Thin named-pipe client for talking to the PTY daemon from the CLI.
// Reuses the daemon's framing protocol (4-byte BE length prefix + JSON) and
// message types — no protocol duplication. Used by: daemon status, sessions
// list/kill, app status, doctor.
import net from 'node:net';
import { paths } from './paths';
// Compiled protocol modules live alongside under dist/daemon/protocol/
import { encodeFrame, FrameDecoder } from '../daemon/protocol/framing';
import type { ClientMessage, DaemonMessage, SessionInfo } from '../daemon/protocol/messages';
import { PROTOCOL_VERSION } from '../daemon/protocol/messages';

/** One-shot request/response over the daemon pipe. Resolves on the FIRST frame. */
export function request<T extends DaemonMessage>(msg: ClientMessage, timeoutMs = 4000): Promise<T> {
  return new Promise((resolve, reject) => {
    const socket = net.connect(paths.pipePath);
    const decoder = new FrameDecoder();
    const timer = setTimeout(() => {
      socket.destroy();
      reject(new Error(`timed out waiting for daemon response (${timeoutMs}ms)`));
    }, timeoutMs);
    let done = false;
    const finish = (fn: () => void): void => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      socket.destroy();
      fn();
    };

    socket.on('connect', () => socket.write(encodeFrame(msg)));

    socket.on('data', (data) => {
      for (const m of decoder.push(data)) {
        const dmsg = m as DaemonMessage;
        finish(() => {
          if (dmsg.type === 'error') reject(new Error((dmsg as any).message));
          else resolve(dmsg as T);
        });
        return;
      }
    });

    socket.on('error', (err) => {
      finish(() => reject(new Error(`cannot reach daemon: ${err.message}`)));
    });
  });
}

export interface DaemonStatus {
  reachable: boolean;
  protocolVersion?: number;
  sessions: SessionInfo[];
  error?: string;
}

/** Connect, negotiate version, and list active sessions. Returns status snapshot. */
export async function getDaemonStatus(): Promise<DaemonStatus> {
  try {
    // Two clean single-frame requests (the daemon handles each on its own connection).
    const ack = await request<{ type: 'hello-ack'; version: number }>({ type: 'hello', version: PROTOCOL_VERSION });
    const res = await request<{ type: 'list-response'; sessions: SessionInfo[] }>({ type: 'list' });
    return { reachable: true, protocolVersion: ack.version, sessions: res.sessions };
  } catch (e) {
    return { reachable: false, sessions: [], error: (e as Error).message };
  }
}

/** Send a fire-and-forget message (e.g. kill). Resolves once written. */
export function send(msg: ClientMessage, timeoutMs = 3000): Promise<void> {
  return new Promise((resolve, reject) => {
    const socket = net.connect(paths.pipePath);
    const timer = setTimeout(() => { socket.destroy(); reject(new Error('timed out')); }, timeoutMs);
    socket.on('connect', () => {
      socket.write(encodeFrame(msg));
      // Give the frame a moment to flush before closing.
      setTimeout(() => { clearTimeout(timer); socket.destroy(); resolve(); }, 150);
    });
    socket.on('error', (err) => { clearTimeout(timer); reject(new Error(`cannot reach daemon: ${err.message}`)); });
  });
}
