# Phase 3: Git Worktree 隔离 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Each AI agent gets an isolated git worktree outside the project root (`~/.conductor/worktrees/`), with event-driven conflict detection and verified cleanup.

**Architecture:** WorktreeManager runs in the Electron main process (not daemon) using simple-git. WorktreeWatcher uses `fs.watch` on `.git/` directories — event-driven, no polling. Git ref resolution uses discriminated unions (local always wins over remote-tracking). Worktree paths go under `~/.conductor/worktrees/{project-hash}/{agent}-{date}-{hex}/`.

**Tech Stack:** simple-git 3.x, better-sqlite3, node:fs.watch, node:crypto, React (inline styles)

**Design spec:** `docs/superpowers/specs/2026-06-11-electron-migration-design.md` Section 3

---

## File Structure

```
Create:
  src/common/worktree-types.ts           — ResolvedRef, WorktreeInfo, ConflictReport, CleanupOptions
  src/main/worktree-manager.ts           — createForAgent / cleanup / detectConflicts / resolveRef / restoreFromRow
  src/main/worktree-watcher.ts           — fs.watch .git/ + 300ms debounce + onChange
  src/renderer/components/WorktreeBadge.tsx — Inline branch + path indicator
  tests/worktree-manager.test.ts
  tests/worktree-watcher.test.ts

Modify:
  src/main/database.ts                   — CREATE TABLE worktrees + saveWorktree/loadWorktrees/deleteWorktree
  src/main/ipc-handlers.ts              — add worktreeManager + worktreeWatcher params + 5 new handlers
  src/main/index.ts                      — init WorktreeManager + WorktreeWatcher + restore + cleanup
  src/preload/index.ts                   — 5 worktree APIs
  src/renderer/global.d.ts               — ElectronAPI worktree methods
  src/renderer/components/Sidebar.tsx    — WorktreeBadge per session + Conflicts section
  src/renderer/App.tsx                   — worktree polling + conflict push + pass to Sidebar
  src/daemon/protocol/messages.ts        — spawn message adds optional worktree field
```

---

### Task 1: Shared Worktree Types

**Files:**
- Create: `src/common/worktree-types.ts`

- [ ] **Step 1: Create types file**

```typescript
// src/common/worktree-types.ts
// Shared types for git worktree isolation.
// Used by Electron main (WorktreeManager, WorktreeWatcher) and renderer (Sidebar).

/** Discriminated union — downstream code never re-derives ref type from string.
 *  Resolution: local > remote-tracking > tag > head.
 *  A local branch named 'origin/foo' still resolves as kind:'local'. */
export type ResolvedRef =
  | { kind: 'local';            fullRef: string; shortName: string }
  | { kind: 'remote-tracking';  fullRef: string; shortName: string; remote: string }
  | { kind: 'tag';              fullRef: string; shortName: string }
  | { kind: 'head' };

export interface WorktreeInfo {
  id: string;
  sessionId: string;
  agentId: string;
  worktreePath: string;
  branch: string;
  baseBranch: string;
  projectPath: string;
  createdAt: number;
  status: 'creating' | 'ready' | 'cleanup' | 'removed';
}

export interface CleanupOptions {
  keepBranch: boolean;
  force: boolean;
}

export interface ConflictReport {
  hasConflicts: boolean;
  conflicts: Array<{
    file: string;
    worktrees: string[];
    branches: string[];
  }>;
}

/** Persisted row shape */
export interface WorktreeRow {
  id: string;
  session_id: string;
  agent_id: string;
  worktree_path: string;
  branch: string;
  base_branch: string;
  project_path: string;
  created_at: number;
  status: string;
}
```

- [ ] **Step 2: Verify build**

Run: `npx tsc --noEmit`
Expected: No errors

- [ ] **Step 3: Commit**

```bash
git add src/common/worktree-types.ts
git commit -m "feat(phase3): add shared worktree types (ResolvedRef, WorktreeInfo, ConflictReport)

Co-Authored-By: Claude <noreply@anthropic.com>"
```

---

### Task 2: WorktreeManager — Creation + Ref Resolution

**Files:**
- Create: `src/main/worktree-manager.ts`
- Test: `tests/worktree-manager.test.ts`

- [ ] **Step 1: Write tests**

