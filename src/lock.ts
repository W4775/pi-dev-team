import { existsSync, mkdirSync, rmSync, statSync } from "node:fs";

const STALE_MS = 15_000;
const WAIT_TOTAL_MS = 8_000;
const WAIT_STEP_MS = 25;

function sleepSync(ms: number): void {
  const until = Date.now() + ms;
  while (Date.now() < until) {
    /* spin: lock hold times are milliseconds */
  }
}

function lockPathFor(target: string): string {
  return `${target}.lock`;
}

function acquire(lockPath: string): boolean {
  try {
    mkdirSync(lockPath);
    return true;
  } catch {
    try {
      const age = Date.now() - statSync(lockPath).mtimeMs;
      if (age > STALE_MS) {
        rmSync(lockPath, { recursive: true, force: true });
        mkdirSync(lockPath);
        return true;
      }
    } catch {
      /* still held */
    }
    return false;
  }
}

/**
 * Cross-process lock for run-state writes. Parallel implementor children
 * append notes at the same time; an unlocked read-modify-write loses one.
 */
export function withStateLock<T>(target: string, fn: () => T): T {
  const lockPath = lockPathFor(target);
  const deadline = Date.now() + WAIT_TOTAL_MS;
  while (!acquire(lockPath)) {
    if (Date.now() >= deadline) break;
    sleepSync(WAIT_STEP_MS);
  }
  if (!existsSync(lockPath)) {
    try {
      mkdirSync(lockPath);
    } catch {
      /* proceed anyway — better a race than a hang */
    }
  }
  try {
    return fn();
  } finally {
    try {
      rmSync(lockPath, { recursive: true, force: true });
    } catch {
      /* ignore */
    }
  }
}
