// `conductor` CLI entry router. Hand-rolled argv parsing (no deps).
// Dispatches `conductor <resource> <action> [flags]` to the cmd modules.
import * as daemon from './cmd/daemon';
import * as app from './cmd/app';
import * as sessions from './cmd/sessions';
import * as worktree from './cmd/worktree';
import * as agents from './cmd/agents';

const HELP = `conductor — Multi-Agent Terminal Workbench CLI

Usage:
  conductor                              show this help
  conductor version                      print version (+ protocol version)
  conductor status                       daemon + version overview
  conductor doctor                       environment health check
  conductor open                         launch the Electron app (dev)

  conductor daemon status                daemon PID, protocol version, sessions
  conductor daemon start                 start the daemon (detached)
  conductor daemon stop                  stop the daemon (SIGTERM via PID file)
  conductor daemon restart               stop + start (picks up rebuilt daemon)
  conductor daemon logs [--follow]       tail conductor-daemon.log

  conductor sessions list                list active PTY sessions
  conductor sessions kill <sessionId>    kill a session

  conductor worktree list                list Conductor worktrees (active/dirty)
  conductor worktree cleanup [--force]   remove non-active worktrees

  conductor agents list                  list configured agents
  conductor agents add --id <> --name <> --command <> [--create <>] [--resume <>] [--worktree] [--base-branch <>]
  conductor agents remove <id>
  conductor agents edit <id> <field> <value>    (fields: name|command|create|resume)
`;

async function dispatchDaemon(rest: string[]): Promise<void> {
  switch (rest[0]) {
    case 'status': return daemon.status();
    case 'start': return daemon.start();
    case 'stop': return daemon.stop();
    case 'restart': return daemon.restart();
    case 'logs': return daemon.logs(rest.includes('--follow') || rest.includes('-f'));
    default:
      console.error('Usage: conductor daemon status|start|stop|restart|logs [--follow]');
      process.exit(1);
  }
}

async function dispatchSessions(rest: string[]): Promise<void> {
  switch (rest[0]) {
    case 'list': return sessions.list();
    case 'kill': return sessions.killSession(rest[1]);
    default:
      console.error('Usage: conductor sessions list|kill <sessionId>');
      process.exit(1);
  }
}

async function dispatchWorktree(rest: string[]): Promise<void> {
  switch (rest[0]) {
    case 'list': return worktree.list();
    case 'cleanup': return worktree.cleanup(rest.includes('--force'));
    default:
      console.error('Usage: conductor worktree list|cleanup [--force]');
      process.exit(1);
  }
}

function dispatchAgents(rest: string[]): void {
  switch (rest[0]) {
    case 'list': return agents.list();
    case 'add': return agents.add(rest.slice(1));
    case 'remove': return agents.remove(rest[1]);
    case 'edit': return agents.edit(rest.slice(1));
    default:
      console.error('Usage: conductor agents list|add|remove <id>|edit <id> <field> <value>');
      process.exit(1);
  }
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const cmd = argv[0];
  const rest = argv.slice(1);

  switch (cmd) {
    case undefined:
    case '-h':
    case '--help':
    case 'help':
      console.log(HELP);
      break;
    case 'version':
    case '-v':
      app.version();
      break;
    case 'status':
      await app.status();
      break;
    case 'doctor':
      await app.doctor();
      break;
    case 'open':
      app.open();
      break;
    case 'daemon':
      await dispatchDaemon(rest);
      break;
    case 'sessions':
      await dispatchSessions(rest);
      break;
    case 'worktree':
      await dispatchWorktree(rest);
      break;
    case 'agents':
      dispatchAgents(rest);
      break;
    default:
      console.error(`Unknown command: ${cmd}\n`);
      console.log(HELP);
      process.exit(1);
  }
}

main().catch((e) => {
  console.error(e instanceof Error ? e.message : String(e));
  process.exit(1);
});
