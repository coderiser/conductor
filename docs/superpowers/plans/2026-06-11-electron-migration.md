# Conductor V2: Phase 1 — Electron 迁移实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 将 Conductor 从 Tauri/Rust 迁移到 Electron/Node.js，保留所有现有功能，建立 PTY Daemon 架构基础。

**Architecture:** Electron 主进程管理窗口和 daemon 客户端，PTY Daemon 是独立的 Node.js 进程通过 Windows Named Pipe 通信，渲染进程复用现有 React + xterm.js 前端代码（90%）。

**Tech Stack:** Electron 40.x, node-pty 1.1.0, better-sqlite3 12.x, simple-git 3.x, @xterm/xterm 6.x, zustand 5.x, TypeScript 5.x

---

## 项目结构

```
conductor/ (根目录)
├── package.json                    # 主 package (Electron + 前端)
├── electron.vite.config.ts         # Vite 构建配置
├── electron-builder.ts             # Electron 打包配置
├── tsconfig.json                   # TypeScript 配置
├── src/
│   ├── main/                       # Electron 主进程
│   │   ├── index.ts                # 入口：创建窗口 + 启动 daemon
│   │   ├── daemon-client.ts        # Named Pipe 客户端
│   │   ├── ipc-handlers.ts         # ipcMain 处理器
│   │   ├── database.ts             # better-sqlite3 封装
│   │   ├── agent-config.ts         # agents.json 加载
│   │   └── window-manager.ts       # 窗口管理 + 快捷键
│   ├── renderer/                   # 渲染进程 (前端)
│   │   ├── index.html              # HTML 入口
│   │   ├── main.tsx                # React 入口
│   │   ├── App.tsx                 # 主组件 (迁移自 Tauri)
│   │   ├── components/
│   │   │   ├── Sidebar.tsx         # 侧边栏
│   │   │   └── TerminalPanel.tsx   # 终端面板
│   │   ├── hooks/
│   │   │   └── usePty.ts           # PTY hook
│   │   ├── lib/
│   │   │   ├── pty-ipc.ts          # Electron IPC 封装 (替代 tauri-ipc.ts)
│   │   │   └── terminal-theme.ts   # 终端主题
│   │   └── store/
│   │       └── sessions.ts         # Zustand store
│   └── daemon/                     # PTY Daemon (独立进程)
│       ├── main.ts                 # Daemon 入口
│       ├── server.ts               # Named Pipe 服务
│       ├── pty-manager.ts          # node-pty 管理
│       ├── session-store.ts        # 会话存储
│       ├── session-recovery.ts     # Agent session 发现
│       └── protocol/
│           ├── messages.ts         # 消息类型
│           └── framing.ts          # 帧编解码
├── agents.json                     # Agent 配置 (复用)
└── resources/                      # 图标等资源
```

---

## Task 1: 项目初始化 + Electron 基础

**Files:**
- Create: `package.json`
- Create: `tsconfig.json`
- Create: `electron.vite.config.ts`
- Create: `electron-builder.ts`
- Create: `src/main/index.ts`
- Create: `src/renderer/index.html`
- Create: `src/renderer/main.tsx`

- [ ] **Step 1: 初始化 package.json**

```json
{
  "name": "conductor",
  "version": "2.0.0",
  "description": "AI Agent Terminal Manager",
  "main": "dist/main/index.js",
  "scripts": {
    "dev": "electron-vite dev",
    "build": "electron-vite build",
    "package": "electron-builder"
  },
  "dependencies": {
    "@xterm/xterm": "^6.0.0",
    "@xterm/addon-fit": "^0.12.0",
    "@xterm/addon-canvas": "^0.12.0",
    "@xterm/addon-clipboard": "^0.3.0",
    "@xterm/addon-search": "^0.17.0",
    "react": "^19.0.0",
    "react-dom": "^19.0.0",
    "zustand": "^5.0.0",
    "better-sqlite3": "^12.0.0",
    "simple-git": "^3.27.0",
    "node-pty": "^1.1.0"
  },
  "devDependencies": {
    "electron": "^40.0.0",
    "electron-vite": "^4.0.0",
    "electron-builder": "^26.0.0",
    "vite": "^7.0.0",
    "@vitejs/plugin-react": "^5.0.0",
    "typescript": "^5.9.0",
    "@types/react": "^19.0.0",
    "@types/react-dom": "^19.0.0",
    "@types/node": "^24.0.0",
    "@types/better-sqlite3": "^7.6.0"
  }
}
```

- [ ] **Step 2: 安装依赖**

```bash
cd E:/workspace/conductor-cli
npm install
```

Expected: 无错误，node_modules 创建成功

