import fs from 'fs';
import path from 'path';
import { app } from 'electron';
import { execFileSync } from 'child_process';
import { AgentConfig, DEFAULT_AGENTS, mapAgentEntry } from '../common/agent-config.js';

export type { AgentConfig };
export { DEFAULT_AGENTS } from '../common/agent-config.js';

/**
 * Load agent configuration from agents.json.
 * The file is expected in userData (copied there from the app bundle on first run).
 * If not found, creates it with defaults and returns defaults.
 */
export function loadAgentConfig(): AgentConfig[] {
  const configPath = path.join(app.getPath('userData'), 'agents.json');
  console.log('[loadAgentConfig] path:', configPath, 'exists:', fs.existsSync(configPath));

  if (!fs.existsSync(configPath)) {
    fs.writeFileSync(configPath, JSON.stringify({ agents: DEFAULT_AGENTS }, null, 2));
    return DEFAULT_AGENTS;
  }

  try {
    const raw = fs.readFileSync(configPath, 'utf-8');
    const config = JSON.parse(raw);
    const agents = (config.agents || DEFAULT_AGENTS).map(mapAgentEntry);
    const claude = agents.find(a => a.id === 'claude');
    console.log('[loadAgentConfig] claude worktree:', JSON.stringify(claude?.worktree));
    return agents;
  } catch (err) {
    console.error('[loadAgentConfig] error:', err);
    return DEFAULT_AGENTS;
  }
}

/** Check whether a command is available on the system PATH. */
export function isAgentInstalled(command: string): boolean {
  try {
    if (process.platform === 'win32') {
      execFileSync('where', [command], { stdio: 'ignore', windowsHide: true });
    } else {
      execFileSync('command', ['-v', command], { stdio: 'ignore' });
    }
    return true;
  } catch {
    return false;
  }
}
