# Conductor-CLI Tauri Rewrite — Phase 1 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace blessed TUI + Node.js with Tauri 2.x native window + dockview + xterm.js, delivering smooth drag-to-resize multi-pane terminals with full color.

**Architecture:** Tauri 2.x Rust backend manages PTY via portable-pty (ConPTY). Single WebView2 window renders React + dockview + xterm.js Canvas. IPC via Tauri events (output) and invoke (control).

**Tech Stack:** Tauri 2.11+, Rust, portable-pty 0.9, tokio, rusqlite, git2, React 19, dockview, xterm.js 6 + addon-canvas, Zustand, Vite 5

**Spec:** `docs/superpowers/specs/2026-06-10-tauri-rewrite-design.md`

---

## File Map

### New Files (Rust)

| File | Purpose |
|---|---|
| `src-tauri/Cargo.toml` | Dependencies |
| `src-tauri/tauri.conf.json` | App/window config |
| `src-tauri/capabilities/default.json` | ACL permissions |
| `src-tauri/build.rs` | Build script |
| `src-tauri/src/main.rs` | Entry point |
| `src-tauri/src/lib.rs` | App builder |
| `src-tauri/src/pty/mod.rs` | Module root |
| `src-tauri/src/pty/manager.rs` | Session lifecycle |
| `src-tauri/src/pty/session.rs` | Single PTY: read thread, output batching |
| `src-tauri/src/pty/shell_detect.rs` | PATH scanner |
| `src-tauri/src/commands/mod.rs` | Module root |
| `src-tauri/src/commands/pty_commands.rs` | pty_spawn/write/resize/kill/list |
| `src-tauri/src/commands/app_commands.rs` | detect_agents, get_git_status |
| `src-tauri/src/db/mod.rs` | Module root |
| `src-tauri/src/db/store.rs` | SQLite persistence |

### New Files (Frontend)

| File | Purpose |
|---|---|
| `web/src/main.tsx` | React entry |
| `web/src/App.tsx` | Root: dockview + sidebar |
| `web/src/components/TerminalPanel.tsx` | xterm.js per dockview panel |
| `web/src/components/Sidebar.tsx` | Agent cards + metadata |
| `web/src/components/StatusBar.tsx` | Bottom counts bar |
| `web/src/components/AgentPicker.tsx` | Add-agent popup |
| `web/src/hooks/usePty.ts` | PTY session hook |
| `web/src/store/sessions.ts` | Zustand: sessions |
| `web/src/store/notifications.ts` | Zustand: notifications |
| `web/src/lib/tauri-ipc.ts` | Typed invoke/event wrappers |
| `web/src/lib/terminal-theme.ts` | xterm theme config |
| `web/src/styles/tokens.css` | Keep existing |

### Modified Files

| File | Change |
|---|---|
| `web/vite.config.ts` | Tauri settings |
| `web/package.json` | Add tauri/dockview/zustand, remove react-router-dom |
| `web/index.html` | Remove router, add #root |

---

## Task 1: Tauri Project Scaffold

**Goal:** Native Windows window opens with React "Hello Conductor" rendered inside.

- [ ] **Step 1: Install Rust toolchain**

```bash
rustup --version
```
Expected: `rustup 1.27+`, target `stable-x86_64-pc-windows-msvc`.

- [ ] **Step 2: Install frontend packages**

```bash
cd E:\workspace\conductor-cli\web
npm install -D @tauri-apps/cli@latest
npm install @tauri-apps/api@latest dockview zustand @xterm/addon-canvas
npm uninstall react-router-dom
```

- [ ] **Step 3: Create directory structure**

```bash
cd E:\workspace\conductor-cli
mkdir -p src-tauri/src src-tauri/capabilities src-tauri/icons
```

- [ ] **Step 4: Write src-tauri/Cargo.toml**

```toml
[package]
name = "conductor"
version = "0.1.0"
edition = "2021"

[lib]
name = "conductor_lib"
crate-type = ["staticlib", "cdylib", "rlib"]

[build-dependencies]
tauri-build = { version = "2", features = [] }

[dependencies]
tauri = { version = "2", features = [] }
tauri-plugin-shell = "2"
tauri-plugin-opener = "2"
portable-pty = "0.9"
tokio = { version = "1", features = ["full"] }
rusqlite = { version = "0.40", features = ["bundled"] }
git2 = "0.21"
serde = { version = "1", features = ["derive"] }
serde_json = "1"
which = "8"
chrono = { version = "0.4", features = ["serde"] }
log = "0.4"
env_logger = "0.11"
```

- [ ] **Step 5: Write src-tauri/build.rs**

```rust
fn main() {
    tauri_build::build()
}
```

- [ ] **Step 6: Write src-tauri/src/main.rs**

```rust
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    conductor_lib::run()
}
```

- [ ] **Step 7: Write src-tauri/src/lib.rs**

```rust
mod pty;
mod commands;
mod db;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_shell::init())
        .plugin(tauri_plugin_opener::init())
        .invoke_handler(tauri::generate_handler![
            commands::app_commands::detect_agents,
            commands::app_commands::get_git_status,
            commands::pty_commands::pty_spawn,
            commands::pty_commands::pty_write,
            commands::pty_commands::pty_resize,
            commands::pty_commands::pty_kill,
            commands::pty_commands::pty_list,
        ])
        .setup(|app| {
            let pty_manager = pty::manager::PtyManager::new(app.handle().clone());
            app.manage(pty_manager);
            let db = db::store::DbStore::new()?;
            app.manage(db);
            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
```

- [ ] **Step 8: Write stub modules for compilation**

`src-tauri/src/pty/mod.rs`:
```rust
pub mod manager;
pub mod session;
pub mod shell_detect;
```

`src-tauri/src/pty/manager.rs`:
```rust
pub struct PtyManager;
impl PtyManager {
    pub fn new(_app: tauri::AppHandle) -> Self { Self }
}
```

`src-tauri/src/pty/session.rs`:
```rust
// Task 2
```

`src-tauri/src/pty/shell_detect.rs`:
```rust
// Task 4
```

`src-tauri/src/commands/mod.rs`:
```rust
pub mod pty_commands;
pub mod app_commands;
```

`src-tauri/src/commands/pty_commands.rs`:
```rust
#[tauri::command]
pub async fn pty_spawn() -> Result<String, String> { Ok("stub".into()) }
#[tauri::command]
pub async fn pty_write() -> Result<(), String> { Ok(()) }
#[tauri::command]
pub async fn pty_resize() -> Result<(), String> { Ok(()) }
#[tauri::command]
pub async fn pty_kill() -> Result<(), String> { Ok(()) }
#[tauri::command]
pub async fn pty_list() -> Result<Vec<String>, String> { Ok(vec![]) }
```

