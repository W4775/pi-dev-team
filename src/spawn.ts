import { existsSync } from "node:fs";
import { basename } from "node:path";
import type { ChildAssignment, IsolatedRole, ServiceInfo } from "./types.ts";

export type HostInvocation = {
  command: string;
  args: string[];
  shell: boolean;
};

export type InvocationRuntime = {
  argv?: string[];
  execPath?: string;
  platform?: NodeJS.Platform;
};

/**
 * How Oh My Pi launches a nested `omp` (`resolveOmpCommand`): honor
 * `PI_SUBPROCESS_CMD`, re-exec a `.js`/`.ts` entry, otherwise the packed
 * binary or `omp.cmd` on Windows (which needs `shell: true`).
 */
export function getPiInvocation(
  args: string[],
  env: NodeJS.ProcessEnv = process.env,
  runtime: InvocationRuntime = {},
): HostInvocation {
  const argv = runtime.argv ?? process.argv;
  const execPath = runtime.execPath ?? process.execPath;
  const platform = runtime.platform ?? process.platform;
  const win = platform === "win32";

  const subprocessCmd = env.PI_SUBPROCESS_CMD?.trim();
  if (subprocessCmd) {
    return { command: subprocessCmd, args, shell: win };
  }

  const currentScript = argv[1];
  const isBunVirtualScript = currentScript?.startsWith("/$bunfs/root/");
  const isJsEntry = Boolean(currentScript && /\.[cm]?[tj]sx?$/i.test(currentScript));
  if (currentScript && !isBunVirtualScript && isJsEntry && existsSync(currentScript)) {
    return { command: execPath, args: [currentScript, ...args], shell: false };
  }

  const execName = basename(execPath.replaceAll("\\", "/")).toLowerCase();
  const isGenericRuntime = /^(node|bun)(\.exe)?$/.test(execName);
  if (!isGenericRuntime) {
    return { command: execPath, args, shell: false };
  }

  if (isOmpHost(env, argv, execPath) && win) {
    return { command: "omp.cmd", args, shell: true };
  }
  return { command: hostBinaryName(env, argv, execPath), args, shell: false };
}

export function hostBinaryName(
  env: NodeJS.ProcessEnv = process.env,
  argv: string[] = process.argv,
  execPath: string = process.execPath,
): "omp" | "pi" {
  return isOmpHost(env, argv, execPath) ? "omp" : "pi";
}

export const READ_TOOL_NAMES = ["read", "grep", "find", "ls", "bash"] as const;

/**
 * Oh My Pi built-ins are `read` / `grep` / `glob` / `bash`. `find` is a legacy
 * alias for `glob`; `ls` is not a tool and fails `--tools` validation.
 */
export function mapToolsForHost(tools: string[], omp: boolean): string[] {
  if (!omp) return [...tools];
  const mapped = tools.map((name) => (name === "find" || name === "ls" ? "glob" : name));
  return [...new Set(mapped)];
}

export function toolsForRole(role: IsolatedRole): string[] {
  const custom = ["devteam_state", "devteam_handoff"];
  if (role === "design_critic" || role === "frontend" || role === "general") {
    custom.push("devteam_mockup");
  }
  if (role === "scout") return ["read", "grep", "find", "ls", ...custom];
  if (role === "orchestrator" || role === "planner_orchestrator") return [...READ_TOOL_NAMES, ...custom];
  if (role === "database" || role === "backend" || role === "frontend" || role === "general") {
    return [...READ_TOOL_NAMES, "edit", "write", ...custom];
  }
  return [...READ_TOOL_NAMES, ...custom];
}

export type ChildCliOptions = {
  extensionPath: string;
  rolePromptFile: string;
  role: IsolatedRole;
  statePath: string;
  skillDirs: string[];
  tools: string[];
  model?: string;
  thinking?: string;
  trusted?: boolean;
  prompt: string;
  /** Force Oh My Pi argv shape in tests. Defaults to `isOmpHost()`. */
  omp?: boolean;
  serviceName?: string;
  taskId?: string;
};

export function isOmpHost(
  env: NodeJS.ProcessEnv = process.env,
  argv: string[] = process.argv,
  execPath: string = process.execPath,
): boolean {
  const forced = (env.DEVTEAM_HOST ?? "").trim().toLowerCase();
  if (forced === "omp" || forced === "oh-my-pi") return true;
  if (forced === "pi") return false;

  if (env.OH_MY_PI === "1" || env.OH_MY_PI === "true") return true;
  if ((env.PI_CODING_AGENT_PACKAGE ?? "").includes("oh-my-pi")) return true;
  if (Object.keys(env).some((key) => key.startsWith("OMP_") || key.startsWith("OH_MY_PI"))) return true;

  const candidates = [execPath, argv[1] ?? "", argv[0] ?? "", env._ ?? ""]
    .map((value) => value.toLowerCase().replaceAll("\\", "/"))
    .filter(Boolean);
  return candidates.some(
    (path) => path.includes("oh-my-pi") || path.includes("/.omp/") || /\/omp(\.\w+)?$/.test(path),
  );
}

