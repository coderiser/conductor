// src/daemon/session-recovery.ts

import { spawnSync } from 'child_process';
import { existsSync, readdirSync } from 'fs';
import path from 'path';
import os from 'os';

export function discoverSessionIds(agent: string, cwd: string): string[] {
  if (agent === 'opencode') {
    return discoverOpenCodeSessions(cwd);
  }
  if (agent === 'codex') {
    return discoverCodexSessions();
  }
  return [];
}

function discoverOpenCodeSessions(cwd: string): string[] {
  try {
    const result = spawnSync('opencode', ['db', 'SELECT id FROM session'], { cwd });
    if (result.error) return [];
    return result.stdout
      .toString()
      .split('\n')
      .filter((l: string) => l.trim().startsWith('ses_'));
  } catch {
    return [];
  }
}

function discoverCodexSessions(): string[] {
  const dir = path.join(os.homedir(), '.codex', 'sessions');
  if (!existsSync(dir)) return [];

  const files = readdirSync(dir);
  const sessionIds: string[] = [];

  for (const file of files) {
    if (file.startsWith('rollout-') && file.endsWith('.jsonl')) {
      const match = file.match(/rollout-(\d+)-(.+)\.jsonl/);
      if (match) {
        sessionIds.push(match[2]);
      }
    }
  }

  return sessionIds;
}
