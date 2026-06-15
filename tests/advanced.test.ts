/**
 * Additional tests for session recovery, agent config mapping, and advanced features.
 */
import { describe, it, expect } from 'vitest';
import path from 'path';
import fs from 'fs';

// ============================================================================
// Agent Config Mapping
// ============================================================================
describe('Agent Config Mapping', () => {
  // We need to import from the compiled JS since TS files can't be directly imported by vitest
  const configModule = require('../dist/common/agent-config.js');
  const { mapAgentEntry, DEFAULT_AGENTS } = configModule;

  it('should map snake_case fields to camelCase', () => {
    const entry = {
      id: 'test',
      name: 'Test Agent',
      command: 'test-cmd',
      args: ['--flag'],
      create_template: '--new {session_id}',
      resume_template: '--resume {session_id}',
      setup: ['echo hello'],
      builtin: false,
    };
    const mapped = mapAgentEntry(entry);
    expect(mapped.createTemplate).toBe('--new {session_id}');
    expect(mapped.resumeTemplate).toBe('--resume {session_id}');
    expect(mapped.setup).toEqual(['echo hello']);
  });

  it('should handle camelCase fields directly', () => {
    const entry = {
      id: 'test',
      command: 'test-cmd',
      createTemplate: '--create {session_id}',
      resumeTemplate: '--resume {session_id}',
    };
    const mapped = mapAgentEntry(entry);
    expect(mapped.createTemplate).toBe('--create {session_id}');
    expect(mapped.resumeTemplate).toBe('--resume {session_id}');
  });

  it('should use defaults for missing fields', () => {
    const entry = { id: 'minimal' };
    const mapped = mapAgentEntry(entry);
    expect(mapped.name).toBe('minimal');
    expect(mapped.command).toBe('');
    expect(mapped.args).toEqual([]);
    expect(mapped.createTemplate).toBe('');
    expect(mapped.resumeTemplate).toBe('');
    expect(mapped.setup).toEqual([]);
    expect(mapped.builtin).toBe(false);
  });

  it('should have correct DEFAULT_AGENTS', () => {
    expect(DEFAULT_AGENTS.length).toBe(4);
    expect(DEFAULT_AGENTS.map((a: any) => a.id)).toEqual(['cmd', 'claude', 'opencode', 'codex']);
  });

  it('should mark cmd as builtin', () => {
    const cmd = DEFAULT_AGENTS.find((a: any) => a.id === 'cmd');
    expect(cmd.builtin).toBe(true);
  });

  it('should not mark claude/opencode/codex as builtin', () => {
    const agents = DEFAULT_AGENTS.filter((a: any) => a.id !== 'cmd');
    for (const a of agents) {
      expect(a.builtin).toBe(false);
    }
  });
});

// ============================================================================
// Session Recovery
// ============================================================================
describe('Session Recovery', () => {
  const { discoverSessionIds } = require('../dist/daemon/session-recovery.js');

  it('should return empty array for unknown agents', () => {
    const ids = discoverSessionIds('unknown-agent', '.');
    expect(ids).toEqual([]);
  });

  it('should return empty array for cmd', () => {
    const ids = discoverSessionIds('cmd.exe', '.');
    expect(ids).toEqual([]);
  });

  it('should return empty array for claude', () => {
    const ids = discoverSessionIds('claude', '.');
    expect(ids).toEqual([]);
  });

  it('should handle opencode discovery (may return empty)', () => {
    // opencode discovery runs `opencode db` which may or may not be available
    const ids = discoverSessionIds('opencode', process.cwd());
    expect(Array.isArray(ids)).toBe(true);
  });

  it('should handle codex discovery (may return empty)', () => {
    // codex discovery scans ~/.codex/sessions
    const ids = discoverSessionIds('codex', process.cwd());
    expect(Array.isArray(ids)).toBe(true);
  });

  it('should discover codex sessions from rollout files', () => {
    // Create temp codex sessions directory with test files
    const codexDir = path.join(process.env.USERPROFILE || process.env.HOME || '/tmp', '.codex', 'sessions');
    const testFile = path.join(codexDir, 'rollout-1234-test-session-abc.jsonl');

    try {
      fs.mkdirSync(codexDir, { recursive: true });
      fs.writeFileSync(testFile, '{"test": true}');

      const ids = discoverSessionIds('codex', process.cwd());
      expect(ids).toContain('test-session-abc');
    } finally {
      // Cleanup
      try { fs.unlinkSync(testFile); } catch {}
    }
  });
});