/** Flags that consume the following argv entry as their value. */
const VALUE_FLAGS = new Set([
  "-e",
  "--extension",
  "--mode",
  "--model",
  "--thinking",
  "--tools",
  "--skill",
  "--append-system-prompt",
  "--devteam-role",
  "--devteam-state",
  "--devteam-service",
  "--devteam-task",
]);

/**
 * Hosts reject unrecognized flags before the extension loads, so the only
 * reliable signal is the failure text itself. Flags learned this way are reused
 * for every later child in the session.
 */
const rejectedFlags = new Set<string>();

export function parseUnknownFlags(output: string): string[] {
  const found = new Set<string>();
  const pattern = /unknown|unrecognized|unsupported/i;
  for (const line of output.split(/\r?\n/)) {
    if (!pattern.test(line)) continue;
    const tail = line.slice(line.search(pattern));
    for (const match of tail.matchAll(/(?<![\w-])(--?[A-Za-z][\w-]*)/g)) {
      const flag = match[1];
      if (flag && flag !== "--help") found.add(flag);
    }
  }
  return [...found];
}

export function rememberRejectedFlags(flags: Iterable<string>): void {
  for (const flag of flags) rejectedFlags.add(flag);
}

export function knownRejectedFlags(): string[] {
  return [...rejectedFlags];
}

export function resetRejectedFlags(): void {
  rejectedFlags.clear();
}

export function stripFlags(args: string[], flags: Iterable<string>): string[] {
  const drop = new Set(flags);
  if (!drop.size) return [...args];
  const lastIndex = args.length - 1;
  const kept: string[] = [];
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i] ?? "";
    if (i === lastIndex) {
      kept.push(arg);
      break;
    }
    const eq = arg.indexOf("=");
    const name = arg.startsWith("-") && eq > 0 ? arg.slice(0, eq) : arg;
    if (!drop.has(name)) {
      kept.push(arg);
      continue;
    }
    if (eq < 0 && VALUE_FLAGS.has(name) && i + 1 < lastIndex) i += 1;
  }
  return kept;
}

/**
 * Rebuild argv after a host rejected flags: drop them, and keep the child
 * non-interactive by swapping Pi's `-a` for Oh My Pi's `--yolo`.
 */
export function adaptArgsForUnknownFlags(args: string[], unknown: Iterable<string>): string[] {
  const dropped = new Set(unknown);
  const next = stripFlags(args, dropped);
  if (dropped.has("-a") && !rejectedFlags.has("--yolo") && !next.includes("--yolo")) {
    next.splice(Math.max(next.length - 1, 0), 0, "--yolo");
  }
  return next;
}

export function childProcessEnv(
  role: IsolatedRole,
  statePath: string,
  env: NodeJS.ProcessEnv = process.env,
  extra?: { serviceName?: string; taskId?: string },
): NodeJS.ProcessEnv {
  const next: NodeJS.ProcessEnv = {
    ...env,
    DEVTEAM_ROLE: role,
    DEVTEAM_STATE: statePath,
  };
  if (extra?.serviceName) next.DEVTEAM_SERVICE = extra.serviceName;
  else delete next.DEVTEAM_SERVICE;
  if (extra?.taskId) next.DEVTEAM_TASK = extra.taskId;
  else delete next.DEVTEAM_TASK;
  return next;
}

export function buildChildCliArgs(opts: ChildCliOptions): string[] {
  const omp = opts.omp ?? isOmpHost();
  const args = ["--mode", "json", "-p", "--no-session", "--no-skills"];
  args.push("-e", opts.extensionPath);
  if (opts.trusted) args.push(omp ? "--yolo" : "-a");
  if (opts.model) args.push("--model", opts.model);
  if (opts.thinking) args.push("--thinking", opts.thinking);
  if (opts.tools.length) args.push("--tools", mapToolsForHost(opts.tools, omp).join(","));
  args.push("--append-system-prompt", opts.rolePromptFile);
  // Oh My Pi loads `-e` extensions, then reparses argv, then errors on
  // leftover unknown flags (`Error: unknown flags: …`, exit 2). Flags we
  // register (`--devteam-role`, …) survive. Pi's `-a` and `--skill` do not:
  // auto-approve is `--yolo` / `--auto-approve`, and `--skills` is a glob
  // filter, not a skill-directory injector. Role/state go via env. Skill
  // paths are listed in the user prompt for the read tool.
  if (!omp) {
    args.push("--devteam-role", opts.role);
    args.push("--devteam-state", opts.statePath);
    if (opts.serviceName) args.push("--devteam-service", opts.serviceName);
    if (opts.taskId) args.push("--devteam-task", opts.taskId);
    for (const dir of opts.skillDirs) {
      if (dir) args.push("--skill", dir);
    }
  }
  args.push(opts.prompt);
  return adaptArgsForUnknownFlags(args, knownRejectedFlags());
}

