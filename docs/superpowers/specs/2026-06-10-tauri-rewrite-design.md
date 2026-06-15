# Conductor-CLI Tauri Rewrite Design

**Date:** 2026-06-10
**Status:** Approved
**Scope:** Phase 1 — Tauri shell + PTY foundation + dockview terminal layout

---

## 1. Problem Statement

Conductor-CLI 当前存在根本性架构问题导致体验不佳：

1. **blessed TUI 无法渲染颜色** — `AgentPane.ts` 的 ScreenBuffer 丢弃所有 SGR 序列，Agent 输出只有黑白
2. **两套 PTY 系统互不相通** — CLI 用 `WindowManager`，Web 用 `ptyShell.ts`，状态完全隔离
3. **无状态 CLI** — 每次 `conductor spawn` 创建新 `WindowManager`，进程退出后状态丢失
4. **PTY 尺寸硬编码 120x30** — 不随 pane 实际大小调整
5. **无拖拽分割** — blessed 是文本网格，不可能实现流畅的拖拽 resize
6. **SQLite 引入但未使用** — 数据全在内存，重启丢失

目标：用 Tauri 2.x + xterm.js + Rust PTY 替代 blessed + Node.js 架构，实现流畅原生的多窗口终端体验。

---

## 2. Architecture

### 2.1 Overall Stack

```
Tauri 2.x (Rust backend)
├── portable-pty 0.9          — ConPTY on Windows (replaces node-pty + Node.js)
├── tokio                      — async runtime
├── rusqlite                   — SQLite for persistence (replaces unused better-sqlite3)
├── git2                       — git branch/status in sidebar
├── serde + serde_json         — serialization
└── tauri-plugin-shell         — agent command detection
    │
    │  Tauri Events (high-freq output) + invoke (control commands)
    │
Single WebView2 Window
├── React 19 + TypeScript
├── dockview                   — split panes + tabs + drag-to-rearrange (~45KB, zero deps)
├── xterm.js 6 + addon-canvas  — GPU-accelerated terminal rendering
├── @xterm/addon-fit           — auto dimension calculation
├── @xterm/addon-webgl         — fallback for heavy output (Phase 2)
└── Zustand                    — state management
```

### 2.2 Why This Stack

| Decision | Rationale |
|---|---|
| **Rust PTY instead of Node.js** | Eliminates the two-system split. One PTY manager, one state. portable-pty is WezTerm's PTY backend, battle-tested on Windows. |
| **dockview over react-mosaic** | Zero dependencies, more active (June 2026 commits), built-in tabs + serialization. react-mosaic v7 is still beta. |
| **Canvas renderer first, WebGL later** | Canvas is 3-5x faster than DOM and more stable than WebGL. Switch to WebGL in Phase 2 if needed. |
| **Single WebView2, not multi-webview** | Tauri 2's `add_child()` is behind `unstable` flag with known resize bugs. CSS-based split in one webview is what all production Tauri terminals do. |
| **Events for output, invoke for control** | PTY output is high-frequency (8-24ms batches). Tauri Events avoid invoke serialization overhead for streaming data. |

### 2.3 PTY Data Flow

```
Agent Process (Claude Code / OpenCode / Codex)
    │
    ▼ stdout/stderr
ConPTY (Windows) / Unix PTY
    │
    ▼ blocking read in dedicated thread
PTY Manager (Rust)
    │  • Adaptive batching: 8ms normal, 24ms under load
    │  • Buffer cap: 64KB per session
    │  • OSC sequence detection for notifications
    │
    ▼ tauri::AppHandle.emit("pty-output-{session_id}", payload)
WebView2 Frontend
    │
    ▼ dockview panel receives event
xterm.js Terminal
    │  term.write(data)
    ▼
GPU Canvas Rendering

Reverse path (user input):
xterm.js term.onData → invoke("pty_write", {session_id, data}) → PTY master.write(data)

Resize path:
xterm.js ResizeObserver → term.fit() → invoke("pty_resize", {session_id, cols, rows}) → master.resize(PtySize)
```

---

## 3. Project Structure

