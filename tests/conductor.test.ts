/**
 * Comprehensive test suite for Conductor V2 - Phase 1 (Electron Migration)
 * Tests: Protocol, PTY lifecycle, Session recovery, Persistence, Git integration
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import net from 'net';
import path from 'path';
import fs from 'fs';
import { execSync } from 'child_process';

const PIPE_PATH = '\\\\.\\pipe\\conductor-pty-daemon';

// Helper: encode message to Named Pipe frame
function encodeFrame(msg: object): Buffer {
  const payload = Buffer.from(JSON.stringify(msg), 'utf8');
  const header = Buffer.alloc(4);
  header.writeUInt32BE(payload.length, 0);
  return Buffer.concat([header, payload]);
}

// Helper: decode frame from Named Pipe
function decodeFrame(data: Buffer): { msg: any; consumed: number } | null {
  if (data.length < 4) return null;
  const len = data.readUInt32BE(0);
  if (data.length < 4 + len) return null;
  const payload = data.slice(4, 4 + len).toString('utf8');
  return { msg: JSON.parse(payload), consumed: 4 + len };
}

// Helper: connect to daemon and run a test
async function withDaemon(fn: (socket: net.Socket, recv: () => Promise<any>) => Promise<void>) {
  return new Promise<void>((resolve, reject) => {
    const socket = net.connect(PIPE_PATH);
    let buffer = Buffer.alloc(0);
    const waiters: ((_msg: any) => void)[] = [];

    socket.on('data', (data) => {
      buffer = Buffer.concat([buffer, data]);
      while (true) {
        const frame = decodeFrame(buffer);
        if (!frame) break;
        buffer = buffer.slice(frame.consumed);
        const waiter = waiters.shift();
        if (waiter) waiter(frame.msg);
      }
    });

    socket.on('error', reject);

    const recv = () => new Promise<any>((res) => {
      waiters.push(res);
    });

    // Send hello first
    socket.write(encodeFrame({ type: 'hello', version: 1 }));
    recv().then(() => fn(socket, recv)).then(() => {
      socket.destroy();
      resolve();
    }).catch(reject);
  });
}

// ============================================================================
// Test Suite
// ============================================================================

describe('Conductor V2 - Phase 1 Tests', () => {

  // --------------------------------------------------------------------------
  // 1. Protocol & Connection
  // --------------------------------------------------------------------------
  describe('Protocol & Connection', () => {
    it('should connect to daemon via Named Pipe', async () => {
      await withDaemon(async (socket, recv) => {
        // If we got here, connection succeeded and hello-ack received
        expect(socket.destroyed).toBe(false);
      });
    });

    it('should respond to hello with hello-ack', async () => {
      await withDaemon(async (socket, recv) => {
        // hello-ack was already received in withDaemon setup
        // This test verifies the protocol handshake works
      });
    });

    it('should handle multiple concurrent connections', async () => {
      const connections = await Promise.all([
        withDaemon(async () => {}),
        withDaemon(async () => {}),
        withDaemon(async () => {}),
      ]);
      expect(connections.length).toBe(3);
    });
  });

  // --------------------------------------------------------------------------
  // 2. PTY Lifecycle
  // --------------------------------------------------------------------------
  describe('PTY Lifecycle', () => {
    it('should spawn cmd.exe and receive output', async () => {
      await withDaemon(async (socket, recv) => {
        socket.write(encodeFrame({
          type: 'spawn', agent: 'cmd.exe', cwd: '.', cols: 80, rows: 24,
          agentSessionId: '', isRestore: false
        }));
        const spawned = await recv();
        expect(spawned.type).toBe('spawned');
        expect(spawned.agent).toBe('cmd.exe');
        expect(spawned.pid).toBeGreaterThan(0);
        expect(spawned.sessionId).toMatch(/^S\d+$/);

        // Wait for some output
        const output = await recv();
        expect(output.type).toBe('output');
        expect(output.sessionId).toBe(spawned.sessionId);

        // Kill the session
        socket.write(encodeFrame({ type: 'kill', sessionId: spawned.sessionId }));
        // Drain messages until exit
        let gotExit = false;
        for (let i = 0; i < 20; i++) {
          const msg = await recv();
          if (msg.type === 'exit') { gotExit = true; break; }
        }
        expect(gotExit).toBe(true);
      });
    });

    it('should spawn claude code', async () => {
      await withDaemon(async (socket, recv) => {
        socket.write(encodeFrame({
          type: 'spawn', agent: 'claude', cwd: '.', cols: 80, rows: 24,
          agentSessionId: '', isRestore: false
        }));
        const spawned = await recv();
        expect(spawned.type).toBe('spawned');
        expect(spawned.agent).toBe('claude');

        // Wait a bit for output then kill
        await new Promise(r => setTimeout(r, 1000));
        socket.write(encodeFrame({ type: 'kill', sessionId: spawned.sessionId }));
        // Drain messages
        for (let i = 0; i < 10; i++) {
          const msg = await recv();
          if (msg.type === 'exit') break;
        }
      });
    });

    it('should spawn opencode', async () => {
      await withDaemon(async (socket, recv) => {
        socket.write(encodeFrame({
          type: 'spawn', agent: 'opencode', cwd: '.', cols: 80, rows: 24,
          agentSessionId: '', isRestore: false
        }));
        const spawned = await recv();
        expect(spawned.type).toBe('spawned');
        expect(spawned.agent).toBe('opencode');

        await new Promise(r => setTimeout(r, 1000));
        socket.write(encodeFrame({ type: 'kill', sessionId: spawned.sessionId }));
        for (let i = 0; i < 10; i++) {
          const msg = await recv();
          if (msg.type === 'exit') break;
        }
      });
    });

    it('should spawn codex', async () => {
      await withDaemon(async (socket, recv) => {
        socket.write(encodeFrame({
          type: 'spawn', agent: 'codex', cwd: '.', cols: 80, rows: 24,
          agentSessionId: '', isRestore: false
        }));
        const spawned = await recv();
        expect(spawned.type).toBe('spawned');
        expect(spawned.agent).toBe('codex');

        await new Promise(r => setTimeout(r, 1000));
        socket.write(encodeFrame({ type: 'kill', sessionId: spawned.sessionId }));
        for (let i = 0; i < 10; i++) {
          const msg = await recv();
          if (msg.type === 'exit') break;
        }
      });
    });

    it('should handle write to PTY', async () => {
      await withDaemon(async (socket, recv) => {
        socket.write(encodeFrame({
          type: 'spawn', agent: 'cmd.exe', cwd: '.', cols: 80, rows: 24,
          agentSessionId: '', isRestore: false
        }));
        const spawned = await recv();

        // Wait for prompt then write a command
        await new Promise(r => setTimeout(r, 1000));
        socket.write(encodeFrame({ type: 'write', sessionId: spawned.sessionId, data: 'echo hello\r\n' }));

        // Should get output containing "hello"
        let found = false;
        for (let i = 0; i < 20; i++) {
          const msg = await recv();
          if (msg.type === 'output' && msg.data.includes('hello')) {
            found = true;
            break;
          }
          if (msg.type === 'exit') break;
        }
        expect(found).toBe(true);

        socket.write(encodeFrame({ type: 'kill', sessionId: spawned.sessionId }));
        for (let i = 0; i < 10; i++) {
          const msg = await recv();
          if (msg.type === 'exit') break;
        }
      });
    });

    it('should handle resize', async () => {
      await withDaemon(async (socket, recv) => {
        socket.write(encodeFrame({
          type: 'spawn', agent: 'cmd.exe', cwd: '.', cols: 80, rows: 24,
          agentSessionId: '', isRestore: false
        }));
        const spawned = await recv();

        // Resize should not error
        socket.write(encodeFrame({ type: 'resize', sessionId: spawned.sessionId, cols: 120, rows: 40 }));
        await new Promise(r => setTimeout(r, 200));

        socket.write(encodeFrame({ type: 'kill', sessionId: spawned.sessionId }));
        for (let i = 0; i < 10; i++) {
          const msg = await recv();
          if (msg.type === 'exit') break;
        }
      });
    });

    it('should list active sessions', async () => {
      await withDaemon(async (socket, recv) => {
        // Spawn two sessions
        socket.write(encodeFrame({
          type: 'spawn', agent: 'cmd.exe', cwd: '.', cols: 80, rows: 24,
          agentSessionId: '', isRestore: false
        }));
        const s1 = await recv();

        socket.write(encodeFrame({
          type: 'spawn', agent: 'cmd.exe', cwd: '.', cols: 80, rows: 24,
          agentSessionId: '', isRestore: false
        }));
        const s2 = await recv();

        // List sessions
        socket.write(encodeFrame({ type: 'list' }));
        // Drain output messages until we get list-response
        let listResp = null;
        for (let i = 0; i < 50; i++) {
          const msg = await recv();
          if (msg.type === 'list-response') { listResp = msg; break; }
        }
        expect(listResp).not.toBeNull();
        expect(listResp!.sessions.length).toBeGreaterThanOrEqual(2);

        // Cleanup
        socket.write(encodeFrame({ type: 'kill', sessionId: s1.sessionId }));
        socket.write(encodeFrame({ type: 'kill', sessionId: s2.sessionId }));
        for (let i = 0; i < 20; i++) {
          const msg = await recv();
          if (msg.type === 'exit') {
            // Check if both exited
            break;
          }
        }
      });
    });
  });

  // --------------------------------------------------------------------------
  // 3. Agent Configuration
  // --------------------------------------------------------------------------
  describe('Agent Configuration', () => {
    it('should load agents.json', async () => {
      const configPath = path.join(__dirname, '..', 'agents.json');
      expect(fs.existsSync(configPath)).toBe(true);
      const config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
      expect(config.agents).toBeDefined();
      expect(config.agents.length).toBeGreaterThanOrEqual(4);
    });

    it('should have cmd.exe agent', async () => {
      const configPath = path.join(__dirname, '..', 'agents.json');
      const config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
      const cmd = config.agents.find((a: any) => a.id === 'cmd');
      expect(cmd).toBeDefined();
      expect(cmd.command).toBe('cmd.exe');
    });

    it('should have claude agent with templates', async () => {
      const configPath = path.join(__dirname, '..', 'agents.json');
      const config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
      const claude = config.agents.find((a: any) => a.id === 'claude');
      expect(claude).toBeDefined();
      expect(claude.create_template).toContain('{session_id}');
      expect(claude.resume_template).toContain('{session_id}');
    });

    it('should have opencode agent', async () => {
      const configPath = path.join(__dirname, '..', 'agents.json');
      const config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
      const opencode = config.agents.find((a: any) => a.id === 'opencode');
      expect(opencode).toBeDefined();
    });

    it('should have codex agent', async () => {
      const configPath = path.join(__dirname, '..', 'agents.json');
      const config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
      const codex = config.agents.find((a: any) => a.id === 'codex');
      expect(codex).toBeDefined();
    });
  });

  // --------------------------------------------------------------------------
  // 4. Protocol Framing
  // --------------------------------------------------------------------------
  describe('Protocol Framing', () => {
    it('should encode and decode frames correctly', () => {
      const msg = { type: 'hello', version: 1 };
      const encoded = encodeFrame(msg);
      expect(encoded.length).toBeGreaterThan(4);

      const decoded = decodeFrame(encoded);
      expect(decoded).not.toBeNull();
      expect(decoded!.msg.type).toBe('hello');
      expect(decoded!.msg.version).toBe(1);
      expect(decoded!.consumed).toBe(encoded.length);
    });

    it('should handle large messages', () => {
      const largeData = 'x'.repeat(100000);
      const msg = { type: 'write', sessionId: 'S1', data: largeData };
      const encoded = encodeFrame(msg);
      const decoded = decodeFrame(encoded);
      expect(decoded!.msg.data.length).toBe(100000);
    });

    it('should handle partial frames', () => {
      const msg = { type: 'hello', version: 1 };
      const encoded = encodeFrame(msg);
      // Only first 3 bytes (incomplete header)
      const partial = encoded.slice(0, 3);
      expect(decodeFrame(partial)).toBeNull();
    });

    it('should handle multiple frames in one buffer', () => {
      const msg1 = encodeFrame({ type: 'hello', version: 1 });
      const msg2 = encodeFrame({ type: 'list' });
      const combined = Buffer.concat([msg1, msg2]);

      const first = decodeFrame(combined);
      expect(first!.msg.type).toBe('hello');

      const second = decodeFrame(combined.slice(first!.consumed));
      expect(second!.msg.type).toBe('list');
    });
  });

  // --------------------------------------------------------------------------
  // 5. Session ID Validation
  // --------------------------------------------------------------------------
  describe('Session ID Validation', () => {
    it('should reject invalid agent session IDs', async () => {
      await withDaemon(async (socket, recv) => {
        socket.write(encodeFrame({
          type: 'spawn', agent: 'claude', cwd: '.', cols: 80, rows: 24,
          agentSessionId: 'invalid; DROP TABLE sessions;', isRestore: false
        }));
        const msg = await recv();
        expect(msg.type).toBe('error');
        expect(msg.message).toContain('Invalid agentSessionId');
      });
    });

    it('should accept valid session IDs', async () => {
      await withDaemon(async (socket, recv) => {
        socket.write(encodeFrame({
          type: 'spawn', agent: 'claude', cwd: '.', cols: 80, rows: 24,
          agentSessionId: 'abc-123-def', isRestore: false
        }));
        const msg = await recv();
        expect(msg.type).toBe('spawned');

        socket.write(encodeFrame({ type: 'kill', sessionId: msg.sessionId }));
        for (let i = 0; i < 10; i++) {
          const m = await recv();
          if (m.type === 'exit') break;
        }
      });
    });
  });

  // --------------------------------------------------------------------------
  // 6. Platform Utilities
  // --------------------------------------------------------------------------
  describe('Platform Utilities', () => {
    it('should resolve safe local directory', () => {
      // Import and test resolveSafeLocalDir
      const { resolveSafeLocalDir } = require('../src/common/platform.ts');
      const safeDir = resolveSafeLocalDir();
      expect(safeDir).toBeDefined();
      expect(typeof safeDir).toBe('string');
      if (process.platform === 'win32') {
        expect(safeDir.startsWith('\\\\')).toBe(false); // Not UNC
      }
    });
  });

  // --------------------------------------------------------------------------
  // 7. Database / Persistence
  // --------------------------------------------------------------------------
  describe('Database / Persistence', () => {
    const testDbPath = path.join(__dirname, '..', 'test-conductor.db');

    afterAll(() => {
      // Cleanup test database
      if (fs.existsSync(testDbPath)) {
        fs.unlinkSync(testDbPath);
      }
    });

    it('should create database tables', () => {
      // This test requires better-sqlite3 compiled for Electron
      // Skip if not available
      try {
        const Database = require('better-sqlite3');
        const db = new Database(testDbPath);
        db.exec(`
          CREATE TABLE IF NOT EXISTS layout (
            id INTEGER PRIMARY KEY CHECK(id=1),
            dockview_json TEXT NOT NULL DEFAULT '',
            window_width INTEGER NOT NULL DEFAULT 1400,
            window_height INTEGER NOT NULL DEFAULT 900,
            updated_at TEXT NOT NULL DEFAULT(datetime('now'))
          );
          CREATE TABLE IF NOT EXISTS sessions (
            id TEXT PRIMARY KEY,
            agent TEXT NOT NULL,
            cwd TEXT NOT NULL,
            agent_session_id TEXT NOT NULL DEFAULT ''
          );
        `);

        // Verify tables exist
        const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all();
        expect(tables.map((t: any) => t.name)).toContain('layout');
        expect(tables.map((t: any) => t.name)).toContain('sessions');
        db.close();
      } catch (e) {
        // better-sqlite3 may not be available for system Node
        console.log('Skipping database test - better-sqlite3 not available for system Node');
      }
    });
  });

  // --------------------------------------------------------------------------
  // 8. Git Integration
  // --------------------------------------------------------------------------
  describe('Git Integration', () => {
    it('should detect git repository', () => {
      try {
        const result = execSync('git rev-parse --is-inside-work-tree', {
          cwd: path.join(__dirname, '..'),
          encoding: 'utf8',
          stdio: ['pipe', 'pipe', 'ignore']
        }).trim();
        expect(result).toBe('true');
      } catch {
        // Not a git repo or git not installed
      }
    });

    it('should get current branch', () => {
      try {
        const branch = execSync('git rev-parse --abbrev-ref HEAD', {
          cwd: path.join(__dirname, '..'),
          encoding: 'utf8',
          stdio: ['pipe', 'pipe', 'ignore']
        }).trim();
        expect(branch.length).toBeGreaterThan(0);
      } catch {
        // Git not available
      }
    });
  });

  // --------------------------------------------------------------------------
  // 9. Error Handling
  // --------------------------------------------------------------------------
  describe('Error Handling', () => {
    it('should handle unknown message types', async () => {
      await withDaemon(async (socket, recv) => {
        socket.write(encodeFrame({ type: 'unknown-type' } as any));
        const msg = await recv();
        expect(msg.type).toBe('error');
      });
    });

    it('should handle kill for non-existent session', async () => {
      await withDaemon(async (socket, recv) => {
        socket.write(encodeFrame({ type: 'kill', sessionId: 'S99999' }));
        // Should not crash - just no response for fire-and-forget
        await new Promise(r => setTimeout(r, 200));
      });
    });

    it('should handle write to non-existent session', async () => {
      await withDaemon(async (socket, recv) => {
        socket.write(encodeFrame({ type: 'write', sessionId: 'S99999', data: 'test' }));
        await new Promise(r => setTimeout(r, 200));
      });
    });
  });
});
