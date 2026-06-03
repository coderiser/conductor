use crate::pty::session::{PtySession, SessionInfo};
use std::collections::HashMap;
use std::sync::Mutex;

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

    pub fn spawn(&self, agent: String, cwd: String, cols: u16, rows: u16, app: tauri::AppHandle) -> Result<SessionInfo, String> {
        let id = self.alloc_id();
        let s = PtySession::spawn(id.clone(), agent, cwd.clone(), cols, rows, app)?;
        let info = s.info();
        self.sessions.lock().unwrap().insert(id, s);
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
        self.sessions.lock().unwrap().values().map(|s| s.info()).collect()
    }

    pub fn kill_all(&self) {
        let mut sessions = self.sessions.lock().unwrap();
        for (_, s) in sessions.iter_mut() { s.kill(); }
        sessions.clear();
    }
}