```typescript
// tests/worktree-manager.test.ts
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import path from 'path';
import fs from 'fs';
import os from 'os';
import simpleGit from 'simple-git';
import { WorktreeManager } from '../src/main/worktree-manager';

describe('WorktreeManager', () => {
  let manager: WorktreeManager;
  let testRepo: string;
  let git: ReturnType<typeof simpleGit>;

  beforeEach(async () => {
    testRepo = path.join(os.tmpdir(), 'conductor-wt-' + Math.random().toString(36).slice(2, 8));
    fs.mkdirSync(testRepo, { recursive: true });
    git = simpleGit(testRepo);
    await git.init();
    // Need user.name for git operations
    await git.addConfig('user.name', 'test');
    await git.addConfig('user.email', 'test@test.com');
    fs.writeFileSync(path.join(testRepo, 'README.md'), '# Test');
    await git.add('README.md');
    await git.commit('initial');
    manager = new WorktreeManager();
  });

  afterEach(() => {
    manager.dispose();
    try { fs.rmSync(testRepo, { recursive: true, force: true }); } catch {}
  });

  it('should create a worktree for an agent', async () => {
    const info = await manager.createForAgent('S1', 'claude', testRepo, 'main');
    expect(info.sessionId).toBe('S1');
    expect(info.status).toBe('ready');
    expect(fs.existsSync(info.worktreePath)).toBe(true);
    expect(info.worktreePath).toContain(path.join(os.homedir(), '.conductor', 'worktrees'));
    expect(info.branch).toMatch(/^conductor\/claude\//);
  });

  it('should create worktrees with unique paths and branches', async () => {
    const a = await manager.createForAgent('S1', 'claude', testRepo, 'main');
    const b = await manager.createForAgent('S2', 'opencode', testRepo, 'main');
    expect(a.worktreePath).not.toBe(b.worktreePath);
    expect(a.branch).not.toBe(b.branch);
  });

  it('should return empty list when no worktrees', () => {
    expect(manager.list()).toEqual([]);
  });

  it('should list all active worktrees', async () => {
    await manager.createForAgent('S1', 'claude', testRepo, 'main');
    await manager.createForAgent('S2', 'opencode', testRepo, 'main');
    expect(manager.list().length).toBe(2);
  });

  it('should get worktree by session id', async () => {
    const info = await manager.createForAgent('S1', 'claude', testRepo, 'main');
    const found = manager.getBySession('S1');
    expect(found).toBeDefined();
    expect(found!.branch).toBe(info.branch);
  });

  it('should return undefined for unknown session', () => {
    expect(manager.getBySession('unknown')).toBeUndefined();
  });

  it('should create branch from base commit', async () => {
    const info = await manager.createForAgent('S1', 'claude', testRepo, 'main');
    const wtGit = simpleGit(info.worktreePath);
    const log = await wtGit.log();
    expect(log.all.length).toBeGreaterThanOrEqual(1);
    const branches = await git.branch();
    expect(branches.all).toContain(info.branch);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run tests/worktree-manager.test.ts`
Expected: FAIL — module not found

- [ ] **Step 3: Implement WorktreeManager creation**

```typescript
// src/main/worktree-manager.ts
import path from 'node:path';
import fs from 'node:fs';
import { homedir } from 'node:os';
import crypto from 'node:crypto';
import simpleGit, { type SimpleGit } from 'simple-git';
import type { WorktreeInfo, ResolvedRef, CleanupOptions, ConflictReport, WorktreeRow } from '../common/worktree-types';

export class WorktreeManager {
  private gitInstances = new Map<string, SimpleGit>();
  private activeWorktrees = new Map<string, WorktreeInfo>();

  static worktreesRoot(): string {
    return path.join(homedir(), '.conductor', 'worktrees');
  }

  static projectHash(projectPath: string): string {
    return crypto.createHash('sha256')
      .update(path.resolve(projectPath))
      .digest('hex').slice(0, 12);
  }

  static worktreeDir(projectPath: string, agentId: string): string {
    const hash = WorktreeManager.projectHash(projectPath);
    const date = new Date().toISOString().slice(0, 10).replace(/-/g, '');
    const shortId = crypto.randomBytes(4).toString('hex');
    return path.join(WorktreeManager.worktreesRoot(), hash,
      `${agentId}-${date}-${shortId}`);
  }

  private getGit(projectPath: string): SimpleGit {
    let git = this.gitInstances.get(projectPath);
    if (!git) {
      git = simpleGit(projectPath);
      this.gitInstances.set(projectPath, git);
    }
    return git;
  }

  // ═══ Git Ref Resolution ═══

  /**
   * Resolve user-supplied ref string against FULL refnames.
   * Resolution order: local > remote-tracking > tag. Returns null if nothing matches.
   */
  async resolveRef(
    git: SimpleGit, input: string, remote: string = 'origin'
  ): Promise<ResolvedRef | null> {
    const trimmed = input.trim();
    if (!trimmed) return null;

    // 1. Local branch — ALWAYS first (even for names like origin/foo)
    const localRef = `refs/heads/${trimmed}`;
    if (await this.refExists(git, localRef)) {
      return { kind: 'local', fullRef: localRef, shortName: trimmed };
    }

    // 2. Remote-tracking — strip <remote>/ prefix if present
    const prefix = `${remote}/`;
    const remoteName = trimmed.startsWith(prefix)
      ? trimmed.slice(prefix.length) : trimmed;
    const remoteRef = `refs/remotes/${remote}/${remoteName}`;
    if (await this.refExists(git, remoteRef)) {
      return { kind: 'remote-tracking', fullRef: remoteRef,
        shortName: remoteName, remote };
    }

    // 3. Tag
    const tagRef = `refs/tags/${trimmed}`;
    if (await this.refExists(git, tagRef)) {
      return { kind: 'tag', fullRef: tagRef, shortName: trimmed };
    }

    return null;
  }

  private async refExists(git: SimpleGit, fullRef: string): Promise<boolean> {
    try {
      const out = await git.raw(['rev-parse', '--verify', `${fullRef}^{commit}`]);
      return /^[0-9a-f]{40,}/.test(out.trim());
    } catch { return false; }
  }

  // ═══ Worktree Creation ═══

  /**
   * Create a worktree for an agent session.
   * Steps: prune → resolve baseBranch → fetch if remote → worktree add --no-track → rollback on failure
   */
  async createForAgent(
    sessionId: string, agentId: string, projectPath: string,
    baseBranch: string = 'main',
  ): Promise<WorktreeInfo> {
    const git = this.getGit(projectPath);
    const worktreePath = WorktreeManager.worktreeDir(projectPath, agentId);
    const branchName = `conductor/${agentId}/${Date.now().toString(36)}`;

    await git.raw(['worktree', 'prune']).catch(() => {});
    fs.mkdirSync(path.dirname(worktreePath), { recursive: true });

    let startPoint: ResolvedRef = { kind: 'head' };
    const resolved = await this.resolveRef(git, baseBranch);
    if (resolved) startPoint = resolved;

    if (startPoint.kind === 'remote-tracking') {
      await git.fetch([startPoint.remote, startPoint.shortName, '--quiet', '--no-tags'])
        .catch((err: unknown) => console.warn(
          `[worktree] fetch ${startPoint.remote}/${startPoint.shortName} failed:`, err));
    }

    const startPointArg = startPoint.kind === 'head' ? 'HEAD'
      : startPoint.kind === 'remote-tracking'
        ? `${startPoint.remote}/${startPoint.shortName}`
      : startPoint.shortName;

    let worktreeCreated = false;
    try {
      await git.raw([
        'worktree', 'add', '--no-track', '-b', branchName,
        worktreePath, startPointArg,
      ]);
      worktreeCreated = true;
      await git.cwd(worktreePath)
        .raw(['config', 'push.autoSetupRemote', 'true']).catch(() => {});
    } catch (err) {
      await this.rollbackCreation(git, worktreePath, branchName, worktreeCreated);
      throw new Error(`Failed to create worktree for ${agentId}: ` +
        `${err instanceof Error ? err.message : String(err)}`);
    }

    const info: WorktreeInfo = {
      id: crypto.randomUUID(), sessionId, agentId,
      worktreePath, branch: branchName, baseBranch,
      projectPath, createdAt: Date.now(), status: 'ready',
    };
    this.activeWorktrees.set(sessionId, info);
    return info;
  }

  private async rollbackCreation(
    git: SimpleGit, worktreePath: string, branchName: string, worktreeCreated: boolean,
  ): Promise<void> {
    if (worktreeCreated) {
      await git.raw(['worktree', 'remove', '--force', worktreePath]).catch(() => {});
    }
    try {
      await git.raw(['rev-parse', '--verify', `refs/heads/${branchName}`]);
      await git.raw(['branch', '-D', branchName]);
    } catch { /* already deleted — satisfied */ }
  }

  // ═══ Accessors ═══

  list(): WorktreeInfo[] { return Array.from(this.activeWorktrees.values()); }
  getBySession(sessionId: string): WorktreeInfo | undefined { return this.activeWorktrees.get(sessionId); }

  /** Re-instantiate from a persisted SQLite row */
  restoreFromRow(row: WorktreeRow): void {
    const info: WorktreeInfo = {
      id: row.id, sessionId: row.session_id, agentId: row.agent_id,
      worktreePath: row.worktree_path, branch: row.branch,
      baseBranch: row.base_branch, projectPath: row.project_path,
      createdAt: row.created_at, status: row.status as WorktreeInfo['status'],
    };
    this.activeWorktrees.set(row.session_id, info);
  }

  dispose(): void { this.gitInstances.clear(); this.activeWorktrees.clear(); }
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run tests/worktree-manager.test.ts`
Expected: All 7 tests passing

