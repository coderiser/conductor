import { EventEmitter } from 'events';
import fs from 'node:fs';

interface WatcherConfig {
  debounceMs: number;
}

interface ChangeEvent {
  sessionId: string;
  worktreePath: string;
  files: string[];
}

interface WatchEntry {
  sessionId: string;
  worktreePath: string;
  fsWatcher: fs.FSWatcher;
  debounceTimer: ReturnType<typeof setTimeout> | null;
  pendingFiles: Set<string>;
}

export class WorktreeWatcher extends EventEmitter {
  private entries = new Map<string, WatchEntry>();
  private config: WatcherConfig;

  constructor(config: Partial<WatcherConfig> = {}) {
    super();
    this.config = { debounceMs: 300, ...config };
  }

  watch(sessionId: string, worktreePath: string): void {
    if (this.entries.has(sessionId)) {
      this.unwatch(sessionId);
    }

    const entry: WatchEntry = {
      sessionId,
      worktreePath,
      fsWatcher: null as unknown as fs.FSWatcher,
      debounceTimer: null,
      pendingFiles: new Set(),
    };

    try {
      entry.fsWatcher = fs.watch(worktreePath, { recursive: true }, (eventType, filename) => {
        if (!filename) return;
        // Normalize path separators
        const normalized = filename.replace(/\\/g, '/');
        // Skip .git internal files that don't represent user changes
        if (normalized.startsWith('.git/')) return;

        entry.pendingFiles.add(normalized);

        if (entry.debounceTimer) clearTimeout(entry.debounceTimer);
        entry.debounceTimer = setTimeout(() => {
          this.flush(entry);
        }, this.config.debounceMs);
      });

      entry.fsWatcher.on('error', () => {
        this.cleanupEntry(sessionId);
      });
    } catch {
      return;
    }

    this.entries.set(sessionId, entry);
  }

  private flush(entry: WatchEntry): void {
    if (entry.pendingFiles.size === 0) return;
    const files = Array.from(entry.pendingFiles);
    entry.pendingFiles.clear();
    entry.debounceTimer = null;

    const event: ChangeEvent = {
      sessionId: entry.sessionId,
      worktreePath: entry.worktreePath,
      files,
    };
    this.emit('change', event);
  }

  unwatch(sessionId: string): void {
    this.cleanupEntry(sessionId);
  }

  private cleanupEntry(sessionId: string): void {
    const entry = this.entries.get(sessionId);
    if (!entry) return;
    if (entry.debounceTimer) clearTimeout(entry.debounceTimer);
    try { entry.fsWatcher?.close(); } catch {}
    this.entries.delete(sessionId);
  }

  getWatchedSessions(): string[] {
    return Array.from(this.entries.keys());
  }

  dispose(): void {
    for (const sessionId of this.entries.keys()) {
      this.cleanupEntry(sessionId);
    }
    this.removeAllListeners();
  }
}
