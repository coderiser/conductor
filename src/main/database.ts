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

export function saveLayout(layout: {
  sessions: { id: string; agent: string; cwd: string; agent_session_id: string }[];
  dockviewJson?: string;
  windowWidth?: number;
  windowHeight?: number;
}) {
  if (!db) return;

  db.prepare('DELETE FROM sessions').run();
  for (const s of layout.sessions) {
    db.prepare('INSERT INTO sessions (id, agent, cwd, agent_session_id) VALUES (?, ?, ?, ?)').run(s.id, s.agent, s.cwd, s.agent_session_id);
  }
  db.prepare('INSERT OR REPLACE INTO layout (id, dockview_json, window_width, window_height) VALUES (1, ?, ?, ?)').run(
    layout.dockviewJson ?? '[]',
    layout.windowWidth ?? 1400,
    layout.windowHeight ?? 900
  );
}

export function loadLayout() {
  if (!db) return null;

  const sessions = db.prepare('SELECT id, agent, cwd, agent_session_id FROM sessions').all() as any[];
  const layout = db.prepare('SELECT dockview_json, window_width, window_height FROM layout WHERE id=1').get() as any;

  return { sessions, dockview_json: layout?.dockview_json || '[]', window_width: layout?.window_width || 1400, window_height: layout?.window_height || 900 };
}
