// `conductor sessions list|kill` — manage active PTY sessions via the daemon.
import { getDaemonStatus, send } from '../daemon-client';

/** `conductor sessions list` */
export async function list(): Promise<void> {
  const ds = await getDaemonStatus();
  if (!ds.reachable) {
    console.log(`Daemon not reachable (${ds.error}). Is it running? Try \`conductor daemon status\`.`);
    process.exit(1);
  }
  if (ds.sessions.length === 0) {
    console.log('No active sessions.');
    return;
  }
  console.log(`Active sessions (${ds.sessions.length}):`);
  for (const s of ds.sessions) {
    console.log(`  ${s.sessionId}  ${s.agent.padEnd(8)}  pid=${s.pid}  running=${s.running}`);
    if (s.agentSessionId) console.log(`           agentSessionId=${s.agentSessionId}`);
    console.log(`           cwd=${s.cwd}`);
  }
}

/** `conductor sessions kill <sessionId>` */
export async function killSession(sessionId: string): Promise<void> {
  if (!sessionId) {
    console.error('Usage: conductor sessions kill <sessionId>');
    process.exit(1);
  }
  try {
    await send({ type: 'kill', sessionId });
    console.log(`Sent kill for session ${sessionId}.`);
  } catch (e) {
    console.error(`Failed: ${(e as Error).message}`);
    process.exit(1);
  }
}
