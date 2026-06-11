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
    pub agent_session_id: String,
}

pub struct PtySession {
    pub id: String,
    pub agent: String,
    pub cwd: String,
    pub agent_session_id: String,
    master: Box<dyn MasterPty + Send>,
    writer: Arc<Mutex<Option<Box<dyn std::io::Write + Send>>>>,
    alive: Arc<AtomicBool>,
    handle: Option<thread::JoinHandle<()>>,
}

impl PtySession {
    pub fn spawn(
        id: String, agent: String, cwd: String, cols: u16, rows: u16, app: AppHandle, agent_session_id: &str, is_restore: bool,
    ) -> Result<Self, String> {
        let pty_system = native_pty_system();
        let pair = pty_system
            .openpty(PtySize { rows, cols, pixel_width: 0, pixel_height: 0 })
            .map_err(|e| format!("PTY open failed: {}", e))?;

        // Look up agent config for custom commands/args/resume
        let agent_config = crate::config::agents::AgentsConfig::load();
        let agent_cmd = agent_config.find(&agent)
            .map(|a| a.command.clone())
            .unwrap_or_else(|| agent.clone());
        let mut agent_args = agent_config.find(&agent)
            .map(|a| a.args.clone())
            .unwrap_or_default();
        // DEBUG: log the session args
        log::info!("[SPAWN] agent={} sid_param={:?} is_restore={} cwd={}", agent, agent_session_id, is_restore, cwd);
        // Inject session ID: create_template for new, resume_template for restore
        let mut template_applied = false;
        if !agent_session_id.is_empty() {
            if let Some(cfg) = agent_config.find(&agent) {
                // Pick the correct template: never fall through from empty create to resume
                let tmpl = if is_restore {
                    &cfg.resume_template
                } else {
                    &cfg.create_template
                };
                log::info!("[SPAWN] template='{}' (create='{}' resume='{}')", tmpl, cfg.create_template, cfg.resume_template);
                if !tmpl.is_empty() {
                    let arg = tmpl.replace("{session_id}", agent_session_id);
                    for a in arg.split_whitespace() { agent_args.push(a.to_string()); }
                    template_applied = true;
                    log::info!("[SPAWN] template_applied=true args={:?}", agent_args);
                } else {
                    log::info!("[SPAWN] template is EMPTY — no session flag will be added");
                }
            }
        } else {
            log::info!("[SPAWN] agent_session_id is EMPTY — skipping template");
        }

        // Windows: always spawn via cmd.exe /k with explicit cd to set cwd
        let (binary, args): (String, Vec<String>) = if cfg!(windows) {
            let path = which::which(&agent_cmd).unwrap_or_else(|_| std::path::PathBuf::from(&agent_cmd));
            let resolved = path.to_string_lossy().to_string();
            log::info!("[SPAWN] which({}) = {:?}, extension={:?}", agent_cmd, resolved, path.extension());
            // Build command line with agent + extra args
            let extra = if agent_args.is_empty() { String::new() } else { format!(" {}", agent_args.join(" ")) };
            match path.extension().and_then(|e| e.to_str()) {
                Some("cmd") | Some("bat") => {
                    let cmdline = format!("cd /d {} && call {}{}", cwd, resolved, extra);
                    log::info!("[SPAWN] CMDLINE (call): {}", cmdline);
                    ("cmd.exe".into(), vec!["/k".into(), cmdline])
                }
                _ => {
                    let cmdline = format!("cd /d {} && {}{}", cwd, resolved, extra);
                    log::info!("[SPAWN] CMDLINE (direct): {}", cmdline);
                    ("cmd.exe".into(), vec!["/k".into(), cmdline])
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
        log::info!("[SPAWN] pid={} template_applied={} effective_sid={}", pid, template_applied, if template_applied { agent_session_id } else { "" });
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

        // Only store agent_session_id if a template was applied (e.g. --session-id was used).
        // Otherwise keep empty so setAgentSessionId can capture the real ID from output.
        let effective_sid = if template_applied { agent_session_id.to_string() } else { String::new() };

        // DIAGNOSTIC: append spawn info to a debug file
        if template_applied && !agent_session_id.is_empty() {
            let debug_path = crate::config::config_dir().join("debug-spawn.log");
            let entry = format!("{} | pid={} agent={} sid={} restore={} binary={} args={:?}\n",
                chrono::Local::now().format("%Y-%m-%d %H:%M:%S"),
                pid, agent, agent_session_id, is_restore,
                binary, args);
            let _ = std::fs::OpenOptions::new().create(true).append(true).open(&debug_path)
                .and_then(|mut f| std::io::Write::write_all(&mut f, entry.as_bytes()));
        }

        Ok(Self { id, agent, cwd, agent_session_id: effective_sid, master, writer, alive, handle: Some(handle) })
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
        SessionInfo { id: self.id.clone(), agent: self.agent.clone(), cwd: self.cwd.clone(), pid: 0, running: self.is_alive(), agent_session_id: self.agent_session_id.clone() }
    }

    pub fn set_agent_session_id(&mut self, sid: String) {
        // Only set if not already set (e.g. by --session-id at spawn time).
        // This prevents false-positive regex matches from overwriting the correct ID.
        if self.agent_session_id.is_empty() {
            self.agent_session_id = sid;
        }
    }
}

impl Drop for PtySession {
    fn drop(&mut self) { self.kill(); }
}
