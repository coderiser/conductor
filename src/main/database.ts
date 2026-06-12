// src/main/database.ts

import Database from 'better-sqlite3';
import path from 'path';
import { app } from 'electron';
import type { TaskRecord, ContextEntry } from '../common/stats-types';

interface LayoutData {
  sessions: { id: string; agent: string; cwd: string; agent_session_id: string }[];
  dockviewJson?: string;
  windowWidth?: number;
  windowHeight?: number;
}

interface SessionRow { id: string; agent: string; cwd: string; agent_session_id: string; }
interface LayoutRow { dockview_json: string; window_width: number; window_height: number; }

let db: Database.Database | null = null;

export function initDatabase() {
  try {
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

      CREATE TABLE IF NOT EXISTS agent_stats (
        session_id TEXT PRIMARY KEY,
        agent TEXT NOT NULL,
        token_count INTEGER DEFAULT 0,
        estimated_cost REAL DEFAULT 0,
        health_score INTEGER DEFAULT 100,
        status TEXT NOT NULL DEFAULT 'starting',
        error_count INTEGER DEFAULT 0,
        started_at TEXT NOT NULL,
        last_activity TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS task_queue (
        id TEXT PRIMARY KEY,
        title TEXT NOT NULL,
        description TEXT DEFAULT '',
        priority TEXT NOT NULL DEFAULT 'normal',
        required_capabilities TEXT NOT NULL DEFAULT '[]',
        assigned_agent TEXT,
        assigned_session TEXT,
        status TEXT NOT NULL DEFAULT 'pending',
        progress REAL DEFAULT 0,
        created_at INTEGER NOT NULL,
        started_at INTEGER,
        completed_at INTEGER,
        result TEXT,
        error TEXT
      );

      CREATE TABLE IF NOT EXISTS context_entries (
        id TEXT PRIMARY KEY,
        session_id TEXT NOT NULL,
        agent_id TEXT NOT NULL,
        context_type TEXT NOT NULL,
        title TEXT NOT NULL,
        body TEXT DEFAULT '',
        tags TEXT DEFAULT '[]',
        priority TEXT DEFAULT 'normal',
        timestamp INTEGER NOT NULL,
        consumed INTEGER DEFAULT 0
      );
    `);
  } catch (err) {
    console.error('[Database] Failed to initialize:', err);
    db = null;
  }
}

export function saveLayout(layout: LayoutData) {
  if (!db) return;
  const conn = db; // narrow for closure

  const saveAll = conn.transaction((sessions: LayoutData['sessions'], dockviewJson: string, windowWidth: number, windowHeight: number) => {
    conn.prepare('DELETE FROM sessions').run();
    const insert = conn.prepare('INSERT INTO sessions (id, agent, cwd, agent_session_id) VALUES (?, ?, ?, ?)');
    for (const s of sessions) insert.run(s.id ?? '', s.agent ?? '', s.cwd ?? '', s.agent_session_id ?? '');
    conn.prepare('INSERT OR REPLACE INTO layout (id, dockview_json, window_width, window_height) VALUES (1, ?, ?, ?)').run(
      dockviewJson ?? '', Number(windowWidth) || 1400, Number(windowHeight) || 900
    );
  });
  saveAll(layout.sessions, layout.dockviewJson ?? '[]', layout.windowWidth ?? 1400, layout.windowHeight ?? 900);
}

export function loadLayout(): { sessions: SessionRow[]; dockview_json: string; window_width: number; window_height: number } | null {
  if (!db) return null;

  const sessions = db.prepare('SELECT id, agent, cwd, agent_session_id FROM sessions').all() as SessionRow[];
  const layout = db.prepare('SELECT dockview_json, window_width, window_height FROM layout WHERE id=1').get() as LayoutRow | undefined;

  return { sessions, dockview_json: layout?.dockview_json ?? '[]', window_width: layout?.window_width ?? 1400, window_height: layout?.window_height ?? 900 };
}

// ── Agent Stats ──────────────────────────────────────────────────────────

interface AgentStatsInput {
  sessionId: string;
  agent: string;
  tokenCount: number;
  estimatedCost: number;
  healthScore: number;
  status: string;
  errorCount: number;
  startTime: number;
  lastActivity: number;
}

export function saveAgentStats(stats: AgentStatsInput[]) {
  if (!db || stats.length === 0) return;
  const conn = db;

  const saveAll = conn.transaction((rows: AgentStatsInput[]) => {
    const stmt = conn.prepare(`
      INSERT OR REPLACE INTO agent_stats
      (session_id, agent, token_count, estimated_cost, health_score, status, error_count, started_at, last_activity)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    for (const r of rows) {
      stmt.run(
        r.sessionId ?? '',
        r.agent ?? '',
        r.tokenCount ?? 0,
        r.estimatedCost ?? 0,
        r.healthScore ?? 100,
        r.status ?? 'starting',
        r.errorCount ?? 0,
        new Date(r.startTime).toISOString(),
        new Date(r.lastActivity).toISOString()
      );
    }
  });
  saveAll(stats);
}

