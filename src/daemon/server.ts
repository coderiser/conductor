import net from 'net';
import { PtyManager } from './pty-manager.js';
import { encodeFrame, FrameDecoder } from './protocol/framing.js';
import { ClientMessage, DaemonMessage } from './protocol/messages.js';
import { negotiateVersion } from './protocol/version.js';

export class DaemonServer {
  private server: net.Server | null = null;
  private clients: net.Socket[] = [];
  private ptyManager: PtyManager;

  constructor(private pipePath: string) {
    this.ptyManager = new PtyManager(
      (sessionId, data) => this.broadcast({ type: 'output', sessionId, data }),
      (sessionId, code) => this.broadcast({ type: 'exit', sessionId, code })
    );
  }

  start() {
    this.server = net.createServer((socket) => {
      const decoder = new FrameDecoder();

      socket.on('data', (data) => {
        const messages = decoder.push(data);
        for (const msg of messages) {
          this.handleMessage(socket, msg as ClientMessage);
        }
      });

      socket.on('close', () => {
        this.clients = this.clients.filter(c => c !== socket);
      });

      this.clients.push(socket);
    });

    this.server.listen(this.pipePath, () => {
      console.log(`PTY Daemon listening on ${this.pipePath}`);
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
        const info = this.ptyManager.spawn(msg.agent, msg.cwd, msg.cols, msg.rows, msg.agentSessionId, msg.isRestore);
        response = { type: 'spawned', sessionId: info.sessionId, pid: info.pid, agent: info.agent, agentSessionId: info.agentSessionId };
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
    this.server?.close();
  }
}
