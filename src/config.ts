import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { ProjectConfig } from "./types.ts";

export function loadDevteamConfig(
  cwd: string | undefined,
  trusted: boolean,
  configDirNames: string | readonly string[] = ".pi",
): ProjectConfig | null {
  if (!trusted || !cwd) return null;
  const dirs = typeof configDirNames === "string" ? [configDirNames] : [...configDirNames];
  for (const dir of dirs) {
    const path = join(cwd, dir, "devteam.json");
    if (!existsSync(path)) continue;
    try {
      const raw = JSON.parse(readFileSync(path, "utf8")) as ProjectConfig;
      if (raw && typeof raw === "object") return raw;
    } catch {
      /* try next */
    }
  }
  return null;
}
