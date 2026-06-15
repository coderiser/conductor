// `conductor agents list|add|remove|edit` — manage agents.json (snake_case on disk).
import fs from 'node:fs';
import { paths, ensureUserDataDir } from '../paths';

interface RawAgent { [k: string]: any }

/** Read raw agents.json (creating defaults if absent). Returns the parsed object. */
function readConfig(): { agents: RawAgent[] } {
  if (!fs.existsSync(paths.agentsJson)) {
    return { agents: [] };
  }
  try {
    const cfg = JSON.parse(fs.readFileSync(paths.agentsJson, 'utf-8'));
    if (!Array.isArray(cfg.agents)) cfg.agents = [];
    return cfg;
  } catch (e) {
    console.error(`agents.json invalid: ${(e as Error).message}`);
    process.exit(1);
  }
}

function writeConfig(cfg: { agents: RawAgent[] }): void {
  ensureUserDataDir();
  fs.writeFileSync(paths.agentsJson, JSON.stringify(cfg, null, 2), 'utf-8');
}

/** `conductor agents list` */
export function list(): void {
  const cfg = readConfig();
  if (cfg.agents.length === 0) {
    console.log('No agents configured.');
    return;
  }
  console.log(`Agents (${cfg.agents.length}) in ${paths.agentsJson}:`);
  for (const a of cfg.agents) {
    const wt = a.worktree ? `worktree=${a.worktree.enabled ? 'on' : 'off'}` : 'worktree=off';
    console.log(`  ${String(a.id).padEnd(10)} ${String(a.name).padEnd(16)} cmd=${a.command}  ${wt}`);
    if (a.create_template) console.log(`             create:  ${a.create_template}`);
    if (a.resume_template) console.log(`             resume:  ${a.resume_template}`);
  }
}

/** Flags that take a value (always consume the next arg, even if it starts with --,
 *  so templates like "--session-id {session_id}" parse correctly). */
const VALUE_FLAGS = new Set(['id', 'name', 'command', 'create', 'resume', 'base-branch']);
/** Boolean flags (no value). */
const BOOL_FLAGS = new Set(['worktree']);

/** Parse --flag value pairs from an argv slice. */
function parseFlags(args: string[]): Record<string, string | boolean> {
  const out: Record<string, string | boolean> = {};
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (!a.startsWith('--')) continue;
    const key = a.slice(2);
    if (BOOL_FLAGS.has(key)) { out[key] = true; continue; }
    // value flag: consume next arg unconditionally
    if (i + 1 < args.length) { out[key] = args[++i]; }
    else out[key] = true;
  }
  return out;
}

/** `conductor agents add --id ... --name ... --command ... [--create ...] [--resume ...] [--worktree] [--base-branch ...]` */
export function add(args: string[]): void {
  const f = parseFlags(args);
  const id = String(f.id ?? '');
  if (!id) { console.error('add requires --id'); process.exit(1); }
  const cfg = readConfig();
  if (cfg.agents.some((a) => a.id === id)) {
    console.error(`Agent "${id}" already exists. Use \`agents edit\`.`);
    process.exit(1);
  }
  const entry: RawAgent = {
    id,
    name: String(f.name ?? id),
    command: String(f.command ?? id),
    args: [],
    create_template: String(f.create ?? ''),
    resume_template: String(f.resume ?? ''),
    setup: [],
    builtin: false,
    capabilities: ['code-gen', 'code-review', 'shell', 'file-ops'],
  };
  if (f.worktree) {
    entry.worktree = { enabled: true, base_branch: String(f['base-branch'] ?? 'main'), cleanup: 'keep' };
  }
  cfg.agents.push(entry);
  writeConfig(cfg);
  console.log(`Added agent "${id}". Run \`conductor daemon restart\` for it to take effect.`);
}

/** `conductor agents remove <id>` */
export function remove(id: string): void {
  if (!id) { console.error('Usage: conductor agents remove <id>'); process.exit(1); }
  const cfg = readConfig();
  const before = cfg.agents.length;
  cfg.agents = cfg.agents.filter((a) => a.id !== id);
  if (cfg.agents.length === before) {
    console.error(`Agent "${id}" not found.`);
    process.exit(1);
  }
  writeConfig(cfg);
  console.log(`Removed agent "${id}". Run \`conductor daemon restart\` for it to take effect.`);
}

const FIELD_ALIASES: Record<string, string> = {
  name: 'name', command: 'command', create: 'create_template', create_template: 'create_template',
  resume: 'resume_template', resume_template: 'resume_template',
};

/** `conductor agents edit <id> <field> <value>` */
export function edit(args: string[]): void {
  const [id, field, ...rest] = args;
  const value = rest.join(' ');
  if (!id || !field || !value) {
    console.error('Usage: conductor agents edit <id> <field> <value>');
    console.error('Fields: name | command | create | resume');
    process.exit(1);
  }
  const key = FIELD_ALIASES[field];
  if (!key) {
    console.error(`Unknown field "${field}". Supported: name | command | create | resume`);
    process.exit(1);
  }
  const cfg = readConfig();
  const agent = cfg.agents.find((a) => a.id === id);
  if (!agent) { console.error(`Agent "${id}" not found.`); process.exit(1); }
  agent[key] = value;
  writeConfig(cfg);
  console.log(`Set ${id}.${field} = ${value}. Run \`conductor daemon restart\` for it to take effect.`);
}
