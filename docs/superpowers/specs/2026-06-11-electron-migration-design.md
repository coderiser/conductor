# Conductor V2: Electron 迁移 + 竞品融合设计

**日期:** 2026-06-11  
**状态:** 已批准  
**目标平台:** Windows Only

## 概述

将 Conductor 从 Tauri/Rust 迁移到 Electron/Node.js，同时融合 cmux、ghostty、superset 的最佳特性，打造 AI Agent 终端管理器的差异化产品。

## 架构总览

```
┌─────────────────────────────────────────────────────────────────┐
│                    Conductor V2 Architecture                     │
├─────────────────────────────────────────────────────────────────┤
│                                                                  │
│  ┌──────────────────────┐    Named Pipe    ┌──────────────────┐ │
│  │   pty-daemon (Node)  │◄════════════════►│ Electron 主进程   │ │
│  │                      │  \\.\pipe\       │                  │ │
│  │  ┌─ PtyManager ────┐ │                  │  ┌─ DaemonClient┐ │ │
│  │  │ node-pty spawn  │ │                  │  │  reconnect   │ │ │
│  │  │ session map     │ │                  │  └──────────────┘ │ │
│  │  │ 64KB ring buffer│ │                  │  ┌─ WindowManager┐ │ │
│  │  └────────────────┘ │ │                  │  │  窗口/托盘    │ │ │
│  │  ┌─ Protocol ──────┐ │ │                  │  └──────────────┘ │ │
│  │  │ versioned msgs  │ │ │                  │  ┌─ StatsCollector┐│ │
│  │  │ framing codec   │ │ │                  │  │  Token/Health │ │ │
│  │  └────────────────┘ │ │                  │  └──────────────┘ │ │
│  │  ┌─ SessionStore ──┐ │ │                  │  ┌─ NotifyCenter┐  │ │
│  │  │ agent_session_id│ │ │                  │  │  通知/解析    │  │ │
│  │  │ recovery        │ │ │                  │  └──────────────┘ │ │
│  │  └────────────────┘ │ │                  │  ┌─ WorktreeMgr ──┐ │ │
│  └──────────────────────┘ │                  │  │ create/cleanup │ │ │
│                           │                  │  │ rollback/conf. │ │ │
│  ┌──────────────────────┐ │                  │  └──────────────┘ │ │
│  │   SQLite (共享)      │ │                  │  ┌ WorktreeWatch ┐ │ │
│  │   sessions/layout    │ │                  │  │ fs.watch .git  │ │ │
│  │   stats/notif/worktr.│ │                  │  └──────────────┘ │ │
│  └──────────────────────┘ │                  └──────────────────┘ │
│                           │                          │ IPC         │
│                           │                          ▼             │
│  ┌──────────────────────┐ │            ┌──────────────────────┐  │
│  │  ~/.conductor/        │ │            │  Electron 渲染进程    │  │
│  │    worktrees/         │ │            │                      │  │
│  │    {project-hash}/    │ │            │  React + xterm.js    │  │
│  │    {agent}-{id}/      │ │            │  CSS Grid 动态布局    │  │
│  └──────────────────────┘ │            │  Sidebar + 通知面板   │  │
│                           │            │  Dashboard + Tasks    │  │
│  ┌──────────────────────┐ │            │  Conflicted 冲突预警   │  │
│  │  agents.json (配置)   │ │            └──────────────────────┘  │
│  │  + capabilities      │ │                                      │
│  │  + worktree 策略      │ │                                      │
│  └──────────────────────┘ │                                        │
└─────────────────────────────────────────────────────────────────┘
```

### 核心原则

- Daemon 无状态（每次调用携带完整上下文）
- 协议版本化（hello/hello-ack 握手）
- Auth = Named Pipe ACL（Windows 比 Unix socket 更安全）
- Agent Session Recovery 在 daemon 层实现
- 数据统计在 Electron 主进程层汇总
- Git worktree 隔离在 daemon 层管理

---

## Section 1: PTY Daemon 详细设计

### 项目结构

```
pty-daemon/
├── src/
│   ├── main.ts              # 入口：启动 Server
│   ├── server.ts            # Named Pipe 监听 + 客户端管理
│   ├── pty-manager.ts       # node-pty 封装 + 生命周期
│   ├── session-store.ts     # 会话持久化 + ring buffer
│   ├── session-recovery.ts  # Agent session ID 发现
│   ├── handlers.ts          # 协议处理（纯函数）
│   ├── protocol/
│   │   ├── messages.ts      # ClientMessage / DaemonMessage 定义
│   │   ├── framing.ts       # 4字节长度前缀编解码
│   │   └── version.ts       # 协议版本协商
│   └── agents/
│       ├── config.ts        # agents.json 加载 + 模板解析
│       ├── discovery.ts     # OpenCode DB / Codex sessions 发现
│       └── types.ts         # AgentConfig 类型
```

### 协议消息

```typescript
// Client → Daemon
type ClientMessage =
  | { type: 'hello'; version: number }
  | { type: 'spawn'; agent: string; cwd: string; cols: number; rows: number;
      agentSessionId?: string; isRestore: boolean; worktree?: WorktreeConfig }
  | { type: 'write'; sessionId: string; data: string }
  | { type: 'resize'; sessionId: string; cols: number; rows: number }
  | { type: 'kill'; sessionId: string }
  | { type: 'list' }
  | { type: 'set-agent-session-id'; sessionId: string; agentSessionId: string }

// Daemon → Electron
type DaemonMessage =
  | { type: 'hello-ack'; version: number }
  | { type: 'spawned'; sessionId: string; pid: number; agent: string;
      agentSessionId: string; worktreePath?: string }
  | { type: 'output'; sessionId: string; data: string }
  | { type: 'exit'; sessionId: string; code: number }
  | { type: 'session-id-changed'; sessionId: string; agentSessionId: string }
  | { type: 'worktree-status'; sessionId: string; branch: string; conflicts: string[] }
  | { type: 'error'; message: string }
```

### Session Recovery（从 Rust 迁移，大幅简化）

```typescript
// 之前 Rust 版本 ~80 行，现在 ~20 行
async function discoverSessionId(agent: string, cwd: string): Promise<string[]> {
  if (agent === 'opencode') {
    const { stdout } = execSync('opencode db "SELECT id FROM session"', { cwd });
    return stdout.split('\n').filter(l => l.trim().startsWith('ses_'));
  }
  if (agent === 'codex') {
    const dir = path.join(os.homedir(), '.codex', 'sessions');
    return scanCodexSessions(dir);
  }
  return [];
}
```

