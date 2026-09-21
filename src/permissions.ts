import { matchAnyGlob } from "./glob.ts";
import { serviceCommands } from "./services.ts";
import type {
  ImplementorLayer,
  IsolatedRole,
  ProjectConfig,
  RoleName,
  ServiceInfo,
} from "./types.ts";
import {
  DEFAULT_DEMO_BASH,
  DEFAULT_LINT_BASH,
  DEFAULT_TEST_BASH,
  IMPLEMENTOR_LAYERS,
  ISOLATED_ROLES,
} from "./types.ts";

export const WRITE_TOOLS = new Set(["write", "edit"]);

const DENY_PATHS = [".env", "**/.env", "**/.env.*", "**/*.pem", "**/id_rsa", "**/id_ed25519"];

const WRITE_PATH_KEYS = ["path", "file_path", "filePath", "file"] as const;

export function isImplementorRole(role: RoleName | undefined): role is ImplementorLayer {
  return IMPLEMENTOR_LAYERS.includes(role as ImplementorLayer);
}

export function isWriteTool(toolName: string): boolean {
  return WRITE_TOOLS.has(toolName);
}

/** Path from write/edit tool input — hosts disagree on the field name. */
export function writePathFromInput(input: unknown): string | undefined {
  if (!input || typeof input !== "object") return undefined;
  const rec = input as Record<string, unknown>;
  for (const key of WRITE_PATH_KEYS) {
    const value = rec[key];
    if (typeof value === "string" && value.trim()) return value;
  }
  return undefined;
}