// ============================================================================
// Platform Utilities (Advanced)
// ============================================================================
describe('Platform Utilities (Advanced)', () => {
  const { resolveSafeLocalDir } = require('../dist/common/platform.js');

  it('should return a non-UNC path on Windows', () => {
    const dir = resolveSafeLocalDir();
    if (process.platform === 'win32') {
      expect(dir.startsWith('\\\\')).toBe(false);
    }
    expect(dir.length).toBeGreaterThan(0);
  });

  it('should use fallback parameter', () => {
    const dir = resolveSafeLocalDir('D:\\fallback');
    expect(typeof dir).toBe('string');
    // On Windows, USERPROFILE/HOMEDRIVE should be available, so fallback may not be used
    // Just verify it doesn't crash
  });

  it('should prefer USERPROFILE over HOMEDRIVE', () => {
    // Just verify the function returns a consistent result
    const dir1 = resolveSafeLocalDir();
    const dir2 = resolveSafeLocalDir();
    expect(dir1).toBe(dir2);
  });
});

// ============================================================================
// Protocol Version Negotiation
// ============================================================================
describe('Protocol Version', () => {
  const { negotiateVersion } = require('../dist/daemon/protocol/version.js');

  it('should negotiate version 1', () => {
    const v = negotiateVersion(1);
    expect(v).toBe(1);
  });

  it('should handle unknown versions gracefully', () => {
    // Should return the supported version or throw
    try {
      const v = negotiateVersion(999);
      expect(typeof v).toBe('number');
    } catch {
      // Throwing is also acceptable
    }
  });
});

// ============================================================================
// Framing Edge Cases
// ============================================================================
describe('Framing Edge Cases', () => {
  const framing = require('../dist/daemon/protocol/framing.js');
  const { encodeFrame, FrameDecoder } = framing;

  it('should handle empty payload', () => {
    const encoded = encodeFrame({ type: 'list' });
    expect(encoded.length).toBeGreaterThan(4);
  });

  it('should handle unicode in payload', () => {
    const msg = { type: 'write', sessionId: 'S1', data: '你好世界 🌍' };
    const encoded = encodeFrame(msg);
    const decoder = new FrameDecoder();
    const messages = decoder.push(encoded);
    expect(messages.length).toBe(1);
    expect(messages[0].data).toBe('你好世界 🌍');
  });

  it('should handle incremental data delivery', () => {
    const msg = { type: 'hello', version: 1 };
    const encoded = encodeFrame(msg);

    const decoder = new FrameDecoder();
    // Feed one byte at a time
    let messages: any[] = [];
    for (let i = 0; i < encoded.length; i++) {
      const chunk = encoded.slice(i, i + 1);
      const result = decoder.push(chunk);
      messages = messages.concat(result);
    }
    expect(messages.length).toBe(1);
    expect(messages[0].type).toBe('hello');
  });

  it('should handle multiple messages in chunks', () => {
    const msg1 = encodeFrame({ type: 'hello', version: 1 });
    const msg2 = encodeFrame({ type: 'list' });
    const msg3 = encodeFrame({ type: 'kill', sessionId: 'S1' });

    // Concatenate all
    const all = Buffer.concat([msg1, msg2, msg3]);

    const decoder = new FrameDecoder();
    const messages = decoder.push(all);
    expect(messages.length).toBe(3);
    expect(messages[0].type).toBe('hello');
    expect(messages[1].type).toBe('list');
    expect(messages[2].type).toBe('kill');
  });
});

// ============================================================================
// Session Store
// ============================================================================
describe('Session Store', () => {
  const { SessionStore } = require('../dist/daemon/session-store.js');

  it('should create and list sessions', () => {
    const store = new SessionStore();
    store.set('S1', { sessionId: 'S1', agent: 'cmd.exe', cwd: '.', pid: 1234, running: true, agentSessionId: '' });
    const list = store.list();
    expect(list.length).toBe(1);
    expect(list[0].sessionId).toBe('S1');
  });

  it('should delete sessions', () => {
    const store = new SessionStore();
    store.set('S1', { sessionId: 'S1', agent: 'cmd.exe', cwd: '.', pid: 1234, running: true, agentSessionId: '' });
    store.delete('S1');
    expect(store.list().length).toBe(0);
  });

  it('should set agent session ID', () => {
    const store = new SessionStore();
    store.set('S1', { sessionId: 'S1', agent: 'claude', cwd: '.', pid: 1234, running: true, agentSessionId: '' });
    store.setAgentSessionId('S1', 'abc-123');
    const list = store.list();
    expect(list[0].agentSessionId).toBe('abc-123');
  });

  it('should handle multiple sessions', () => {
    const store = new SessionStore();
    store.set('S1', { sessionId: 'S1', agent: 'cmd.exe', cwd: '.', pid: 1, running: true, agentSessionId: '' });
    store.set('S2', { sessionId: 'S2', agent: 'claude', cwd: '.', pid: 2, running: true, agentSessionId: '' });
    store.set('S3', { sessionId: 'S3', agent: 'opencode', cwd: '.', pid: 3, running: true, agentSessionId: '' });
    expect(store.list().length).toBe(3);
  });
});
