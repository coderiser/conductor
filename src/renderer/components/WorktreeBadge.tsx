import type { WorktreeInfo, ConflictReport } from '../../common/worktree-types';

interface Props {
  worktrees: WorktreeInfo[];
  conflicts: ConflictReport | null;
}

function shortenPath(p: string): string {
  const parts = p.replace(/\\/g, '/').split('/');
  if (parts.length <= 3) return p;
  return '.../' + parts.slice(-3).join('/');
}

export function WorktreeBadge({ worktrees, conflicts }: Props) {
  if (worktrees.length === 0) {
    return (
      <div style={{ fontSize: 11, color: 'var(--caption)', fontStyle: 'italic', padding: '4px 0' }}>
        No isolated worktrees
      </div>
    );
  }

  const hasConflicts = conflicts?.hasConflicts ?? false;

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
      {hasConflicts && (
        <div style={{
          background: 'rgba(248,113,113,0.12)',
          border: '1px solid var(--failed)',
          borderRadius: 3,
          padding: '4px 8px',
          fontSize: 10,
          color: 'var(--failed)',
          marginBottom: 2,
        }}>
          &#9888; {conflicts!.conflicts.length} file(s) modified in multiple worktrees
        </div>
      )}

      {worktrees.map((wt) => {
        const isConflict = conflicts?.conflicts.some(c =>
          c.worktrees.includes(wt.worktreePath) || c.branches.includes(wt.branch)
        );

        return (
          <div key={wt.id} style={{
            background: isConflict ? 'rgba(248,113,113,0.08)' : 'var(--canvas-soft)',
            borderRadius: 3,
            padding: '5px 8px',
            border: isConflict ? '1px solid var(--failed)' : '1px solid var(--hairline)',
            fontSize: 11,
            transition: 'all 0.2s',
          }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
              <span style={{
                color: wt.status === 'ready' ? 'var(--running)' : 'var(--caption)',
                fontSize: 10,
              }}>{wt.status === 'ready' ? '●' : '○'}</span>
              <span style={{ color: 'var(--ink)', fontWeight: 500 }}>{wt.agentId}</span>
              <span style={{ color: 'var(--caption)', fontSize: 10, marginLeft: 'auto' }}>
                S:{wt.sessionId}
              </span>
            </div>
            <div style={{ color: 'var(--caption)', fontSize: 10, marginTop: 3, paddingLeft: 14 }}>
              <span style={{ color: 'var(--accent)' }}>{wt.branch}</span>
              <span style={{ marginLeft: 4 }}>@ {wt.baseBranch}</span>
            </div>
            <div style={{
              color: 'var(--caption)', fontSize: 9, marginTop: 2, paddingLeft: 14,
              overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
            }}>
              {shortenPath(wt.worktreePath)}
            </div>
          </div>
        );
      })}
    </div>
  );
}