- [ ] **Step 5: Commit**

```bash
git add src/main/worktree-manager.ts tests/worktree-manager.test.ts
git commit -m "feat(phase3): add WorktreeManager with git ref safety and rollback creation

- ResolveRef discriminated union (local > remote-tracking > tag > head)
- createForAgent: prune → resolve → fetch → add --no-track → rollback on failure
- Worktree paths: ~/.conductor/worktrees/{project-hash}/{agent}-{date}-{hex}/
- Branch naming: conductor/{agent}/{timestamp-base36}

Co-Authored-By: Claude <noreply@anthropic.com>"
```

---

### Task 3: WorktreeManager — Cleanup + Conflict Detection

**Files:**
- Modify: `src/main/worktree-manager.ts` (append methods)
- Modify: `tests/worktree-manager.test.ts` (append tests)

- [ ] **Step 1: Add cleanup/conflict tests**

Append to `tests/worktree-manager.test.ts` (inside the describe block):

```typescript
  it('should clean up worktree with keepBranch=false', async () => {
    const info = await manager.createForAgent('S1', 'claude', testRepo, 'main');
    const wtPath = info.worktreePath;
    const branch = info.branch;
    const result = await manager.cleanup('S1', { keepBranch: false, force: false });
    expect(result.success).toBe(true);
    expect(fs.existsSync(wtPath)).toBe(false);
    expect(manager.getBySession('S1')).toBeUndefined();
    const branches = await git.branch();
    expect(branches.all).not.toContain(branch);
  });

  it('should clean up worktree with keepBranch=true', async () => {
    const info = await manager.createForAgent('S1', 'claude', testRepo, 'main');
    const result = await manager.cleanup('S1', { keepBranch: true, force: false });
    expect(result.success).toBe(true);
    expect(fs.existsSync(info.worktreePath)).toBe(false);
    const branches = await git.branch();
    expect(branches.all).toContain(info.branch);
  });

  it('should block cleanup on dirty worktree without force', async () => {
    const info = await manager.createForAgent('S1', 'claude', testRepo, 'main');
    fs.writeFileSync(path.join(info.worktreePath, 'README.md'), '# Modified');
    const result = await manager.cleanup('S1', { keepBranch: false, force: false });
    expect(result.success).toBe(false);
    expect(result.warnings[0]).toContain('uncommitted');
    const forceResult = await manager.cleanup('S1', { keepBranch: false, force: true });
    expect(forceResult.success).toBe(true);
  });

  it('should return failure for unknown session cleanup', async () => {
    const result = await manager.cleanup('unknown', { keepBranch: false, force: false });
    expect(result.success).toBe(false);
  });

  it('should detect no conflicts when worktrees touch different files', async () => {
    const aInfo = await manager.createForAgent('S1', 'claude', testRepo, 'main');
    const bInfo = await manager.createForAgent('S2', 'opencode', testRepo, 'main');
    fs.writeFileSync(path.join(aInfo.worktreePath, 'a.ts'), '// claude');
    const aGit = simpleGit(aInfo.worktreePath);
    await aGit.add('a.ts'); await aGit.commit('claude');
    fs.writeFileSync(path.join(bInfo.worktreePath, 'b.ts'), '// opencode');
    const bGit = simpleGit(bInfo.worktreePath);
    await bGit.add('b.ts'); await bGit.commit('opencode');
    expect((await manager.detectConflicts()).hasConflicts).toBe(false);
  });

  it('should detect conflicts when worktrees modify same file', async () => {
    const aInfo = await manager.createForAgent('S1', 'claude', testRepo, 'main');
    const bInfo = await manager.createForAgent('S2', 'opencode', testRepo, 'main');
    fs.writeFileSync(path.join(aInfo.worktreePath, 'README.md'), '# Claude');
    const aGit = simpleGit(aInfo.worktreePath);
    await aGit.add('README.md'); await aGit.commit('claude');
    fs.writeFileSync(path.join(bInfo.worktreePath, 'README.md'), '# OpenCode');
    const bGit = simpleGit(bInfo.worktreePath);
    await bGit.add('README.md'); await bGit.commit('opencode');
    const report = await manager.detectConflicts();
    expect(report.hasConflicts).toBe(true);
    expect(report.conflicts.some(c => c.file === 'README.md')).toBe(true);
  });
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run tests/worktree-manager.test.ts`
Expected: FAIL — 6 tests fail (cleanup/conflict methods missing)

