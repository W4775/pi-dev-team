import { readFileSync, realpathSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { Catalog } from "./types.ts";

function resolvePackageRoot(): string {
  const dir = join(dirname(fileURLToPath(import.meta.url)), "..");
  try {
    return realpathSync(dir);
  } catch {
    return dir;
  }
}

export function catalogDir(): string {
  return join(resolvePackageRoot(), "catalog");
}

export function loadCatalog(path = join(catalogDir(), "stacks.json")): Catalog {
  const raw = readFileSync(path, "utf8");
  const parsed = JSON.parse(raw) as Catalog;
  if (!Array.isArray(parsed.stacks)) throw new Error("Invalid catalog: missing stacks[]");
  return {
    maxSkillsPerChild: parsed.maxSkillsPerChild ?? 3,
    stacks: parsed.stacks,
  };
}

export function packageRoot(): string {
  return resolvePackageRoot();
}

export function bundledSkillDir(name: string): string {
  return join(packageRoot(), "skills", name);
}

export const WORKFLOW_SKILLS = [
  "grilling",
  "to-spec",
  "to-tickets",
  "codebase-design",
  "tdd",
  "implement",
  "code-review",
  "diagnosing-bugs",
  "frontend-design",
] as const;

export function thisExtensionEntry(): string {
  return join(packageRoot(), "src", "index.ts");
}

export function workflowSkillsForRole(
  role: string,
  opts?: { diagnosing?: boolean },
): string[] {
  switch (role) {
    case "planner":
      return ["grilling", "to-spec", "to-tickets", "codebase-design"];
    case "plan_critic":
      return ["to-spec", "codebase-design"];
    case "orchestrator":
      return ["to-tickets", "codebase-design"];
    case "designer":
    case "design_critic":
      return ["frontend-design"];
    case "database":
    case "backend":
    case "frontend":
    case "general":
      return opts?.diagnosing ? ["implement", "tdd", "diagnosing-bugs"] : ["implement", "tdd"];
    case "orchestrator":
    case "planner_orchestrator":
      return ["codebase-design"];
    case "scout":
      return ["codebase-design"];
    case "reviewer":
      return ["code-review"];
    case "tester":
      return opts?.diagnosing ? ["tdd", "diagnosing-bugs"] : ["tdd"];
    default:
      return [];
  }
}