- [ ] **Step 3: 创建 tsconfig.json**

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "ESNext",
    "moduleResolution": "bundler",
    "jsx": "react-jsx",
    "strict": true,
    "esModuleInterop": true,
    "skipLibCheck": true,
    "forceConsistentCasingInFileNames": true,
    "resolveJsonModule": true,
    "outDir": "dist",
    "rootDir": "src",
    "baseUrl": ".",
    "paths": {
      "@main/*": ["src/main/*"],
      "@renderer/*": ["src/renderer/*"],
      "@daemon/*": ["src/daemon/*"]
    }
  },
  "include": ["src/**/*"],
  "exclude": ["node_modules", "dist"]
}
```

- [ ] **Step 4: 创建 electron.vite.config.ts**

```typescript
import { defineConfig, externalizeDepsPlugin } from 'electron-vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  main: {
    plugins: [externalizeDepsPlugin()],
    build: {
      rollupOptions: {
        input: 'src/main/index.ts'
      }
    }
  },
  renderer: {
    plugins: [react()],
    root: 'src/renderer',
    build: {
      rollupOptions: {
        input: 'src/renderer/index.html'
      }
    }
  }
});
```

- [ ] **Step 5: 创建 electron-builder.ts**

```typescript
import type { Configuration } from 'electron-builder';

const config: Configuration = {
  appId: 'com.conductor.app',
  productName: 'Conductor',
  directories: {
    output: 'release'
  },
  files: [
    'dist/**/*',
    'agents.json'
  ],
  win: {
    target: ['nsis', 'portable'],
    icon: 'resources/icon.ico'
  },
  nsis: {
    oneClick: false,
    allowToChangeInstallationDirectory: true
  }
};

export default config;
```

- [ ] **Step 6: 创建 src/main/index.ts (最小化)**

```typescript
import { app, BrowserWindow } from 'electron';
import path from 'path';

let mainWindow: BrowserWindow | null = null;

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1400,
    height: 900,
    webPreferences: {
      preload: path.join(__dirname, '../preload/index.js'),
      nodeIntegration: false,
      contextIsolation: true
    }
  });

  if (process.env.NODE_ENV === 'development') {
    mainWindow.loadURL('http://localhost:5173');
  } else {
    mainWindow.loadFile(path.join(__dirname, '../renderer/index.html'));
  }
}

app.whenReady().then(createWindow);

app.on('window-all-closed', () => {
  app.quit();
});
```

- [ ] **Step 7: 创建 src/renderer/index.html**

```html
<!DOCTYPE html>
<html lang="zh-CN">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>Conductor</title>
</head>
<body>
  <div id="root"></div>
  <script type="module" src="./main.tsx"></script>
</body>
</html>
```

- [ ] **Step 8: 创建 src/renderer/main.tsx (最小化)**

```typescript
import React from 'react';
import ReactDOM from 'react-dom/client';

function App() {
  return <div>Conductor V2 - Loading...</div>;
}

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>
);
```

- [ ] **Step 9: 验证 Electron 启动**

```bash
npm run dev
```

Expected: Electron 窗口打开，显示 "Conductor V2 - Loading..."

- [ ] **Step 10: 提交**

```bash
git add .
git commit -m "feat: Electron 项目初始化 + 基础窗口"
```

---

## Task 2: PTY Daemon 协议层

**Files:**
- Create: `src/daemon/protocol/messages.ts`
- Create: `src/daemon/protocol/framing.ts`
- Create: `src/daemon/protocol/version.ts`

- [ ] **Step 1: 创建协议消息类型**

```typescript
// src/daemon/protocol/messages.ts

export const PROTOCOL_VERSION = 1;

export type ClientMessage =
  | { type: 'hello'; version: number }
  | { type: 'spawn'; agent: string; cwd: string; cols: number; rows: number; agentSessionId?: string; isRestore: boolean }
  | { type: 'write'; sessionId: string; data: string }
  | { type: 'resize'; sessionId: string; cols: number; rows: number }
  | { type: 'kill'; sessionId: string }
  | { type: 'list' }
  | { type: 'set-agent-session-id'; sessionId: string; agentSessionId: string };

export type DaemonMessage =
  | { type: 'hello-ack'; version: number }
  | { type: 'spawned'; sessionId: string; pid: number; agent: string; agentSessionId: string }
  | { type: 'output'; sessionId: string; data: string }
  | { type: 'exit'; sessionId: string; code: number }
  | { type: 'session-id-changed'; sessionId: string; agentSessionId: string }
  | { type: 'list-response'; sessions: SessionInfo[] }
  | { type: 'error'; message: string };

export interface SessionInfo {
  sessionId: string;
  agent: string;
  cwd: string;
  pid: number;
  running: boolean;
  agentSessionId: string;
}
```

- [ ] **Step 2: 创建帧编解码**

```typescript
// src/daemon/protocol/framing.ts

export function encodeFrame(message: object): Buffer {
  const json = JSON.stringify(message);
  const payload = Buffer.from(json, 'utf-8');
  const length = payload.length;
  const frame = Buffer.alloc(4 + length);
  frame.writeUInt32BE(length, 0);
  payload.copy(frame, 4);
  return frame;
}

