import net from 'net';
import fs from 'fs';
import { spawn } from 'child_process';
import path from 'path';
import { app } from 'electron';
import { encodeFrame, FrameDecoder } from '../daemon/protocol/framing.js';
import type { ClientMessage, DaemonMessage } from '../daemon/protocol/messages.js';
import { DEFAULT_AGENTS } from './agent-config.js';

const PIPE_PATH = '\\\\.\\pipe\\conductor-pty-daemon';

/** Message types that are responses to requests (consumed by resolvers). */
const RESPONSE_TYPES = new Set(['hello-ack', 'spawned', 'list-response', 'error']);

export class DaemonClient {
  private socket: net.Socket | null = null;
  private decoder = new FrameDecoder();
  private messageHandlers = new Map<string, ((msg: DaemonMessage) => void)[]>();
  private requestResolvers: ((msg: DaemonMessage) => void)[] = [];
  private requestId = 1;

  /**
   * Connect to the PTY Daemon.
   * If the daemon is not running, starts it automatically.
   */
  async connect(): Promise<void> {
    // Try connecting to an already-running daemon
    try {
      await this.tryConnect();
      console.log('[DaemonClient] Connected to existing PTY Daemon');
      return;
    } catch {
      console.log('[DaemonClient] Starting new PTY Daemon...');
    }

    // Ensure agents.json is available in userData for the daemon to read
    this.ensureAgentsConfig();

    // Start daemon process with config path in environment
    const daemonScript = path.join(app.getAppPath(), 'dist', 'daemon', 'main.js');
    const configPath = path.join(app.getPath('userData'), 'agents.json');
    const daemonProcess = spawn('node', [daemonScript], {
      stdio: 'ignore',
      detached: true,
      env: { ...process.env, CONDUCTOR_AGENTS_CONFIG: configPath },
    });
    daemonProcess.unref();

    // Wait for daemon to be ready, then connect
    await this.waitForDaemon();
    await this.tryConnect();
    console.log('[DaemonClient] PTY Daemon started and connected');
  }

  /**
   * Copy agents.json from the app bundle to userData if not already present.
   * This is needed because the daemon runs as plain Node.js and may not be able
   * to read files inside the Electron asar archive.
   */
  private ensureAgentsConfig(): void {
    const userDataPath = path.join(app.getPath('userData'), 'agents.json');
    if (fs.existsSync(userDataPath)) return;

    // Try to find agents.json in the app bundle
    const bundlePath = path.join(app.getAppPath(), 'agents.json');
    if (fs.existsSync(bundlePath)) {
      fs.copyFileSync(bundlePath, userDataPath);
      return;
    }

    // Create defaults if neither location has the file
    fs.writeFileSync(path.join(app.getPath('userData'), 'agents.json'), JSON.stringify({ agents: DEFAULT_AGENTS }, null, 2));
  }

  /**
   * Attempt to connect to the daemon via Named Pipe.
   * Resolves on success, rejects on failure. Does NOT modify this.socket on failure.
   */
  private tryConnect(): Promise<void> {
    return new Promise((resolve, reject) => {
      const socket = net.connect(PIPE_PATH);

      socket.once('connect', () => {
        this.socket = socket;
        this.decoder = new FrameDecoder(); // reset decoder to discard any stale bytes from prior connection
        this.setupSocketHandlers();
        this.sendHello();
        resolve();
      });

      socket.once('error', (err) => {
        socket.destroy();
        reject(err);
      });
    });
  }

  /**
   * Poll until the daemon pipe becomes available (up to 5 seconds).
   */
  private async waitForDaemon(): Promise<void> {
    for (let i = 0; i < 50; i++) {
      try {
        await this.tryConnect();
        // Connected — disconnect immediately; real connect happens next
        this.socket?.destroy();
        this.socket = null;
        return;
      } catch {
        await new Promise(r => setTimeout(r, 100));
      }
    }
    throw new Error('PTY Daemon failed to start');
  }

