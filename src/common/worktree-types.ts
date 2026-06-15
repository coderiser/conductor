// Shared types for git worktree isolation.
// Used by Electron main (WorktreeManager, WorktreeWatcher) and renderer (Sidebar).

/** Discriminated union — downstream code never re-derives ref type from string.
 *  Resolution order: local > remote-tracking > tag > head.
 *  A local branch literally named 'origin/foo' still resolves as kind:'local'. */
export type ResolvedRef =
  | { kind: 'local';            fullRef: string; shortName: string }
  | { kind: 'remote-tracking';  fullRef: string; shortName: string; remote: string }
  | { kind: 'tag';              fullRef: string; shortName: string }
  | { kind: 'head' }

export interface WorktreeInfo {
  id: string
  sessionId: string
  agentId: string
  worktreePath: string
  branch: string
  baseBranch: string
  projectPath: string
  createdAt: number
  status: 'creating' | 'ready' | 'cleanup' | 'removed'
}

export interface CleanupOptions {
  keepBranch: boolean
  force: boolean
}

export interface ConflictReport {
  hasConflicts: boolean
  conflicts: Array<{
    file: string
    worktrees: string[]
    branches: string[]
  }>
}

/** Persisted row shape matching SQLite worktrees table */
export interface WorktreeRow {
  id: string
  session_id: string
  agent_id: string
  worktree_path: string
  branch: string
  base_branch: string
  project_path: string
  created_at: number
  status: string
}