export class FrameDecoder {
  private buffer: Buffer = Buffer.alloc(0);

  push(data: Buffer): object[] {
    this.buffer = Buffer.concat([this.buffer, data]);
    const messages: object[] = [];

    while (this.buffer.length >= 4) {
      const length = this.buffer.readUInt32BE(0);
      if (this.buffer.length < 4 + length) break;

      const payload = this.buffer.subarray(4, 4 + length);
      const json = payload.toString('utf-8');
      messages.push(JSON.parse(json));
      this.buffer = this.buffer.subarray(4 + length);
    }

    return messages;
  }
}
```

- [ ] **Step 3: 创建协议版本协商**

```typescript
// src/daemon/protocol/version.ts

import { PROTOCOL_VERSION } from './messages.js';

export function negotiateVersion(clientVersion: number): number {
  // 简单策略：取最小值
  return Math.min(clientVersion, PROTOCOL_VERSION);
}
```

- [ ] **Step 4: 提交**

```bash
git add src/daemon/protocol/
git commit -m "feat: PTY Daemon 协议层 (消息类型 + 帧编解码)"
```

---

## Task 3: PTY Daemon PTY 管理器

**Files:**
- Create: `src/daemon/pty-manager.ts`
- Create: `src/daemon/session-store.ts`

- [ ] **Step 1: 创建 session store**

```typescript
// src/daemon/session-store.ts

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
```

- [ ] **Step 2: 创建 PTY 管理器**

```typescript
// src/daemon/pty-manager.ts

import * as pty from 'node-pty';
import path from 'path';
import os from 'os';
import { SessionStore } from './session-store.js';
import { SessionInfo } from './protocol/messages.js';

export type OutputCallback = (sessionId: string, data: string) => void;
export type ExitCallback = (sessionId: string, code: number) => void;

export class PtyManager {
  private sessionStore = new SessionStore();
  private ptyProcesses = new Map<string, pty.IPty>();
  private nextId = 1;

  constructor(
    private onOutput: OutputCallback,
    private onExit: ExitCallback
  ) {}

  spawn(agent: string, cwd: string, cols: number, rows: number, agentSessionId = '', isRestore = false): SessionInfo {
    const sessionId = `S${this.nextId++}`;
    
    // 解析 agent 命令
    const agentConfig = this.getAgentConfig(agent);
    let command = agentConfig.command;
    let args: string[] = [...agentConfig.args];

    // 模板替换
    if (agentSessionId) {
      const template = isRestore ? agentConfig.resumeTemplate : agentConfig.createTemplate;
      if (template) {
        const arg = template.replace('{session_id}', agentSessionId);
        args.push(...arg.split(/\s+/).filter(s => s));
      }
    }

    // Setup 命令注入
    if (agentConfig.setup.length > 0) {
      const setupChain = agentConfig.setup.join(' && ');
      args = ['/k', `${setupChain} && ${command} ${args.join(' ')}`];
      command = 'cmd.exe';
    }

    // Windows: 通过 cmd.exe 启动以设置 cwd
    let finalCommand = command;
    let finalArgs = args;
    
    if (process.platform === 'win32' && command !== 'cmd.exe') {
      const cmdline = `cd /d ${cwd} && ${command} ${args.join(' ')}`;
      finalCommand = 'cmd.exe';
      finalArgs = ['/k', cmdline];
    }

    const ptyProcess = pty.spawn(finalCommand, finalArgs, {
      name: 'xterm-256color',
      cols,
      rows,
      cwd,
      env: process.env as { [key: string]: string }
    });

    const info: SessionInfo = {
      sessionId,
      agent,
      cwd,
      pid: ptyProcess.pid,
      running: true,
      agentSessionId
    };

    this.sessionStore.set(sessionId, info);
    this.ptyProcesses.set(sessionId, ptyProcess);

    ptyProcess.onData((data) => {
      this.sessionStore.appendOutput(sessionId, data);
      this.onOutput(sessionId, data);
    });

    ptyProcess.onExit(({ exitCode }) => {
      this.sessionStore.delete(sessionId);
      this.ptyProcesses.delete(sessionId);
      this.onExit(sessionId, exitCode);
    });

    return info;
  }

  write(sessionId: string, data: string): boolean {
    const ptyProcess = this.ptyProcesses.get(sessionId);
    if (!ptyProcess) return false;
    ptyProcess.write(data);
    return true;
  }

  resize(sessionId: string, cols: number, rows: number): boolean {
    const ptyProcess = this.ptyProcesses.get(sessionId);
    if (!ptyProcess) return false;
    ptyProcess.resize(cols, rows);
    return true;
  }

  kill(sessionId: string): boolean {
    const ptyProcess = this.ptyProcesses.get(sessionId);
    if (!ptyProcess) return false;
    ptyProcess.kill();
    return true;
  }