`src-tauri/src/commands/app_commands.rs`:
```rust
#[tauri::command]
pub async fn detect_agents() -> Result<Vec<String>, String> { Ok(vec![]) }
#[tauri::command]
pub async fn get_git_status(path: String) -> Result<String, String> { Ok("".into()) }
```

`src-tauri/src/db/mod.rs`:
```rust
pub mod store;
```

`src-tauri/src/db/store.rs`:
```rust
use rusqlite::Connection;
use std::sync::Mutex;

pub struct DbStore {
    pub conn: Mutex<Connection>,
}

impl DbStore {
    pub fn new() -> Result<Self, Box<dyn std::error::Error>> {
        let conn = Connection::open_in_memory()?;
        Ok(Self { conn: Mutex::new(conn) })
    }
}
```

- [ ] **Step 9: Write src-tauri/tauri.conf.json**

```json
{
  "productName": "conductor",
  "version": "0.1.0",
  "identifier": "com.conductor.app",
  "build": {
    "beforeDevCommand": "npm --prefix web run dev",
    "beforeBuildCommand": "npm --prefix web run build",
    "devUrl": "http://localhost:3000",
    "frontendDist": "../dist/webui/static"
  },
  "app": {
    "security": { "csp": null },
    "windows": [{
      "title": "Conductor",
      "width": 1400,
      "height": 900,
      "minWidth": 800,
      "minHeight": 500,
      "resizable": true,
      "decorations": true,
      "center": true
    }]
  },
  "bundle": {
    "active": true,
    "targets": "all",
    "icon": ["icons/32x32.png", "icons/128x128.png", "icons/128x128@2x.png", "icons/icon.icns", "icons/icon.ico"]
  }
}
```

- [ ] **Step 10: Write src-tauri/capabilities/default.json**

```json
{
  "$schema": "../gen/schemas/desktop-schema.json",
  "identifier": "default",
  "description": "Main window capabilities",
  "windows": ["main"],
  "permissions": [
    "core:default",
    "shell:default",
    "shell:allow-spawn",
    "shell:allow-execute",
    "shell:allow-kill",
    "shell:allow-stdin-write"
  ]
}
```

- [ ] **Step 11: Update web/vite.config.ts**

```typescript
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

const host = process.env.TAURI_DEV_HOST;

export default defineConfig({
  plugins: [react()],
  clearScreen: false,
  server: {
    port: 3000,
    strictPort: true,
    host: host || false,
    watch: { ignored: ['**/src-tauri/**'] },
  },
  envPrefix: ['VITE_', 'TAURI_ENV_*'],
  build: {
    target: process.env.TAURI_ENV_PLATFORM === 'windows' ? 'chrome105' : 'safari13',
    minify: !process.env.TAURI_ENV_DEBUG ? 'esbuild' : false,
    sourcemap: !!process.env.TAURI_ENV_DEBUG,
    outDir: '../dist/webui/static',
    emptyOutDir: true,
  },
});
```

- [ ] **Step 12: Add tauri scripts to web/package.json scripts**

Add:
```json
"tauri": "tauri",
"tauri:dev": "tauri dev",
"tauri:build": "tauri build"
```

- [ ] **Step 13: Write minimal frontend**

`web/src/main.tsx`:
```tsx
import React from 'react';
import ReactDOM from 'react-dom/client';
import './styles/tokens.css';
import App from './App';

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode><App /></React.StrictMode>
);
```

`web/src/App.tsx`:
```tsx
export default function App() {
  return (
    <div style={{
      display: 'flex', alignItems: 'center', justifyContent: 'center',
      height: '100vh', color: 'var(--ink)', fontFamily: 'var(--font-sans)'
    }}>
      <h1>Conductor — Tauri Shell Active</h1>
    </div>
  );
}
```

- [ ] **Step 14: Create placeholder icon**

```bash
cd E:\workspace\conductor-cli\src-tauri
mkdir -p icons
# Create a minimal 32x32 PNG (any small PNG works for dev)
python -c "
import struct, zlib
w, h = 32, 32
raw = b''
for y in range(h):
    raw += b'\x00'
    for x in range(w):
        raw += b'\x5E\x6A\xD2\xFF'
compressed = zlib.compress(raw)
def chunk(t, d):
    c = t + d
    return struct.pack('>I', len(d)) + c + struct.pack('>I', zlib.crc32(c) & 0xFFFFFFFF)
with open('icons/32x32.png', 'wb') as f:
    f.write(b'\x89PNG\r\n\x1a\n')
    f.write(chunk(b'IHDR', struct.pack('>IIBBBBB', w, h, 8, 6, 0, 0, 0)))
    f.write(chunk(b'IDAT', compressed))
    f.write(chunk(b'IEND', b''))
" 2>/dev/null || echo "Placeholder icon not created (non-critical for dev)"
```

- [ ] **Step 15: Verify Rust compilation**

```bash
cd E:\workspace\conductor-cli
cargo check --manifest-path src-tauri/Cargo.toml
```
Expected: `Finished dev` — no errors.

- [ ] **Step 16: Verify Tauri dev launch**

```bash
cd E:\workspace\conductor-cli\web
npm run tauri:dev
```

**Verification — 页面体验:**
- [ ] 原生 Windows 窗口打开（不是浏览器标签）
- [ ] 标题栏显示 "Conductor"
- [ ] 深色背景 `#232022`
- [ ] 居中显示 "Conductor — Tauri Shell Active" 白色文字

**Verification — 交互:**
- [ ] 窗口可拖动、最小化、最大化、关闭
- [ ] 可调整大小至 800x500 下限
- [ ] 关闭窗口后进程退出

**Verification — 功能:**
- [ ] DevTools (右键→检查) 无报错
- [ ] Rust 后台日志正常输出

- [ ] **Step 17: Commit**

```bash
git add src-tauri/ web/vite.config.ts web/package.json web/src/main.tsx web/src/App.tsx
git commit -m "feat: scaffold Tauri 2.x with React frontend — native window opens"
```

---

## Task 2: Rust PTY Manager

**Goal:** Rust 后端能 spawn ConPTY 进程、流式输出到前端、接受输入、resize、kill。

- [ ] **Step 1: Implement session.rs**

Write `src-tauri/src/pty/session.rs` with:
- `PtySession::spawn(id, agent, cwd, cols, rows, app)` — opens ConPTY, starts read thread
- Read thread: loops `reader.read(buf)`, emits `pty-output-{id}` Tauri event
- `write(&self, data)` — writes to PTY master
- `resize(&self, cols, rows)` — calls `master.resize(PtySize)`
- `kill(&mut self)` — drops writer, joins thread
- `SessionInfo` struct with id/agent/cwd/running, derives Serialize

