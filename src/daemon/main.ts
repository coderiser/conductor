import { DaemonServer } from './server.js';

const PIPE_PATH = '\\\\.\\pipe\\conductor-pty-daemon';

const server = new DaemonServer(PIPE_PATH);
server.start();

process.on('SIGINT', () => {
  console.log('Shutting down PTY Daemon...');
  server.stop();
  process.exit(0);
});

process.on('SIGTERM', () => {
  server.stop();
  process.exit(0);
});

console.log('PTY Daemon started');
