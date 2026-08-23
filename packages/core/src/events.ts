import { randomUUID } from "node:crypto";

export const EVENT_NAMES = [
  "tool.started", "tool.completed", "tool.failed", "process.started", "process.stdout",
  "process.stderr", "process.exited", "policy.allowed", "policy.blocked", "policy.approval_required",
  "workspace.changed", "tunnel.connected", "tunnel.disconnected",
] as const;

export type EventName = (typeof EVENT_NAMES)[number];

export interface AgentEvent {
  id: string;
  name: EventName;
  timestamp: string;
  data: Record<string, unknown>;
}

export type EventListener = (event: AgentEvent) => void;

export class EventBus {
  private readonly listeners = new Set<EventListener>();
  private readonly history: AgentEvent[] = [];

  on(listener: EventListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  emit(name: EventName, data: Record<string, unknown> = {}): AgentEvent {
    const event: AgentEvent = { id: randomUUID(), name, timestamp: new Date().toISOString(), data };
    this.history.push(event);
    if (this.history.length > 500) this.history.shift();
    for (const listener of this.listeners) {
      try { listener(event); } catch { /* logging must not break execution */ }
    }
    return event;
  }

  recent(limit = 100): AgentEvent[] { return this.history.slice(-Math.max(1, Math.min(limit, 500))); }
}