- [ ] **Step 2: Implement manager.rs**

Write `src-tauri/src/pty/manager.rs` with:
- `PtyManager` holds `AppHandle`, `HashMap<String, PtySession>` in Mutex, next_id counter
- `spawn()` — alloc_id → PtySession::spawn → insert → return SessionInfo
- `write(id, data)` → session.write
- `resize(id, cols, rows)` → session.resize
- `kill(id)` → session.kill
- `list()` → all SessionInfo

- [ ] **Step 3: Implement pty_commands.rs**

Write `src-tauri/src/commands/pty_commands.rs` — 5 tauri::command functions that delegate to PtyManager via `tauri::State<PtyManager>`.

- [ ] **Step 4: Verify Rust compilation**

```bash
cargo check --manifest-path src-tauri/Cargo.toml
```

- [ ] **Step 5: Test PTY via DevTools console**

Launch `npm run tauri:dev`, open DevTools console:

```javascript
const { invoke } = window.__TAURI__.core;
const { listen } = window.__TAURI__.event;

// Spawn cmd.exe
const info = await invoke('pty_spawn', { agent: 'cmd.exe', cwd: null, cols: 80, rows: 24 });
console.log('Spawned:', info);

// Listen output
await listen(`pty-output-${info.id}`, e => {
    if (e.payload.data.trim()) console.log('[OUT]', e.payload.data.substring(0, 100));
});

// Send command
await invoke('pty_write', { sessionId: info.id, data: 'echo hello conductor\r\n' });

// Wait 2s then resize, kill, list
await new Promise(r => setTimeout(r, 2000));
await invoke('pty_resize', { sessionId: info.id, cols: 120, rows: 40 });
await invoke('pty_kill', { sessionId: info.id });
const list = await invoke('pty_list');
console.log('Sessions:', list);
```

**Verification — 功能:**
- [ ] `pty_spawn` 返回 `{ id: "S1", agent: "cmd.exe", cwd: "...", running: true }`
- [ ] `pty-output-S1` 事件流包含 cmd.exe 启动输出
- [ ] `pty_write` 发送 `echo hello` 后输出包含 "hello conductor"
- [ ] `pty_resize` 无报错
- [ ] `pty_kill` 后 `pty_list` 显示 running=false

- [ ] **Step 6: Commit**

```bash
git add src-tauri/src/pty/ src-tauri/src/commands/ src-tauri/src/lib.rs
git commit -m "feat: implement Rust PTY manager with ConPTY — spawn/write/resize/kill"
```

---

## Task 3: xterm.js Terminal Panel

**Goal:** 一个 dockview 面板里渲染 xterm.js，连接到 Rust PTY，全彩输出。

- [ ] **Step 1: Create terminal-theme.ts**

`web/src/lib/terminal-theme.ts`:
```typescript
export const terminalTheme = {
  background: '#1a1a1e',
  foreground: '#d4d0cc',
  cursor: '#5E6AD2',
  cursorAccent: '#1a1a1e',
  selectionBackground: 'rgba(94,106,210,0.3)',
  selectionForeground: '#f0f0f0',
  black: '#1a1a1e',
  red: '#f87171',
  green: '#4ade80',
  yellow: '#fbbf24',
  blue: '#60a5fa',
  magenta: '#c084fc',
  cyan: '#22d3ee',
  white: '#f0f0f0',
  brightBlack: '#3a3538',
  brightRed: '#fca5a5',
  brightGreen: '#86efac',
  brightYellow: '#fde68a',
  brightBlue: '#93c5fd',
  brightMagenta: '#d8b4fe',
  brightCyan: '#67e8f9',
  brightWhite: '#ffffff',
};
```

- [ ] **Step 2: Create tauri-ipc.ts**

`web/src/lib/tauri-ipc.ts`:
```typescript
import { invoke } from '@tauri-apps/api/core';
import { listen, type UnlistenFn } from '@tauri-apps/api/event';

export interface SessionInfo {
  id: string;
  agent: string;
  cwd: string;
  pid: number;
  running: boolean;
}

export const pty = {
  spawn: (agent: string, cwd: string | null, cols: number, rows: number) =>
    invoke<SessionInfo>('pty_spawn', { agent, cwd, cols, rows }),

  write: (sessionId: string, data: string) =>
    invoke<void>('pty_write', { sessionId, data }),

  resize: (sessionId: string, cols: number, rows: number) =>
    invoke<void>('pty_resize', { sessionId, cols, rows }),

  kill: (sessionId: string) =>
    invoke<void>('pty_kill', { sessionId }),

  list: () =>
    invoke<SessionInfo[]>('pty_list'),

  onOutput: (sessionId: string, handler: (data: string) => void): Promise<UnlistenFn> =>
    listen<{ id: string; data: string }>(`pty-output-${sessionId}`, (e) => handler(e.payload.data)),

  onExit: (sessionId: string, handler: (code: number) => void): Promise<UnlistenFn> =>
    listen<{ id: string; exitCode: number }>(`pty-exit-${sessionId}`, (e) => handler(e.payload.exitCode)),
};
```

- [ ] **Step 3: Create usePty.ts hook**