export interface AgentStatsRow {
  session_id: string;
  agent: string;
  token_count: number;
  estimated_cost: number;
  health_score: number;
  status: string;
  error_count: number;
  started_at: string;
  last_activity: string;
}

export function loadAgentStats(): AgentStatsRow[] {
  if (!db) return [];
  return db.prepare('SELECT * FROM agent_stats ORDER BY started_at DESC').all() as AgentStatsRow[];
}

// ── Task Queue persistence (Phase 4) ──────────────────────────────────────

export function saveTask(task: TaskRecord): void {
  if (!db) return;
  const stmt = db.prepare(`
    INSERT OR REPLACE INTO task_queue
      (id, title, description, priority, required_capabilities, assigned_agent,
       assigned_session, status, progress, created_at, started_at, completed_at, result, error)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  stmt.run(
    task.id, task.title, task.description, task.priority,
    JSON.stringify(task.requiredCapabilities), task.assignedAgent ?? null,
    task.assignedSession ?? null, task.status, task.progress, task.createdAt,
    task.startedAt ?? null, task.completedAt ?? null, task.result ?? null, task.error ?? null
  );
}

export function loadTasks(): TaskRecord[] {
  if (!db) return [];
  const rows = db.prepare('SELECT * FROM task_queue ORDER BY created_at DESC').all() as any[];
  return rows.map((r: any) => ({
    id: r.id, title: r.title, description: r.description,
    priority: r.priority, requiredCapabilities: JSON.parse(r.required_capabilities),
    assignedAgent: r.assigned_agent, assignedSession: r.assigned_session,
    status: r.status, progress: r.progress, createdAt: r.created_at,
    startedAt: r.started_at, completedAt: r.completed_at,
    result: r.result, error: r.error,
  }));
}

// ── Context Sharing persistence (Phase 4) ─────────────────────────────────

export function saveContextEntry(entry: ContextEntry): void {
  if (!db) return;
  const stmt = db.prepare(`
    INSERT OR REPLACE INTO context_entries
      (id, session_id, agent_id, context_type, title, body, tags, priority, timestamp, consumed)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  stmt.run(entry.id, entry.sessionId, entry.agentId, entry.contextType,
    entry.title, entry.body, JSON.stringify(entry.tags), entry.priority,
    entry.timestamp, entry.consumed ? 1 : 0);
}

export function loadContextEntries(): ContextEntry[] {
  if (!db) return [];
  const rows = db.prepare('SELECT * FROM context_entries ORDER BY timestamp DESC').all() as any[];
  return rows.map((r: any) => ({
    id: r.id, sessionId: r.session_id, agentId: r.agent_id,
    contextType: r.context_type, title: r.title, body: r.body,
    tags: JSON.parse(r.tags), priority: r.priority,
    timestamp: r.timestamp, consumed: r.consumed === 1,
  }));
}
