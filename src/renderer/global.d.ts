/* eslint-disable no-unused-vars */
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

  // Task Queue APIs
  enqueueTask: (input: { title: string; description: string; priority: string; requiredCapabilities: string[] }) => Promise<any>;
  listTasks: (status?: string) => Promise<any[]>;
  getTaskStats: () => Promise<any>;
  completeTask: (taskId: string, result: string) => Promise<void>;
  failTask: (taskId: string, error: string) => Promise<void>;

  // Context Sharing APIs
  publishContext: (sessionId: string, agentId: string, input: any) => Promise<any>;
  listContext: (filter?: any) => Promise<any[]>;
  markContextConsumed: (id: string) => Promise<void>;
  onNewContext: (callback: (entry: any) => void) => () => void;

  // Worktree APIs
  createWorktree: (args: { sessionId: string; agentId: string; projectPath: string; baseBranch?: string }) => Promise<any>;
  listWorktrees: () => Promise<any[]>;
  getWorktree: (sessionId: string) => Promise<any | null>;
  cleanupWorktree: (args: { sessionId: string; keepBranch?: boolean; force?: boolean }) => Promise<void>;
  getWorktreeConflicts: () => Promise<any>;

  // Window controls
  closeWindow: () => void;

  // External editor
  openInEditor: (path: string, editor?: string) => Promise<{ success: boolean; editor?: string; error?: string }>;
  detectEditor: () => Promise<{ editor: string | null }>;
}

declare global {
  interface Window {
    electronAPI: ElectronAPI;
  }
}
