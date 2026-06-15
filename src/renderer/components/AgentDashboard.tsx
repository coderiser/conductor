// src/renderer/components/AgentDashboard.tsx
// Modal overlay showing all running agents with status, health, tokens, cost, errors, and uptime.

import React, { useState, useEffect, useCallback } from 'react';
import { formatTokens, formatCost, formatUptime, formatHealthDots, healthColor } from '../lib/format-utils';

interface AgentStats {
  sessionId: string;
  agentId: string;
  agentType: string;
  status: 'starting' | 'running' | 'thinking' | 'waiting' | 'error' | 'done';
  tokenCount: number;
  tokenRate: number;
  estimatedCost: number;
  healthScore: number;
  lastActivity: number;
  startTime: number;
  errorCount: number;
  cwd: string;
  branch?: string;
}

interface StatsTotals {
  tokens: number;
  cost: number;
  running: number;
  failed: number;
}

interface Props {
  visible: boolean;
  onClose: () => void;
}

const POLL_INTERVAL = 2000;

export function AgentDashboard({ visible, onClose }: Props) {
  const [agents, setAgents] = useState<AgentStats[]>([]);
  const [totals, setTotals] = useState<StatsTotals>({ tokens: 0, cost: 0, running: 0, failed: 0 });
  const [now, setNow] = useState(Date.now());

  const fetchStats = useCallback(async () => {
    try {
      const [agentStats, statsTotals] = await Promise.all([
        window.electronAPI.getAgentStats(),
        window.electronAPI.getStatsTotals(),
      ]);
      setAgents(agentStats);
      setTotals(statsTotals);
      setNow(Date.now());
    } catch (err) {
      console.error('[AgentDashboard] Failed to fetch stats:', err);
    }
  }, []);

  useEffect(() => {
    if (!visible) return;

    // Fetch immediately on open
    fetchStats();

    const interval = setInterval(fetchStats, POLL_INTERVAL);
    return () => clearInterval(interval);
  }, [visible, fetchStats]);

  // Close on Escape key
  useEffect(() => {
    if (!visible) return;
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [visible, onClose]);

  if (!visible) return null;

  const handleOverlayClick = (e: React.MouseEvent) => {
    if (e.target === e.currentTarget) onClose();
  };

  const statusColor = (status: string): string => {
    switch (status) {
      case 'running':
      case 'thinking':
        return 'var(--running)';
      case 'starting':
      case 'waiting':
        return 'var(--pending)';
      case 'error':
        return 'var(--failed)';
      case 'done':
        return 'var(--caption)';
      default:
        return 'var(--body)';
    }
  };

  return (
    <div style={styles.overlay} onClick={handleOverlayClick}>
      <div style={styles.modal}>
        {/* Header */}
        <div style={styles.header}>
          <div style={styles.headerLeft}>
            <span style={styles.title}>Agent Dashboard</span>
            <span style={styles.badge}>
              {totals.running} running
              {totals.failed > 0 && <span style={{ color: 'var(--failed)' }}> · {totals.failed} failed</span>}
            </span>
          </div>
          <button style={styles.closeBtn} onClick={onClose} title="Close (Esc)">
            ✕
          </button>
        </div>

        {/* Table */}
        <div style={styles.tableWrap}>
          <table style={styles.table}>
            <thead>
              <tr>
                <th style={{ ...styles.th, ...styles.colAgent }}>Agent</th>
                <th style={{ ...styles.th, ...styles.colStatus }}>Status</th>
                <th style={{ ...styles.th, ...styles.colHealth }}>Health</th>
                <th style={{ ...styles.th, ...styles.colTokens }}>Tokens</th>
                <th style={{ ...styles.th, ...styles.colCost }}>Cost</th>
                <th style={{ ...styles.th, ...styles.colErrors }}>Errors</th>
                <th style={{ ...styles.th, ...styles.colUptime }}>Uptime</th>
              </tr>
            </thead>
            <tbody>
              {agents.length === 0 ? (
                <tr>
                  <td colSpan={7} style={styles.empty}>
                    No active agents
                  </td>
                </tr>
              ) : (
                agents.map((agent) => {
                  const uptimeSec = (now - agent.startTime) / 1000;
                  return (
                    <tr key={agent.sessionId} style={styles.row}>
                      <td style={{ ...styles.td, ...styles.colAgent }}>
                        <div style={styles.agentCell}>
                          <span style={styles.agentType}>{agent.agentType}</span>
                          {agent.branch && (
                            <span style={styles.branch}>{agent.branch}</span>
                          )}
                        </div>
                      </td>
                      <td style={{ ...styles.td, ...styles.colStatus }}>
                        <span style={{
                          ...styles.statusPill,
                          color: statusColor(agent.status),
                          background: `${statusColor(agent.status)}18`,
                        }}>
                          {agent.status}
                        </span>
                      </td>
                      <td style={{ ...styles.td, ...styles.colHealth }}>
                        <span style={{
                          fontFamily: 'var(--font-mono)',
                          fontSize: 11,
                          color: healthColor(agent.healthScore),
                          letterSpacing: 1,
                        }}>
                          {formatHealthDots(agent.healthScore)}
                        </span>
                        <span style={styles.healthNum}>
                          {agent.healthScore}
                        </span>
                      </td>
                      <td style={{ ...styles.td, ...styles.colTokens, color: 'var(--pending)' }}>
                        {formatTokens(agent.tokenCount)}
                        {agent.tokenRate > 0 && (
                          <span style={styles.rate}>/{agent.tokenRate.toFixed(0)}tpm</span>
                        )}
                      </td>
                      <td style={{ ...styles.td, ...styles.colCost, color: 'var(--running)' }}>
                        {formatCost(agent.estimatedCost)}
                      </td>
                      <td style={{
                        ...styles.td,
                        ...styles.colErrors,
                        color: agent.errorCount > 0 ? 'var(--failed)' : 'var(--caption)',
                      }}>
                        {agent.errorCount > 0 ? agent.errorCount : '—'}
                      </td>
                      <td style={{ ...styles.td, ...styles.colUptime, color: 'var(--body)' }}>
                        {formatUptime(uptimeSec)}
                      </td>
                    </tr>
                  );
                })
              )}
            </tbody>
          </table>
        </div>

        {/* Totals footer */}
        <div style={styles.footer}>
          <span style={styles.footerLabel}>Total</span>
          <span style={styles.footerItem}>
            <span style={styles.footerKey}>Tokens</span>
            <span style={{ color: 'var(--pending)' }}>{formatTokens(totals.tokens)}</span>
          </span>
          <span style={styles.footerItem}>
            <span style={styles.footerKey}>Cost</span>
            <span style={{ color: 'var(--running)' }}>{formatCost(totals.cost)}</span>
          </span>
          <span style={styles.footerItem}>
            <span style={styles.footerKey}>Running</span>
            <span style={{ color: 'var(--running)' }}>{totals.running}</span>
          </span>
          <span style={styles.footerItem}>
            <span style={styles.footerKey}>Failed</span>
            <span style={{ color: totals.failed > 0 ? 'var(--failed)' : 'var(--caption)' }}>
              {totals.failed}
            </span>
          </span>
        </div>
      </div>
    </div>
  );
}

// ─── Styles ────────────────────────────────────────────────────────────────────

const styles: Record<string, React.CSSProperties> = {
  overlay: {
    position: 'fixed',
    inset: 0,
    background: 'var(--dashboard-bg)',
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    zIndex: 1000,
    fontFamily: 'var(--font-sans)',
  },
  modal: {
    background: 'var(--canvas-deep)',
    border: '1px solid var(--hairline)',
    borderRadius: 'var(--radius-lg)',
    width: '90vw',
    maxWidth: 900,
    maxHeight: '80vh',
    display: 'flex',
    flexDirection: 'column',
    boxShadow: '0 16px 48px rgba(0,0,0,0.5)',
  },
  header: {
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'space-between',
    padding: '14px 18px',
    borderBottom: '1px solid var(--hairline)',
  },
  headerLeft: {
    display: 'flex',
    alignItems: 'center',
    gap: 12,
  },
  title: {
    fontSize: 14,
    fontWeight: 600,
    color: 'var(--ink)',
    letterSpacing: '-0.01em',
  },
  badge: {
    fontSize: 11,
    color: 'var(--caption)',
    fontFamily: 'var(--font-mono)',
  },
  closeBtn: {
    background: 'transparent',
    border: 'none',
    color: 'var(--caption)',
    fontSize: 16,
    cursor: 'pointer',
    padding: '4px 8px',
    borderRadius: 'var(--radius-sm)',
    transition: 'all 0.15s',
    lineHeight: 1,
  },
  tableWrap: {
    flex: 1,
    overflowY: 'auto',
    padding: '0 2px',
  },
  table: {
    width: '100%',
    borderCollapse: 'collapse',
    fontSize: 12,
  },
  th: {
    textAlign: 'left',
    padding: '10px 14px',
    fontSize: 10,
    fontWeight: 500,
    textTransform: 'uppercase',
    letterSpacing: '0.06em',
    color: 'var(--caption)',
    borderBottom: '1px solid var(--hairline)',
    position: 'sticky',
    top: 0,
    background: 'var(--canvas-deep)',
  },
  td: {
    padding: '10px 14px',
    borderBottom: '1px solid var(--hairline)',
    whiteSpace: 'nowrap',
    fontFamily: 'var(--font-mono)',
    fontSize: 12,
  },
  row: {
    transition: 'background 0.1s',
  },
  // Column widths
  colAgent: { width: '22%' },
  colStatus: { width: '12%' },
  colHealth: { width: '16%' },
  colTokens: { width: '16%' },
  colCost: { width: '10%' },
  colErrors: { width: '10%' },
  colUptime: { width: '14%' },
  // Cell content
  agentCell: {
    display: 'flex',
    flexDirection: 'column',
    gap: 2,
  },
  agentType: {
    fontFamily: 'var(--font-sans)',
    fontSize: 12,
    fontWeight: 500,
    color: 'var(--ink)',
  },
  branch: {
    fontFamily: 'var(--font-mono)',
    fontSize: 10,
    color: 'var(--caption)',
  },
  statusPill: {
    fontSize: 11,
    fontWeight: 500,
    fontFamily: 'var(--font-sans)',
    padding: '2px 8px',
    borderRadius: 10,
    display: 'inline-block',
  },
  healthNum: {
    fontSize: 10,
    color: 'var(--caption)',
    marginLeft: 6,
    fontFamily: 'var(--font-mono)',
  },
  rate: {
    fontSize: 10,
    color: 'var(--caption)',
    marginLeft: 4,
  },
  empty: {
    padding: '40px 14px',
    textAlign: 'center',
    color: 'var(--caption)',
    fontFamily: 'var(--font-sans)',
    fontSize: 12,
  },
  footer: {
    display: 'flex',
    alignItems: 'center',
    gap: 20,
    padding: '12px 18px',
    borderTop: '1px solid var(--hairline)',
    fontSize: 12,
    fontFamily: 'var(--font-mono)',
  },
  footerLabel: {
    fontWeight: 600,
    color: 'var(--ink)',
    fontFamily: 'var(--font-sans)',
    fontSize: 11,
    textTransform: 'uppercase',
    letterSpacing: '0.06em',
  },
  footerItem: {
    display: 'flex',
    alignItems: 'center',
    gap: 6,
  },
  footerKey: {
    color: 'var(--caption)',
    fontSize: 10,
    textTransform: 'uppercase',
    letterSpacing: '0.04em',
    fontFamily: 'var(--font-sans)',
  },
};

export default AgentDashboard;