### Named Pipe 通信（Windows 优势）

```typescript
// Windows Named Pipe 比 Unix Socket 更简单
const PIPE_PATH = '\\\\.\\pipe\\conductor-pty-daemon';

// Server 端
const server = net.createServer();
server.listen(PIPE_PATH);

// Client 端（Electron 主进程）
const client = net.connect(PIPE_PATH);
```

### Daemon 生命周期

```
conductor start
  ├── Electron 启动
  ├── 检查 daemon 是否运行（尝试连接 Named Pipe）
  │   ├── 已运行 → 直接连接
  │   └── 未运行 → spawn daemon 进程 → 等待就绪
  ├── hello/hello-ack 握手
  └── 恢复上次会话

窗口关闭
  ├── Electron → daemon: kill all sessions
  ├── Daemon 清理 PTY 进程树
  └── Daemon 保持运行（下次启动秒连）

用户退出 Conductor（托盘退出）
  ├── Electron → daemon: shutdown
  └── Daemon 进程退出
```

---

## Section 2: Electron 主进程 + 渲染进程

### 项目结构

```
conductor/
├── package.json
├── electron-builder.ts          # 打包配置
├── electron.vite.config.ts      # Vite + Electron 构建
├── src/
│   ├── main/                    # Electron 主进程
│   │   ├── index.ts             # 入口：窗口创建 + daemon 启动
│   │   ├── daemon-client.ts     # Named Pipe 客户端 + 重连
│   │   ├── ipc-handlers.ts      # ipcMain 处理器（桥接渲染↔daemon）
│   │   ├── notify-center.ts     # Agent 通知系统
│   │   ├── stats-collector.ts   # Token/Cost/健康统计
│   │   ├── window-manager.ts    # 窗口生命周期 + 快捷键
│   │   ├── tray.ts              # 系统托盘
│   │   └── worktree-manager.ts  # Git worktree 管理
│   ├── renderer/                # 渲染进程（现有代码复用）
│   │   ├── App.tsx              # 主编排（从 Tauri 版迁移）
│   │   ├── main.tsx             # React 入口
│   │   ├── components/
│   │   │   ├── Sidebar.tsx      # 侧边栏（复用 + 增强）
│   │   │   ├── TerminalPanel.tsx # 终端面板（复用）
│   │   │   ├── NotifyPanel.tsx  # 🆕 通知面板
│   │   │   ├── AgentDashboard.tsx # 🆕 Agent 状态仪表盘
│   │   │   └── WorktreeStatus.tsx # 🆕 worktree 状态显示
│   │   ├── hooks/
│   │   │   └── usePty.ts        # PTY hook（改为 ipcRenderer 调用）
│   │   ├── lib/
│   │   │   ├── pty-ipc.ts       # 替代 tauri-ipc.ts
│   │   │   └── terminal-theme.ts # 复用
│   │   └── store/
│   │       └── sessions.ts      # Zustand（复用）
│   └── daemon/                  # PTY Daemon（独立进程）
│       ├── main.ts
│       ├── server.ts
│       ├── pty-manager.ts
│       ├── session-store.ts
│       ├── session-recovery.ts
│       ├── handlers.ts
│       ├── protocol/
│       │   ├── messages.ts
│       │   ├── framing.ts
│       │   └── version.ts
│       └── agents/
│           ├── config.ts
│           ├── discovery.ts
│           └── types.ts
├── agents.json                  # Agent 配置（复用）
└── resources/                   # 图标等资源
```

### IPC 桥接层（替代 Tauri invoke）

```typescript
// src/renderer/lib/pty-ipc.ts
// 几乎 1:1 对应现有 tauri-ipc.ts

export const pty = {
  spawn: (agent, cwd, cols, rows, agentSessionId, isRestore) =>
    ipcRenderer.invoke('pty_spawn', { agent, cwd, cols, rows, agentSessionId, isRestore }),
  write: (sessionId, data) =>
    ipcRenderer.invoke('pty_write', { sessionId, data }),
  resize: (sessionId, cols, rows) =>
    ipcRenderer.invoke('pty_resize', { sessionId, cols, rows }),
  kill: (sessionId) =>
    ipcRenderer.invoke('pty_kill', { sessionId }),
  setAgentSessionId: (sessionId, agentSessionId) =>
    ipcRenderer.invoke('pty_set_agent_session_id', { sessionId, agentSessionId }),
  // 事件监听改为 Electron IPC
  onOutput: (id, handler) =>
    ipcRenderer.on(`pty-output-${id}`, (_e, data) => handler(data.data)),
  onExit: (id, handler) =>
    ipcRenderer.on(`pty-exit-${id}`, (_e, data) => handler(data.exitCode)),
  onSessionIdChanged: (id, handler) =>
    ipcRenderer.on(`pty-session-id-changed-${id}`, (_e, data) => handler(data.agentSessionId)),
};
```

### 主进程 IPC 转发（Electron ↔ Daemon）

```typescript
// src/main/ipc-handlers.ts
// 简单转发：渲染进程请求 → 主进程 → daemon → 返回

ipcMain.handle('pty_spawn', async (_, args) => {
  return daemonClient.request({ type: 'spawn', ...args });
});

ipcMain.handle('pty_write', async (_, args) => {
  return daemonClient.request({ type: 'write', ...args });
});

// Daemon 推送 → 主进程 → 渲染进程
daemonClient.on('output', (msg) => {
  mainWindow.webContents.send(`pty-output-${msg.sessionId}`, msg);
});
daemonClient.on('exit', (msg) => {
  mainWindow.webContents.send(`pty-exit-${msg.sessionId}`, msg);
});
daemonClient.on('session-id-changed', (msg) => {
  mainWindow.webContents.send(`pty-session-id-changed-${msg.sessionId}`, msg);
});
```

### 现有功能保留清单

