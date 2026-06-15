import { SessionInfo } from './protocol/messages.js';

export class SessionStore {
  private sessions = new Map<string, SessionInfo & { outputBuffer: string }>();

  set(sessionId: string, info: SessionInfo) {
    this.sessions.set(sessionId, { ...info, outputBuffer: '' });
  }

  get(sessionId: string): (SessionInfo & { outputBuffer: string }) | undefined {
    return this.sessions.get(sessionId);
  }

  delete(sessionId: string) {
    this.sessions.delete(sessionId);
  }

  list(): SessionInfo[] {
    return Array.from(this.sessions.values()).map(({ outputBuffer, ...info }) => info);
  }

  appendOutput(sessionId: string, data: string) {
    const session = this.sessions.get(sessionId);
    if (session) {
      session.outputBuffer += data;
      if (session.outputBuffer.length > 64_000) {
        session.outputBuffer = session.outputBuffer.slice(-64_000);
      }
    }
  }

  setAgentSessionId(sessionId: string, agentSessionId: string) {
    const session = this.sessions.get(sessionId);
    if (session) {
      session.agentSessionId = agentSessionId;
    }
  }
}
