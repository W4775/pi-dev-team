import { isKnowledgePath } from "./knowledge.ts";
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
} from "./types.ts";

export const WRITE_TOOLS = new Set(["write", "edit"]);

const DENY_PATHS = [".env", "**/.env", "**/.env.*", "**/*.pem", "**/id_rsa", "**/id_ed25519"];

export function isImplementorRole(role: RoleName | undefined): role is ImplementorLayer {
  return IMPLEMENTOR_LAYERS.includes(role as ImplementorLayer);
}

export function isWriteTool(toolName: string): boolean {
  return WRITE_TOOLS.has(toolName);
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
  knowledgeRel?: string,
): WriteGate {
  if (
    knowledgeRel &&
    (role === "scout" || role === "planner") &&
    isKnowledgePath(filePath, cwd, knowledgeRel)
  ) {
    if (isDeniedPath(filePath, cwd)) {
      return { block: true, reason: "Writing secrets or credential files is blocked." };
    }
    return { block: false };
  }
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
    role === "commit_message"
  ) {
    const where =
      role === "orchestrator"
        ? "devteam_state (section workItems)"
        : role === "planner_orchestrator"
          ? "devteam_state (section scoutItems)"
          : role === "scout"
            ? knowledgeRel
              ? `devteam_handoff summary and OKF concepts under ${knowledgeRel}/`
              : "devteam_handoff summary (scout findings)"
            : role === "planner" && knowledgeRel
              ? `devteam_state and OKF concepts under ${knowledgeRel}/`
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

function commandMatchesAllowlist(command: string, allow: string[]): boolean {
  const trimmed = command.trim();
  return allow.some((entry) => {
    const e = entry.trim();
    if (!e) return false;
    if (trimmed === e) return true;
    if (trimmed.startsWith(`${e} `)) return true;
    // allow `cd foo && npm test`
    const parts = trimmed.split(/&&|\|\||;/).map((p) => p.trim());
    return parts.some((p) => p === e || p.startsWith(`${e} `));
  });
}

export function gateBash(
  role: RoleName | undefined,
  command: string,
  config: ProjectConfig | undefined,
  services?: ServiceInfo[],
): WriteGate {
  const cmd = command.trim();
  if (!role) return { block: false };

  if (role === "commit_message") {
    const ok =
      /^(git status|git diff|git log|git rev-parse)\b/.test(cmd) ||
      commandMatchesAllowlist(cmd, ["git status", "git diff", "git log", "git rev-parse"]);
    if (!ok)
      return {
        block: true,
        reason:
          "Commit-message role may only run git status, git diff, git log, and git rev-parse.",
      };
    if (/\bcommit\b/.test(cmd) && !/^git log\b/.test(cmd)) {
      return { block: true, reason: "Auto-commit is disabled." };
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
    const readOnly =
      /^(git |ls |cat |head |tail |rg |grep |find |wc |file )/.test(cmd) ||
      /^(git status|git diff|git log|git rev-parse|ls|pwd)\b/.test(cmd);
    if (!readOnly)
      return { block: true, reason: `${role} may only run read-only inspection commands.` };
    if (/\bgit commit\b/.test(cmd)) return { block: true, reason: "Auto-commit is disabled." };
    return { block: false };
  }

  if (role === "tester") {
    const allow = [
      ...DEFAULT_TEST_BASH,
      ...(config?.bash?.test ?? []),
      ...serviceCommands(services, "test"),
    ];
    if (
      !commandMatchesAllowlist(cmd, allow) &&
      !/^(cd .+ && )?(npm|pnpm|yarn|pytest|go|cargo|dotnet)\b/.test(cmd)
    ) {
      // still allow common test runners even if not exact
      if (!/\b(test|pytest|vitest|jest)\b/.test(cmd)) {
        return { block: true, reason: "Tester may only run the agreed test commands." };
      }
    }
    if (/\bgit commit\b/.test(cmd)) return { block: true, reason: "Auto-commit is disabled." };
    return { block: false };
  }

  if (role === "linter") {
    const allow = [
      ...DEFAULT_LINT_BASH,
      ...(config?.bash?.lint ?? []),
      ...serviceCommands(services, "lint"),
    ];
    if (
      !commandMatchesAllowlist(cmd, allow) &&
      !/\b(lint|eslint|ruff|clippy|prettier|format)\b/.test(cmd)
    ) {
      return { block: true, reason: "Linter may only run lint commands." };
    }
    if (/\bgit commit\b/.test(cmd)) return { block: true, reason: "Auto-commit is disabled." };
    return { block: false };
  }
  if (role === "demo") {
    const allow = [
      ...DEFAULT_DEMO_BASH,
      ...(config?.bash?.demo ?? []),
      ...serviceCommands(services, "serve"),
    ];
    if (
      !commandMatchesAllowlist(cmd, allow) &&
      !/\b(playwright|headed|xvfb|serve|dev|start)\b/.test(cmd)
    ) {
      return {
        block: true,
        reason: "Demo may only run the agreed serve command and headed Playwright.",
      };
    }
    if (/\bgit commit\b/.test(cmd)) return { block: true, reason: "Auto-commit is disabled." };
    return { block: false };
  }

  if (isImplementorRole(role)) {
    return gateImplementorBash(cmd);
  }

  return { block: false };
}

const IMPLEMENTOR_GIT_READ =
  /^(?:cd\s+.+\s+&&\s+)?git\s+(status|diff|log|show|rev-parse|ls-files|blame|describe)\b/;

function stripEnvPrefix(command: string): string {
  return command.replace(/^(?:[A-Za-z_][A-Za-z0-9_]*=\S*\s+)+/, "").trim();
}

function commandSegments(command: string): string[] {
  return command
    .split(/&&|\|\||;|\n/)
    .map((part) => stripEnvPrefix(part.trim()))
    .filter(Boolean);
}

export function gateImplementorBash(command: string): WriteGate {
  const cmd = command.trim();
  if (/\bgit\s+commit\b/.test(cmd)) return { block: true, reason: "Auto-commit is disabled." };
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
  const allowed: IsolatedRole[] = [
    "plan_critic",
    "design_critic",
    "planner_orchestrator",
    "scout",
    "orchestrator",
    "database",
    "backend",
    "frontend",
    "general",
    "reviewer",
    "tester",
    "linter",
    "commit_message",
  ];
  return allowed.includes(value as IsolatedRole) ? (value as IsolatedRole) : undefined;
}
