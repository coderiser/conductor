import fs from 'fs';
import path from 'path';
import { AgentConfig, DEFAULT_AGENTS, mapAgentEntry } from '../common/agent-config.js';

export type { AgentConfig };

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
