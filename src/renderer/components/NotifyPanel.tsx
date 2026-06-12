import React, { useState, useEffect, useRef } from 'react';
import { formatTimeAgo } from '../lib/format-utils';

interface Notification {
  id: string;
  sessionId: string;
  agent: string;
  level: 'info' | 'warning' | 'error' | 'success';
  message: string;
  timestamp: number;
  dismissed: boolean;
}

interface NotifyPanelProps {
  visible: boolean;
  onClose: () => void;
  onJumpToSession: (sessionId: string) => void;
}

const LEVEL_CONFIG = {
  info:    { icon: '🔵', color: 'var(--info)' },
  warning: { icon: '🟡', color: 'var(--pending)' },
  error:   { icon: '🔴', color: 'var(--failed)' },
  success: { icon: '🟢', color: 'var(--running)' }
};

export function NotifyPanel({ visible, onClose, onJumpToSession }: NotifyPanelProps) {
  const [notifications, setNotifications] = useState<Notification[]>([]);
  const [hoveredId, setHoveredId] = useState<string | null>(null);
  const intervalRef = useRef<NodeJS.Timeout | null>(null);

  // Fetch unread notifications
  const fetchNotifications = async () => {
    try {
      const result = await window.electronAPI.getNotifications(false);
      if (result && !Array.isArray(result)) {
        // Handle both array and object-wrapped responses
        const notifs = result.notifications || result;
        if (Array.isArray(notifs)) {
          setNotifications(notifs);
        }
      } else if (Array.isArray(result)) {
        setNotifications(result);
      }
    } catch (err) {
      console.error('[NotifyPanel] Failed to fetch notifications:', err);
    }
  };

  // Poll every 2 seconds
  useEffect(() => {
    fetchNotifications();
    intervalRef.current = setInterval(fetchNotifications, 2000);
    return () => {
      if (intervalRef.current) clearInterval(intervalRef.current);
    };
  }, []);

  // Listen for real-time notifications
  useEffect(() => {
    const unsubscribe = window.electronAPI.onNotification((notification: Notification) => {
      setNotifications(prev => {
        // Avoid duplicates
        if (prev.some(n => n.id === notification.id)) return prev;
        return [notification, ...prev];
      });
    });
    return unsubscribe;
  }, []);

  const handleDismiss = async (id: string) => {
    try {
      await window.electronAPI.dismissNotification(id);
      setNotifications(prev => prev.filter(n => n.id !== id));
    } catch (err) {
      console.error('[NotifyPanel] Failed to dismiss notification:', err);
    }
  };

  const handleDismissAll = async () => {
    try {
      // Dismiss each notification individually
      await Promise.all(notifications.map(n => window.electronAPI.dismissNotification(n.id)));
      setNotifications([]);
    } catch (err) {
      console.error('[NotifyPanel] Failed to dismiss all notifications:', err);
    }
  };

  const handleJumpToSession = (sessionId: string) => {
    onJumpToSession(sessionId);
    onClose();
  };

  return (
    <div
      style={{
        position: 'fixed',
        top: 0,
        right: visible ? 0 : -360,
        width: 360,
        height: '100vh',
        background: 'var(--canvas-deep)',
        borderLeft: '1px solid var(--hairline)',
        display: 'flex',
        flexDirection: 'column',
        fontFamily: 'var(--font-sans)',
        transition: 'right 0.2s ease',
        zIndex: 9999,
        boxShadow: visible ? '-4px 0 16px rgba(0,0,0,0.4)' : 'none'
      }}
    >
      {/* Header */}
      <div
        style={{
          padding: '14px 16px',
          borderBottom: '1px solid var(--hairline)',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          flexShrink: 0
        }}
      >
        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <span style={{ fontSize: 14, fontWeight: 600, color: 'var(--ink)' }}>
            Notifications
          </span>
          <span
            style={{
              fontSize: 12,
              color: 'var(--caption)',
              fontWeight: 500,
              fontFamily: 'var(--font-mono)'
            }}
          >
            ({notifications.length})
          </span>
          {notifications.length > 0 && (
            <button
              onClick={handleDismissAll}
              style={{
                fontSize: 11,
                color: 'var(--caption)',
                background: 'transparent',
                border: 'none',
                cursor: 'pointer',
                padding: '2px 6px',
                borderRadius: 'var(--radius-sm)',
                transition: 'all 0.15s',
                fontFamily: 'var(--font-sans)'
              }}
              onMouseEnter={e => {
                (e.target as HTMLElement).style.color = 'var(--ink)';
                (e.target as HTMLElement).style.background = 'var(--hairline)';
              }}
              onMouseLeave={e => {
                (e.target as HTMLElement).style.color = 'var(--caption)';
                (e.target as HTMLElement).style.background = 'transparent';
              }}
              title="Dismiss all"
            >
              Dismiss all
            </button>
          )}
        </div>
        <button
          onClick={onClose}
          style={{
            width: 28,
            height: 28,
            borderRadius: 'var(--radius-sm)',
            background: 'transparent',
            border: '1px solid var(--hairline)',
            color: 'var(--caption)',
            cursor: 'pointer',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            fontSize: 14,
            transition: 'all 0.15s',
            fontFamily: 'var(--font-sans)'
          }}
          onMouseEnter={e => {
            (e.currentTarget as HTMLElement).style.color = 'var(--ink)';
            (e.currentTarget as HTMLElement).style.background = 'var(--hairline)';
          }}
          onMouseLeave={e => {
            (e.currentTarget as HTMLElement).style.color = 'var(--caption)';
            (e.currentTarget as HTMLElement).style.background = 'transparent';
          }}
          title="Close panel"
        >
          ✕
        </button>
      </div>

      {/* Notification list */}
      <div
        style={{
          flex: 1,
          overflowY: 'auto',
          padding: '8px 0'
        }}
      >
        {notifications.length === 0 ? (
          <div
            style={{
              padding: '32px 16px',
              textAlign: 'center',
              color: 'var(--caption)',
              fontSize: 13,
              fontFamily: 'var(--font-sans)'
            }}
          >
            No notifications
          </div>
        ) : (
          notifications.map(notification => {
            const config = LEVEL_CONFIG[notification.level] || LEVEL_CONFIG.info;
            const isHovered = hoveredId === notification.id;
            return (
              <div
                key={notification.id}
                style={{
                  padding: '10px 16px',
                  borderBottom: '1px solid var(--hairline)',
                  background: isHovered ? 'rgba(255,255,255,0.02)' : 'transparent',
                  transition: 'background 0.15s',
                  cursor: 'default'
                }}
                onMouseEnter={() => setHoveredId(notification.id)}
                onMouseLeave={() => setHoveredId(null)}
              >
                {/* Top row: icon + agent + time */}
                <div
                  style={{
                    display: 'flex',
                    alignItems: 'center',
                    gap: 6,
                    marginBottom: 4
                  }}
                >
                  <span style={{ fontSize: 12, lineHeight: 1 }}>{config.icon}</span>
                  <span
                    style={{
                      fontSize: 12,
                      fontWeight: 600,
                      color: 'var(--ink)',
                      flex: 1,
                      overflow: 'hidden',
                      textOverflow: 'ellipsis',
                      whiteSpace: 'nowrap'
                    }}
                  >
                    {notification.agent || 'Unknown'}
                  </span>
                  <span
                    style={{
                      fontSize: 11,
                      color: 'var(--caption)',
                      fontFamily: 'var(--font-mono)',
                      flexShrink: 0
                    }}
                  >
                    {formatTimeAgo(notification.timestamp)}
                  </span>
                </div>

                {/* Message */}
                <div
                  style={{
                    fontSize: 12,
                    color: 'var(--body)',
                    lineHeight: 1.5,
                    marginBottom: 8,
                    wordBreak: 'break-word'
                  }}
                >
                  {notification.message}
                </div>

                {/* Action buttons */}
                <div style={{ display: 'flex', gap: 6 }}>
                  <button
                    onClick={() => handleJumpToSession(notification.sessionId)}
                    style={{
                      fontSize: 11,
                      fontWeight: 500,
                      color: '#fff',
                      background: 'var(--accent)',
                      border: 'none',
                      borderRadius: 'var(--radius-sm)',
                      padding: '4px 10px',
                      cursor: 'pointer',
                      transition: 'all 0.15s',
                      fontFamily: 'var(--font-sans)'
                    }}
                    onMouseEnter={e => {
                      (e.target as HTMLElement).style.background = 'var(--accent-light)';
                    }}
                    onMouseLeave={e => {
                      (e.target as HTMLElement).style.background = 'var(--accent)';
                    }}
                  >
                    Jump to session
                  </button>
                  <button
                    onClick={() => handleDismiss(notification.id)}
                    style={{
                      fontSize: 11,
                      color: 'var(--caption)',
                      background: 'transparent',
                      border: '1px solid var(--hairline)',
                      borderRadius: 'var(--radius-sm)',
                      padding: '4px 10px',
                      cursor: 'pointer',
                      transition: 'all 0.15s',
                      fontFamily: 'var(--font-sans)'
                    }}
                    onMouseEnter={e => {
                      (e.target as HTMLElement).style.color = 'var(--ink)';
                      (e.target as HTMLElement).style.borderColor = 'var(--caption)';
                    }}
                    onMouseLeave={e => {
                      (e.target as HTMLElement).style.color = 'var(--caption)';
                      (e.target as HTMLElement).style.borderColor = 'var(--hairline)';
                    }}
                  >
                    Dismiss
                  </button>
                </div>
              </div>
            );
          })
        )}
      </div>
    </div>
  );
}

export default NotifyPanel;
