import { create } from 'zustand';

export interface Session { id: string; agent: string; dockviewId: string; ptyId?: string; }

export const useSessionStore = create<{
  sessions: Session[];
  add: (s: Session) => void;
  remove: (_dockviewId: string) => void;
  updateId: (_dockviewId: string, _ptyId: string) => void;
}>((set) => ({
  sessions: [],
  add: (s) => set((st) => ({ sessions: [...st.sessions, s] })),
  remove: (id) => set((st) => ({ sessions: st.sessions.filter((s) => s.dockviewId !== id) })),
  updateId: (dockviewId, ptyId) => set((st) => ({
    sessions: st.sessions.map((s) => s.dockviewId === dockviewId ? { ...s, ptyId } : s),
  })),
}));