- [ ] **Step 3: Add cleanup and conflict detection to WorktreeManager**

Append to `src/main/worktree-manager.ts` (inside the class, after `dispose()`):

```typescript
  // ═══ Worktree Cleanup (6-phase + verification) ═══

  /**
   * Phases: preflight → verify registered → remove --force --force → verify removed → delete branch → rm dir
   * Key: phase 3 verification FAILS the cleanup if git still reports worktree as registered
   */
  async cleanup(
    sessionId: string, options: CleanupOptions = { keepBranch: false, force: false },
  ): Promise<{ success: boolean; warnings: string[] }> {
    const info = this.activeWorktrees.get(sessionId);
    if (!info) return { success: false, warnings: ['Session not found'] };
    const git = this.getGit(info.projectPath);
    const warnings: string[] = [];

    // Phase 0: preflight dirty check
    if (!options.force) {
      try {
        const wtGit = simpleGit(info.worktreePath);
        if (!(await wtGit.status()).isClean()) {
          return { success: false, warnings: ['Worktree has uncommitted changes. Use force to discard.'] };
        }
      } catch { /* can't read — continue */ }
    }

    // Phase 1: verify registered
    const registered = await this.isRegisteredWorktree(git, info.worktreePath);
    if (!registered) warnings.push('Worktree not registered — may already be removed');

    // Phase 2: remove
    if (registered) {
      try {
        await git.raw(['worktree', 'remove', '--force', '--force', info.worktreePath]);
      } catch (err) {
        return { success: false, warnings: [`Remove failed: ${err instanceof Error ? err.message : String(err)}`] };
      }
    }

    // Phase 3: verify removed
    if (await this.isRegisteredWorktree(git, info.worktreePath)) {
      return { success: false, warnings: ['Verification failed — git still reports as registered. Retry.'] };
    }

    // Phase 4: delete branch (optional)
    if (!options.keepBranch) {
      try {
        if (await this.refExists(git, `refs/heads/${info.branch}`)) {
          await git.raw(['branch', '-D', info.branch]);
        }
      } catch (err) {
        warnings.push(`Branch delete failed: ${err instanceof Error ? err.message : String(err)}`);
      }
    }

    // Phase 5: remove directory
    try {
      if (fs.existsSync(info.worktreePath)) fs.rmSync(info.worktreePath, { recursive: true, force: true });
    } catch (err) {
      warnings.push(`Directory remove failed: ${err instanceof Error ? err.message : String(err)}`);
    }

    info.status = 'removed';
    this.activeWorktrees.delete(sessionId);
    return { success: true, warnings };
  }

  private async isRegisteredWorktree(git: SimpleGit, worktreePath: string): Promise<boolean> {
    try {
      const raw = await git.raw(['worktree', 'list', '--porcelain']);
      const target = path.resolve(worktreePath);
      return this.parseWorktreeList(raw).some(w => w.path === target);
    } catch { return false; }
  }

  private parseWorktreeList(raw: string): Array<{ path: string; branch: string | null }> {
    const results: Array<{ path: string; branch: string | null }> = [];
    let cur: { path: string; branch: string | null } | null = null;
    for (const line of raw.split('\n')) {
      if (line.startsWith('worktree ')) {
        if (cur) results.push(cur);
        cur = { path: line.slice('worktree '.length).trim(), branch: null };
      } else if (cur && line.startsWith('branch ')) {
        const ref = line.slice('branch '.length).trim();
        cur.branch = ref.startsWith('refs/heads/') ? ref.slice('refs/heads/'.length) : ref;
      }
    }
    if (cur) results.push(cur);
    return results;
  }

  // ═══ Conflict Detection ═══

  /**
   * Find files modified by ≥2 worktrees relative to base branch.
   * Uses git diff --name-only per worktree, then finds file intersection.
   */
  async detectConflicts(): Promise<ConflictReport> {
    const entries = Array.from(this.activeWorktrees.values()).filter(w => w.status === 'ready');
    if (entries.length < 2) return { hasConflicts: false, conflicts: [] };

    const fileMap = new Map<string, { worktreeId: string; branch: string; files: Set<string> }>();
    for (const wt of entries) {
      try {
        const diff = await simpleGit(wt.worktreePath).raw(['diff', '--name-only', wt.baseBranch]);
        fileMap.set(wt.id, { worktreeId: wt.id, branch: wt.branch,
          files: new Set(diff.trim().split('\n').filter(Boolean)) });
      } catch { /* skip */ }
    }

    const allFiles = new Map<string, Array<{ worktreeId: string; branch: string }>>();
    for (const e of fileMap.values()) {
      for (const f of e.files) {
        if (!allFiles.has(f)) allFiles.set(f, []);
        allFiles.get(f)!.push({ worktreeId: e.worktreeId, branch: e.branch });
      }
    }

    const conflicts: ConflictReport['conflicts'] = [];
    for (const [file, wts] of allFiles) {
      if (wts.length >= 2) conflicts.push({
        file, worktrees: wts.map(w => w.worktreeId), branches: wts.map(w => w.branch),
      });
    }
    return { hasConflicts: conflicts.length > 0, conflicts };
  }
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run tests/worktree-manager.test.ts`
Expected: All 13 tests passing

