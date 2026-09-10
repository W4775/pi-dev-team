import { readFileSync } from "node:fs";
import { join } from "node:path";
import { packageRoot } from "./catalog.ts";
import type { RoleName } from "./types.ts";

export function rolePromptPath(role: RoleName): string {
  return join(packageRoot(), "roles", `${role}.md`);
}

export function loadRolePrompt(role: RoleName): string {
  return readFileSync(rolePromptPath(role), "utf8");
}
