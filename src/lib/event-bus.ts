import type { EventBus, EventListener } from "../types.js";

export function createEventBus(): EventBus {
  const listeners = new Set<EventListener>();

  return {
    emit(event: Record<string, unknown>): void {
      for (const listener of listeners) {
        try {
          listener(event);
        } catch {
          // Isolate listener errors to prevent disrupting other subscribers.
        }
      }
    },
    subscribe(listener: EventListener): () => void {
      listeners.add(listener);
      return () => { listeners.delete(listener); };
    },
  };
}