- [ ] **Step 5: Commit**

```bash
git add src/main/worktree-manager.ts tests/worktree-manager.test.ts
git commit -m "feat(phase3): add worktree cleanup and conflict detection

- 6-phase cleanup: preflight → verify registered → remove --force --force → verify removed → delete branch → rm dir
- Verification via git worktree list --porcelain parsing (never trusts exit code)
- Conflict detection: git diff --name-only per worktree, find file intersection

Co-Authored-By: Claude <noreply@anthropic.com>"
```

---

### Task 4: WorktreeWatcher

**Files:**
- Create: `src/main/worktree-watcher.ts`
- Test: `tests/worktree-watcher.test.ts`

- [ ] **Step 1: Write tests**

```typescript
// tests/worktree-watcher.test.ts
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import path from 'path';
import fs from 'fs';
import os from 'os';
import simpleGit from 'simple-git';
import { WorktreeWatcher } from '../src/main/worktree-watcher';
import type { WorktreeInfo } from '../src/common/worktree-types';

function makeInfo(overrides: Partial<WorktreeInfo> = {}): WorktreeInfo {
  return {
    id: 'wt-1', sessionId: 'S1', agentId: 'claude',
    worktreePath: '', branch: 'test/b', baseBranch: 'main',
    projectPath: '', createdAt: Date.now(), status: 'ready',
    ...overrides,
  };
}

describe('WorktreeWatcher', () => {
  let watcher: WorktreeWatcher;
  let testRepo: string;
  let info: WorktreeInfo;

  beforeEach(async () => {
    testRepo = path.join(os.tmpdir(), 'conductor-wtw-' + Math.random().toString(36).slice(2, 8));
    fs.mkdirSync(testRepo, { recursive: true });
    const git = simpleGit(testRepo);
    await git.init();
    await git.addConfig('user.name', 'test');
    await git.addConfig('user.email', 'test@test.com');
    fs.writeFileSync(path.join(testRepo, 'f.txt'), 'hello');
    await git.add('f.txt');
    await git.commit('init');
    info = makeInfo({ worktreePath: testRepo });
    watcher = new WorktreeWatcher();
  });

  afterEach(() => {
    watcher.close();
    try { fs.rmSync(testRepo, { recursive: true, force: true }); } catch {}
  });

  it('should register and unregister a worktree without error', () => {
    watcher.add(info);
    watcher.remove(info.id);
  });

  it('should not emit after remove()', async () => {
    watcher.add(info);
    let fired = false;
    watcher.onChange(() => { fired = true; });
    watcher.remove(info.id);
    fs.writeFileSync(path.join(testRepo, 'f.txt'), 'x');
    const git = simpleGit(testRepo);
    await git.add('f.txt');
    await git.commit('should not fire');
    await new Promise(r => setTimeout(r, 800));
    expect(fired).toBe(false);
  });

  it('should support multiple listeners', async () => {
    watcher.add(info);
    let c = 0;
    watcher.onChange(() => { c++; });
    watcher.onChange(() => { c++; });
    fs.writeFileSync(path.join(testRepo, 'f.txt'), 'm');
    const git = simpleGit(testRepo);
    await git.add('f.txt');
    await git.commit('multi');
    await new Promise(r => setTimeout(r, 1500));
    expect(c).toBeGreaterThanOrEqual(2);
  }, 10000);
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run tests/worktree-watcher.test.ts`
Expected: FAIL — module not found

- [ ] **Step 3: Implement WorktreeWatcher**

