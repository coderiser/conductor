export interface ElectronAPI {
  invoke: (channel: string, ...args: any[]) => Promise<any>;
  onOutput: (id: string, callback: (data: string) => void) => () => void;
  onExit: (id: string, callback: (code: number) => void) => () => void;
  onSessionIdChanged: (id: string, callback: (agentSessionId: string) => void) => () => void;
  closeWindow: () => void;
}

declare global {
  interface Window {
    electronAPI: ElectronAPI;
  }
}