function serviceBlock(role: IsolatedRole, service?: ServiceInfo, services?: ServiceInfo[]): string {
  if (service) {
    const root = service.root ? `${service.root}/` : "the repository root";
    const langs = service.languages.length ? service.languages.join(" + ") : "unknown";
    return [
      `Service: ${service.name} — ${langs}, rooted at ${root}. Write ${langs} the way the rest of that service is written; do not carry another service's idioms into it.`,
      service.test.length ? `Tests: run \`${service.test.join(" && ")}\` from ${root}` : "",
      service.lint.length ? `Lint: \`${service.lint.join(" && ")}\`` : "",
    ]
      .filter(Boolean)
      .join("\n");
  }
  const all = services ?? [];
  if (all.length < 2) return "";
  const wantsCommands = role === "tester" || role === "linter";
  const lines = all.map((entry) => {
    const root = entry.root ? `${entry.root}/` : "./";
    const langs = entry.languages.length ? entry.languages.join("+") : "unknown";
    const kind = role === "linter" ? entry.lint : entry.test;
    const commands = wantsCommands && kind.length ? ` — \`${kind.join(" && ")}\`` : "";
    return `- ${entry.name} (${langs}) at ${root}${commands}`;
  });
  const header = wantsCommands
    ? `This repository has ${all.length} services. Cover every service the change touched, running each one's command from its own directory:`
    : `This repository has ${all.length} services, each with its own toolchain:`;
  return [header, ...lines].join("\n");
}

export function expectedHandoffActions(role: IsolatedRole): string[] {
  switch (role) {
    case "plan_critic":
    case "design_critic":
      return ["critic_approve", "critic_revise"];
    case "planner_orchestrator":
      return ["scout_planned"];
    case "scout":
      return ["scout_done"];
    case "orchestrator":
      return ["work_planned"];
    case "database":
    case "backend":
    case "frontend":
    case "general":
      return ["implementor_done"];
    case "reviewer":
    case "tester":
    case "linter":
      return ["qa_pass", "qa_fail"];
    case "commit_message":
      return ["commit_drafted"];
    default:
      return [];
  }
}

export function childUserPrompt(
  role: IsolatedRole,
  task: string,
  skillDirs: string[] = [],
  service?: ServiceInfo,
  services?: ServiceInfo[],
  assignment?: ChildAssignment,
): string {
  const skillLines = skillDirs
    .filter(Boolean)
    .map((dir) => `- ${dir.replace(/\\/g, "/")}/SKILL.md`);
  const actions = expectedHandoffActions(role);
  const handoff = assignment
    ? assignment.list === "scout"
      ? `Your last action must be devteam_handoff with action scout_done. Put the findings in the summary (what exists, where, constraints the spec must respect). That marks scout ${assignment.id} complete.`
      : `Your last action must be devteam_handoff with action implementor_done and a one-line summary. That marks work item ${assignment.id} complete; it does not advance the whole pipeline.`
    : actions.length
      ? `Your last action must be devteam_handoff with action ${actions.join(" or ")}. The pipeline cannot advance until you call it.`
      : `Your last action must be devteam_handoff.`;
  const assigned = assignment
    ? assignment.list === "scout"
      ? [
          `Your scout assignment (${assignment.id}): ${assignment.title}`,
          assignment.details ? assignment.details : "",
          assignment.files.length
            ? `Start in these paths (you may read neighbours when a trail leads there):\n${assignment.files.map((file) => `- ${file}`).join("\n")}`
            : "",
          `Report facts: existing files, types, endpoints, and patterns. Do not propose work items. Do not write a spec.`,
        ]
          .filter(Boolean)
          .join("\n")
      : [
          `Your assignment (work item ${assignment.id}): ${assignment.title}`,
          assignment.details ? assignment.details : "",
          assignment.files.length
            ? `Stay inside these paths — other subagents are editing the rest of the tree right now:\n${assignment.files.map((file) => `- ${file}`).join("\n")}`
            : "",
          `Do not do other items' work. Append what you did to ${assignment.layer ?? "general"}Notes with devteam_state.`,
        ]
          .filter(Boolean)
          .join("\n")
    : "";
  return [
    `You are the ${role.replaceAll("_", " ")} for this /devteam run.`,
    `Task: ${task || "(see devteam_state)"}`,
    serviceBlock(role, service, services),
    assigned,
    `First: call devteam_state with action "get". Then read each attached skill's SKILL.md (use the read tool).`,
    skillLines.length ? `Skill files:\n${skillLines.join("\n")}` : "",
    `Follow /skill:<name> together with TDD at agreed seams when you are implementing.`,
    handoff,
    `Do not start /devteam. Do not git commit.`,
    assignment?.list === "scout"
      ? `Stay under 40 tool calls. If you cannot finish the map, hand off what you found.`
      : `Stay under 80 tool calls. If the remaining work does not fit, hand off with what you finished and leave the rest in notes.`,
  ]
    .filter(Boolean)
    .join("\n");
}

export function assertNoNoExtensions(args: string[]): void {
  if (args.includes("--no-extensions")) {
    throw new Error("Isolated children must inherit user extensions; do not pass --no-extensions.");
  }
}