```
conductor-cli/
├── src-tauri/                        # Rust backend (NEW)
│   ├── Cargo.toml
│   ├── tauri.conf.json
│   ├── capabilities/
│   │   └── default.json              # Tauri 2 ACL permissions
│   ├── src/
│   │   ├── main.rs                   # Tauri entry point
│   │   ├── pty/
│   │   │   ├── mod.rs
│   │   │   ├── manager.rs            # PTY session lifecycle (spawn/kill/resize)
│   │   │   ├── session.rs            # Single PTY session (read thread, output batching)
│   │   │   └── shell_detect.rs       # Detect installed shells/agents on PATH
│   │   ├── commands/
│   │   │   ├── mod.rs
│   │   │   ├── pty_commands.rs       # invoke targets: spawn, write, resize, kill, list
│   │   │   └── app_commands.rs       # invoke targets: get_agents, get_git_status, etc.
│   │   ├── db/
│   │   │   ├── mod.rs
│   │   │   └── store.rs              # SQLite: sessions, layout, config
│   │   ├── notification/
│   │   │   ├── mod.rs
│   │   │   └── osc_parser.rs         # Parse OSC 9/99/777 from PTY output
│   │   └── lib.rs
│   └── icons/
│
├── src/                              # Frontend (REPLACE web/src/)
│   ├── main.tsx                      # React entry, mount to #root in Tauri webview
│   ├── App.tsx                       # Root: dockview layout + sidebar
│   ├── components/
│   │   ├── TerminalPanel.tsx         # xterm.js wrapper for dockview panel
│   │   ├── Sidebar.tsx               # Agent list, rich metadata, notifications
│   │   ├── StatusBar.tsx             # Bottom bar: running count, token usage
│   │   └── AgentPicker.tsx           # "Add agent" dialog
│   ├── hooks/
│   │   ├── usePty.ts                 # PTY session management hook
│   │   ├── useNotifications.ts       # Notification state
│   │   └── useGitStatus.ts           # Per-pane git info
│   ├── store/
│   │   ├── sessions.ts               # Zustand: PTY sessions
│   │   ├── layout.ts                 # Zustand: dockview layout state
│   │   └── notifications.ts          # Zustand: unread notifications
│   ├── lib/
│   │   ├── tauri-ipc.ts              # Typed wrappers for invoke/event
│   │   └── terminal-theme.ts         # xterm.js theme config
│   └── styles/
│       └── tokens.css                # Design tokens (reuse existing)
│
├── src-webui/                        # Standalone web server (LEGACY, keep for browser access)
│   └── ...                           # Existing server.ts, wsTerminal.ts, etc.
│
└── package.json
```

### 3.1 What Gets Deleted

These files become dead code after Phase 1:

- `src/tui/` — entire directory (blessed TUI)
- `src/cli/commands/start.ts` — blessed screen builder
- `src/webui/ptyShell.ts` — replaced by Rust PTY
- `src/webui/wsTerminal.ts` — replaced by Tauri events
- `src/webui/sessionStore.ts` — replaced by SQLite + Zustand
- `src/core/conpty/` — replaced by portable-pty

### 3.2 What Gets Kept

- `src/core/EventBus.ts` — still useful for internal Rust-side eventing via Tauri
- `src/core/TaskScheduler.ts` — agent coordination logic (Phase 3)
- `src/config/` — YAML config loading logic (will migrate to Rust later)
- `src/db/` — schema patterns (rewrite in rusqlite)
- `web/src/styles/tokens.css` — design tokens carry over

---

## 4. Core Components

### 4.1 PTY Manager (Rust)

```rust
// src-tauri/src/pty/manager.rs

pub struct PtyManager {
    sessions: HashMap<String, PtySession>,
    next_id: AtomicU32,
}

pub struct PtySession {
    id: String,                    // "S1", "S2", ...
    agent: String,                 // "claude", "opencode", "codex"
    cwd: PathBuf,
    master: Box<dyn MasterPty + Send>,
    pid: u32,
    status: SessionStatus,         // Running, Exited, WaitingReconnect
    created_at: DateTime<Utc>,
    tokens_used: AtomicU32,
}

pub enum SessionStatus {
    Running,
    Exited { code: i32 },
    WaitingReconnect { since: DateTime<Utc> },
}
```

Key behaviors:
- `spawn()` — Creates ConPTY, starts read thread, emits `pty-output-{id}` events
- `write()` — Forwards input bytes to PTY master
- `resize()` — Calls `master.resize(PtySize)`
- `kill()` — Kills process, cleans up read thread
- Read thread does adaptive batching: collects output for 8ms (or 24ms under load), then emits as single event
- OSC parser in read thread extracts OSC 9/99/777 sequences, emits `notification` events

### 4.2 Tauri Commands (Rust to JS)

```rust
#[tauri::command]
async fn pty_spawn(agent: String, cwd: Option<String>, cols: u16, rows: u16) -> Result<SessionInfo, String>

#[tauri::command]
async fn pty_write(session_id: String, data: String) -> Result<(), String>

#[tauri::command]
async fn pty_resize(session_id: String, cols: u16, rows: u16) -> Result<(), String>

#[tauri::command]
async fn pty_kill(session_id: String) -> Result<(), String>

#[tauri::command]
async fn pty_list() -> Result<Vec<SessionInfo>, String>

#[tauri::command]
async fn detect_agents() -> Result<Vec<AgentInfo>, String>

#[tauri::command]
async fn get_git_status(path: String) -> Result<GitInfo, String>
```

### 4.3 Frontend Terminal Panel (React)

