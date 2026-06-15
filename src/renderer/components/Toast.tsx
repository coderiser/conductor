import { useState, useEffect } from 'react';

interface Toast {
  id: number;
  message: string;
  type: 'error' | 'success' | 'info';
}

let toastId = 0;
const listeners: Array<(toasts: Toast[]) => void> = [];
let toasts: Toast[] = [];

function notify() {
  listeners.forEach((l) => l([...toasts]));
}

export function showToast(message: string, type: 'error' | 'success' | 'info' = 'info') {
  const id = ++toastId;
  toasts = [...toasts, { id, message, type }];
  notify();
  // Auto-remove after 4 seconds
  setTimeout(() => {
    toasts = toasts.filter((t) => t.id !== id);
    notify();
  }, 4000);
}

export function ToastContainer() {
  const [items, setItems] = useState<Toast[]>([]);

  useEffect(() => {
    listeners.push(setItems);
    return () => {
      const idx = listeners.indexOf(setItems);
      if (idx >= 0) listeners.splice(idx, 1);
    };
  }, []);

  if (items.length === 0) return null;

  return (
    <div style={{
      position: 'fixed',
      bottom: 20,
      right: 20,
      zIndex: 99999,
      display: 'flex',
      flexDirection: 'column',
      gap: 8,
      maxWidth: 360,
    }}>
      {items.map((t) => (
        <div
          key={t.id}
          style={{
            background: t.type === 'error' ? '#dc2626' : t.type === 'success' ? '#16a34a' : '#2563eb',
            color: '#fff',
            padding: '10px 14px',
            borderRadius: 6,
            fontSize: 12,
            fontFamily: 'system-ui, -apple-system, sans-serif',
            boxShadow: '0 4px 12px rgba(0,0,0,0.3)',
            animation: 'slideIn 0.2s ease-out',
            lineHeight: 1.4,
          }}
        >
          {t.type === 'error' && '⚠ '}
          {t.type === 'success' && '✓ '}
          {t.type === 'info' && 'ℹ '}
          {t.message}
        </div>
      ))}
    </div>
  );
}
