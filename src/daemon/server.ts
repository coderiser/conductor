import net from 'net';
import { PtyManager } from './pty-manager.js';
import { encodeFrame, FrameDecoder } from './protocol/framing.js';
import { ClientMessage, DaemonMessage } from './protocol/messages.js';
import { negotiateVersion } from './protocol/version.js';

export class DaemonServer {
  private server: net.Server | null = null;
  private clients: net.Socket[] = [];
  private ptyManager: PtyManager;

  constructor(private _pipePath: string) {
    this.ptyManager = new PtyManager(
      (sessionId, data) => this.broadcast({ type: 'output', sessionId, data }),
      (sessionId, code) => this.broadcast({ type: 'exit', sessionId, code }),
      (sessionId, agentSessionId) => this.broadcast({ type: 'session-id-changed', sessionId, agentSessionId })
    );
  }

  start() {
    this.server = net.createServer((socket) => {
      const decoder = new FrameDecoder();

      socket.on('data', (data) => {
        try {
          const messages = decoder.push(data);
          for (const msg of messages) {
            this.handleMessage(socket, msg as ClientMessage);
          }
        } catch (err) {
          console.error('Message processing error:', (err as Error).message);
          try { socket.destroy(); } catch { /* ignore */ }
        }
      });

      socket.on('error', (err) => {
        console.error('Socket error:', err.message);
        // Socket will emit 'close' after this, so cleanup happens there
      });

      socket.on('close', () => {
        this.clients = this.clients.filter(c => c !== socket);
      });

      this.clients.push(socket);
    });

    this.server.on('error', (err) => {
      console.error('Server error:', err.message);
      throw err; // Re-throw so process.on('uncaughtException') catches it
    });

    this.server.listen(this._pipePath, () => {
      console.log(`PTY Daemon listening on ${this._pipePath}`);
    });
  }

  private handleMessage(socket: net.Socket, msg: ClientMessage) {
    let response: DaemonMessage;

    switch (msg.type) {
      case 'hello': {
        const version = negotiateVersion(msg.version);
        response = { type: 'hello-ack', version };
        break;
      }
      case 'spawn': {
        try {
          const info = this.ptyManager.spawn(msg.agent, msg.cwd, msg.cols, msg.rows, msg.agentSessionId, msg.isRestore);
          response = { type: 'spawned', sessionId: info.sessionId, pid: info.pid, agent: info.agent, agentSessionId: info.agentSessionId };
        } catch (err) {
          response = { type: 'error', message: (err as Error).message };
        }
        break;
      }
      case 'write': {
        this.ptyManager.write(msg.sessionId, msg.data);
        return; // no response
      }
      case 'resize': {
        this.ptyManager.resize(msg.sessionId, msg.cols, msg.rows);
        return;
      }
      case 'kill': {
        this.ptyManager.kill(msg.sessionId);
        return;
      }
      case 'list': {
        response = { type: 'list-response', sessions: this.ptyManager.list() };
        break;
      }
      case 'set-agent-session-id': {
        this.ptyManager.setAgentSessionId(msg.sessionId, msg.agentSessionId);
        this.broadcast({ type: 'session-id-changed', sessionId: msg.sessionId, agentSessionId: msg.agentSessionId });
        return;
      }
      case 'get-session-activity': {
        const activity = this.ptyManager.getSessionActivity(msg.sessionId);
        response = { type: 'session-activity', sessionId: msg.sessionId, hasRecentOutput: activity.hasRecentOutput, lastOutputAt: activity.lastOutputAt };
        break;
      }
      default:
        response = { type: 'error', message: `Unknown message type: ${(msg as any).type}` };
    }

    socket.write(encodeFrame(response));
  }

  private broadcast(msg: DaemonMessage) {
    const frame = encodeFrame(msg);
    for (const client of this.clients) {
      client.write(frame);
    }
  }

  stop() {
    this.ptyManager.killAll();
    for (const client of this.clients) {
      client.destroy();
    }
    this.clients = [];
    this.server?.close();
  }
}