`web/src/hooks/usePty.ts`:
```typescript
import { useEffect, useRef, useCallback } from 'react';
import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import { CanvasAddon } from '@xterm/addon-canvas';
import { pty, type SessionInfo } from '../lib/tauri-ipc';
import { terminalTheme } from '../lib/terminal-theme';

export function usePty(agent: string, container: HTMLDivElement | null) {
  const termRef = useRef<Terminal | null>(null);
  const sessionRef = useRef<SessionInfo | null>(null);
  const fitRef = useRef<FitAddon | null>(null);
  const unsubscribers = useRef<(() => void)[]>([]);

  useEffect(() => {
    if (!container) return;

    const term = new Terminal({
      cursorBlink: true,
      cursorStyle: 'block',
      fontSize: 13,
      fontFamily: "'Cascadia Code', Consolas, monospace",
      theme: terminalTheme,
      scrollback: 5000,
    });

    const fitAddon = new FitAddon();
    term.loadAddon(fitAddon);
    term.loadAddon(new CanvasAddon());
    term.open(container);

    fitAddon.fit();
    const dims = fitAddon.proposeDimensions();
    const cols = dims?.cols ?? 80;
    const rows = dims?.rows ?? 24;

    termRef.current = term;
    fitRef.current = fitAddon;

    // Spawn PTY
    pty.spawn(agent, null, cols, rows).then(async (info) => {
      sessionRef.current = info;

      // Listen for output
      const unlistenOutput = await pty.onOutput(info.id, (data) => {
        term.write(data);
      });
      unsubscribers.current.push(unlistenOutput);

      // Listen for exit
      const unlistenExit = await pty.onExit(info.id, (code) => {
        term.write(`\r\n\x1b[33m● Session ended (exit: ${code})\x1b[0m\r\n`);
      });
      unsubscribers.current.push(unlistenExit);
    });

    // Forward input
    const dataDisposable = term.onData((data) => {
      if (sessionRef.current?.running) {
        pty.write(sessionRef.current.id, data);
      }
    });

    // Resize observer
    let resizeTimer: ReturnType<typeof setTimeout>;
    const ro = new ResizeObserver(() => {
      clearTimeout(resizeTimer);
      resizeTimer = setTimeout(() => {
        fitAddon.fit();
        const d = fitAddon.proposeDimensions();
        if (d?.cols && d?.rows && sessionRef.current?.running) {
          pty.resize(sessionRef.current.id, d.cols, d.rows);
        }
      }, 150);
    });
    ro.observe(container);

    return () => {
      clearTimeout(resizeTimer);
      dataDisposable.dispose();
      ro.disconnect();
      unsubscribers.current.forEach(fn => fn());
      unsubscribers.current = [];
      if (sessionRef.current?.running) {
        pty.kill(sessionRef.current.id);
      }
      term.dispose();
      termRef.current = null;
      sessionRef.current = null;
      fitRef.current = null;
    };
  }, [agent, container]);

  return { termRef, sessionRef };
}
```

- [ ] **Step 4: Create TerminalPanel.tsx**

`web/src/components/TerminalPanel.tsx`:
```tsx
import { useRef, useState, useCallback } from 'react';
import { usePty } from '../hooks/usePty';
import '@xterm/xterm/css/xterm.css';

interface Props {
  agent: string;
  onFocus?: () => void;
}

export function TerminalPanel({ agent, onFocus }: Props) {
  const containerRef = useRef<HTMLDivElement>(null);
  const [containerEl, setContainerEl] = useState<HTMLDivElement | null>(null);
  const { sessionRef } = usePty(agent, containerEl);

  const ref = useCallback((node: HTMLDivElement | null) => {
    containerRef.current = node;
    setContainerEl(node);
  }, []);

  return (
    <div
      ref={ref}
      onClick={onFocus}
      style={{
        width: '100%',
        height: '100%',
        background: '#1a1a1e',
        position: 'relative',
        overflow: 'hidden',
      }}
    />
  );
}
```

- [ ] **Step 5: Create sessions Zustand store**

`web/src/store/sessions.ts`:
```typescript
import { create } from 'zustand';

export interface Session {
  id: string;
  agent: string;
  dockviewId: string;
}

interface SessionState {
  sessions: Session[];
  add: (s: Session) => void;
  remove: (dockviewId: string) => void;
}

export const useSessionStore = create<SessionState>((set) => ({
  sessions: [],
  add: (s) => set((state) => ({ sessions: [...state.sessions, s] })),
  remove: (dockviewId) => set((state) => ({
    sessions: state.sessions.filter((s) => s.dockviewId !== dockviewId),
  })),
}));
```

- [ ] **Step 6: Create App.tsx with basic xterm test**

`web/src/App.tsx` (temporary single-terminal test):
```tsx
import { TerminalPanel } from './components/TerminalPanel';

export default function App() {
  return (
    <div style={{ width: '100vw', height: '100vh', display: 'flex', flexDirection: 'column' }}>
      <div style={{ padding: '8px 16px', background: 'var(--canvas-deep)', borderBottom: '1px solid var(--hairline)', color: 'var(--ink)', fontSize: 13 }}>
        Conductor — Terminal Test
      </div>
      <div style={{ flex: 1, position: 'relative' }}>
        <TerminalPanel agent="cmd.exe" />
      </div>
    </div>
  );
}
```

- [ ] **Step 7: Verify terminal rendering**

```bash
cd E:\workspace\conductor-cli\web
npm run tauri:dev
```

**Verification — 页面体验:**
- [ ] 窗口顶部有标题栏 "Conductor — Terminal Test"
- [ ] 下方区域渲染 cmd.exe 终端
- [ ] 终端背景色 `#1a1a1e`，不是白色
- [ ] 文字颜色 `#d4d0cc`，可读

**Verification — 交互:**
- [ ] 点击终端区域后键盘输入能发送到 cmd.exe
- [ ] 输入 `dir` 回车，能看到目录列表（全彩色）
- [ ] 终端随窗口缩放自动 refit（resize observer 生效）
- [ ] 滚动条可拖动查看历史输出

**Verification — 功能 (颜色重点):**
- [ ] 运行 `echo \x1b[31mRED\x1b[0m \x1b[32mGREEN\x1b[0m` (或在 PowerShell 中 `$([char]27)[31mRED$([char]27)[0m $([char]27)[32mGREEN$([char]27)[0m`)，红色和绿色能正确渲染
- [ ] 这一步验证 SGR 颜色序列不再被剥离（对比 blessed 版本的黑白问题）

- [ ] **Step 8: Commit**

```bash
git add web/src/
git commit -m "feat: xterm.js TerminalPanel with Canvas renderer and Tauri PTY IPC

- Full color rendering (fixes blessed monochrome issue)
- Canvas addon for GPU-accelerated rendering
- usePty hook manages PTY lifecycle
- tauri-ipc typed wrappers for invoke/event"
```

---

## Task 4: dockview Multi-Pane Layout

**Goal:** 用 dockview 实现可拖拽分割、可拖拽重排的多终端面板布局。

- [ ] **Step 1: Create dockview App.tsx**

`web/src/App.tsx`:
```tsx
import { useRef, useCallback } from 'react';
import {
  DockviewReact,
  DockviewReadyEvent,
  IGridviewPanelProps,
  DockviewPanelApi,
} from 'dockview';
import { TerminalPanel } from './components/TerminalPanel';
import { Sidebar } from './components/Sidebar';
import { useSessionStore } from './store/sessions';

const TerminalComponent = (props: IGridviewPanelProps<{ agent: string }>) => {
  const agent = props.params?.agent ?? 'cmd.exe';
  return <TerminalPanel agent={agent} />;
};

export default function App() {
  const apiRef = useRef<DockviewReadyEvent['api'] | null>(null);
  const { add, remove } = useSessionStore();

  const onReady = useCallback((event: DockviewReadyEvent) => {
    apiRef.current = event.api;

    // Start with one default terminal
    const panel = event.api.addPanel({
      id: 'terminal-1',
      component: 'terminal',
      params: { agent: 'cmd.exe' },
      title: 'cmd.exe',
    });

    add({ id: 'S1', agent: 'cmd.exe', dockviewId: 'terminal-1' });

    event.api.onDidRemovePanel((panel) => {
      remove(panel.id);
    });
  }, [add, remove]);

  const addTerminal = useCallback((agent: string) => {
    if (!apiRef.current) return;
    const count = apiRef.current.panels.length + 1;
    const id = `terminal-${count}`;
    apiRef.current.addPanel({
      id,
      component: 'terminal',
      params: { agent },
      title: agent,
      position: { direction: 'right', referenceGroup: apiRef.current.activeGroup?.id },
    });
    add({ id: `S${count}`, agent, dockviewId: id });
  }, [add]);

  return (
    <div style={{ display: 'flex', height: '100vh', width: '100vw' }}>
      <Sidebar onAddTerminal={addTerminal} />
      <div style={{ flex: 1 }}>
        <DockviewReact
          onReady={onReady}
          components={{ terminal: TerminalComponent }}
        />
      </div>
    </div>
  );
}
```

- [ ] **Step 2: Create Sidebar.tsx**

`web/src/components/Sidebar.tsx`:
```tsx
import { useState, useEffect } from 'react';

interface Props {
  onAddTerminal: (agent: string) => void;
}

const AGENTS = ['claude', 'opencode', 'codex', 'cmd.exe'];

export function Sidebar({ onAddTerminal }: Props) {
  const [detectedAgents, setDetectedAgents] = useState<string[]>(['cmd.exe']);

  useEffect(() => {
    // Detect agents on mount (Task 5 will replace with Rust detect_agents)
    AGENTS.forEach(async (agent) => {
      try {
        const { invoke } = await import('@tauri-apps/api/core');
        const result = await invoke<string[]>('detect_agents');
        if (result.includes(agent)) {
          setDetectedAgents((prev) => prev.includes(agent) ? prev : [...prev, agent]);
        }
      } catch {
        // Fallback: cmd.exe always available on Windows
      }
    });
  }, []);

  return (
    <div style={{
      width: 220,
      background: 'var(--canvas-deep)',
      borderRight: '1px solid var(--hairline)',
      display: 'flex',
      flexDirection: 'column',
      padding: '12px',
      gap: '8px',
      overflowY: 'auto',
    }}>
      <div style={{ color: 'var(--ink)', fontWeight: 600, fontSize: 15, marginBottom: 4 }}>
        Conductor
      </div>
      <div style={{ color: 'var(--caption)', fontSize: 11, marginBottom: 12 }}>
        Windows Agent Workbench
      </div>

      <div style={{ color: 'var(--secondary)', fontSize: 11, textTransform: 'uppercase', letterSpacing: '0.05em' }}>
        Add Terminal
      </div>
      {AGENTS.map((agent) => (
        <button
          key={agent}
          onClick={() => onAddTerminal(agent)}
          style={{
            background: 'var(--canvas-soft)',
            border: '1px solid var(--hairline)',
            borderRadius: 'var(--radius-md)',
            color: detectedAgents.includes(agent) ? 'var(--ink)' : 'var(--caption)',
            padding: '6px 10px',
            cursor: 'pointer',
            fontSize: 13,
            textAlign: 'left',
            display: 'flex',
            alignItems: 'center',
            gap: 6,
          }}
        >
          <span style={{ color: 'var(--accent)', fontSize: 16 }}>+</span>
          {agent}
          {!detectedAgents.includes(agent) && (
            <span style={{ color: 'var(--pending)', fontSize: 10, marginLeft: 'auto' }}>?</span>
          )}
        </button>
      ))}

      <div style={{ marginTop: 'auto', color: 'var(--caption)', fontSize: 10 }}>
        Ctrl+Shift+T new tab · Ctrl+W close
      </div>
    </div>
  );
}
```

- [ ] **Step 3: Verify multi-pane layout**

```bash
cd E:\workspace\conductor-cli\web
npm run tauri:dev
```

**Verification — 页面体验:**
- [ ] 左侧 220px 侧边栏，深色背景
- [ ] 侧边栏标题 "Conductor" + 副标题 "Windows Agent Workbench"
- [ ] "Add Terminal" 区域有 4 个按钮 (claude, opencode, codex, cmd.exe)
- [ ] 右侧主区域默认显示一个 cmd.exe 终端面板
- [ ] dockview 标签栏显示 "cmd.exe" 标签

**Verification — 交互:**
- [ ] 点击 "+ cmd.exe" 按钮，右侧新增一个终端面板（水平分割）
- [ ] 拖拽两个面板之间的分割线，大小平滑变化
- [ ] 终端内容随面板大小自动 refit（列数/行数变化）
- [ ] 点击标签可切换焦点面板
- [ ] 拖拽标签到另一侧可实现重排

**Verification — 功能:**
- [ ] 每个面板独立运行 PTY，输入不互相干扰
- [ ] 在面板 A 输入 `echo A`，在面板 B 输入 `echo B`，各自显示正确输出
- [ ] 关闭标签（右键菜单或 dockview 的关闭按钮）后 PTY 被 kill

- [ ] **Step 4: Commit**

```bash
git add web/src/App.tsx web/src/components/Sidebar.tsx
git commit -m "feat: dockview multi-pane layout with sidebar and dynamic add"
```

---

## Task 5: Agent Auto-Detection

**Goal:** 启动时扫描 PATH，只显示已安装的 agent。

- [ ] **Step 1: Implement shell_detect.rs**

`src-tauri/src/pty/shell_detect.rs`:
```rust
use serde::Serialize;

#[derive(Debug, Clone, Serialize)]
pub struct AgentInfo {
    pub name: String,
    pub path: Option<String>,
    pub installed: bool,
}

const KNOWN_AGENTS: &[&str] = &["claude", "opencode", "codex"];

pub fn detect_agents() -> Vec<AgentInfo> {
    KNOWN_AGENTS
        .iter()
        .map(|name| {
            match which::which(name) {
                Ok(path) => AgentInfo {
                    name: name.to_string(),
                    path: Some(path.to_string_lossy().to_string()),
                    installed: true,
                },
                Err(_) => AgentInfo {
                    name: name.to_string(),
                    path: None,
                    installed: false,
                },
            }
        })
        .collect()
}
```

- [ ] **Step 2: Update app_commands.rs**

`src-tauri/src/commands/app_commands.rs`:
```rust
use crate::pty::shell_detect::{self, AgentInfo};
use serde::Serialize;

#[derive(Serialize)]
pub struct GitInfo {
    pub branch: Option<String>,
    pub dirty: bool,
}

#[tauri::command]
pub async fn detect_agents() -> Result<Vec<AgentInfo>, String> {
    Ok(shell_detect::detect_agents())
}

#[tauri::command]
pub async fn get_git_status(path: String) -> Result<GitInfo, String> {
    let repo = git2::Repository::discover(&path).map_err(|e| e.message().to_string());
    match repo {
        Ok(repo) => {
            let head = repo.head().ok();
            let branch = head.and_then(|h| h.shorthand().map(|s| s.to_string()));
            let dirty = repo.statuses(None)
                .map(|statuses| statuses.iter().any(|s| s.status() != git2::Status::CURRENT))
                .unwrap_or(false);
            Ok(GitInfo { branch, dirty })
        }
        Err(_) => Ok(GitInfo { branch: None, dirty: false }),
    }
}
```

- [ ] **Step 3: Update Sidebar.tsx to use detect_agents**

Update `web/src/components/Sidebar.tsx` — replace the useEffect with:
```tsx
useEffect(() => {
    (async () => {
        try {
            const { invoke } = await import('@tauri-apps/api/core');
            const agents = await invoke<Array<{ name: string; installed: boolean }>>('detect_agents');
            const installed = agents.filter(a => a.installed).map(a => a.name);
            setDetectedAgents(['cmd.exe', ...installed]);
        } catch {
            setDetectedAgents(['cmd.exe']);
        }
    })();
}, []);
```

Change the button rendering to show install hints for missing agents:
```tsx
{KNOWN_AGENTS.map((agent) => {
    const isInstalled = detectedAgents.includes(agent);
    return (
        <button key={agent} onClick={() => isInstalled && onAddTerminal(agent)}
            style={{ /* same as before */ opacity: isInstalled ? 1 : 0.5 }}>
            <span style={{ color: 'var(--accent)', fontSize: 16 }}>+</span>
            {agent}
            {!isInstalled && <span style={{ fontSize: 10, color: 'var(--caption)' }}>not found</span>}
        </button>
    );
})}
```

- [ ] **Step 4: Verify agent detection**

```bash
cd E:\workspace\conductor-cli\web
npm run tauri:dev
```

**Verification — 功能:**
- [ ] DevTools console 运行 `await window.__TAURI__.core.invoke('detect_agents')` 返回数组
- [ ] 数组中 `claude` 的 `installed` 字段反映实际安装状态
- [ ] 侧边栏中已安装 agent 按钮可点击，未安装的显示 "not found"
- [ ] 点击未安装 agent 按钮不会 spawn 进程

**Verification — 交互:**
- [ ] 侧边栏加载后 <500ms 显示正确的 agent 列表

- [ ] **Step 5: Commit**

```bash
git add src-tauri/src/pty/shell_detect.rs src-tauri/src/commands/app_commands.rs web/src/components/Sidebar.tsx
git commit -m "feat: agent auto-detection via PATH scan with which crate"
```

---

## Task 6: Rich Sidebar — Git Branch & Session Status

**Goal:** 侧边栏每个 session 卡片显示 git branch、工作目录、运行状态。

- [ ] **Step 1: Create useGitStatus.ts**

`web/src/hooks/useGitStatus.ts`:
```typescript
import { useState, useEffect } from 'react';
import { invoke } from '@tauri-apps/api/core';

interface GitInfo {
    branch: string | null;
    dirty: boolean;
}

export function useGitStatus(cwd: string | null) {
    const [git, setGit] = useState<GitInfo>({ branch: null, dirty: false });

    useEffect(() => {
        if (!cwd) return;
        let cancelled = false;
        (async () => {
            try {
                const info = await invoke<GitInfo>('get_git_status', { path: cwd });
                if (!cancelled) setGit(info);
            } catch { /* not a git repo */ }
        })();
        return () => { cancelled = true; };
    }, [cwd]);

    return git;
}
```

- [ ] **Step 2: Update Sidebar.tsx with session cards**

Add to `web/src/components/Sidebar.tsx` imports and session list rendering:
```tsx
import { useSessionStore } from '../store/sessions';
import { useGitStatus } from '../hooks/useGitStatus';

// Inside Sidebar component:
const { sessions } = useSessionStore();

// Add session cards section after "Add Terminal" buttons:
<div style={{ color: 'var(--secondary)', fontSize: 11, textTransform: 'uppercase', marginTop: 16 }}>
  Sessions ({sessions.length})
</div>
{sessions.map((s) => (
  <SessionCard key={s.dockviewId} agent={s.agent} />
))}
```

Create inline `SessionCard` component:
```tsx
function SessionCard({ agent }: { agent: string }) {
    const git = useGitStatus(null); // Will pass real cwd in Task 7

    return (
        <div style={{
            background: 'var(--canvas-soft)',
            border: '1px solid var(--hairline)',
            borderRadius: 'var(--radius-md)',
            padding: '8px 10px',
            fontSize: 12,
        }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                <span style={{
                    width: 6, height: 6, borderRadius: '50%',
                    background: 'var(--running)', display: 'inline-block',
                }} />
                <span style={{ color: 'var(--ink)', fontWeight: 500 }}>{agent}</span>
            </div>
            {git.branch && (
                <div style={{ color: 'var(--accent)', fontSize: 11, marginTop: 4, paddingLeft: 12 }}>
                     {git.branch}{git.dirty ? ' *' : ''}
                </div>
            )}
        </div>
    );
}
```

- [ ] **Step 3: Verify rich sidebar**

```bash
cd E:\workspace\conductor-cli\web
npm run tauri:dev
```

**Verification — 页面体验:**
- [ ] 侧边栏 "Sessions" 区域显示已添加的终端卡片
- [ ] 每个卡片有绿色圆点 + agent 名称
- [ ] 如果工作目录是 git 仓库，显示分支名（如 `master *`）

**Verification — 功能:**
- [ ] DevTools 运行 `await window.__TAURI__.core.invoke('get_git_status', { path: 'E:\\workspace\\conductor-cli' })` 返回 `{ branch: "master", dirty: true/false }`
- [ ] 非 git 目录返回 `{ branch: null, dirty: false }`

- [ ] **Step 4: Commit**

```bash
git add web/src/components/Sidebar.tsx web/src/hooks/useGitStatus.ts
git commit -m "feat: rich sidebar with git branch and session status cards"
```

---

## Task 7: Session Persistence (SQLite)

**Goal:** 退出时保存布局和 session 信息到 SQLite，重启后恢复。

- [ ] **Step 1: Implement db/store.rs with schema**

`src-tauri/src/db/store.rs`:
```rust
use rusqlite::{params, Connection, Result as SqlResult};
use serde::{Deserialize, Serialize};
use std::sync::Mutex;

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SavedSession {
    pub id: String,
    pub agent: String,
    pub cwd: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SavedLayout {
    pub sessions: Vec<SavedSession>,
    pub dockview_json: String,
    pub window_width: u32,
    pub window_height: u32,
}

pub struct DbStore {
    conn: Mutex<Connection>,
}

impl DbStore {
    pub fn new() -> Result<Self, Box<dyn std::error::Error>> {
        let app_data = dirs::data_local_dir()
            .unwrap_or_else(|| std::path::PathBuf::from("."))
            .join("conductor");
        std::fs::create_dir_all(&app_data)?;
        let db_path = app_data.join("conductor.db");
        let conn = Connection::open(&db_path)?;
        conn.execute_batch(
            "CREATE TABLE IF NOT EXISTS layout (
                id INTEGER PRIMARY KEY CHECK (id = 1),
                dockview_json TEXT NOT NULL DEFAULT '',
                window_width INTEGER NOT NULL DEFAULT 1400,
                window_height INTEGER NOT NULL DEFAULT 900,
                updated_at TEXT NOT NULL DEFAULT (datetime('now'))
            );
            CREATE TABLE IF NOT EXISTS sessions (
                id TEXT PRIMARY KEY,
                agent TEXT NOT NULL,
                cwd TEXT NOT NULL
            );"
        )?;
        Ok(Self { conn: Mutex::new(conn) })
    }

    pub fn save_layout(&self, layout: &SavedLayout) -> SqlResult<()> {
        let conn = self.conn.lock().unwrap();
        // Clear and replace
        conn.execute("DELETE FROM sessions", [])?;
        for s in &layout.sessions {
            conn.execute(
                "INSERT INTO sessions (id, agent, cwd) VALUES (?1, ?2, ?3)",
                params![s.id, s.agent, s.cwd],
            )?;
        }
        conn.execute(
            "INSERT OR REPLACE INTO layout (id, dockview_json, window_width, window_height) VALUES (1, ?1, ?2, ?3)",
            params![layout.dockview_json, layout.window_width, layout.window_height],
        )?;
        Ok(())
    }

    pub fn load_layout(&self) -> SqlResult<Option<SavedLayout>> {
        let conn = self.conn.lock().unwrap();
        let mut stmt = conn.prepare("SELECT dockview_json, window_width, window_height FROM layout WHERE id = 1")?;
        let layout_row = stmt.query_row([], |row| {
            Ok((row.get::<_, String>(0)?, row.get::<_, u32>(1)?, row.get::<_, u32>(2)?))
        }).ok();

        let Some((dockview_json, w, h)) = layout_row else { return Ok(None) };

        let mut stmt = conn.prepare("SELECT id, agent, cwd FROM sessions")?;
        let sessions = stmt.query_map([], |row| {
            Ok(SavedSession {
                id: row.get(0)?,
                agent: row.get(1)?,
                cwd: row.get(2)?,
            })
        })?.filter_map(|r| r.ok()).collect();

        Ok(Some(SavedLayout { sessions, dockview_json, window_width: w, window_height: h }))
    }
}
```

Add `dirs` to `Cargo.toml` dependencies:
```toml
dirs = "6"
```

- [ ] **Step 2: Add save/restore Tauri commands**

Add to `src-tauri/src/commands/app_commands.rs`:
```rust
use crate::db::store::{DbStore, SavedLayout, SavedSession};

#[tauri::command]
pub async fn save_layout(
    dockview_json: String,
    sessions: Vec<SavedSession>,
    window_width: u32,
    window_height: u32,
    state: tauri::State<'_, DbStore>,
) -> Result<(), String> {
    state.save_layout(&SavedLayout {
        sessions,
        dockview_json,
        window_width,
        window_height,
    }).map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn load_layout(
    state: tauri::State<'_, DbStore>,
) -> Result<Option<SavedLayout>, String> {
    state.load_layout().map_err(|e| e.to_string())
}
```

Register in `lib.rs` invoke_handler.

- [ ] **Step 3: Add persistence hooks in frontend**

`web/src/hooks/usePersistence.ts`:
```typescript
import { useEffect, useRef } from 'react';
import { invoke } from '@tauri-apps/api/core';

interface SavedSession {
    id: string;
    agent: string;
    cwd: string;
}

export function usePersistence(
    dockviewApi: any,
    sessions: Array<{ id: string; agent: string; dockviewId: string }>
) {
    const saved = useRef(false);

    // Save on beforeunload
    useEffect(() => {
        const handle = async () => {
            if (!dockviewApi || saved.current) return;
            saved.current = true;
            try {
                const json = dockviewApi.toJSON();
                const savedSessions: SavedSession[] = sessions.map(s => ({
                    id: s.id, agent: s.agent, cwd: '.',
                }));
                await invoke('save_layout', {
                    dockviewJson: JSON.stringify(json),
                    sessions: savedSessions,
                    windowWidth: window.innerWidth,
                    windowHeight: window.innerHeight,
                });
            } catch (e) {
                console.error('Failed to save layout:', e);
            }
        };

        window.addEventListener('beforeunload', handle);
        return () => window.removeEventListener('beforeunload', handle);
    }, [dockviewApi, sessions]);
}
```

- [ ] **Step 4: Verify persistence**

```bash
cd E:\workspace\conductor-cli\web
npm run tauri:dev
```

Test sequence:
1. Add 3 terminal panels (cmd.exe, cmd.exe, cmd.exe)
2. Type something unique in each (e.g. "AAA", "BBB", "CCC")
3. Close the Conductor window
4. Run `npm run tauri:dev` again

**Verification — 功能:**
- [ ] DevTools 运行 `await window.__TAURI__.core.invoke('load_layout')` 返回保存的数据
- [ ] `dockview_json` 包含 3 个面板的布局信息
- [ ] `sessions` 数组包含 3 条记录

**Verification — 页面体验 (Phase 2 will do full restore):**
- [ ] 重启后 `load_layout` 返回的数据结构正确
- [ ] 数据存储在 `%LOCALAPPDATA%\conductor\conductor.db`

- [ ] **Step 5: Commit**

```bash
git add src-tauri/src/db/ src-tauri/src/commands/app_commands.rs src-tauri/src/lib.rs web/src/hooks/usePersistence.ts web/src/App.tsx
git commit -m "feat: SQLite session persistence — save layout on close, load on start"
```

---

## Task 8: Keyboard Shortcuts

**Goal:** 全局快捷键控制终端面板。

- [ ] **Step 1: Add keyboard handler to App.tsx**

In `web/src/App.tsx`, add a `useEffect` for global keyboard shortcuts:

```tsx
useEffect(() => {
    const handle = (e: KeyboardEvent) => {
        // Ctrl+Shift+T: new terminal
        if (e.ctrlKey && e.shiftKey && e.key === 'T') {
            e.preventDefault();
            addTerminal('cmd.exe');
        }
        // Ctrl+W: close active panel
        if (e.ctrlKey && e.key === 'w') {
            e.preventDefault();
            const active = apiRef.current?.activePanel;
            if (active) {
                active.api.close();
            }
        }
        // Ctrl+Shift+D: split right
        if (e.ctrlKey && e.shiftKey && e.key === 'D') {
            e.preventDefault();
            addTerminal('cmd.exe');
        }
    };
    window.addEventListener('keydown', handle);
    return () => window.removeEventListener('keydown', handle);
}, [addTerminal]);
```

- [ ] **Step 2: Verify shortcuts**

```bash
cd E:\workspace\conductor-cli\web
npm run tauri:dev
```

**Verification — 交互:**
- [ ] `Ctrl+Shift+T` 打开新终端面板
- [ ] `Ctrl+W` 关闭当前面板
- [ ] `Ctrl+Shift+D` 右侧分割新面板
- [ ] 快捷键不会与终端输入冲突（xterm.js 获得焦点时 Ctrl+W 不关闭面板，只关闭面板获焦时）

**Note:** xterm.js 会捕获键盘事件。需要确保在 xterm 获焦时 `Ctrl+W` 发送到 PTY 而不是关闭面板。这是后续优化点。Phase 1 先确保非终端焦点时快捷键工作。

- [ ] **Step 3: Commit**

```bash
git add web/src/App.tsx
git commit -m "feat: keyboard shortcuts — Ctrl+Shift+T new, Ctrl+W close, Ctrl+Shift+D split"
```

---

## Task 9: Comprehensive End-to-End Verification

**Goal:** 全面对照 spec 成功标准做最终验证。

- [ ] **Step 1: Binary size check**

```bash
# After building
cd E:\workspace\conductor-cli\web
npm run tauri:build
# Check the built binary
ls -la src-tauri/target/release/conductor.exe
```

**Verification:** Binary under 30MB.

- [ ] **Step 2: Memory check**

启动 Conductor，打开 4 个 cmd.exe 终端面板。打开任务管理器，找到 conductor.exe 进程。

**Verification:** 内存使用低于 200MB。

- [ ] **Step 3: Page Experience Checklist**

逐项验证：

| # | 检查项 | 结果 |
|---|---|---|
| 1 | 原生窗口打开（非浏览器） | [ ] |
| 2 | 深色主题，背景 #232022 | [ ] |
| 3 | 侧边栏 220px，显示 Conductor 标题 | [ ] |
| 4 | Agent 按钮列表（claude/opencode/codex/cmd.exe） | [ ] |
| 5 | 终端渲染全彩色（SGR 序列不被剥离） | [ ] |
| 6 | 终端字体 Cascadia Code / Consolas | [ ] |
| 7 | 终端光标闪烁 | [ ] |
| 8 | Session 卡片显示绿色运行指示灯 | [ ] |
| 9 | Git 分支显示（在 git 仓库目录） | [ ] |
| 10 | 无闪烁/抖动/白屏 | [ ] |

- [ ] **Step 4: Interaction Checklist**

逐项验证：

| # | 检查项 | 结果 |
|---|---|---|
| 1 | 点击 "+ cmd.exe" 新增终端面板 | [ ] |
| 2 | 拖拽面板分割线，大小平滑变化 | [ ] |
| 3 | resize 后终端自动 refit | [ ] |
| 4 | 点击标签切换焦点面板 | [ ] |
| 5 | 关闭标签后 PTY 被 kill | [ ] |
| 6 | Ctrl+Shift+T 打开新面板 | [ ] |
| 7 | Ctrl+W 关闭面板（非 xterm 焦点时） | [ ] |
| 8 | 键盘输入发送到当前焦点面板 | [ ] |
| 9 | 滚动终端历史正常 | [ ] |
| 10 | 窗口最小化/最大化/还原正常 | [ ] |

- [ ] **Step 5: Functionality Checklist**

逐项验证：

| # | 检查项 | 结果 |
|---|---|---|
| 1 | spawn cmd.exe — 输出流式显示 | [ ] |
| 2 | 输入 `echo hello` — 输出 "hello" | [ ] |
| 3 | 输入 `dir` — 目录列表全彩色 | [ ] |
| 4 | `cls` 命令清屏正常 | [ ] |
| 5 | 多面板独立运行，输入不串 | [ ] |
| 6 | resize 面板后 `mode con` 显示正确列数/行数 | [ ] |
| 7 | detect_agents 返回正确安装状态 | [ ] |
| 8 | get_git_status 返回正确分支 | [ ] |
| 9 | save_layout 保存成功 | [ ] |
| 10 | load_layout 读取成功 | [ ] |
| 11 | 关闭窗口后进程退出（无孤儿 PTY） | [ ] |

- [ ] **Step 6: Spawn Real Agent (if installed)**

如果系统安装了 Claude Code：
```bash
# 在 Conductor 中点击 "+ claude" 按钮
# 等待 Claude Code 启动
```

**Verification:**
- [ ] Claude Code 启动画面全彩色渲染
- [ ] 交互式提示正常显示
- [ ] 输入/输出流畅
- [ ] 对比旧版 blessed TUI 的黑白输出，确认颜色问题已解决

- [ ] **Step 7: Final commit**

```bash
git add -A
git commit -m "chore: Phase 1 complete — Tauri rewrite with dockview + xterm.js

All 10 success criteria from spec verified:
1. Native window with dockview layout
2. Full color rendering (fixes blessed monochrome)
3. Drag-to-resize split panes
4. Drag-to-rearrange tabs
5. Session persistence via SQLite
6. Agent auto-detection
7. Git branch in sidebar
8. Smooth 60fps Canvas rendering
9. Binary under 30MB
10. Memory under 200MB with 4 terminals"
```

---

## Summary

| Task | What It Delivers | Key Verification |
|---|---|---|
| 1 | Tauri scaffold | Native window opens with React |
| 2 | Rust PTY Manager | spawn/write/resize/kill work via DevTools |
| 3 | xterm.js TerminalPanel | Full color, Canvas GPU, resize auto-fit |
| 4 | dockview Layout | Multi-pane, drag-to-resize, add/remove |
| 5 | Agent Detection | Only installed agents shown |
| 6 | Rich Sidebar | Git branch, session status cards |
| 7 | SQLite Persistence | Layout saved on close, loadable on start |
| 8 | Keyboard Shortcuts | Ctrl+Shift+T, Ctrl+W, Ctrl+Shift+D |
| 9 | E2E Verification | 30+ checklist items across experience/interaction/functionality |