| 功能 | 迁移方式 | 工作量 |
|------|---------|--------|
| 多 Agent PTY | node-pty 替代 portable-pty | 中 |
| 动态格网布局 | CSS Grid 不变 | 零 |
| 会话恢复 | daemon 层实现（更简单） | 小 |
| agents.json 配置 | 直接复用 | 零 |
| Terminal 搜索 Ctrl+F | xterm addon-search 不变 | 零 |
| Terminal 清屏 Ctrl+K/L | xterm 不变 | 零 |
| Setup 脚本 | daemon spawn 时注入 | 小 |
| 广播模式 | 前端不变 | 零 |
| SQLite 持久化 | better-sqlite3 替代 rusqlite | 小 |
| Git 分支检测 | simple-git 替代 git2 | 小 |
| 复制/粘贴 | xterm clipboard addon 不变 | 零 |
| 进程清理 | daemon 负责进程树 | 中 |

**估算：前端代码 90% 复用，Rust 代码全部删除用 Node.js 重写（代码量减半）。**

---

## Section 3: Git Worktree 隔离

> **调研参考:** Superset (superset-sh/superset) 的 worktree 实现方案。以下设计融合了 Superset 的实践验证：worktree 放在项目外部、discriminated union 处理 git ref 安全、事件驱动变更检测、多阶段清理+验证、不自动 merge。

### 3.1 架构

```
用户主目录:
  ~/.conductor/
    ├── worktrees/                       ← 所有 worktree 的根目录
    │   └── {project-hash}/              ← 每个项目一个子目录（基于 repo path 的 hash）
    │       ├── claude-20260612-a3f2/    ← Agent 独立 worktree
    │       ├── opencode-20260612-b91d/
    │       └── codex-20260612-c74e/
    └── conductor.db                     ← SQLite（已有）

项目仓库: E:\workspace\my-project\       ← main checkout（不受影响）
  └── .git/
      └── worktrees/                     ← git 内部元数据（git 自动管理）
```

**核心决策：worktree 放在项目外部**（`~/.conductor/worktrees/`），不在项目根目录下。

理由（Superset 验证）：
- 编辑器/IDE 不会把 worktree 当作嵌套目录重复索引
- 文件监视器不会产生额外的递归事件
- `.gitignore` 规则无需特殊处理
- 多个 agent 并行读写时避免同目录下的锁竞争

### 3.2 文件结构

```
Create:
  src/main/worktree-manager.ts           — Worktree 创建/清理/查询（Electron 主进程）
  src/main/worktree-watcher.ts           — 事件驱动的 worktree 文件变更检测
  src/common/worktree-types.ts           — 共享类型（WorktreeInfo, ResolvedRef, ConflictReport）
  src/renderer/components/WorktreeBadge.tsx — Sidebar worktree 状态标识
  tests/worktree-manager.test.ts
  tests/worktree-watcher.test.ts

Modify:
  src/main/index.ts                      — 初始化 WorktreeManager, WorktreeWatcher
  src/main/ipc-handlers.ts              — worktree_* IPC handlers
  src/main/database.ts                   — worktrees 表 + migration
  src/preload/index.ts                   — expose worktree APIs
  src/renderer/global.d.ts               — ElectronAPI 类型声明
  src/renderer/components/Sidebar.tsx    — Worktree 状态显示
  src/common/agent-config.ts             — AgentConfig.worktree 字段（已有）
  src/daemon/protocol/messages.ts        — spawn message 添加 worktree 字段
```

### 3.3 Git Ref 类型安全

Superset 踩过的坑：用 `startsWith("origin/")` 判断 ref 类型是不安全的——本地分支完全可以叫 `origin/foo`。必须用 full refname 判断 + discriminated union 携带类型标签。

```typescript
// src/common/worktree-types.ts

/** Git ref 类型安全解析 — local 永远优先于 remote-tracking */
export type ResolvedRef =
  | { kind: 'local';            fullRef: string; shortName: string }
  | { kind: 'remote-tracking';  fullRef: string; shortName: string; remote: string }
  | { kind: 'tag';             fullRef: string; shortName: string }
  | { kind: 'head' };

/** Worktree 信息 */
export interface WorktreeInfo {
  id: string;              // UUID
  sessionId: string;        // 关联的 PTY session
  agentId: string;          // 'claude' | 'opencode' | 'codex'
  worktreePath: string;     // 文件系统路径
  branch: string;           // git 分支名
  baseBranch: string;       // fork 来源分支
  projectPath: string;      // 主仓库路径
  createdAt: number;        // Date.now()
  status: 'creating' | 'ready' | 'cleanup' | 'removed';
}

/** 清理选项 */
export interface CleanupOptions {
  keepBranch: boolean;      // true=保留分支和 worktree, false=删除
  force: boolean;           // 跳过 dirty check
}

/** 冲突报告 */
export interface ConflictReport {
  hasConflicts: boolean;
  conflicts: Array<{
    file: string;
    worktrees: string[];    // 改了同一文件的 worktree id 列表
    branches: string[];     // 对应分支名
  }>;
}
```

### 3.4 Worktree Manager — 创建流程

