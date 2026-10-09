export function createKeyedWriteQueue() {
  const pending = new Map<string, Promise<unknown>>();

  return {
    run<T>(key: string, write: () => Promise<T>): Promise<T> {
      const previous = pending.get(key) ?? Promise.resolve();
      const current = previous.catch(() => undefined).then(write);
      pending.set(key, current);
      // The caller handles the result; cleanup must not create an unhandled rejection.
      void current.finally(() => {
        if (pending.get(key) === current) pending.delete(key);
      }).catch(() => undefined);
      return current;
    },
  };
}
