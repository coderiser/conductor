# Conductor

Windows Agent Workbench — 基于 Tauri 的多 Agent 终端工作台。

![Screenshot](docs/images/screenshot.jpg)

## 快速开始

### 环境要求

- Windows 10/11
- [Rust](https://rustup.rs/)（MSVC 工具链）
- [Node.js](https://nodejs.org/) 18+

### 安装与运行

```bash
git clone <repo-url>
cd conductor-cli
cd web && npm install
cd ..
conductor start       # 首次需等待 Rust 编译（约 3-5 分钟）
```

启动后打开原生 Windows 窗口，默认加载 `cmd.exe` 终端面板。

> 将项目目录加入 `PATH` 后可在任意位置使用 `conductor` 命令。

### 基本操作

| 操作 | 方式 |
|------|------|
| 新建终端 | 侧边栏 `+ New Terminal` 或 `Ctrl+N` |
| 指定工作目录 | 侧边栏 `working dir` 输入框填入路径后新建 |
| 关闭终端 | 侧边栏 `kill current` 或 `Ctrl+W` |
| 切换面板 | `F1`-`F9` |
| 广播输入 | 勾选 `broadcast`，输入命令后点 `▶` |
| 复制文字 | 鼠标拖选 + `Ctrl+Shift+C` 或右键 |
| 退出 | `F10` |

---

## CLI 命令

| 命令 | 别名 | 说明 |
|------|------|------|
| `conductor` | | 启动桌面应用（默认） |
| `conductor start` | `s` | 启动桌面应用 |
| `conductor dev` | `d` | 开发模式 |
| `conductor web` | `w` | 启动 Web 服务（端口 56560） |
| `conductor build` | `b` | 构建生产版本 .exe |
| `conductor build web` | | 仅构建前端 |
| `conductor restart` | `r` | 杀掉并重启 |
| `conductor kill` | `k` | 终止所有进程 |
| `conductor status` | `st`, `ps` | 查看运行状态 |
| `conductor clean` | | 清除构建产物 |
| `conductor version` | `-v` | 显示版本号 |
| `conductor help` | `-h` | 显示帮助 |

---

## 架构

```
Tauri 2.x (Rust)                     WebView2 (React)
┌───────────────────────┐    ┌──────────────────────────┐
│ portable-pty (ConPTY) │───▶│ xterm.js Canvas GPU      │
│ tokio 异步运行时       │    │ CSS Grid 动态格网布局    │
│ rusqlite 持久化       │    │ 五分区可折叠侧边栏        │
│ git2 分支检测          │    │ Zustand 状态管理          │
│ config::agents 配置    │    │ @xterm/addon-clipboard   │
└───────────────────────┘    └──────────────────────────┘
```

---

## Agent 配置

`agents.json` 位于项目根目录（与 `conductor.cmd` 同级），首次启动自动生成默认配置。

```json
{
  "agents": [
    { "id": "cmd", "name": "Command Prompt", "command": "cmd.exe", "args": [], "builtin": true },
    { "id": "claude", "name": "Claude Code", "command": "claude", "args": [], "builtin": false },
    { "id": "opencode", "name": "OpenCode", "command": "opencode", "args": [], "builtin": false },
    { "id": "codex", "name": "Codex", "command": "codex", "args": [], "builtin": false }
  ]
}
```

添加自定义 Agent：

```json
{
  "id": "my-agent",
  "name": "My Company Agent",
  "command": "D:\\tools\\agent.exe",
  "args": ["--interactive", "--workspace"],
  "builtin": false
}
```

| 字段 | 说明 |
|------|------|
| `id` | 唯一标识，对应 spawn 命令 |
| `name` | 侧边栏显示名称 |
| `command` | 可执行文件路径或命令名 |
| `args` | 启动参数（可选） |
| `builtin` | `true` = 始终显示；`false` = PATH 检测到才显示 |

---

## 功能

- **原生窗口** — Tauri 2.x + WebView2，非 Electron
- **可配置 Agent** — `agents.json` 配置任意 Agent 类型和启动命令
- **多 Agent PTY** — 同时运行 Claude Code / OpenCode / Codex / cmd.exe 及自定义 Agent
- **动态格网布局** — 1=全屏, 2=双列, 3=2+1跨行, 4=2×2, 5=2×2+跨行, 6+=3列
- **工作目录** — 新建终端时指定起始目录
- **广播模式** — 同时向所有终端发送输入
- **文本选择** — 鼠标拖选 + Ctrl+Shift+C 复制
- **进程清理** — 窗口关闭时自动终止所有子 PTY 进程
- **全彩色** — xterm.js Canvas 渲染，256 色

---

## 侧边栏

| 分区 | 内容 |
|------|------|
| Stats | Tasks / Tokens / Running / Failed / Duration |
| Commands | + New Terminal + working dir 输入 + 动态 Agent 快捷命令 |
| Sessions | 会话卡片：状态圆点、Agent、运行时长、工作目录、Git 分支 |
| Input | Broadcast 开关 + 命令输入框 + 发送按钮 |
| Log | 时间戳事件流（启动/退出/终止） |

---

## 技术栈

| 层 | 技术 |
|----|------|
| 桌面壳 | Tauri 2.11, Rust, portable-pty 0.9 |
| 前端 | React 19, xterm.js 6, Zustand, dockview |
| 布局 | CSS Grid（动态格网算法） |
| 存储 | SQLite (rusqlite) |
| Git | git2 crate |
| 配置 | JSON（agents.json，项目根目录） |
| 样式 | CSS 自定义属性 + WebKit 滚动条 |

---

## 快捷键

| 按键 | 功能 |
|------|------|
| `F1`-`F9` | 切换到第 N 个面板 |
| `Ctrl+N` | 新建终端 |
| `Ctrl+W` | 关闭当前面板 |
| `Ctrl+Shift+C` | 复制选中文字 |
| `F10` | 退出 |