```typescript
// src/main/worktree-manager.ts
import path from 'node:path';
import fs from 'node:fs';
import { homedir } from 'node:os';
import crypto from 'node:crypto';
import simpleGit, { type SimpleGit } from 'simple-git';
import type { WorktreeInfo, ResolvedRef, CleanupOptions } from '../common/worktree-types';

export class WorktreeManager {
  private gitInstances = new Map<string, SimpleGit>(); // projectPath → SimpleGit
  private activeWorktrees = new Map<string, WorktreeInfo>();

  /** worktree 根目录: ~/.conductor/worktrees/ */
  static worktreesRoot(): string {
    return path.join(homedir(), '.conductor', 'worktrees');
  }

  /** project hash：基于 repo path 的稳定标识 */
  static projectHash(projectPath: string): string {
    return crypto.createHash('sha256')
      .update(path.resolve(projectPath))
      .digest('hex').slice(0, 12);
  }

  /** worktree 目录: ~/.conductor/worktrees/{project-hash}/{agent}-{date}-{shortId}/ */
  static worktreeDir(projectPath: string, agentId: string): string {
    const hash = WorktreeManager.projectHash(projectPath);
    const date = new Date().toISOString().slice(0, 10).replace(/-/g, '');
    const shortId = crypto.randomBytes(4).toString('hex');
    return path.join(WorktreeManager.worktreesRoot(), hash,
      `${agentId}-${date}-${shortId}`);
  }

  private getGit(projectPath: string): SimpleGit {
    let git = this.gitInstances.get(projectPath);
    if (!git) {
      git = simpleGit(projectPath);
      this.gitInstances.set(projectPath, git);
    }
    return git;
  }

  // ═══ Git Ref 安全解析 ═══

  /** 解析 ref：probe full refname → 返回 discriminated union。
   *  解析顺序: local → remote-tracking → tag → null
   *  关键: refs/heads/<input> 优先于 refs/remotes/origin/<input>
   *  — 所以本地分支名 'origin/foo' 不会被误判为 remote-tracking */
  async resolveRef(
    git: SimpleGit, input: string, remote: string = 'origin'
  ): Promise<ResolvedRef | null> {
    const trimmed = input.trim();
    if (!trimmed) return null;

    const localRef = `refs/heads/${trimmed}`;
    if (await this.refExists(git, localRef)) {
      return { kind: 'local', fullRef: localRef, shortName: trimmed };
    }

    const prefix = `${remote}/`;
    const remoteName = trimmed.startsWith(prefix)
      ? trimmed.slice(prefix.length) : trimmed;
    const remoteRef = `refs/remotes/${remote}/${remoteName}`;
    if (await this.refExists(git, remoteRef)) {
      return { kind: 'remote-tracking', fullRef: remoteRef,
        shortName: remoteName, remote };
    }

    const tagRef = `refs/tags/${trimmed}`;
    if (await this.refExists(git, tagRef)) {
      return { kind: 'tag', fullRef: tagRef, shortName: trimmed };
    }

    return null;
  }

  private async refExists(git: SimpleGit, fullRef: string): Promise<boolean> {
    try {
      const out = await git.raw(['rev-parse', '--verify', `${fullRef}^{commit}`]);
      return /^[0-9a-f]{40,}/.test(out.trim());
    } catch { return false; }
  }

  // ═══ Worktree 创建 ═══

  /**
   * 为 Agent 创建独立 worktree。
   *
   * 流程:
   *  1. git worktree prune           ← 清理残留注册
   *  2. 解析 baseBranch → ResolvedRef
   *  3. git fetch origin <branch>    ← 如果 fork 自远程（确保最新）
   *  4. git worktree add --no-track -b <newBranch> <path> <startPoint>
   *  5. push.autoSetupRemote = true
   *  6. 失败 → rollback（remove worktree + delete branch）
   */
  async createForAgent(
    sessionId: string,
    agentId: string,
    projectPath: string,
    baseBranch: string = 'main',
  ): Promise<WorktreeInfo> {
    const git = this.getGit(projectPath);
    const worktreePath = WorktreeManager.worktreeDir(projectPath, agentId);
    const branchName = `conductor/${agentId}/${Date.now().toString(36)}`;

    // Step 1: Prune — 清理目录已被删除的残留
    await git.raw(['worktree', 'prune']).catch(() => {});

    // Step 2: 确保父目录存在
    fs.mkdirSync(path.dirname(worktreePath), { recursive: true });

    // Step 3: 解析基点
    let startPoint: ResolvedRef = { kind: 'head' };
    const resolved = await this.resolveRef(git, baseBranch);
    if (resolved) startPoint = resolved;

    // Step 4: Fetch（如果是 remote-tracking）
    if (startPoint.kind === 'remote-tracking') {
      await git.fetch([startPoint.remote, startPoint.shortName,
        '--quiet', '--no-tags'])
        .catch(err => console.warn(
          `[worktree] fetch ${startPoint.remote}/${startPoint.shortName} failed:`, err));
    }

    // Step 5: git worktree add
    const startPointArg = startPoint.kind === 'head' ? 'HEAD'
      : startPoint.kind === 'remote-tracking'
        ? `${startPoint.remote}/${startPoint.shortName}`
        : startPoint.shortName;

    let worktreeCreated = false;
    try {
      await git.raw([
        'worktree', 'add',
        '--no-track',           // 新分支不跟踪上游（push.autoSetupRemote 处理）
        '-b', branchName,
        worktreePath,
        startPointArg,
      ]);
      worktreeCreated = true;

      // 首次 push 自动设置 upstream
      await git.cwd(worktreePath)
        .raw(['config', 'push.autoSetupRemote', 'true'])
        .catch(() => {});

    } catch (err) {
      await this.rollbackCreation(git, worktreePath, branchName, worktreeCreated);
      throw new Error(
        `Failed to create worktree for ${agentId}: ` +
        `${err instanceof Error ? err.message : String(err)}`);
    }

    const info: WorktreeInfo = {
      id: crypto.randomUUID(), sessionId, agentId,
      worktreePath, branch: branchName, baseBranch,
      projectPath, createdAt: Date.now(), status: 'ready',
    };
    this.activeWorktrees.set(sessionId, info);
    return info;
  }

  private async rollbackCreation(
    git: SimpleGit, worktreePath: string, branchName: string,
    worktreeCreated: boolean,
  ): Promise<void> {
    if (worktreeCreated) {
      await git.raw(['worktree', 'remove', '--force', worktreePath])
        .catch(() => {});
    }
    try {
      await git.raw(['rev-parse', '--verify', `refs/heads/${branchName}`]);
      await git.raw(['branch', '-D', branchName]);
    } catch { /* 分支不存在 — 已满足 */ }
  }

  // ═══ Worktree 清理（多阶段 + 验证） ═══

  /**
   * 清理 worktree — 6 个阶段:
   *
   *  0. Preflight    — dirty worktree 检查（force 跳过）
   *  1. 验证注册      — git worktree list --porcelain 确认已注册
   *  2. git worktree remove --force --force <path>
   *  3. 验证移除      — 再次 worktree list 确认已删除（否则返回失败）
   *  4. Branch delete — git branch -D（keepBranch=false 时）
   *  5. 目录清理      — rimraf worktreePath
   *
   * 关键: Step 3 验证失败 → 整个清理返回失败，worktree 路径不变，可重试
   */
  async cleanup(
    sessionId: string,
    options: CleanupOptions = { keepBranch: false, force: false },
  ): Promise<{ success: boolean; warnings: string[] }> {
    const info = this.activeWorktrees.get(sessionId);
    if (!info) return { success: false, warnings: ['Session not found'] };

    const git = this.getGit(info.projectPath);
    const warnings: string[] = [];

    // Phase 0: Preflight
    if (!options.force) {
      try {
        const wtGit = simpleGit(info.worktreePath);
        const status = await wtGit.status();
        if (!status.isClean()) {
          return { success: false,
            warnings: ['Worktree has uncommitted changes. Use force to discard.'] };
        }
      } catch { /* 无法读状态 → 继续 */ }
    }

    // Phase 1: 验证已注册
    const registeredBefore = await this.isRegisteredWorktree(git, info.worktreePath);
    if (!registeredBefore) {
      warnings.push('Worktree not registered — directory may already be removed');
    }

    // Phase 2: 移除 worktree（双 force）
    if (registeredBefore) {
      try {
        await git.raw(['worktree', 'remove', '--force', '--force', info.worktreePath]);
      } catch (err) {
        return { success: false,
          warnings: [`Failed to remove: ${err instanceof Error ? err.message : String(err)}`] };
      }
    }

    // Phase 3: 验证已移除（关键！）
    if (await this.isRegisteredWorktree(git, info.worktreePath)) {
      return { success: false,
        warnings: ['Removal verification failed — git still reports as registered. Retry.'] };
    }

    // Phase 4: 删除分支（可选）
    if (!options.keepBranch) {
      try {
        if (await this.refExists(git, `refs/heads/${info.branch}`)) {
          await git.raw(['branch', '-D', info.branch]);
        }
      } catch (err) {
        warnings.push(`Failed to delete branch ${info.branch}: ` +
          `${err instanceof Error ? err.message : String(err)}`);
      }
    }

    // Phase 5: 清理空目录
    try {
      if (fs.existsSync(info.worktreePath)) {
        fs.rmSync(info.worktreePath, { recursive: true, force: true });
      }
    } catch (err) {
      warnings.push(`Failed to remove directory: ` +
        `${err instanceof Error ? err.message : String(err)}`);
    }

    info.status = 'removed';
    this.activeWorktrees.delete(sessionId);
    return { success: true, warnings };
  }

  /** 验证 worktree 是否在 git 注册中（解析 --porcelain 输出） */
  private async isRegisteredWorktree(
    git: SimpleGit, worktreePath: string
  ): Promise<boolean> {
    try {
      const raw = await git.raw(['worktree', 'list', '--porcelain']);
      const target = path.resolve(worktreePath);
      return this.parseWorktreeList(raw).some(w => w.path === target);
    } catch { return false; }
  }

  /** 解析 git worktree list --porcelain */
  private parseWorktreeList(
    raw: string
  ): Array<{ path: string; branch: string | null }> {
    const results: Array<{ path: string; branch: string | null }> = [];
    let cur: { path: string; branch: string | null } | null = null;
    for (const line of raw.split('\n')) {
      if (line.startsWith('worktree ')) {
        if (cur) results.push(cur);
        cur = { path: line.slice('worktree '.length).trim(), branch: null };
      } else if (cur && line.startsWith('branch ')) {
        const ref = line.slice('branch '.length).trim();
        cur.branch = ref.startsWith('refs/heads/')
          ? ref.slice('refs/heads/'.length) : ref;
      }
    }
    if (cur) results.push(cur);
    return results;
  }

  // ═══ 冲突检测 ═══

  /**
   * 检测 worktree 之间的文件冲突。
   * git diff --name-only <base> 取每个 worktree 改动 → 找交集。
   */
  async detectConflicts(): Promise<ConflictReport> {
    const entries = Array.from(this.activeWorktrees.values())
      .filter(w => w.status === 'ready');
    if (entries.length < 2) return { hasConflicts: false, conflicts: [] };

    const fileMap = new Map<string,
      { worktreeId: string; branch: string; files: Set<string> }>();

    for (const wt of entries) {
      try {
        const git = simpleGit(wt.worktreePath);
        const diff = await git.raw(['diff', '--name-only', wt.baseBranch]);
        fileMap.set(wt.id, {
          worktreeId: wt.id, branch: wt.branch,
          files: new Set(diff.trim().split('\n').filter(Boolean)),
        });
      } catch { /* skip */ }
    }

    // 找交集：同一文件被 ≥2 个 worktree 修改
    const allFiles = new Map<string,
      Array<{ worktreeId: string; branch: string }>>();
    for (const entry of fileMap.values()) {
      for (const file of entry.files) {
        if (!allFiles.has(file)) allFiles.set(file, []);
        allFiles.get(file)!.push(
          { worktreeId: entry.worktreeId, branch: entry.branch });
      }
    }

    const conflicts: ConflictReport['conflicts'] = [];
    for (const [file, wts] of allFiles) {
      if (wts.length >= 2) {
        conflicts.push({
          file,
          worktrees: wts.map(w => w.worktreeId),
          branches: wts.map(w => w.branch),
        });
      }
    }

    return { hasConflicts: conflicts.length > 0, conflicts };
  }

  list(): WorktreeInfo[] {
    return Array.from(this.activeWorktrees.values());
  }

  getBySession(sessionId: string): WorktreeInfo | undefined {
    return this.activeWorktrees.get(sessionId);
  }

  dispose(): void {
    this.gitInstances.clear();
    this.activeWorktrees.clear();
  }
}
```

