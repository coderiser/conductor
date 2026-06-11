use crate::pty::session::{PtySession, SessionInfo};
use std::collections::HashMap;
use std::sync::Mutex;
use tauri::Emitter;

pub struct PtyManager {
    sessions: Mutex<HashMap<String, PtySession>>,
    next_id: Mutex<u32>,
}

impl PtyManager {
    pub fn new() -> Self {
        Self { sessions: Mutex::new(HashMap::new()), next_id: Mutex::new(1) }
    }

    fn alloc_id(&self) -> String {
        let mut n = self.next_id.lock().unwrap();
        let id = format!("S{}", *n);
        *n += 1;
        id
    }

    pub fn spawn(&self, agent: String, cwd: String, cols: u16, rows: u16, app: tauri::AppHandle, agent_session_id: &str, is_restore: bool) -> Result<SessionInfo, String> {
        let id = self.alloc_id();
        let agent_clone = agent.clone();
        let app_clone = app.clone();
        let session_cwd = cwd.clone();

        // Snapshot existing session IDs BEFORE spawn for concurrent-safe diff
        let prev_ids: Vec<String> = if !is_restore && is_snapshot_agent(&agent_clone) {
            get_all_session_ids(&agent_clone, &session_cwd)
        } else {
            vec![]
        };

        let s = PtySession::spawn(id.clone(), agent, cwd.clone(), cols, rows, app, agent_session_id, is_restore)?;
        let info = s.info();
        self.sessions.lock().unwrap().insert(id.clone(), s);

        // Post-spawn: discover agent's real session ID via before/after diff
        if !is_restore && is_snapshot_agent(&agent_clone) {
            let session_id = id.clone();
            let app_handle = app_clone;

            std::thread::spawn(move || {
                std::thread::sleep(std::time::Duration::from_secs(3));

                let new_ids = get_all_session_ids(&agent_clone, &session_cwd);
                // Concurrent-safe: find ID that wasn't in the pre-spawn snapshot
                let found = new_ids.iter().find(|id| !prev_ids.contains(id)).cloned();
                log::info!("[POST_SPAWN] {}: prev={} new={} found={:?}", session_id, prev_ids.len(), new_ids.len(), found);

                if let Some(ref sid) = found {
                    let event_name = format!("pty-session-id-changed-{}", session_id);
                    let _ = app_handle.emit(&event_name,
                        serde_json::json!({"id": session_id, "sessionId": sid}));
                }
            });
        }

        Ok(info)
    }

    pub fn write(&self, id: &str, data: &str) -> Result<(), String> {
        self.sessions.lock().unwrap().get(id).ok_or_else(|| format!("Session {} not found", id))?.write(data)
    }

    pub fn resize(&self, id: &str, cols: u16, rows: u16) -> Result<(), String> {
        self.sessions.lock().unwrap().get(id).ok_or_else(|| format!("Session {} not found", id))?.resize(cols, rows)
    }

    pub fn kill(&self, id: &str) -> Result<(), String> {
        let mut sessions = self.sessions.lock().unwrap();
        sessions.get_mut(id).ok_or_else(|| format!("Session {} not found", id))?.kill();
        sessions.remove(id);
        Ok(())
    }

    pub fn list(&self) -> Vec<SessionInfo> {
        let sessions = self.sessions.lock().unwrap();
        let mut ids: Vec<&String> = sessions.keys().collect();
        ids.sort_by_key(|k| k.trim_start_matches('S').parse::<u32>().unwrap_or(0));
        ids.iter().filter_map(|k| sessions.get(*k).map(|s| s.info())).collect()
    }

    pub fn set_agent_session_id(&self, id: &str, sid: &str) -> Result<(), String> {
        self.sessions.lock().unwrap().get_mut(id).ok_or_else(|| format!("Session {} not found", id))?.set_agent_session_id(sid.into());
        Ok(())
    }

    pub fn kill_all(&self) {
        let mut sessions = self.sessions.lock().unwrap();
        for (_, s) in sessions.iter_mut() { s.kill(); }
        sessions.clear();
    }
}

/// Check if this agent supports session ID discovery via its database
fn is_snapshot_agent(agent: &str) -> bool {
    agent == "opencode" || agent == "codex"
}

/// Recursively collect .jsonl files from a directory tree
fn collect_jsonl_files(dir: &std::path::Path, out: &mut Vec<std::path::PathBuf>) {
    if let Ok(entries) = std::fs::read_dir(dir) {
        for entry in entries.filter_map(|e| e.ok()) {
            let path = entry.path();
            if path.is_dir() {
                collect_jsonl_files(&path, out);
            } else if path.extension().map_or(false, |ext| ext == "jsonl") {
                out.push(path);
            }
        }
    }
}

/// Get ALL known session IDs from the agent's database/storage.
/// Used for before/after diff to safely identify newly created sessions.
fn get_all_session_ids(agent: &str, _cwd: &str) -> Vec<String> {
    match agent {
        "opencode" => {
            match std::process::Command::new("cmd")
                .args(["/c", "opencode", "db", "SELECT id FROM session"])
                .output()
            {
                Ok(out) => {
                    let stdout = String::from_utf8_lossy(&out.stdout);
                    stdout
                        .lines()
                        .filter_map(|line| {
                            let trimmed = line.trim();
                            if trimmed.starts_with("ses_") {
                                Some(trimmed.to_string())
                            } else {
                                None
                            }
                        })
                        .collect()
                }
                Err(_) => vec![],
            }
        }
        "codex" => {
            if let Ok(home) = std::env::var("USERPROFILE") {
                let sessions_dir = std::path::PathBuf::from(home)
                    .join(".codex").join("sessions");
                let mut files: Vec<std::path::PathBuf> = Vec::new();
                collect_jsonl_files(&sessions_dir, &mut files);
                // Extract UUIDs from all rollout filenames
                return files
                    .iter()
                    .filter_map(|path| {
                        let name = path.file_name()?.to_str()?;
                        let stem = name.strip_suffix(".jsonl")?;
                        let parts: Vec<&str> = stem.rsplitn(6, '-').collect();
                        if parts.len() == 6 {
                            let uuid = parts[0..5].iter().rev().copied().collect::<Vec<_>>().join("-");
                            if uuid.len() >= 32 { Some(uuid) } else { None }
                        } else {
                            None
                        }
                    })
                    .collect();
            }
            vec![]
        }
        _ => vec![],
    }
}
