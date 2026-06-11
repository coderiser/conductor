import fs from 'fs';
import path from 'path';
import { app } from 'electron';
import { execSync } from 'child_process';

/**
 * Agent configuration — defines how to spawn and manage an agent session.
 * This interface is used by both the Electron main process and the daemon process.
 * The daemon has its own copy in src/daemon/agent-config.ts.
 */
export interface AgentConfig {
  id: string;
  name: string;
  command: string;
  args: string[];
  createTemplate: string;
  resumeTemplate: string;
  setup: string[];
  builtin: boolean;
}

/** Default agents shipped with the app. */
export const DEFAULT_AGENTS: AgentConfig[] = [
  { id: 'cmd', name: 'Command Prompt', command: 'cmd.exe', args: [], createTemplate: '', resumeTemplate: '', setup: [], builtin: true },
  { id: 'claude', name: 'Claude Code', command: 'claude', args: ['--allow-dangerously-skip-permissions'], createTemplate: '--session-id {session_id}', resumeTemplate: '--resume {session_id}', setup: [], builtin: false },
  { id: 'opencode', name: 'OpenCode', command: 'opencode', args: [], createTemplate: '', resumeTemplate: '--session {session_id}', setup: [], builtin: false },
  { id: 'codex', name: 'Codex', command: 'codex', args: [], createTemplate: '', resumeTemplate: 'resume --last', setup: [], builtin: false },
];

/**
 * Load agent configuration from agents.json.
 * The file is expected in userData (copied there from the app bundle on first run).
 * If not found, creates it with defaults and returns defaults.
 */
export function loadAgentConfig(): AgentConfig[] {
  const configPath = path.join(app.getPath('userData'), 'agents.json');

  if (!fs.existsSync(configPath)) {
    fs.writeFileSync(configPath, JSON.stringify({ agents: DEFAULT_AGENTS }, null, 2));
    return DEFAULT_AGENTS;
  }

  try {
    const raw = fs.readFileSync(configPath, 'utf-8');
    const config = JSON.parse(raw);
    const agents = (config.agents || DEFAULT_AGENTS).map(mapAgentEntry);
    return agents;
  } catch {
    return DEFAULT_AGENTS;
  }
}

/** Check whether a command is available on the system PATH. */
export function isAgentInstalled(command: string): boolean {
  try {
    if (process.platform === 'win32') {
      execSync(`where ${command}`, { stdio: 'ignore' });
    } else {
      execSync(`command -v ${command}`, { stdio: 'ignore' });
    }
    return true;
  } catch {
    return false;
  }
}

/** Map a raw agents.json entry to AgentConfig, handling snake_case → camelCase. */
function mapAgentEntry(entry: any): AgentConfig {
  return {
    id: entry.id ?? '',
    name: entry.name ?? entry.id ?? '',
    command: entry.command ?? '',
    args: entry.args ?? [],
    createTemplate: entry.create_template ?? entry.createTemplate ?? '',
    resumeTemplate: entry.resume_template ?? entry.resumeTemplate ?? '',
    setup: entry.setup ?? [],
    builtin: entry.builtin ?? false,
  };
}