  killAll() {
    for (const [sessionId] of this.ptyProcesses) {
      this.kill(sessionId);
    }
  }

  list(): SessionInfo[] {
    return this.sessionStore.list();
  }

  setAgentSessionId(sessionId: string, agentSessionId: string) {
    this.sessionStore.setAgentSessionId(sessionId, agentSessionId);
  }

  private getAgentConfig(agent: string): any {
    // TODO: 从 agents.json 加载，这里先用默认值
    const defaults: Record<string, any> = {
      'cmd.exe': { command: 'cmd.exe', args: [], createTemplate: '', resumeTemplate: '', setup: [] },
      'claude': { command: 'claude', args: ['--allow-dangerously-skip-permissions'], createTemplate: '--session-id {session_id}', resumeTemplate: '--resume {session_id}', setup: [] },
      'opencode': { command: 'opencode', args: [], createTemplate: '', resumeTemplate: '--session {session_id}', setup: [] },
      'codex': { command: 'codex', args: [], createTemplate: '', resumeTemplate: 'resume --last', setup: [] }
    };
    return defaults[agent] || { command: agent, args: [], createTemplate: '', resumeTemplate: '', setup: [] };
  }
}
```

- [ ] **Step 3: 提交**

```bash
git add src/daemon/
git commit -m "feat: PTY Daemon 管理器 (node-pty 封装 + session store)"
```

---

## Task 4: PTY Daemon Server

**Files:**
- Create: `src/daemon/server.ts`
- Create: `src/daemon/main.ts`

- [ ] **Step 1: 创建 Named Pipe server**

```typescript
// src/daemon/server.ts

import net from 'net';
import { PtyManager } from './pty-manager.js';
import { encodeFrame, FrameDecoder } from './protocol/framing.js';
import { ClientMessage, DaemonMessage, PROTOCOL_VERSION } from './protocol/messages.js';
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
        return; // 无响应
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
```

- [ ] **Step 2: 创建 daemon 入口**

```typescript
// src/daemon/main.ts

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
```

- [ ] **Step 3: 提交**

```bash
git add src/daemon/
git commit -m "feat: PTY Daemon server (Named Pipe 监听 + 消息路由)"
```

---

## Task 5: Electron Daemon Client

**Files:**
- Create: `src/main/daemon-client.ts`

- [ ] **Step 1: 创建 Named Pipe 客户端**

```typescript
// src/main/daemon-client.ts

import net from 'net';
import { spawn } from 'child_process';
import { encodeFrame, FrameDecoder } from '../daemon/protocol/framing.js';
import { ClientMessage, DaemonMessage } from '../daemon/protocol/messages.js';

const PIPE_PATH = '\\\\.\\pipe\\conductor-pty-daemon';

export class DaemonClient {
  private socket: net.Socket | null = null;
  private decoder = new FrameDecoder();
  private messageHandlers = new Map<string, ((msg: DaemonMessage) => void)[]>();
  private requestResolvers = new Map<string, (msg: DaemonMessage) => void>();
  private requestId = 1;

  async connect(): Promise<void> {
    // 尝试连接已运行的 daemon
    try {
      await this.tryConnect();
      console.log('Connected to existing PTY Daemon');
      return;
    } catch {
      console.log('Starting new PTY Daemon...');
    }

    // 启动 daemon 进程
    const daemonProcess = spawn('node', ['dist/daemon/main.js'], {
      stdio: 'ignore',
      detached: true
    });
    daemonProcess.unref();

    // 等待 daemon 就绪
    await this.waitForDaemon();
    await this.tryConnect();
    console.log('PTY Daemon started and connected');
  }

  private async tryConnect(): Promise<void> {
    return new Promise((resolve, reject) => {
      const socket = net.connect(PIPE_PATH);
      
      socket.on('connect', () => {
        this.socket = socket;
        this.setupSocketHandlers();
        this.sendHello();
        resolve();
      });

      socket.on('error', (err) => {
        reject(err);
      });
    });
  }

  private async waitForDaemon(): Promise<void> {
    for (let i = 0; i < 50; i++) {
      try {
        await this.tryConnect();
        this.socket?.destroy();
        return;
      } catch {
        await new Promise(r => setTimeout(r, 100));
      }
    }
    throw new Error('PTY Daemon failed to start');
  }

  private setupSocketHandlers() {
    if (!this.socket) return;

    this.socket.on('data', (data) => {
      const messages = this.decoder.push(data);
      for (const msg of messages) {
        this.handleMessage(msg as DaemonMessage);
      }
    });

    this.socket.on('close', () => {
      console.log('Disconnected from PTY Daemon');
      this.socket = null;
      // TODO: 自动重连
    });
  }

  private sendHello() {
    this.send({ type: 'hello', version: 1 });
  }

