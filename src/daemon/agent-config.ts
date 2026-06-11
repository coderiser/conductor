import fs from 'fs';
import path from 'path';

/**
 * Agent configuration — defines how to spawn and manage an agent session.
 * This is the daemon-side equivalent of src/main/agent-config.ts.
 * Both must keep the AgentConfig interface in sync.
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
 *
 * Path resolution order:
 *   1. CONDUCTOR_AGENTS_CONFIG env var (set by daemon-client when spawning)
 *   2. Fallback: two directories up from this compiled file (works in dev mode)
 *
 * Falls back to built-in defaults if the file is missing or malformed.
 */
export function loadAgentConfig(): AgentConfig[] {
  const configPath = resolveConfigPath();
  if (!configPath || !fs.existsSync(configPath)) {
    return DEFAULT_AGENTS;
  }

  try {
    const raw = fs.readFileSync(configPath, 'utf-8');
    const parsed = JSON.parse(raw);
    return (parsed.agents || DEFAULT_AGENTS).map(mapAgentEntry);
  } catch {
    return DEFAULT_AGENTS;
  }
}

/** Resolve the path to agents.json using env var or __dirname fallback. */
function resolveConfigPath(): string | null {
  if (process.env.CONDUCTOR_AGENTS_CONFIG) {
    return process.env.CONDUCTOR_AGENTS_CONFIG;
  }
  // Dev mode: __dirname = dist/daemon → project root
  return path.resolve(__dirname, '..', '..', 'agents.json');
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
