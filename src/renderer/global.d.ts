export interface ElectronAPI {
  invoke: (channel: string, ...args: any[]) => Promise<any>;
  projectDir: () => string;
  onOutput: (id: string, callback: (data: string) => void) => () => void;
  onExit: (id: string, callback: (code: number) => void) => () => void;
  onSessionIdChanged: (id: string, callback: (agentSessionId: string) => void) => () => void;

  // Stats
  getAgentStats: () => Promise<any[]>;
  getStatsTotals: () => Promise<{ tokens: number; cost: number; running: number; failed: number }>;

  // Notifications
  getNotifications: (includeDismissed?: boolean) => Promise<any[]>;
  dismissNotification: (id: string) => Promise<void>;
  dismissSessionNotifications: (sessionId: string) => Promise<void>;
  getNotificationCount: () => Promise<number>;
  onNotification: (callback: (notification: any) => void) => () => void;

  // Window controls
  closeWindow: () => void;
}

declare global {
  interface Window {
    electronAPI: ElectronAPI;
  }
}
