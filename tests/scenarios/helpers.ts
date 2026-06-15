/**
 * Scenario Test Helpers
 * Shared utilities for user-story-driven acceptance tests.
 */
import net from 'net';
import fs from 'fs';
import os from 'os';
import path from 'path';
import simpleGit from 'simple-git';

// ═══ Named Pipe Protocol ═══

export const PIPE_PATH = '\\\\.\\pipe\\conductor-pty-daemon';

export function encodeFrame(msg: object): Buffer {
  const payload = Buffer.from(JSON.stringify(msg), 'utf8');
  const header = Buffer.alloc(4);
  header.writeUInt32BE(payload.length, 0);
  return Buffer.concat([header, payload]);
}

export function decodeFrame(data: Buffer): { msg: any; consumed: number } | null {
  if (data.length < 4) return null;
  const len = data.readUInt32BE(0);
  if (data.length < 4 + len) return null;
  return { msg: JSON.parse(data.slice(4, 4 + len).toString('utf8')), consumed: 4 + len };
}

const RESPONSE_TYPES = new Set(['hello-ack', 'spawned', 'list-response', 'error', 'session-activity']);
const FIRE_FORGET = new Set(['kill', 'write', 'resize', 'set-agent-session-id', 'agent-notify']);

/** Send request to daemon (hello + msg), resolve on first response-type message. */
export function daemonRequest(msg: object, timeoutMs = 15000): Promise<any> {
  return new Promise((resolve, reject) => {
    const socket = net.connect(PIPE_PATH);
    let buffer = Buffer.alloc(0);
    let requestSent = false;
    const timeout = setTimeout(() => { socket.destroy(); reject(new Error('Daemon timeout')); }, timeoutMs);

    socket.on('connect', () => socket.write(encodeFrame({ type: 'hello', version: 1 })));
    socket.on('data', (data: Buffer) => {
      buffer = Buffer.concat([buffer, data]);
      while (true) {
        const frame = decodeFrame(buffer);
        if (!frame) break;
        buffer = buffer.slice(frame.consumed);
        if (!requestSent && frame.msg.type === 'hello-ack') {
          requestSent = true;
          socket.write(encodeFrame(msg));
        } else if (RESPONSE_TYPES.has(frame.msg.type)) {
          clearTimeout(timeout);
          socket.destroy();
          resolve(frame.msg);
          return;
        }
      }
    });
    socket.on('error', (err) => { clearTimeout(timeout); reject(err); });
  });
}

/** Fire-and-forget message to daemon (no response expected). */
export function daemonSend(msg: object): void {
  const socket = net.connect(PIPE_PATH);
  let sent = false;
  socket.on('connect', () => socket.write(encodeFrame({ type: 'hello', version: 1 })));
  socket.on('data', (data: Buffer) => {
    if (sent) return;
    const frame = decodeFrame(data);
    if (frame && frame.msg.type === 'hello-ack') {
      sent = true;
      socket.write(encodeFrame(msg));
      setTimeout(() => socket.destroy(), 100);
    }
  });
}

/** Collect output from a daemon session for a given duration. */
export function collectOutput(sessionId: string, durationMs: number): Promise<string> {
  return new Promise((resolve) => {
    const socket = net.connect(PIPE_PATH);
    let buffer = Buffer.alloc(0);
    let output = '';
    let started = false;

    socket.on('connect', () => socket.write(encodeFrame({ type: 'hello', version: 1 })));
    socket.on('data', (data: Buffer) => {
      buffer = Buffer.concat([buffer, data]);
      while (true) {
        const frame = decodeFrame(buffer);
        if (!frame) break;
        buffer = buffer.slice(frame.consumed);
        if (!started && frame.msg.type === 'hello-ack') {
          started = true;
          setTimeout(() => { socket.destroy(); resolve(output); }, durationMs);
        } else if (frame.msg.type === 'output' && frame.msg.sessionId === sessionId) {
          output += frame.msg.data;
        }
      }
    });
    socket.on('error', () => resolve(output));
  });
}

// ═══ Git Repo Setup ═══

export async function createTestGitRepo(): Promise<string> {
  const repo = path.join(os.tmpdir(), 'conductor-scenario-' + crypto.randomUUID().slice(0, 8));
  fs.mkdirSync(repo, { recursive: true });
  const git = simpleGit(repo);
  await git.init(['-b', 'main']);
  await git.addConfig('user.name', 'scenario-test');
  await git.addConfig('user.email', 'scenario@conductor.test');
  fs.writeFileSync(path.join(repo, 'main.ts'), 'export const version = 1;\n');
  await git.add('main.ts');
  await git.commit('initial commit');
  return repo;
}

export function cleanupTestRepo(repo: string): void {
  try { fs.rmSync(repo, { recursive: true, force: true }); } catch { /* best effort */ }
}

/** Unique session ID for test isolation */
export function sid(prefix: string): string {
  return `${prefix}-${Math.random().toString(36).slice(2, 8)}`;
}