function normalizeRel(filePath: string, cwd: string): string {
  const abs = filePath.replaceAll("\\", "/");
  const root = cwd.replaceAll("\\", "/").replace(/\/$/, "");
  if (abs === root) return "";
  if (abs.startsWith(`${root}/`)) return abs.slice(root.length + 1);
  return abs.replace(/^\.\//, "");
}

export function isDeniedPath(filePath: string, cwd: string): boolean {
  const rel = normalizeRel(filePath, cwd);
  const base = rel.split("/").pop() ?? rel;
  if (base === ".env" || base.startsWith(".env.")) return true;
  return matchAnyGlob(DENY_PATHS, rel) || matchAnyGlob(DENY_PATHS, filePath);
}

export function pathAllowedForLayer(
  layer: ImplementorLayer,
  filePath: string,
  cwd: string,
  globs: ProjectConfig["paths"] | undefined,
): boolean {
  const patterns = globs?.[layer];
  if (!patterns || patterns.length === 0) return true;
  const rel = normalizeRel(filePath, cwd);
  return matchAnyGlob(patterns, rel) || matchAnyGlob(patterns, filePath);
}

export type WriteGate = { block: true; reason: string } | { block: false };

export function gateWrite(
  role: RoleName | undefined,
  filePath: string,
  cwd: string,
  config: ProjectConfig | undefined,
  service?: ServiceInfo,
  assignedPaths?: string[],
): WriteGate {
  if (
    !role ||
    role === "planner" ||
    role === "designer" ||
    role === "plan_critic" ||
    role === "design_critic" ||
    role === "orchestrator" ||
    role === "planner_orchestrator" ||
    role === "scout" ||
    role === "reviewer" ||
    role === "tester" ||
    role === "linter" ||
    role === "demo" ||
    role === "commit_message"
  ) {
    const where =
      role === "orchestrator"
        ? "devteam_state (section workItems)"
        : role === "planner_orchestrator"
          ? "devteam_state (section scoutItems)"
          : role === "scout"
            ? "devteam_handoff summary (scout findings)"
            : "devteam_state (and devteam_mockup for the designer)";
    return {
      block: true,
      reason: `${role ?? "this role"} cannot edit the repository. Use ${where}.`,
    };
  }
  if (isDeniedPath(filePath, cwd)) {
    return { block: true, reason: "Writing secrets or credential files is blocked." };
  }
  const rel = normalizeRel(filePath, cwd);
  if (service && !matchAnyGlob(service.paths, rel) && !matchAnyGlob(service.paths, filePath)) {
    return {
      block: true,
      reason: `This pass belongs to the ${service.name} service (${service.root ? `${service.root}/` : "./"}). Changing another service is a separate implementor pass — record what is needed in ${role}Notes instead.`,
    };
  }
  if (
    assignedPaths?.length &&
    !matchAnyGlob(assignedPaths, rel) &&
    !matchAnyGlob(assignedPaths, filePath)
  ) {
    return {
      block: true,
      reason: `This subagent owns only ${assignedPaths.join(", ")}. Another subagent is editing the rest of the tree right now — record anything else you need in ${role}Notes instead.`,
    };
  }
  if (isImplementorRole(role) && !pathAllowedForLayer(role, filePath, cwd, config?.paths)) {
    return { block: true, reason: `Path is outside the ${role} glob allowlist.` };
  }
  return { block: false };
}

function stripEnvPrefix(command: string): string {
  return command.replace(/^(?:[A-Za-z_][A-Za-z0-9_]*=\S*\s+)+/, "").trim();
}

function commandSegments(command: string): string[] {
  return command
    .split(/&&|\|\||;|\n/)
    .map((part) => stripEnvPrefix(part.trim()))
    .filter(Boolean);
}

function isCdOnly(part: string): boolean {
  return /^cd\s+\S/.test(part);
}

function entryMatches(part: string, entry: string): boolean {
  const e = entry.trim();
  if (!e) return false;
  return part === e || part.startsWith(`${e} `);
}

function everySegmentAllowed(
  command: string,
  allow: string[],
  extra?: (part: string) => boolean,
): boolean {
  const parts = commandSegments(command);
  if (!parts.length) return false;
  return parts.every(
    (part) => extra?.(part) === true || allow.some((entry) => entryMatches(part, entry)),
  );
}

function isInspectSegment(part: string): boolean {
  if (isCdOnly(part)) return true;
  if (/^(ls|cat|head|tail|rg|grep|find|wc|file|pwd)\b/.test(part)) return true;
  return /^git\s+(status|diff|log|show|rev-parse|ls-files|blame|describe)\b/.test(part);
}

function isTestRunner(part: string): boolean {
  if (isCdOnly(part)) return true;
  if (/^(pytest|vitest|jest)\b/.test(part)) return true;
  if (/^(npm|pnpm|yarn|bun)\s+(test|run\s+test)\b/.test(part)) return true;
  return /^(go\s+test|cargo\s+test|dotnet\s+test)\b/.test(part);
}

function isLintRunner(part: string): boolean {
  if (isCdOnly(part)) return true;
  if (/^(eslint|ruff|clippy|prettier|oxlint|oxfmt)\b/.test(part)) return true;
  if (/^(npm|pnpm|yarn|bun)\s+run\s+(lint|fmt|format|prettier)\b/.test(part)) return true;
  return /^(cargo\s+clippy|dotnet\s+format|go\s+vet)\b/.test(part);
}

function isDemoRunner(part: string): boolean {
  if (isCdOnly(part)) return true;
  if (/^(npx\s+)?playwright\b/.test(part)) return true;
  if (/^xvfb-run\b/.test(part)) return true;
  return /^(npm|pnpm|yarn|bun)\s+(run\s+)?(dev|start)\b/.test(part);
}

function denyGitCommit(command: string): WriteGate | undefined {
  if (/\bgit\s+commit\b/.test(command)) return { block: true, reason: "Auto-commit is disabled." };
  return undefined;
}

export function gateBash(
  role: RoleName | undefined,
  command: string,
  config: ProjectConfig | undefined,
  services?: ServiceInfo[],
): WriteGate {
  const cmd = command.trim();
  if (!role) {
    return { block: true, reason: "Bash is blocked until a /devteam role is active." };
  }

  const commit = denyGitCommit(cmd);
  if (commit) return commit;

  if (role === "commit_message") {
    const ok = everySegmentAllowed(cmd, ["git status", "git diff", "git log", "git rev-parse"]);
    if (!ok) {
      return {
        block: true,
        reason:
          "Commit-message role may only run git status, git diff, git log, and git rev-parse.",
      };
    }
    return { block: false };
  }

  if (
    role === "planner" ||
    role === "designer" ||
    role === "plan_critic" ||
    role === "design_critic" ||
    role === "planner_orchestrator" ||
    role === "scout" ||
    role === "orchestrator" ||
    role === "reviewer"
  ) {
    if (!everySegmentAllowed(cmd, [], isInspectSegment)) {
      return { block: true, reason: `${role} may only run read-only inspection commands.` };
    }
    return { block: false };
  }

  if (role === "tester") {
    const allow = [
      ...DEFAULT_TEST_BASH,
      ...(config?.bash?.test ?? []),
      ...serviceCommands(services, "test"),
    ];
    if (!everySegmentAllowed(cmd, allow, isTestRunner)) {
      return { block: true, reason: "Tester may only run the agreed test commands." };
    }
    return { block: false };
  }

  if (role === "linter") {
    const allow = [
      ...DEFAULT_LINT_BASH,
      ...(config?.bash?.lint ?? []),
      ...serviceCommands(services, "lint"),
    ];
    if (!everySegmentAllowed(cmd, allow, isLintRunner)) {
      return { block: true, reason: "Linter may only run lint commands." };
    }
    return { block: false };
  }

  if (role === "demo") {
    const allow = [
      ...DEFAULT_DEMO_BASH,
      ...(config?.bash?.demo ?? []),
      ...serviceCommands(services, "serve"),
    ];
    if (!everySegmentAllowed(cmd, allow, isDemoRunner)) {
      return {
        block: true,
        reason: "Demo may only run the agreed serve command and headed Playwright.",
      };
    }
    return { block: false };
  }

  if (isImplementorRole(role)) {
    return gateImplementorBash(cmd);
  }

  return { block: true, reason: "Bash is blocked for this role." };
}

const IMPLEMENTOR_GIT_READ = /^git\s+(status|diff|log|show|rev-parse|ls-files|blame|describe)\b/;

export function gateImplementorBash(command: string): WriteGate {
  const cmd = command.trim();
  const commit = denyGitCommit(cmd);
  if (commit) return commit;
  if (/\b(sudo|doas)\b/.test(cmd)) {
    return { block: true, reason: "Privileged commands are blocked." };
  }
  if (/\b(curl|wget)\b/.test(cmd)) {
    return { block: true, reason: "Network fetch (curl/wget) is blocked for implementors." };
  }
  if (/\brm\s+(?:-[a-zA-Z]*r[a-zA-Z]*|--recursive)\b/.test(cmd)) {
    return { block: true, reason: "Recursive delete is blocked." };
  }

  for (const part of commandSegments(cmd)) {
    if (/^git\b/.test(part) && !IMPLEMENTOR_GIT_READ.test(part)) {
      return { block: true, reason: "Implementors may not mutate git state." };
    }
    if (
      /\b(?:npm|pnpm|yarn|bun)\s+(?:i|install|add|remove|uninstall|ci)\b/.test(part) ||
      /\b(?:pip|pip3)\s+install\b/.test(part) ||
      /\bpoetry\s+add\b/.test(part) ||
      /\bcargo\s+(?:add|install)\b/.test(part) ||
      /\bgo\s+get\b/.test(part)
    ) {
      return { block: true, reason: "Package installs are blocked." };
    }
  }
  return { block: false };
}

export function isolatedRoleFromFlag(value: unknown): IsolatedRole | undefined {
  if (typeof value !== "string") return undefined;
  return (ISOLATED_ROLES as readonly string[]).includes(value)
    ? (value as IsolatedRole)
    : undefined;
}