```typescript
// src/main/worktree-watcher.ts
import { watch } from 'node:fs';
import type { WorktreeInfo } from '../common/worktree-types';

export type WorktreeChangeListener = (info: WorktreeInfo) => void;

/**
 * Monitors .git/ of all active worktrees via fs.watch (recursive).
 * Event-driven — idle worktrees cost zero. 300ms debounce per worktree.
 */
export class WorktreeWatcher {
  private watched = new Map<string, {
    info: WorktreeInfo;
    watcher: ReturnType<typeof watch> | null;
    timer: ReturnType<typeof setTimeout> | null;
  }>();
  private listeners = new Set<WorktreeChangeListener>();
  private closed = false;
  private static DEBOUNCE_MS = 300;

  add(info: WorktreeInfo): void {
    if (this.closed || this.watched.has(info.id)) return;
    let watcher: ReturnType<typeof watch> | null = null;
    try {
      watcher = watch(`${info.worktreePath}/.git`, { recursive: true },
        () => this.scheduleEmit(info));
      watcher.on('error', () => {
        this.watched.delete(info.id);
        watcher?.close();
      });
    } catch { return; }
    this.watched.set(info.id, { info, watcher, timer: null });
  }

  remove(worktreeId: string): void {
    const w = this.watched.get(worktreeId);
    if (!w) return;
    w.watcher?.close();
    if (w.timer) clearTimeout(w.timer);
    this.watched.delete(worktreeId);
  }

  onChange(listener: WorktreeChangeListener): () => void {
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  }

  private scheduleEmit(info: WorktreeInfo): void {
    const w = this.watched.get(info.id);
    if (!w) return;
    if (w.timer) clearTimeout(w.timer);
    w.timer = setTimeout(() => {
      w.timer = null;
      for (const fn of this.listeners) {
        try { fn(info); } catch { /* isolate listener errors */ }
      }
    }, WorktreeWatcher.DEBOUNCE_MS);
  }

  close(): void {
    this.closed = true;
    for (const w of this.watched.values()) {
      w.watcher?.close();
      if (w.timer) clearTimeout(w.timer);
    }
    this.watched.clear();
    this.listeners.clear();
  }
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run tests/worktree-watcher.test.ts`
Expected: All 3 tests passing

- [ ] **Step 5: Commit**

```bash
git add src/main/worktree-watcher.ts tests/worktree-watcher.test.ts
git commit -m "feat(phase3): add WorktreeWatcher for event-driven .git/ change detection

Co-Authored-By: Claude <noreply@anthropic.com>"
```

---

### Task 5: SQLite + IPC + Preload

**Files:**
- Modify: `src/main/database.ts` — add worktrees table + saveWorktree/loadWorktrees/deleteWorktree
- Modify: `src/main/ipc-handlers.ts` — add worktreeManager/worktreeWatcher params + 5 handlers
- Modify: `src/preload/index.ts` — expose 5 worktree APIs
- Modify: `src/renderer/global.d.ts` — ElectronAPI worktree methods

- [ ] **Step 1: Add worktrees table + persistence functions**

In `src/main/database.ts` — add import and table:

```typescript
// Add import near top:
import type { WorktreeRow } from '../common/worktree-types';

// Add inside initDatabase() exec block (after context_entries):
`
  CREATE TABLE IF NOT EXISTS worktrees (
    id TEXT PRIMARY KEY,
    session_id TEXT NOT NULL,
    agent_id TEXT NOT NULL,
    worktree_path TEXT NOT NULL,
    branch TEXT NOT NULL,
    base_branch TEXT NOT NULL DEFAULT 'main',
    project_path TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    status TEXT NOT NULL DEFAULT 'ready'
  );
`

// Add exported functions at bottom:
export function saveWorktree(row: WorktreeRow): void {
  if (!db) return;
  db.prepare(`INSERT OR REPLACE INTO worktrees
    (id, session_id, agent_id, worktree_path, branch, base_branch, project_path, created_at, status)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
    row.id, row.session_id, row.agent_id, row.worktree_path,
    row.branch, row.base_branch, row.project_path, row.created_at, row.status);
}

export function loadWorktrees(): WorktreeRow[] {
  if (!db) return [];
  return db.prepare('SELECT * FROM worktrees ORDER BY created_at DESC').all() as WorktreeRow[];
}

export function deleteWorktree(id: string): void {
  if (!db) return;
  db.prepare('DELETE FROM worktrees WHERE id = ?').run(id);
}
```

- [ ] **Step 2: Add IPC handlers**

In `src/main/ipc-handlers.ts` — update imports, signature, and add handlers:

```typescript
// Add imports:
import { saveWorktree, loadWorktrees, deleteWorktree } from './database.js';
import type { WorktreeManager } from './worktree-manager.js';
import type { WorktreeWatcher } from './worktree-watcher.js';

