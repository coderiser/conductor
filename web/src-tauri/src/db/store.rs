use rusqlite::{params, Connection};
use serde::{Deserialize, Serialize};
use std::sync::Mutex;

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SavedSession { pub id: String, pub agent: String, pub cwd: String }

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SavedLayout { pub sessions: Vec<SavedSession>, pub dockview_json: String, pub window_width: u32, pub window_height: u32 }

pub struct DbStore { conn: Mutex<Connection> }

impl DbStore {
    pub fn new() -> Result<Self, Box<dyn std::error::Error>> {
        let dir = crate::config::config_dir();
        let conn = Connection::open(dir.join("conductor.db"))?;
        conn.execute_batch("CREATE TABLE IF NOT EXISTS layout (id INTEGER PRIMARY KEY CHECK(id=1), dockview_json TEXT NOT NULL DEFAULT '', window_width INTEGER NOT NULL DEFAULT 1400, window_height INTEGER NOT NULL DEFAULT 900, updated_at TEXT NOT NULL DEFAULT(datetime('now'))); CREATE TABLE IF NOT EXISTS sessions (id TEXT PRIMARY KEY, agent TEXT NOT NULL, cwd TEXT NOT NULL);")?;
        Ok(Self { conn: Mutex::new(conn) })
    }

    pub fn save_layout(&self, layout: &SavedLayout) -> Result<(), rusqlite::Error> {
        let conn = self.conn.lock().unwrap();
        conn.execute("DELETE FROM sessions", [])?;
        for s in &layout.sessions {
            conn.execute("INSERT INTO sessions (id,agent,cwd) VALUES (?1,?2,?3)", params![s.id, s.agent, s.cwd])?;
        }
        conn.execute("INSERT OR REPLACE INTO layout (id,dockview_json,window_width,window_height) VALUES (1,?1,?2,?3)", params![layout.dockview_json, layout.window_width, layout.window_height])?;
        Ok(())
    }

    pub fn load_layout(&self) -> Result<Option<SavedLayout>, rusqlite::Error> {
        let conn = self.conn.lock().unwrap();
        let Some((dj, ww, wh)) = conn.query_row("SELECT dockview_json, window_width, window_height FROM layout WHERE id=1", [], |r| Ok((r.get::<_,String>(0)?, r.get::<_,u32>(1)?, r.get::<_,u32>(2)?))).ok() else { return Ok(None) };
        let mut stmt = conn.prepare("SELECT id, agent, cwd FROM sessions")?;
        let sessions = stmt.query_map([], |r| Ok(SavedSession { id: r.get(0)?, agent: r.get(1)?, cwd: r.get(2)? }))?.filter_map(|r| r.ok()).collect();
        Ok(Some(SavedLayout { sessions, dockview_json: dj, window_width: ww, window_height: wh }))
    }
}