### 3.5 Worktree Watcher — 事件驱动变更检测

```typescript
// src/main/worktree-watcher.ts
import { watch } from 'node:fs';
import type { WorktreeInfo } from '../common/worktree-types';

export type WorktreeChangeListener = (info: WorktreeInfo, paths?: string[]) => void;

/**
 * 监视所有活跃 worktree 的 .git/ 变更。
 * 事件驱动，不轮询 — idle worktree 零开销。
 *
 * 每个 worktree 只监视 .git/ 目录（recursive）。
 * .git/ 发生变化（commit, branch switch, fetch 等）→ 300ms debounce
 * → 发出 onChange。消费者可据此重新检测冲突。
 */
export class WorktreeWatcher {
  private watched = new Map<string, {
    info: WorktreeInfo;
    watcher: ReturnType<typeof watch> | null;
    timer: ReturnType<typeof setTimeout> | null;
  }>();
  private listeners = new Set<WorktreeChangeListener>();
  private closed = false;
  private static DEBOUNCE_MS = 300;

  add(info: WorktreeInfo): void {
    if (this.closed || this.watched.has(info.id)) return;
    let watcher: ReturnType<typeof watch> | null = null;
    try {
      watcher = watch(`${info.worktreePath}/.git`, { recursive: true },
        () => this.scheduleEmit(info));
      watcher.on('error', () => {
        this.watched.delete(info.id);
        watcher?.close();
      });
    } catch { return; }
    this.watched.set(info.id, { info, watcher, timer: null });
  }

  remove(worktreeId: string): void {
    const w = this.watched.get(worktreeId);
    if (!w) return;
    w.watcher?.close();
    if (w.timer) clearTimeout(w.timer);
    this.watched.delete(worktreeId);
  }

  onChange(listener: WorktreeChangeListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private scheduleEmit(info: WorktreeInfo): void {
    const w = this.watched.get(info.id);
    if (!w) return;
    if (w.timer) clearTimeout(w.timer);
    w.timer = setTimeout(() => {
      w.timer = null;
      for (const fn of this.listeners) {
        try { fn(info); } catch { /* isolate */ }
      }
    }, WorktreeWatcher.DEBOUNCE_MS);
  }

  close(): void {
    this.closed = true;
    for (const w of this.watched.values()) {
      w.watcher?.close();
      if (w.timer) clearTimeout(w.timer);
    }
    this.watched.clear();
    this.listeners.clear();
  }
}
```

