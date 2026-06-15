// `conductor worktree list|cleanup` — manage Conductor-created git worktrees.
// Layout: <worktreesRoot>/<projectHash>/<agent>-<date>-<hex>/
import fs from 'node:fs';
import path from 'node:path';
import simpleGit from 'simple-git';
import { paths } from '../paths';
import { getDaemonStatus } from '../daemon-client';

interface WorktreeEntry {
  dir: string;
  branch: string;
  clean: boolean;
  active: boolean;
}

/** Collect worktree entries under worktreesRoot, tagging those whose cwd matches an active session. */
async function collect(): Promise<WorktreeEntry[]> {
  const entries: WorktreeEntry[] = [];
  if (!fs.existsSync(paths.worktreesRoot)) return entries;

  const ds = await getDaemonStatus();
  const activeCwds = new Set(ds.reachable ? ds.sessions.map((s) => path.resolve(s.cwd)) : []);

  for (const proj of fs.readdirSync(paths.worktreesRoot)) {
    const projDir = path.join(paths.worktreesRoot, proj);
    if (!fs.statSync(projDir).isDirectory()) continue;
    for (const name of fs.readdirSync(projDir)) {
      const wtDir = path.join(projDir, name);
      if (!fs.statSync(wtDir).isDirectory()) continue;
      let branch = '?';
      let clean = true;
      try {
        const git = simpleGit(wtDir);
        branch = (await git.revparse(['--abbrev-ref', 'HEAD'])).trim() || '?';
        const status = await git.status();
        clean = status.isClean();
      } catch { /* not a git worktree / orphan dir */ }
      entries.push({ dir: wtDir, branch, clean, active: activeCwds.has(path.resolve(wtDir)) });
    }
  }
  return entries;
}

/** `conductor worktree list` */
export async function list(): Promise<void> {
  const entries = await collect();
  if (entries.length === 0) {
    console.log('No worktrees.');
    return;
  }
  console.log(`Worktrees (${entries.length}) under ${paths.worktreesRoot}:`);
  for (const e of entries) {
    const flag = e.active ? 'ACTIVE' : e.clean ? '      ' : 'DIRTY';
    console.log(`  [${flag}] ${e.dir}`);
    console.log(`           branch=${e.branch}`);
  }
}

/** `conductor worktree cleanup [--force]` — remove non-active worktrees (protects dirty unless --force). */
export async function cleanup(force: boolean): Promise<void> {
  const entries = await collect();
  const removable = entries.filter((e) => !e.active);
  if (removable.length === 0) {
    console.log('Nothing to clean (all worktrees are active or none exist).');
    return;
  }
  let removed = 0;
  let skipped = 0;
  for (const e of removable) {
    if (!e.clean && !force) {
      console.log(`  SKIP (dirty, use --force): ${e.dir}`);
      skipped++;
      continue;
    }
    try {
      fs.rmSync(e.dir, { recursive: true, force: true });
      console.log(`  REMOVED: ${e.dir}`);
      removed++;
    } catch (err) {
      console.log(`  SKIP (error: ${(err as Error).message}): ${e.dir}`);
      skipped++;
    }
  }
  console.log(`\nRemoved ${removed}, skipped ${skipped}.`);
  if (removed > 0) {
    console.log('Run `git worktree prune` in your project repo to clean git\'s worktree registry.');
  }
}