  private handleMessage(msg: DaemonMessage) {
    // 处理请求响应
    if (msg.type === 'hello-ack' || msg.type === 'spawned' || msg.type === 'list-response' || msg.type === 'error') {
      const resolver = this.requestResolvers.values().next().value;
      if (resolver) {
        resolver(msg);
        this.requestResolvers.clear();
      }
    }

    // 广播事件
    const handlers = this.messageHandlers.get(msg.type) || [];
    for (const handler of handlers) {
      handler(msg);
    }
  }

  async request<T extends DaemonMessage>(msg: ClientMessage): Promise<T> {
    return new Promise((resolve, reject) => {
      if (!this.socket) {
        reject(new Error('Not connected'));
        return;
      }

      const timeout = setTimeout(() => {
        reject(new Error('Request timeout'));
      }, 5000);

      this.requestResolvers.set(`req-${this.requestId++}`, (response) => {
        clearTimeout(timeout);
        if (response.type === 'error') {
          reject(new Error(response.message));
        } else {
          resolve(response as T);
        }
      });

      this.socket.write(encodeFrame(msg));
    });
  }

  on(type: string, handler: (msg: DaemonMessage) => void) {
    if (!this.messageHandlers.has(type)) {
      this.messageHandlers.set(type, []);
    }
    this.messageHandlers.get(type)!.push(handler);
  }

  send(msg: ClientMessage) {
    if (this.socket) {
      this.socket.write(encodeFrame(msg));
    }
  }

  disconnect() {
    this.socket?.destroy();
  }
}
```

- [ ] **Step 2: 提交**

```bash
git add src/main/daemon-client.ts
git commit -m "feat: Electron Daemon 客户端 (Named Pipe 连接 + 请求/响应)"
```

---

## Task 6: Electron IPC 桥接

**Files:**
- Create: `src/main/ipc-handlers.ts`
- Modify: `src/main/index.ts`

- [ ] **Step 1: 创建 IPC 处理器**

```typescript
// src/main/ipc-handlers.ts

import { ipcMain, BrowserWindow } from 'electron';
import { DaemonClient } from './daemon-client.js';
import { DaemonMessage } from '../daemon/protocol/messages.js';

export function setupIpcHandlers(daemonClient: DaemonClient, mainWindow: BrowserWindow) {
  // 请求转发：renderer → main → daemon
  ipcMain.handle('pty_spawn', async (_, args) => {
    return daemonClient.request({ type: 'spawn', ...args });
  });

  ipcMain.handle('pty_write', async (_, args) => {
    daemonClient.send({ type: 'write', ...args });
  });

  ipcMain.handle('pty_resize', async (_, args) => {
    daemonClient.send({ type: 'resize', ...args });
  });

  ipcMain.handle('pty_kill', async (_, args) => {
    daemonClient.send({ type: 'kill', ...args });
  });

  ipcMain.handle('pty_set_agent_session_id', async (_, args) => {
    daemonClient.send({ type: 'set-agent-session-id', ...args });
  });

  // 事件转发：daemon → main → renderer
  daemonClient.on('output', (msg: DaemonMessage & { type: 'output' }) => {
    mainWindow.webContents.send(`pty-output-${msg.sessionId}`, { data: msg.data });
  });

  daemonClient.on('exit', (msg: DaemonMessage & { type: 'exit' }) => {
    mainWindow.webContents.send(`pty-exit-${msg.sessionId}`, { exitCode: msg.code });
  });

  daemonClient.on('session-id-changed', (msg: DaemonMessage & { type: 'session-id-changed' }) => {
    mainWindow.webContents.send(`pty-session-id-changed-${msg.sessionId}`, { agentSessionId: msg.agentSessionId });
  });
}
```

- [ ] **Step 2: 更新 src/main/index.ts**

```typescript
import { app, BrowserWindow, globalShortcut } from 'electron';
import path from 'path';
import { DaemonClient } from './daemon-client.js';
import { setupIpcHandlers } from './ipc-handlers.js';

let mainWindow: BrowserWindow | null = null;
let daemonClient: DaemonClient | null = null;

async function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1400,
    height: 900,
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      preload: path.join(__dirname, '../preload/index.js')
    }
  });

  // 连接 daemon
  daemonClient = new DaemonClient();
  await daemonClient.connect();

  // 设置 IPC
  setupIpcHandlers(daemonClient, mainWindow);

  // 加载前端
  if (process.env.NODE_ENV === 'development') {
    await mainWindow.loadURL('http://localhost:5173');
  } else {
    await mainWindow.loadFile(path.join(__dirname, '../renderer/index.html'));
  }

  // 全局快捷键
  globalShortcut.register('F10', () => {
    app.quit();
  });
}

app.whenReady().then(createWindow);

app.on('window-all-closed', () => {
  daemonClient?.disconnect();
  app.quit();
});
```

- [ ] **Step 3: 提交**

```bash
git add src/main/
git commit -m "feat: Electron IPC 桥接 (renderer ↔ daemon 转发)"
```

---

## Task 7: 前端 IPC 层迁移

**Files:**
- Create: `src/renderer/lib/pty-ipc.ts`
- Modify: `src/renderer/hooks/usePty.ts`
- Modify: `src/renderer/App.tsx`

- [ ] **Step 1: 创建 pty-ipc.ts**

```typescript
// src/renderer/lib/pty-ipc.ts

