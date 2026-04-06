export function createEventBus() {
  const listeners = new Set();

  return {
    emit(event) {
      for (const listener of listeners) {
        try {
          listener(event);
        } catch {
          // Isolate listener errors to prevent disrupting other subscribers.
        }
      }
    },
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
}
