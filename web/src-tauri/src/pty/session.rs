use portable_pty::{native_pty_system, CommandBuilder, MasterPty, PtySize};
use std::io::Read;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::thread;
use tauri::{AppHandle, Emitter};
use serde::Serialize;

#[derive(Debug, Clone, Serialize)]
pub struct SessionInfo {
    pub id: String,
    pub agent: String,
    pub cwd: String,
    pub pid: u32,
    pub running: bool,
}

pub struct PtySession {
    pub id: String,
    pub agent: String,
    pub cwd: String,
    master: Box<dyn MasterPty + Send>,
    writer: Arc<Mutex<Option<Box<dyn std::io::Write + Send>>>>,
    alive: Arc<AtomicBool>,
    handle: Option<thread::JoinHandle<()>>,
}

impl PtySession {
    pub fn spawn(
        id: String, agent: String, cwd: String, cols: u16, rows: u16, app: AppHandle,
    ) -> Result<Self, String> {
        let pty_system = native_pty_system();
        let pair = pty_system
            .openpty(PtySize { rows, cols, pixel_width: 0, pixel_height: 0 })
            .map_err(|e| format!("PTY open failed: {}", e))?;

        // Look up agent config for custom commands/args
        let agent_config = crate::config::agents::AgentsConfig::load();
        let agent_cmd = agent_config.find(&agent)
            .map(|a| a.command.clone())
            .unwrap_or_else(|| agent.clone());
        let agent_args = agent_config.find(&agent)
            .map(|a| a.args.clone())
            .unwrap_or_default();

        // Windows: always spawn via cmd.exe /k with explicit cd to set cwd
        let (binary, args): (String, Vec<String>) = if cfg!(windows) {
            let path = which::which(&agent_cmd).unwrap_or_else(|_| std::path::PathBuf::from(&agent_cmd));
            let resolved = path.to_string_lossy().to_string();
            // Build command line with agent + extra args
            let extra = if agent_args.is_empty() { String::new() } else { format!(" {}", agent_args.join(" ")) };
            match path.extension().and_then(|e| e.to_str()) {
                Some("cmd") | Some("bat") => {
                    ("cmd.exe".into(), vec!["/k".into(), format!("cd /d {} && call {}{}", cwd, resolved, extra)])
                }
                _ => {
                    ("cmd.exe".into(), vec!["/k".into(), format!("cd /d {} && {}{}", cwd, resolved, extra)])
                }
            }
        } else {
            (agent_cmd, agent_args)
        };

        let mut cmd = CommandBuilder::new(&binary);
        for a in &args { cmd.arg(a); }

        let mut child = pair.slave.spawn_command(cmd)
            .map_err(|e| format!("Spawn {} failed: {}", agent, e))?;
        let pid = child.process_id().unwrap_or(0);
        let master = pair.master;
        let reader = master.try_clone_reader()
            .map_err(|e| format!("Reader: {}", e))?;
        let writer = Arc::new(Mutex::new(Some(
            master.take_writer().map_err(|e| e.to_string())?
        )));
        let alive = Arc::new(AtomicBool::new(true));
        let alive2 = alive.clone();
        let sid = id.clone();

        let handle = thread::Builder::new().name(format!("pty-{}", sid)).spawn(move || {
            let mut reader = reader;
            let mut buf = [0u8; 8192];
            loop {
                match reader.read(&mut buf) {
                    Ok(0) | Err(_) => break,
                    Ok(n) => {
                        let t = String::from_utf8_lossy(&buf[..n]).to_string();
                        let _ = app.emit(&format!("pty-output-{}", sid),
                            serde_json::json!({"id": sid, "data": t}));
                    }
                }
            }
            alive2.store(false, Ordering::Relaxed);
            let _ = child.wait();
            let _ = app.emit(&format!("pty-exit-{}", sid),
                serde_json::json!({"id": sid, "exitCode": 0}));
        }).map_err(|e| format!("Thread: {}", e))?;

        Ok(Self { id, agent, cwd, master, writer, alive, handle: Some(handle) })
    }

    pub fn write(&self, data: &str) -> Result<(), String> {
        let mut g = self.writer.lock().map_err(|e| e.to_string())?;
        match &mut *g {
            Some(w) => { w.write_all(data.as_bytes()).map_err(|e| e.to_string())?; w.flush().map_err(|e| e.to_string()) }
            None => Err("closed".into()),
        }
    }

    pub fn resize(&self, cols: u16, rows: u16) -> Result<(), String> {
        self.master.resize(PtySize { rows, cols, pixel_width: 0, pixel_height: 0 })
            .map_err(|e| format!("Resize: {}", e))
    }

    pub fn kill(&mut self) {
        self.alive.store(false, Ordering::Relaxed);
        if let Ok(mut g) = self.writer.lock() {
            if let Some(ref mut w) = *g {
                let _ = w.write_all(b"exit\r\n");
            }
            *g = None;
        }
        self.handle.take(); // detach thread, don't block
    }

    pub fn is_alive(&self) -> bool { self.alive.load(Ordering::Relaxed) }

    pub fn info(&self) -> SessionInfo {
        SessionInfo { id: self.id.clone(), agent: self.agent.clone(), cwd: self.cwd.clone(), pid: 0, running: self.is_alive() }
    }
}

impl Drop for PtySession {
    fn drop(&mut self) { self.kill(); }
}