import { ipcRenderer } from 'electron';

export interface SessionInfo {
  sessionId: string;
  agent: string;
  cwd: string;
  pid: number;
  running: boolean;
  agentSessionId: string;
}

export const pty = {
  spawn: (agent: string, cwd: string, cols: number, rows: number, agentSessionId?: string, isRestore?: boolean) =>
    ipcRenderer.invoke('pty_spawn', { agent, cwd, cols, rows, agentSessionId: agentSessionId || '', isRestore: isRestore || false }),
  
  write: (sessionId: string, data: string) =>
    ipcRenderer.invoke('pty_write', { sessionId, data }),
  
  resize: (sessionId: string, cols: number, rows: number) =>
    ipcRenderer.invoke('pty_resize', { sessionId, cols, rows }),
  
  kill: (sessionId: string) =>
    ipcRenderer.invoke('pty_kill', { sessionId }),
  
  setAgentSessionId: (sessionId: string, agentSessionId: string) =>
    ipcRenderer.invoke('pty_set_agent_session_id', { sessionId, agentSessionId }),
  
  onOutput: (id: string, handler: (data: string) => void) => {
    const listener = (_event: any, msg: { data: string }) => handler(msg.data);
    ipcRenderer.on(`pty-output-${id}`, listener);
    return () => ipcRenderer.removeListener(`pty-output-${id}`, listener);
  },
  
  onExit: (id: string, handler: (code: number) => void) => {
    const listener = (_event: any, msg: { exitCode: number }) => handler(msg.exitCode);
    ipcRenderer.on(`pty-exit-${id}`, listener);
    return () => ipcRenderer.removeListener(`pty-exit-${id}`, listener);
  },
  
  onSessionIdChanged: (id: string, handler: (agentSessionId: string) => void) => {
    const listener = (_event: any, msg: { agentSessionId: string }) => handler(msg.agentSessionId);
    ipcRenderer.on(`pty-session-id-changed-${id}`, listener);
    return () => ipcRenderer.removeListener(`pty-session-id-changed-${id}`, listener);
  }
};
```

- [ ] **Step 2: 更新 usePty.ts (替换 tauri-ipc 导入)**

从现有 `web/src/hooks/usePty.ts` 复制，修改导入：

```typescript
// 替换
// import { pty, type SessionInfo } from '../lib/tauri-ipc';
// 为
import { pty, type SessionInfo } from '../lib/pty-ipc';
```

其他代码保持不变（xterm 逻辑、快捷键、session recovery 等）。

- [ ] **Step 3: 更新 App.tsx (替换 tauri-ipc 导入)**

从现有 `web/src/App.tsx` 复制，修改导入和 SQLite 相关代码：

```typescript
// 替换 Tauri invoke 为 Electron IPC
// import { invoke } from '@tauri-apps/api/core';
// 移除，改为使用 pty-ipc 或新增 database.ts

// savePanelsToDb 和 load_layout 改为调用 database.ts (下一步实现)
```

- [ ] **Step 4: 提交**

```bash
git add src/renderer/
git commit -m "feat: 前端 IPC 层迁移 (Tauri → Electron)"
```

---

## Task 8: SQLite 持久化

**Files:**
- Create: `src/main/database.ts`
- Modify: `src/main/index.ts`
- Modify: `src/renderer/App.tsx`

- [ ] **Step 1: 创建 database.ts**

```typescript
// src/main/database.ts

import Database from 'better-sqlite3';
import path from 'path';
import { app } from 'electron';

let db: Database.Database | null = null;

export function initDatabase() {
  const dbPath = path.join(app.getPath('userData'), 'conductor.db');
  db = new Database(dbPath);
  
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
}

export function saveLayout(layout: { sessions: { id: string; agent: string; cwd: string; agent_session_id: string }[] }) {
  if (!db) return;
  
  db.prepare('DELETE FROM sessions').run();
  for (const s of layout.sessions) {
    db.prepare('INSERT INTO sessions (id, agent, cwd, agent_session_id) VALUES (?, ?, ?, ?)').run(s.id, s.agent, s.cwd, s.agent_session_id);
  }
  db.prepare('INSERT OR REPLACE INTO layout (id, dockview_json, window_width, window_height) VALUES (1, ?, ?, ?)').run('[]', 1400, 900);
}

export function loadLayout() {
  if (!db) return null;
  
  const sessions = db.prepare('SELECT id, agent, cwd, agent_session_id FROM sessions').all() as any[];
  const layout = db.prepare('SELECT dockview_json, window_width, window_height FROM layout WHERE id=1').get() as any;
  
  return { sessions, dockview_json: layout?.dockview_json || '[]', window_width: layout?.window_width || 1400, window_height: layout?.window_height || 900 };
}
```

- [ ] **Step 2: 添加 IPC handlers for database**

```typescript
// 在 src/main/ipc-handlers.ts 中添加