### 3.6 交互流程

```
用户点击 "+ Claude" 时（Sidebar）：
  ┌─ 无额外 UI 面板，直接创建 ──────────────────────┐
  │                                                  │
  │  1. WorktreeManager.createForAgent(              │
  │       sessionId, 'claude', projectPath, 'main'   │
  │     )                                            │
  │  2. DaemonClient.spawn({                         │
  │       agent: 'claude',                           │
  │       cwd: worktreePath,     ← worktree 路径     │
  │       worktree: { branch, baseBranch }           │
  │     })                                           │
  │  3. WorktreeWatcher.add(worktreeInfo)             │
  │                                                  │
  │  Agent 退出时：                                   │
  │  4. WorktreeManager.cleanup(sessionId, {         │
  │       keepBranch: false,  ← 来自 agents.json     │
  │       force: false                               │
  │     })                                           │
  │  5. WorktreeWatcher.remove(worktreeId)            │
  └──────────────────────────────────────────────────┘
```

**Worktree 配置（agents.json）**:

```json
{
  "id": "claude",
  "worktree": {
    "enabled": true,
    "baseBranch": "main",
    "cleanup": "keep"
  }
}
```

- `cleanup: "keep"` — Agent 退出后保留 worktree + 分支（推荐）
- `cleanup: "ask"` — Agent 退出时弹窗询问

> **不再实现自动 merge。** 调研结论：自动 merge 在生产中引发的问题多于解决的问题（冲突时阻塞、意外覆盖、回滚困难）。用户应通过正常 git 工作流手动合并。

### 3.7 清理策略

| 策略 | Agent 退出时行为 |
|------|-----------------|
| **keep** (推荐) | 保留 worktree + 分支，用户可随时切回继续工作 |
| **ask** | Sidebar 弹窗让用户选择 keep 还是 discard |

`force: true`（通过 `CleanupOptions`）跳过 dirty check，直接 `git worktree remove --force --force` + `git branch -D`。

### 3.8 冲突检测

通过 `WorktreeManager.detectConflicts()` 手动触发：

```
触发时机:
  1. 用户打开 AgentDashboard（Ctrl+D）
  2. WorktreeWatcher 检测到 .git/ 变化 → debounce 300ms → 自动重扫
  3. 新 worktree 创建后

检测方法:
  git diff --name-only <baseBranch> → 每个 worktree 改动文件集合
  → 文件出现在 ≥2 个 worktree → 标记为冲突
  → Sidebar Conflicts 区域标红显示
```

### 3.9 Sidebar 显示

```
┌─ Sessions ──────────────────────────┐
│ ● Claude Code                       │
│   🌿 conductor/claude/m1a2b3c4      │
│   📁 ~/.conductor/worktrees/a1b2/   │
│                                      │
│ ● OpenCode                          │
│   🌿 conductor/opencode/m5d6e7f8    │
│   📁 ~/.conductor/worktrees/a1b2/   │
│                                      │
│ ● cmd.exe                           │
│   📁 E:\workspace\my-project\       │
│   (no worktree)                      │
│                                      │
│ ⚠ Conflicts (1)                     │
│   src/auth.ts: claude, opencode     │
└─────────────────────────────────────┘
```

### 3.10 SQLite 持久化

```sql
-- migration: 新增 worktrees 表
CREATE TABLE IF NOT EXISTS worktrees (
  id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL,
  agent_id TEXT NOT NULL,
  worktree_path TEXT NOT NULL,
  branch TEXT NOT NULL,
  base_branch TEXT NOT NULL DEFAULT 'main',
  project_path TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  status TEXT NOT NULL DEFAULT 'ready',
  FOREIGN KEY (session_id) REFERENCES sessions(id) ON DELETE CASCADE
);
```

### 3.11 与现有功能的关系

- **cmd.exe** — 不使用 worktree（`worktree.enabled: false`），直接在项目目录运行
- **会话恢复** — worktree 路径 + branch 持久化到 SQLite，重启后恢复到同一 worktree
- **广播模式** — 不影响，广播发送到所有终端 stdin，worktree 不改 stdin/stdout
- **Phase 2 NotifyCenter** — 可扩展通知面板支持 worktree 冲突预警卡片

### 3.12 实现注意事项

1. **WorktreeManager 在主进程运行。** 不经过 daemon——daemon 只负责 PTY 的 spawn/write/resize/kill，worktree 管理是主进程职责。

2. **Windows 兼容性。** `git worktree` 和 `git worktree list --porcelain` 在 Windows 上行为一致。`fs.watch` 在 Windows 上对 `.git/` 目录使用 ReadDirectoryChangesW，比 macOS FSEvents 更可靠。

3. **并发安全。** 同一 project 的 worktree 创建必须串行——使用 per-project Promise 链避免竞态。

4. **清理验证。** 永远不信任 `git worktree remove` 的 exit code——必须用 `git worktree list --porcelain` 解析确认 worktree 真的从注册中消除了。

5. **路径规范化。** Windows 路径不区分大小写但 git 存储规范化路径。对比前统一 `path.resolve()`。

---

## Section 4: Agent 通知系统 + 运维监控

### 通知系统（cmux 式蓝色环 + 通知面板）

#### 通知触发机制

