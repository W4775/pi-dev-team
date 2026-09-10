import { spawnSync } from "node:child_process";

export function captureGit(cwd: string): { baseline?: string; dirty: boolean } {
  const baseline = spawnSync("git", ["rev-parse", "HEAD"], {
    cwd,
    encoding: "utf8",
    timeout: 10_000,
  });
  const status = spawnSync("git", ["status", "--porcelain"], {
    cwd,
    encoding: "utf8",
    timeout: 10_000,
  });
  return {
    baseline: baseline.status === 0 ? baseline.stdout.trim() || undefined : undefined,
    dirty: status.status === 0 ? status.stdout.trim().length > 0 : false,
  };
}