import { saveLayout, loadLayout } from './database.js';

// ... existing code ...

export function setupDatabaseIpcHandlers() {
  ipcMain.handle('save_layout', async (_, layout) => {
    saveLayout(layout);
  });

  ipcMain.handle('load_layout', async () => {
    return loadLayout();
  });
}
```

- [ ] **Step 3: 更新 src/main/index.ts**

```typescript
import { initDatabase } from './database.js';

app.whenReady().then(async () => {
  initDatabase();
  await createWindow();
});
```

- [ ] **Step 4: 更新 App.tsx 使用 database IPC**

在 `src/renderer/App.tsx` 中，将 `invoke('save_layout', ...)` 和 `invoke('load_layout')` 改为通过 `ipcRenderer.invoke` 调用。

- [ ] **Step 5: 提交**

```bash
git add src/main/database.ts src/main/ipc-handlers.ts src/main/index.ts src/renderer/App.tsx
git commit -m "feat: SQLite 持久化 (better-sqlite3 替代 rusqlite)"
```

---

## Task 9: Agent 配置加载

**Files:**
- Create: `src/main/agent-config.ts`
- Modify: `src/daemon/pty-manager.ts`

- [ ] **Step 1: 创建 agent-config.ts**

```typescript
// src/main/agent-config.ts

import fs from 'fs';
import path from 'path';
import { app } from 'electron';

export interface AgentConfig {
  id: string;
  name: string;
  command: string;
  args: string[];
  createTemplate: string;
  resumeTemplate: string;
  setup: string[];
  builtin: boolean;
}

const DEFAULT_AGENTS: AgentConfig[] = [
  { id: 'cmd', name: 'Command Prompt', command: 'cmd.exe', args: [], createTemplate: '', resumeTemplate: '', setup: [], builtin: true },
  { id: 'claude', name: 'Claude Code', command: 'claude', args: ['--allow-dangerously-skip-permissions'], createTemplate: '--session-id {session_id}', resumeTemplate: '--resume {session_id}', setup: [], builtin: false },
  { id: 'opencode', name: 'OpenCode', command: 'opencode', args: [], createTemplate: '', resumeTemplate: '--session {session_id}', setup: [], builtin: false },
  { id: 'codex', name: 'Codex', command: 'codex', args: [], createTemplate: '', resumeTemplate: 'resume --last', setup: [], builtin: false }
];

export function loadAgentConfig(): AgentConfig[] {
  const configPath = path.join(app.getPath('userData'), '..', 'agents.json');
  
  if (!fs.existsSync(configPath)) {
    fs.writeFileSync(configPath, JSON.stringify({ agents: DEFAULT_AGENTS }, null, 2));
    return DEFAULT_AGENTS;
  }
  
  try {
    const config = JSON.parse(fs.readFileSync(configPath, 'utf-8'));
    return config.agents || DEFAULT_AGENTS;
  } catch {
    return DEFAULT_AGENTS;
  }
}
```

- [ ] **Step 2: 更新 pty-manager.ts 使用配置**

将 `getAgentConfig` 方法改为从 `agent-config.ts` 加载（通过 IPC 或共享）。

- [ ] **Step 3: 提交**

```bash
git add src/main/agent-config.ts src/daemon/pty-manager.ts
git commit -m "feat: Agent 配置加载 (agents.json 复用)"
```

---

## Task 10: Git 分支检测集成

**Files:**
- Create: `src/main/git-integration.ts`
- Modify: `src/main/ipc-handlers.ts`
- Modify: `src/renderer/App.tsx`

- [ ] **Step 1: 创建 git-integration.ts**

```typescript
// src/main/git-integration.ts

import simpleGit from 'simple-git';

export async function getGitStatus(repoPath: string): Promise<{ branch: string | null; dirty: boolean; repoExists: boolean }> {
  try {
    const git = simpleGit(repoPath);
    const isRepo = await git.checkIsRepo();
    
    if (!isRepo) {
      return { branch: null, dirty: false, repoExists: false };
    }
    
    const status = await git.status();
    const branch = status.current || null;
    const dirty = !status.isClean();
    
    return { branch, dirty, repoExists: true };
  } catch {
    return { branch: null, dirty: false, repoExists: false };
  }
}
```

- [ ] **Step 2: 添加 IPC handler**

在 `src/main/ipc-handlers.ts` 中添加：

```typescript
import { getGitStatus } from './git-integration.js';

