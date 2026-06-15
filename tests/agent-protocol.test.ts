import { describe, it, expect } from 'vitest';
import {
  extractProtocolMessage,
  serializeProtocolMessage,
  parseProtocolMessage,
} from '../src/common/agent-protocol';

describe('AgentProtocol', () => {
  it('should validate protocol message structure', () => {
    const line = '[TASK:T1] progress=50% status=running message=Analyzing code';
    const result = extractProtocolMessage('S1', 'claude', line);
    expect(result).toBeDefined();
    expect(result!.type).toBe('task-progress');
    expect(result!.agentId).toBe('claude');
    expect(result!.sessionId).toBe('S1');
    expect(result!.payload.taskId).toBe('T1');
    expect(result!.payload.progress).toBe(0.5);
  });

  it('should parse context-share from PTY marker', () => {
    const line = '[CTX:summary] {"title":"Code Review","body":"3 bugs found in auth.ts"}';
    const result = extractProtocolMessage('S1', 'claude', line);
    expect(result?.type).toBe('context-share');
    expect(result?.payload.contextType).toBe('summary');
  });

  it('should return null for non-protocol output lines', () => {
    expect(extractProtocolMessage('S1', 'claude', 'normal terminal output')).toBeNull();
    expect(extractProtocolMessage('S1', 'claude', '')).toBeNull();
  });

  it('should serialize and parse OSC escape sequence round-trip', () => {
    const msg = {
      type: 'need-attention' as const,
      agentId: 'claude',
      sessionId: 'S1',
      timestamp: 1700000000000,
      payload: { reason: 'permission required', urgency: 'critical' },
    };
    const osc = serializeProtocolMessage(msg);
    expect(osc).toMatch(/^\x1b\]9999;/);
    expect(osc).toContain('conductor:');
    const parsed = parseProtocolMessage(osc);
    expect(parsed?.type).toBe('need-attention');
    expect(parsed?.payload.reason).toBe('permission required');
  });

  it('should parse complete task payload', () => {
    const line = '[TASK:T2] progress=100% status=done message=Complete.';
    const result = extractProtocolMessage('S1', 'claude', line);
    expect(result?.payload.status).toBe('done');
    expect(result?.payload.progress).toBe(1);
  });

  it('should handle malformed OSC sequences gracefully', () => {
    expect(parseProtocolMessage('not an OSC sequence')).toBeNull();
    expect(parseProtocolMessage('\x1b]9999;conductor:invalid-json\x07')).toBeNull();
  });

  it('should parse context-share with raw text body', () => {
    const line = '[CTX:finding] just some plain text here';
    const result = extractProtocolMessage('S1', 'claude', line);
    expect(result?.type).toBe('context-share');
    expect(result?.payload.contextType).toBe('finding');
    expect(result?.payload.body).toBe('just some plain text here');
  });
});