```typescript
// 三层通知来源
type AgentNotification = 
  // 1. PTY 输出解析（现有 status 检测增强）
  | { type: 'attention-needed'; agent: string; reason: string }
  // 2. OSC 转义序列（cmux 方案）
  | { type: 'osc-notify'; agent: string; message: string }
  // 3. Agent Protocol（未来扩展）
  | { type: 'agent-protocol'; agent: string; payload: any }

// 输出解析规则
const ATTENTION_PATTERNS = [
  /needs?\s+input/i,
  /permission/i,
  /approval/i,
  /confirm/i,
  /y\/n/i,
  /press any key/i,
  /waiting for/i,
  /error|failed|exception/i,
];
```

#### 视觉反馈

```
正常状态:                    需要注意:
┌──────────────────┐        ┌──────────────────┐
│ Claude Code      │        │ ● Claude Code    │
│ ● running        │        │ 🔵 蓝色光环       │
│                  │        │ ⚠ 需要确认        │
└──────────────────┘        └──────────────────┘
                            标签高亮 + 面板计数

通知面板（右侧滑出或底部）:
┌─ Notifications (3) ─────────────────────┐
│ 🔴 Claude Code · 2m ago                  │
│   "Error: TypeScript compilation failed" │
│   [Jump to →]                            │
│                                           │
│ 🟡 OpenCode · 5m ago                     │
│   "Requires approval to continue"         │
│   [Jump to →]                            │
│                                           │
│ 🟢 Codex · 12m ago                       │
│   "Task completed successfully"           │
│   [Dismiss]                              │
└───────────────────────────────────────────┘
```

#### 实现

```typescript
// notify-center.ts (Electron 主进程)
class NotifyCenter {
  private notifications: Notification[] = [];
  
  // PTY 输出 → 解析 → 通知
  handleDaemonOutput(msg: DaemonMessage) {
    if (msg.type !== 'output') return;
    
    const attention = this.parseAttention(msg.data);
    if (attention) {
      this.add({
        agent: this.getAgent(msg.sessionId),
        level: attention.level,
        message: attention.message,
        timestamp: Date.now(),
        sessionId: msg.sessionId,
      });
      // 推送到渲染进程
      this.broadcast('notification', notification);
      // Windows 原生通知（可选）
      if (this.isInBackground()) {
        new Notification({ title, body }).show();
      }
    }
  }
}
```

### Agent 运维监控仪表盘

#### 数据模型

```typescript
interface AgentStats {
  agentId: string;
  agentType: string;          // claude | opencode | codex | cmd
  
  // Token 统计
  tokenCount: number;
  tokenRate: number;          // tokens/min
  
  // 成本估算
  estimatedCost: number;      // USD
  costModel: string;          // 基于已知 API 定价
  
  // 健康评分 (0-100)
  health: {
    score: number;
    responseLatency: number;  // ms
    errorRate: number;        // 0-1
    uptime: number;           // seconds
    lastActivity: number;     // timestamp
  };
  
  // 会话信息
  sessionId: string;
  branch: string;
  cwd: string;
  worktreePath?: string;
  startTime: number;
}
```

#### 健康评分算法

```typescript
function calculateHealth(stats: AgentStats): number {
  let score = 100;
  
  // 响应延迟扣分
  if (stats.health.responseLatency > 10000) score -= 20;
  else if (stats.health.responseLatency > 5000) score -= 10;
  
  // 错误率扣分
  score -= stats.health.errorRate * 30;
  
  // 无活动超时扣分
  const idleSeconds = (Date.now() - stats.health.lastActivity) / 1000;
  if (idleSeconds > 300) score -= 15;    // 5分钟无活动
  if (idleSeconds > 600) score -= 20;    // 10分钟
  
  return Math.max(0, Math.min(100, score));
}
```

#### 仪表盘 UI

```
┌─ Agent Dashboard ─────────────────────────────────────┐
│                                                        │
│  Agent    Status    Health   Tokens    Cost    Uptime  │
│  ──────   ──────    ──────   ──────   ─────   ──────  │
│  Claude   ■ think   ●●●●○   45.2k    $0.34   23m      │
│  Open     ■ wait    ●●●●●   12.1k    $0.09   18m      │
│  Codex    ■ run     ●●●○○   28.7k    $0.21   31m      │
│  cmd      ■ run     ●●●●●   —        —       45m      │
│                                                        │
│  ────────────────────────────────────────────────────  │
│  Total: 4 agents | 86.0k tokens | $0.64 | 1h 57m      │
│                                                        │
│  Token Trend:  ▁▂▃▅▆▇█▇▆▅ (last 30min)               │
└────────────────────────────────────────────────────────┘
```

#### 崩溃自动恢复

```typescript
// daemon 内置 watchdog
class AgentWatchdog {
  private healthCheckInterval = 30_000; // 30秒检查一次
  
  async check() {
    for (const [id, session] of this.sessions) {
      const health = calculateHealth(session.stats);
      
      if (health < 20 && session.agent !== 'cmd') {
        // Agent 可能卡死
        this.emit('agent-unhealthy', { sessionId: id, health, agent: session.agent });
        // 可选：自动 kill + 重启
        if (session.config.autoRestart) {
          await this.restart(session);
        }
      }
    }
  }
}
```

### 数据持久化

```sql
-- SQLite 新增表
CREATE TABLE agent_stats (
  session_id TEXT PRIMARY KEY,
  agent TEXT NOT NULL,
  token_count INTEGER DEFAULT 0,
  estimated_cost REAL DEFAULT 0,
  health_score INTEGER DEFAULT 100,
  started_at TEXT NOT NULL,
  last_activity TEXT NOT NULL
);

CREATE TABLE notifications (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id TEXT NOT NULL,
  agent TEXT NOT NULL,
  level TEXT NOT NULL,  -- 'info' | 'warning' | 'error'
  message TEXT NOT NULL,
  created_at TEXT NOT NULL,
  dismissed INTEGER DEFAULT 0
);
```

---

## Section 5: 技术栈 + 迁移策略 + 分期交付

### 完整技术栈

```
Conductor V2 Technology Stack
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
桌面框架:  Electron 40.x + electron-vite 4.x
PTY管理:   node-pty 1.1.0
终端渲染:  @xterm/xterm 6.x + WebGL + Canvas + Search + Clipboard + Fit
数据库:    better-sqlite3 12.x
Git操作:    simple-git 3.x
状态管理:   zustand 5.x
构建打包:   electron-builder 26.x
运行时:    Node ≥ 20 (Electron 内置)
语言:      TypeScript 5.x
布局:      CSS Grid (现有) + react-resizable-panels (Phase 2)
样式:      Tailwind CSS 4.x + CSS 自定义属性
```