ipcMain.handle('get_git_status', async (_, args: { path: string }) => {
  return getGitStatus(args.path);
});
```

- [ ] **Step 3: 在 App.tsx 中使用**

在 `src/renderer/App.tsx` 的 `onReady` 回调中：

```typescript
onReady={(info) => {
  updateId(p.dockId, info.id);
  setPanels((prev) => prev.map((pp) => pp.dockId === p.dockId ? { ...pp, ptyId: info.id, cwd: info.cwd || pp.cwd, status: 'running', needsAttention: false, resumeId: info.agentSessionId || pp.resumeId } : pp));
  // 获取 Git 状态
  ipcRenderer.invoke('get_git_status', { path: info.cwd || p.cwd }).then((git: any) => {
    if (git.branch) {
      setPanels((prev) => prev.map((pp) => pp.dockId === p.dockId ? { ...pp, gitBranch: git.branch + (git.dirty ? ' *' : '') } : pp));
    }
  }).catch(() => {});
}}
```

- [ ] **Step 4: 提交**

```bash
git add src/main/git-integration.ts src/main/ipc-handlers.ts src/renderer/App.tsx
git commit -m "feat: Git 分支检测集成 (simple-git 替代 git2)"
```

---

## Task 11: Session Recovery 迁移

**Files:**
- Create: `src/daemon/session-recovery.ts`
- Modify: `src/daemon/pty-manager.ts`

- [ ] **Step 1: 创建 session-recovery.ts**

```typescript
// src/daemon/session-recovery.ts

import { execSync } from 'child_process';
import path from 'path';
import os from 'os';

export function discoverSessionIds(agent: string, cwd: string): string[] {
  if (agent === 'opencode') {
    return discoverOpenCodeSessions(cwd);
  }
  if (agent === 'codex') {
    return discoverCodexSessions();
  }
  return [];
}

function discoverOpenCodeSessions(cwd: string): string[] {
  try {
    const { stdout } = require('child_process').spawnSync('opencode', ['db', 'SELECT id FROM session'], { cwd });
    return stdout.toString().split('\n').filter(l => l.trim().startsWith('ses_'));
  } catch {
    return [];
  }
}

function discoverCodexSessions(): string[] {
  const dir = path.join(os.homedir(), '.codex', 'sessions');
  if (!require('fs').existsSync(dir)) return [];
  
  const files = require('fs').readdirSync(dir);
  const sessionIds: string[] = [];
  
  for (const file of files) {
    if (file.startsWith('rollout-') && file.endsWith('.jsonl')) {
      const match = file.match(/rollout-(\d+)-(.+)\.jsonl/);
      if (match) {
        sessionIds.push(match[2]);
      }
    }
  }
  
  return sessionIds;
}
```

- [ ] **Step 2: 在 pty-manager.ts 中集成**

在 `spawn` 方法中，如果是 snapshot agent（opencode/codex），在 spawn 前调用 `discoverSessionIds` 获取 prev_ids，spawn 后 3 秒再调用一次，diff 找到新 session ID。

- [ ] **Step 3: 提交**

```bash
git add src/daemon/
git commit -m "feat: Session Recovery 迁移 (OpenCode/Codex snapshot diff)"
```

---

## Task 12: 完整功能集成 + 测试

**Files:**
- Modify: `src/renderer/App.tsx` (从现有代码完整迁移)
- Modify: `src/renderer/components/Sidebar.tsx`
- Modify: `src/renderer/components/TerminalPanel.tsx`

- [ ] **Step 1: 完整迁移 App.tsx**

从 `web/src/App.tsx` 复制完整代码，替换所有 Tauri 相关导入为 Electron IPC。

- [ ] **Step 2: 迁移 Sidebar.tsx 和 TerminalPanel.tsx**

从 `web/src/components/` 复制，修改导入。

- [ ] **Step 3: 迁移 usePty.ts**

从 `web/src/hooks/usePty.ts` 复制，替换 `tauri-ipc` 为 `pty-ipc`。

- [ ] **Step 4: 端到端测试**

```bash
npm run dev
```

验证：
- ✅ 窗口正常打开
- ✅ cmd.exe 终端可以启动
- ✅ 可以输入命令并看到输出
- ✅ Ctrl+N 新建终端
- ✅ Ctrl+W 关闭终端
- ✅ 广播模式工作
- ✅ Terminal 搜索 (Ctrl+F) 工作
- ✅ 会话恢复工作

- [ ] **Step 5: 最终提交**

```bash
git add .
git commit -m "feat: Phase 1 完成 - Electron 迁移 + 全功能保留"
```

---

## 清理工作

- [ ] **删除 Tauri 代码**

```bash
rm -rf web/src-tauri
rm conductor.cmd  # 或更新为 Electron 启动脚本
```

- [ ] **更新 README**

```bash
git commit -m "chore: 删除 Tauri/Rust 代码，更新 README"
```

---

**计划完成。总计 12 个任务，预计 2-3 周完成。**

下一步：选择执行方式
1. **Subagent-Driven** (推荐) - 每个任务分配独立 subagent，任务间审查
2. **Inline Execution** - 在当前会话中批量执行，带检查点

选择哪种方式？