Each dockview panel renders one xterm.js instance. Lifecycle:
- mount: `invoke("pty_spawn")` -> listen `pty-output-{id}` -> `term.write()`
- resize: `term.fit()` -> `invoke("pty_resize")`
- input: `term.onData()` -> `invoke("pty_write")`
- unmount: `invoke("pty_kill")`

### 4.4 Layout with dockview

dockview provides:
- Split panes (horizontal + vertical, any nesting depth)
- Tab groups (multiple terminals in one pane area)
- Drag-to-rearrange (panels and groups)
- Floating panels
- Serialization: `api.toJSON()` / `api.fromJSON()` for layout persistence

Sidebar (fixed left, 240px):
- Agent status cards (running/idle/needs-input)
- Git branch per session
- Unread notification badges
- Quick add buttons (detected agents only)

---

## 5. Session Persistence

### 5.1 What Gets Saved (on app quit)

```json
{
  "layout": {},
  "sessions": [
    {
      "id": "S1",
      "agent": "claude",
      "cwd": "E:\\workspace\\conductor-cli",
      "agentSessionId": "abc-123-def",
      "status": "running"
    }
  ],
  "windowBounds": { "x": 100, "y": 100, "width": 1400, "height": 900 }
}
```

### 5.2 Restore Flow

1. App start, load `sessions.json` from SQLite
2. For each saved session, spawn new PTY with same cwd and agent
3. If agent supports resume (Claude: `--resume <id>`), pass resume flag
4. Restore dockview layout from serialized JSON
5. Wire new PTY sessions to restored panels

---

## 6. Notification System (Phase 1 Foundation)

Phase 1 implements detection only. Full UX is Phase 2.

### 6.1 OSC Detection (Rust)

In PTY read thread, scan output for:
- `ESC ] 9 ; <text> BEL` (OSC 9, general notification)
- `ESC ] 99 ; <json> BEL` (OSC 99, detailed notification)
- `ESC ] 777 ; notify ; <json> BEL` (OSC 777, iTerm2 format)

When detected, emit `notification` Tauri event:
```json
{
  "session_id": "S1",
  "type": "osc9",
  "title": "Agent needs input",
  "body": "Claude Code is waiting for permission",
  "timestamp": "2026-06-10T12:00:00Z"
}
```

### 6.2 Frontend (Phase 1)

- Session with unread notification gets highlighted border (`#5E6AD2`)
- Sidebar shows unread count badge
- No notification panel yet (Phase 2)

---

## 7. Agent Detection

### 7.1 Startup Scan (Rust)

Scan PATH for `claude`, `opencode`, `codex`. Return list with installed status and path.

### 7.2 Frontend

- Only show "Add" buttons for detected agents
- Show install hint for missing agents

---

## 8. Window Configuration

Tauri window: 1400x900, min 800x500, centered, native decorations.

Keyboard shortcuts:

| Shortcut | Action |
|---|---|
| `Ctrl+Shift+T` | New terminal tab |
| `Ctrl+Shift+D` | Split pane right |
| `Ctrl+Shift+E` | Split pane down |
| `Ctrl+W` | Close current pane |
| `Ctrl+1-9` | Focus pane by index |
| `Alt+Arrow` | Focus adjacent pane |
| `Ctrl+Shift+U` | Jump to unread |
| `F11` | Toggle fullscreen |

---

## 9. Migration Strategy

### 9.1 Dual Mode During Transition

- `conductor` launches Tauri app (new)
- `conductor web` launches Express server (old, kept for browser-only access)

### 9.2 Incremental Migration

1. Phase 1: Tauri app handles PTY + rendering. No Express server needed.
2. Phase 2: Migrate TaskScheduler/EventBus/coordination to Rust.
3. Phase 3: Express server becomes optional API-only mode for remote access.

---

## 10. Success Criteria

Phase 1 is complete when:

1. [ ] `conductor` launches a native window with dockview layout
2. [ ] Can spawn Claude Code / OpenCode / Codex with **full color**
3. [ ] Can **drag to resize** split panes smoothly
4. [ ] Can **drag to rearrange** tabs between pane groups
5. [ ] Sessions survive app restart (layout + working directories)
6. [ ] Only shows "Add" buttons for agents actually installed
7. [ ] Sidebar shows git branch for each session's working directory
8. [ ] PTY output is smooth at 60fps with Canvas renderer
9. [ ] App binary is under 30MB
10. [ ] Memory usage under 200MB with 4 active terminals

---

## 11. Out of Scope (Phase 2/3)

- Notification panel + notification hooks (Phase 2)
- Agent hibernation (Phase 2)
- JSON-RPC external API (Phase 3)
- Embedded browser pane (Phase 3)
- Feed approval system (Phase 3)
- SSH workspaces (Phase 3)
- Task scheduler / agent coordination (Phase 3)
