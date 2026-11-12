import { mkdirSync, rmSync, statSync } from "node:fs";

const WAIT_TOTAL_MS = 8_000;
const WAIT_STEP_MS = 25;
const sleepBuffer = new Int32Array(new SharedArrayBuffer(4));

/**
 * Cross-process lock for run-state read-modify-write operations.
 * After a crash, stop all writers and remove the abandoned .lock directory manually.
 * PID/age checks cannot safely unlink a lock that may have been replaced meanwhile.
 */
export function withStateLock<T>(target: string, fn: () => T): T {
  const lockPath = `${target}.lock`;
  const deadline = Date.now() + WAIT_TOTAL_MS;
  while (true) {
    try {
      mkdirSync(lockPath);
      break;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      if (Date.now() >= deadline) {
        throw new Error(
          `Timed out acquiring state lock: ${lockPath}. If abandoned, stop all writers before removing this directory manually.`,
        );
      }
      Atomics.wait(sleepBuffer, 0, 0, WAIT_STEP_MS);
    }
  }

  const owner = statSync(lockPath);
  let result: T;
  let cleanupError: unknown;
  try {
    result = fn();
  } finally {
    try {
      const current = statSync(lockPath);
      if (current.dev === owner.dev && current.ino === owner.ino) {
        rmSync(lockPath, { recursive: true, force: true });
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") cleanupError = error;
    }
  }
  if (cleanupError) throw cleanupError;
  return result;
}
