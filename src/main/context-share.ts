import type { ContextEntry } from '../common/stats-types';

const genId = () => 'ctx-' + Math.random().toString(36).slice(2, 10);

interface PublishInput {
  contextType: string;
  title: string;
  body: string;
  tags: string[];
  priority: ContextEntry['priority'];
}

interface SearchFilter {
  contextType?: string;
  tags?: string[];
  sessionId?: string;
  agentId?: string;
  consumed?: boolean;
}

export class ContextShare {
  private entries = new Map<string, ContextEntry>();

  publish(sessionId: string, agentId: string, input: PublishInput): ContextEntry {
    const entry: ContextEntry = {
      id: genId(),
      sessionId,
      agentId,
      contextType: input.contextType,
      title: input.title,
      body: input.body,
      tags: input.tags,
      priority: input.priority,
      timestamp: Date.now(),
      consumed: false,
    };
    this.entries.set(entry.id, entry);
    return entry;
  }

  get(id: string): ContextEntry | undefined {
    return this.entries.get(id);
  }

  list(): ContextEntry[] {
    return Array.from(this.entries.values()).sort((a, b) => b.timestamp - a.timestamp);
  }

  listForSession(sessionId: string): ContextEntry[] {
    return this.list().filter(e => e.sessionId === sessionId);
  }

  search(filter: SearchFilter): ContextEntry[] {
    let results = this.list();
    if (filter.contextType) results = results.filter(e => e.contextType === filter.contextType);
    if (filter.tags?.length) results = results.filter(e => filter.tags!.some(t => e.tags.includes(t)));
    if (filter.sessionId) results = results.filter(e => e.sessionId === filter.sessionId);
    if (filter.agentId) results = results.filter(e => e.agentId === filter.agentId);
    if (filter.consumed !== undefined) results = results.filter(e => e.consumed === filter.consumed);
    return results;
  }

  markConsumed(id: string): void {
    const entry = this.entries.get(id);
    if (entry) entry.consumed = true;
  }
}
