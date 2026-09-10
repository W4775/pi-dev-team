const queues = new Map<string, Promise<unknown>>();

/** Serialize mutations to the same path. Used when the host does not export withFileMutationQueue (Oh My Pi). */
export async function withFileMutationQueue<T>(filePath: string, fn: () => Promise<T> | T): Promise<T> {
  const key = filePath;
  const previous = queues.get(key) ?? Promise.resolve();
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const current = previous.then(() => gate);
  queues.set(key, current);

  await previous;
  try {
    return await fn();
  } finally {
    release();
    if (queues.get(key) === current) queues.delete(key);
  }
}