  private setupSocketHandlers(): void {
    if (!this.socket) return;

    this.socket.on('data', (data: Buffer) => {
      const messages = this.decoder.push(data);
      for (const msg of messages) {
        this.handleMessage(msg as DaemonMessage);
      }
    });

    this.socket.on('close', () => {
      console.log('[DaemonClient] Disconnected from PTY Daemon');
      this.socket = null;
      // Reject all pending request resolvers
      this.rejectPendingRequests('Connection to daemon lost');
    });

    this.socket.on('error', (err: Error) => {
      console.error('[DaemonClient] Socket error:', err.message);
    });
  }

  private sendHello(): void {
    this.send({ type: 'hello', version: 1 });
  }

  private handleMessage(msg: DaemonMessage): void {
    // If this is a response type, try to resolve a pending request first
    if (RESPONSE_TYPES.has(msg.type)) {
      const resolver = this.requestResolvers.shift();
      if (resolver) {
        resolver(msg);
        return; // consumed by resolver — not broadcast to handlers
      }
    }

    // Broadcast to all registered event handlers
    const handlers = this.messageHandlers.get(msg.type) || [];
    for (const handler of handlers) {
      handler(msg);
    }
  }

  /**
   * Send a request and wait for the corresponding response.
   * Requests are queued in FIFO order (protocol is single-threaded on the server).
   * Times out after 5 seconds.
   */
  async request<T extends DaemonMessage>(msg: ClientMessage): Promise<T> {
    return new Promise((resolve, reject) => {
      if (!this.socket) {
        reject(new Error('Not connected to daemon'));
        return;
      }

      const id = `req-${this.requestId++}`;
      const timeout = setTimeout(() => {
        // Remove this resolver from the queue
        const idx = this.requestResolvers.indexOf(resolverFn);
        if (idx >= 0) this.requestResolvers.splice(idx, 1);
        reject(new Error(`Request ${id} timed out`));
      }, 5000);

      const resolverFn = (response: DaemonMessage): void => {
        clearTimeout(timeout);
        if (response.type === 'error') {
          reject(new Error(response.message));
        } else {
          resolve(response as T);
        }
      };

      this.requestResolvers.push(resolverFn);
      this.socket.write(encodeFrame(msg));
    });
  }

  /**
   * Register a handler for a specific daemon message type.
   * Useful for broadcast events: 'output', 'exit', 'session-id-changed'.
   */
  on(type: string, handler: (msg: DaemonMessage) => void): void {
    if (!this.messageHandlers.has(type)) {
      this.messageHandlers.set(type, []);
    }
    this.messageHandlers.get(type)!.push(handler);
  }

  /** Remove a previously registered handler for a specific daemon message type. */
  off(type: string, handler: (msg: DaemonMessage) => void): void {
    const handlers = this.messageHandlers.get(type);
    if (handlers) {
      const idx = handlers.indexOf(handler);
      if (idx >= 0) handlers.splice(idx, 1);
    }
  }

  /** Disconnect and clear all handlers. */
  destroy(): void {
    this.disconnect();
    this.messageHandlers.clear();
    this.rejectPendingRequests('Client destroyed');
  }

  /**
   * Send a message without expecting a response (fire-and-forget).
   * Use for: write, resize, kill, set-agent-session-id.
   */
  send(msg: ClientMessage): void {
    if (this.socket) {
      this.socket.write(encodeFrame(msg));
    }
  }

  /** Whether the client is currently connected to the daemon. */
  get connected(): boolean {
    return this.socket !== null && !this.socket.destroyed;
  }

  /** Disconnect from the daemon. */
  disconnect(): void {
    this.socket?.destroy();
    this.socket = null;
    this.rejectPendingRequests('Client disconnected');
  }

  private rejectPendingRequests(reason: string): void {
    const pending = this.requestResolvers.splice(0);
    for (const resolver of pending) {
      resolver({ type: 'error', message: reason });
    }
  }
}