### 从 Tauri 迁移的代码映射

```
Rust (删除)                    → Node.js (重写)
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
session.rs (198行)             → pty-manager.ts (~100行)
  portable-pty spawn            node-pty spawn
  template 注入                  template 注入
  setup commands                 setup commands
  reader thread                  onData callback

manager.rs (170行)             → server.ts (~80行)
  Mutex<HashMap>                 Map
  alloc_id                       counter
  snapshot thread                async function
  kill_all                       cleanup

agents.rs (185行)              → agents/config.ts (~60行)
  AgentConfig struct             interface
  template substitution          string.replace
  default_agents                  defaults

store.rs (41行)                → database.ts (~50行)
  rusqlite                       better-sqlite3
  save/load layout               save/load layout

app_commands.rs (32行)         → ipc-handlers.ts (~40行)
  #[tauri::command]              ipcMain.handle

总计: ~626行 Rust               → ~330行 TypeScript (减半)
```

```
前端 (保留)
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
App.tsx           → 改 IPC 调用（invoke → ipcRenderer）
TerminalPanel.tsx → 不变
Sidebar.tsx       → 增加 Worktree/通知/仪表盘
usePty.ts         → 改 IPC 层
tauri-ipc.ts      → pty-ipc.ts
terminal-theme.ts → 不变
sessions.ts       → 不变
```

### 分期交付

```
Phase 1 — Electron 迁移 (2-3周)
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
  ✅ Electron 窗口 + 边框 + 快捷键
  ✅ PTY Daemon (spawn/write/resize/kill)
  ✅ Session Recovery (claude/opencode/codex)
  ✅ agents.json 配置
  ✅ SQLite 持久化
  ✅ Git 分支检测
  ✅ 广播模式
  ✅ Terminal 搜索/清屏
  ✅ Setup 脚本
  🎯 目标：功能完全等同现有 Tauri 版

Phase 2 — 差异化能力 (2周)
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
  ✅ Agent 通知系统（蓝色环 + 通知面板）
  ✅ Agent 健康评分
  ✅ Token/Cost 实时统计
  ✅ 仪表盘 UI
  ✅ 崩溃自动恢复
  ✅ react-resizable-panels 布局（替代纯 CSS Grid）
  🎯 目标：超越现有所有竞品

Phase 3 — Worktree 隔离 (2周)
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
  ✅ Git worktree 自动创建（prune→resolve→add→rollback）
  ✅ 多阶段清理 + worktree list --porcelain 验证
  ✅ 事件驱动 WorktreeWatcher（fs.watch .git/ + 300ms debounce）
  ✅ Git ref 类型安全解析（discriminated union, local 永远优先）
  ✅ 冲突检测（git diff --name-only 交集法）
  ✅ Sidebar worktree 状态 + 冲突预警显示
  ✅ agents.json 清理策略：keep | ask（不自动 merge）
  🎯 目标：多 Agent 并行开发零冲突，worktree 放在 ~/.conductor/ 项目外部

Phase 4 — Agent 编排 (后续)
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
  ○ 任务队列 + 智能路由
  ○ 上下文共享
  ○ 内嵌浏览器
  ○ Agent Protocol 定义
```

### 技术风险和缓解

| 风险 | 影响 | 缓解措施 |
|------|------|---------|
| node-pty Windows 稳定性 | 高 | Superset 已验证，VS Code 生产使用 |
| Named Pipe 性能 | 中 | 4字节前缀帧协议，零拷贝设计 |
| Electron 包体积大 | 低 | ~150MB 对开发者工具可接受 |
| Daemon 进程管理 | 中 | supervisor 模式 + 自动重启 |
| xterm.js WebGL 在 Electron 中 | 低 | 已在 Tauri 中验证 |

---

## 竞品参考

### cmux (macOS)
- **亮点:** AI Agent 专属设计、蓝色环通知系统、内嵌浏览器、脚本化 API
- **借鉴:** 通知系统视觉反馈、Agent 状态感知

### Ghostty (Zig)
- **亮点:** GPU 渲染（Metal/OpenGL）、多线程 I/O、可嵌入库设计
- **借鉴:** 架构分层思想（PTY 引擎与 UI 分离）

### Superset (Electron)
- **亮点:** PTY Daemon 架构、版本化协议、fd-handoff 热升级
- **借鉴:** Daemon 模式、协议设计、测试策略

---

## 附录：文件清单

### 新增文件
```
src/main/
  ├── daemon-client.ts
  ├── ipc-handlers.ts
  ├── notify-center.ts
  ├── stats-collector.ts
  ├── worktree-manager.ts
  └── window-manager.ts

src/renderer/components/
  ├── NotifyPanel.tsx
  ├── AgentDashboard.tsx
  └── WorktreeStatus.tsx

src/renderer/lib/
  └── pty-ipc.ts (替代 tauri-ipc.ts)

src/daemon/
  ├── main.ts
  ├── server.ts
  ├── pty-manager.ts
  ├── session-store.ts
  ├── session-recovery.ts
  ├── handlers.ts
  └── protocol/
      ├── messages.ts
      ├── framing.ts
      └── version.ts
```

### 删除文件
```
web/src-tauri/  (整个目录)
  ├── src/
  │   ├── config/agents.rs
  │   ├── commands/pty_commands.rs
  │   ├── commands/app_commands.rs
  │   ├── db/store.rs
  │   ├── pty/session.rs
  │   ├── pty/manager.rs
  │   └── lib.rs
  ├── Cargo.toml
  └── Cargo.lock
```

### 修改文件
```
web/src/App.tsx           → 改 IPC 调用
web/src/hooks/usePty.ts   → 改 IPC 层
web/src/lib/tauri-ipc.ts  → 重命名为 pty-ipc.ts
web/src/components/Sidebar.tsx → 增加 Worktree/通知/仪表盘入口
package.json              → Electron + 依赖
electron.vite.config.ts   → 新增
electron-builder.ts       → 新增
```

---

**文档完成时间:** 2026-06-11  
**下一步:** 创建实施计划 (writing-plans skill)