// Update setupIpcHandlers signature — add two params at end:
export function setupIpcHandlers(
  daemonClient: DaemonClient, mainWindow: BrowserWindow,
  statsCollector: StatsCollector, notifyCenter: NotifyCenter,
  taskQueue: TaskQueue, contextShare: ContextShare,
  embeddedBrowser: EmbeddedBrowser,
  worktreeManager: WorktreeManager,
  worktreeWatcher: WorktreeWatcher,
): void {

// Add before closing } of setupIpcHandlers:

  // ── Worktree handlers (Phase 3) ──────────────────────────────
  ipcMain.handle('worktree_create', async (_e, args: {
    sessionId: string; agentId: string; projectPath: string; baseBranch: string;
  }) => {
    const info = await worktreeManager.createForAgent(
      args.sessionId, args.agentId, args.projectPath, args.baseBranch || 'main');
    saveWorktree({
      id: info.id, session_id: info.sessionId, agent_id: info.agentId,
      worktree_path: info.worktreePath, branch: info.branch,
      base_branch: info.baseBranch, project_path: info.projectPath,
      created_at: info.createdAt, status: info.status,
    });
    worktreeWatcher.add(info);
    return info;
  });

  ipcMain.handle('worktree_cleanup', async (_e, args: {
    sessionId: string; keepBranch: boolean; force: boolean;
  }) => {
    const result = await worktreeManager.cleanup(args.sessionId,
      { keepBranch: args.keepBranch, force: args.force });
    if (result.success) {
      const info = worktreeManager.getBySession(args.sessionId);
      if (info) { deleteWorktree(info.id); worktreeWatcher.remove(info.id); }
    }
    return result;
  });

  ipcMain.handle('worktree_list', async () => worktreeManager.list());
  ipcMain.handle('worktree_get_by_session', async (_e, sessionId: string) =>
    worktreeManager.getBySession(sessionId) ?? null);
  ipcMain.handle('worktree_conflicts', async () =>
    worktreeManager.detectConflicts());
```

- [ ] **Step 3: Expose worktree APIs in preload**

Add to `src/preload/index.ts` (before `// Window controls`):

```typescript
  // Worktree APIs (Phase 3)
  createWorktree: (args: { sessionId: string; agentId: string; projectPath: string; baseBranch: string }) =>
    ipcRenderer.invoke('worktree_create', args),
  cleanupWorktree: (args: { sessionId: string; keepBranch: boolean; force: boolean }) =>
    ipcRenderer.invoke('worktree_cleanup', args),
  listWorktrees: () => ipcRenderer.invoke('worktree_list'),
  getWorktreeBySession: (sessionId: string) => ipcRenderer.invoke('worktree_get_by_session', sessionId),
  getWorktreeConflicts: () => ipcRenderer.invoke('worktree_conflicts'),
```

- [ ] **Step 4: Update renderer type declarations**

Add to `src/renderer/global.d.ts` inside `ElectronAPI`:

```typescript
  // Worktree APIs (Phase 3)
  createWorktree: (args: { sessionId: string; agentId: string; projectPath: string; baseBranch: string }) => Promise<any>;
  cleanupWorktree: (args: { sessionId: string; keepBranch: boolean; force: boolean }) => Promise<any>;
  listWorktrees: () => Promise<any[]>;
  getWorktreeBySession: (sessionId: string) => Promise<any>;
  getWorktreeConflicts: () => Promise<{ hasConflicts: boolean; conflicts: any[] }>;
```

- [ ] **Step 5: Verify build**

Run: `npx tsc --noEmit`
Expected: No errors

- [ ] **Step 6: Commit**

```bash
git add src/main/database.ts src/main/ipc-handlers.ts src/preload/index.ts src/renderer/global.d.ts
git commit -m "feat(phase3): add worktree SQLite persistence, IPC handlers, and preload APIs

Co-Authored-By: Claude <noreply@anthropic.com>"
```

---

### Task 6: Main Process Integration + Spawn Extension

**Files:**
- Modify: `src/main/index.ts`
- Modify: `src/daemon/protocol/messages.ts`

- [ ] **Step 1: Extend spawn message type**

In `src/daemon/protocol/messages.ts`, update the `spawn` type:

```typescript
// Change:
  | { type: 'spawn'; agent: string; cwd: string; cols: number; rows: number; agentSessionId?: string; isRestore: boolean }
// To:
  | { type: 'spawn'; agent: string; cwd: string; cols: number; rows: number; agentSessionId?: string; isRestore: boolean; worktree?: { branch: string; baseBranch: string } }
```

- [ ] **Step 2: Initialize WorktreeManager + WorktreeWatcher**

In `src/main/index.ts`:

```typescript
// Add imports:
import { WorktreeManager } from './worktree-manager.js';
import { WorktreeWatcher } from './worktree-watcher.js';
import { loadWorktrees } from './database.js';

// Add variable declarations:
let worktreeManager: WorktreeManager | null = null;
let worktreeWatcher: WorktreeWatcher | null = null;

// In createWindow(), after Phase 4 init, add:
  // ── Phase 3: Worktree Manager & Watcher ──────────────────────
  worktreeManager = new WorktreeManager();
  worktreeWatcher = new WorktreeWatcher();

  worktreeWatcher.onChange(() => {
    worktreeManager?.detectConflicts().then((report) => {
      mainWindow?.webContents.send('worktree_conflicts_updated', report);
    }).catch(() => {});
  });

  // Restore persisted worktrees
  try {
    for (const row of loadWorktrees()) {
      worktreeManager.restoreFromRow(row);
      if (row.status === 'ready') {
        worktreeWatcher.add({
          id: row.id, sessionId: row.session_id, agentId: row.agent_id,
          worktreePath: row.worktree_path, branch: row.branch,
          baseBranch: row.base_branch, projectPath: row.project_path,
          createdAt: row.created_at, status: row.status as 'ready',
        });
      }
    }
  } catch { /* first run — no persisted worktrees */ }

  // Update setupIpcHandlers call — add two new params at end:
  setupIpcHandlers(daemonClient, mainWindow, statsCollector, notifyCenter,
    taskQueue, contextShare, embeddedBrowser, worktreeManager, worktreeWatcher);
```

Add cleanup in both `window-all-closed` and `before-quit`:

```typescript
  worktreeWatcher?.close();
  worktreeManager?.dispose();
```

- [ ] **Step 3: Verify build**

Run: `npm run build`
Expected: Build succeeds

- [ ] **Step 4: Commit**

```bash
git add src/daemon/protocol/messages.ts src/main/index.ts
git commit -m "feat(phase3): integrate worktree into main process lifecycle and spawn protocol

Co-Authored-By: Claude <noreply@anthropic.com>"
```

---

### Task 7: Sidebar UI — Worktree Status + Conflicts

**Files:**
- Create: `src/renderer/components/WorktreeBadge.tsx`
- Modify: `src/renderer/components/Sidebar.tsx`
- Modify: `src/renderer/App.tsx`

- [ ] **Step 1: Create WorktreeBadge**

```typescript
// src/renderer/components/WorktreeBadge.tsx
interface Props { worktree?: { branch: string; worktreePath: string } | null; }

export function WorktreeBadge({ worktree }: Props) {
  if (!worktree) return null;
  const shortPath = worktree.worktreePath
    .replace(/^.*[\\/]\.conductor[\\/]worktrees[\\/]/, '~/').replace(/\\/g, '/');
  return (
    <div style={{ display:'flex', gap:6, alignItems:'center', fontSize:10, color:'var(--caption)' }}>
      <span style={{ color:'var(--running)' }}>🌿</span>
      <span style={{ color:'var(--body)', fontWeight:500, fontFamily:'var(--font-mono)' }}>{worktree.branch}</span>
      <span style={{ opacity:0.6, fontFamily:'var(--font-mono)' }}>{shortPath}</span>
    </div>
  );
}
```

- [ ] **Step 2: Add worktree + conflicts to Sidebar**

In `src/renderer/components/Sidebar.tsx`:

```typescript
// Add import:
import { WorktreeBadge } from './WorktreeBadge';

// Add to Props:
  worktrees?: Array<{ sessionId: string; branch: string; worktreePath: string }>;
  conflicts?: Array<{ file: string; branches: string[] }>;

// In the session entry — add after the cwd line:
{(() => {
  const wt = worktrees?.find(w => w.sessionId === s.id);
  return wt ? <WorktreeBadge worktree={wt} /> : null;
})()}

// Add Conflicts section (after Sessions section, inside scrollable body):
{conflicts && conflicts.length > 0 && section('Conflicts', 'conflicts',
  <div style={{ display:'flex', flexDirection:'column', gap:2 }}>
    {conflicts.map((c, i) => (
      <div key={i} style={{ fontSize:10, color:'var(--caption)', display:'flex', justifyContent:'space-between' }}>
        <span style={{ fontFamily:'var(--font-mono)', overflow:'hidden', textOverflow:'ellipsis', whiteSpace:'nowrap', flex:1 }}>{c.file}</span>
        <span style={{ color:'var(--failed)', marginLeft:8, whiteSpace:'nowrap' }}>{c.branches.join(', ')}</span>
      </div>
    ))}
  </div>
)}
```

- [ ] **Step 3: Wire data in App.tsx**

In `src/renderer/App.tsx`:

```typescript
// Add state:
const [worktreeMap, setWorktreeMap] = useState<Map<string, any>>(new Map());
const [conflicts, setConflicts] = useState<any[]>([]);

// Add polling + push effect:
useEffect(() => {
  const refresh = async () => {
    try {
      const list = await window.electronAPI.listWorktrees();
      const map = new Map<string, any>();
      for (const w of list) map.set(w.sessionId, w);
      setWorktreeMap(map);
      const report = await window.electronAPI.getWorktreeConflicts();
      setConflicts(report?.conflicts || []);
    } catch { /* ignore */ }
  };
  refresh();
  const iv = setInterval(refresh, 5000);
  return () => clearInterval(iv);
}, [panels]);

// Pass to Sidebar:
<Sidebar
  // ... existing props
  worktrees={Array.from(worktreeMap.values()).map((w: any) => ({
    sessionId: w.sessionId, branch: w.branch, worktreePath: w.worktreePath,
  }))}
  conflicts={conflicts}
/>
```

- [ ] **Step 4: Verify build**

Run: `npm run build`
Expected: Build succeeds

- [ ] **Step 5: Commit**

```bash
git add src/renderer/components/WorktreeBadge.tsx src/renderer/components/Sidebar.tsx src/renderer/App.tsx
git commit -m "feat(phase3): add worktree status badges and conflict display to Sidebar

Co-Authored-By: Claude <noreply@anthropic.com>"
```

---

## Phase 3 Completion Checklist

- [ ] Shared types: ResolvedRef, WorktreeInfo, ConflictReport, CleanupOptions, WorktreeRow
- [ ] WorktreeManager.createForAgent: prune → resolve → fetch → add --no-track → rollback on failure
- [ ] WorktreeManager.cleanup: 6-phase with `git worktree list --porcelain` verification
- [ ] WorktreeManager.detectConflicts: `git diff --name-only` intersection method
- [ ] WorktreeWatcher: `fs.watch(.git/)` + 300ms debounce + onChange
- [ ] SQLite `worktrees` table + saveWorktree / loadWorktrees / deleteWorktree
- [ ] IPC handlers: worktree_create, worktree_cleanup, worktree_list, worktree_get_by_session, worktree_conflicts
- [ ] Preload APIs: createWorktree, cleanupWorktree, listWorktrees, getWorktreeBySession, getWorktreeConflicts
- [ ] Spawn message extended with optional worktree field
- [ ] Main process: init + restore persisted worktrees + auto-detect conflicts on .git/ changes
- [ ] Sidebar: WorktreeBadge per session + Conflicts collapsible section
- [ ] App.tsx: 5s polling + real-time conflict push
- [ ] 16 unit tests passing (13 manager + 3 watcher)
- [ ] Full build succeeds
