import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { bundledSkillDir, thisExtensionEntry, workflowSkillsForRole } from "./catalog.ts";
import { formatChildFailure, spawnPiChild, type SpawnedChild } from "./child-process.ts";
import {
  bashFailedFromChildOutput,
  formatElapsed,
  isRepeatedToolLoop,
  resolveMaxToolCalls,
  resolveRepeatToolAbort,
  type ChildActivity,
  type ProgressUpdate,
} from "./child-progress.ts";
import { detectStack } from "./detect-stack.ts";
import { projectTrusted } from "./host-compat.ts";
import type { ExtensionContext } from "./pi-host.ts";
import { reviewScope, stackLayerForRole, step } from "./pipeline.ts";
import { loadRolePrompt } from "./roles.ts";
import { serviceByName } from "./services.ts";
import { resolveSkillsForLayer } from "./skills-resolve.ts";
import {
  adaptArgsForUnknownFlags,
  buildChildCliArgs,
  childProcessEnv,
  childUserPrompt,
  isOmpHost,
  parseUnknownFlags,
  rememberRejectedFlags,
  resolveChildModel,
  toolsForRole,
} from "./spawn.ts";
import { mutateRun } from "./state.ts";
import type { Store } from "./tools.ts";
import type {
  Catalog,
  ChildAssignment,
  IsolatedRole,
  ProjectConfig,
  ResolvedSkill,
  RunState,
  ServiceInfo,
} from "./types.ts";
import { lifecycleText, toolLogText } from "./ui-progress.ts";
import { findItem, setItemStatus } from "./work.ts";
import { findScout, setScoutStatus } from "./scout.ts";

export type ChildHostPort = {
  start(opts: {
    args: string[];
    cwd: string;
    env?: NodeJS.ProcessEnv;
    onProgress?: (update: ProgressUpdate) => void;
    onOutput?: () => void;
  }): SpawnedChild;
};

export type ChildOutcome = { ok: boolean; error?: string };

export type ChildProgressEvent = {
  kind: "start" | "tool" | "finish" | "error" | "stage";
  text: string;
  role?: string;
  stage?: string;
  label?: string;
};

export type ChildRunnerDeps = {
  host: ChildHostPort;
  store: Store;
  persist: (run: RunState) => RunState;
  statePath: () => string;
  agentDir: () => string;
  extensionEntry?: () => string;
  catalog: () => Catalog;
  config: () => ProjectConfig | null;
  trusted?: (ctx: ExtensionContext) => boolean;
  modelId: (ctx: ExtensionContext) => string | undefined;
  thinking: (ctx: ExtensionContext) => string | undefined;
  isOmp?: () => boolean;
  activities: Map<string, ChildActivity>;
  aborts: Set<() => void>;
  getAbortChild: () => (() => void) | undefined;
  setAbortChild: (fn: (() => void) | undefined) => void;
  startProgressReporting: (ctx: ExtensionContext) => void;
  stopProgressReporting: (ctx: ExtensionContext) => void;
  logProgress: (
    ctx: ExtensionContext,
    event: ChildProgressEvent,
    toast?: "info" | "warning" | "error",
  ) => void;
  notify: (ctx: ExtensionContext, text: string, level?: "info" | "warning" | "error") => void;
  refreshUi: (ctx: ExtensionContext, run?: RunState) => void;
};

export function processChildHost(): ChildHostPort {
  return { start: (opts) => spawnPiChild(opts) };
}

function skillDirsForRole(
  deps: ChildRunnerDeps,
  role: IsolatedRole,
  run: RunState,
  cwd: string,
  service?: ServiceInfo,
): string[] {
  const diagnosing = run.stage === "fix_test";
  const workflow = workflowSkillsForRole(role, { diagnosing }).map((name) => bundledSkillDir(name));
  const layer = stackLayerForRole(role);
  if (
    !layer ||
    role === "linter" ||
    role === "commit_message" ||
    role === "plan_critic" ||
    role === "design_critic" ||
    role === "orchestrator" ||
    role === "planner_orchestrator" ||
    role === "scout"
  ) {
    return workflow.filter((dir) => dir.length > 0);
  }
  const detection =
    run.stack ?? detectStack(deps.catalog(), { cwd, config: deps.config() ?? undefined });
  const resolved = resolveSkillsForLayer({
    cwd,
    agentDir: deps.agentDir(),
    config: deps.config() ?? undefined,
    catalog: deps.catalog(),
    detection,
    layer,
    service,
  });
  mutateRun(deps.statePath(), deps.agentDir(), (current) => ({
    ...current,
    resolvedSkills: { ...current.resolvedSkills, [role]: resolved },
  }));
  const loaded = resolved.filter((skill) => skill.source !== "unresolved" && skill.dir);
  return [...workflow, ...loaded.map((skill) => skill.dir)];
}

function writeRolePrompt(
  deps: ChildRunnerDeps,
  role: IsolatedRole,
  extras: ResolvedSkill[],
  taskId?: string,
): string {
  const overflow = extras
    .filter((skill) => skill.source === "unresolved")
    .map((skill) => `- ${skill.name}: ${skill.error ?? "unresolved"}`)
    .join("\n");
  const body = `${loadRolePrompt(role)}

## Stack skills

Your first actions: call devteam_state (action get), then read each attached skill's SKILL.md.
Follow /skill:<name> together with TDD at agreed seams when implementing.
Do not start a nested /devteam pipeline. Do not git commit.
${overflow ? `\nSkills not injected (cap, missing, or fetch failed):\n${overflow}\n` : ""}
`;
  const file = join(
    dirname(deps.statePath()),
    taskId ? `${role}.${taskId}.prompt.md` : `${role}.prompt.md`,
  );
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, body);
  return file;
}

export function createChildRunner(deps: ChildRunnerDeps) {
  async function run(
    ctx: ExtensionContext,
    run: RunState,
    role: IsolatedRole,
    assignment?: ChildAssignment,
  ): Promise<ChildOutcome> {
    const config = deps.config();
    const locked = deps.persist({
      ...run,
      pipelineLocked: true,
      currentRole: role,
      updatedAt: new Date().toISOString(),
    });
    deps.refreshUi(ctx, locked);
    const services = locked.stack?.services ?? [];
    const service = serviceByName(services, assignment?.service ?? locked.currentService);
    const label = assignment
      ? `${role.replaceAll("_", " ")} · ${assignment.id}`
      : service
        ? `${role.replaceAll("_", " ")} · ${service.name}`
        : role.replaceAll("_", " ");

    const extras = (locked.resolvedSkills?.[role] ?? []) as ResolvedSkill[];
    const dirs = skillDirsForRole(deps, role, locked, ctx.cwd, service);
    const latest = deps.store.load() ?? locked;
    const promptFile = writeRolePrompt(
      deps,
      role,
      latest.resolvedSkills?.[role] ?? extras,
      assignment?.id,
    );
    const unresolved = (latest.resolvedSkills?.[role] ?? []).filter(
      (skill) => skill.source === "unresolved",
    );
    if (unresolved.length && ctx.hasUI) {
      ctx.ui.notify(
        `Stack skill fallback: ${unresolved.map((skill) => skill.name).join(", ")}. Continuing with workflow skills.`,
        "warning",
      );
    }

    const budget = resolveMaxToolCalls(config?.maxToolCalls, role);
    const repeatLimit = resolveRepeatToolAbort(config?.repeatToolAbort);
    const promptExtras = role === "reviewer" ? reviewScope(latest) : {};
    const omp = deps.isOmp?.() ?? isOmpHost();
    let args = buildChildCliArgs({
      extensionPath: (deps.extensionEntry ?? thisExtensionEntry)(),
      rolePromptFile: promptFile,
      role,
      statePath: deps.statePath(),
      skillDirs: dirs,
      tools: toolsForRole(role),
      model: resolveChildModel(role, deps.modelId(ctx), config?.models, omp, locked.stage),
      thinking: deps.thinking(ctx),
      trusted: deps.trusted ? deps.trusted(ctx) : projectTrusted(ctx),
      serviceName: service?.name,
      taskId: assignment?.id,
      prompt: childUserPrompt(
        role,
        latest.task,
        dirs,
        service,
        services,
        assignment,
        budget,
        promptExtras,
      ),
    });
    const activityKey = assignment?.id ?? role;
    const activity: ChildActivity = {
      role: assignment ? `${role}/${assignment.id}` : service ? `${role}/${service.name}` : role,
      startedAt: Date.now(),
      label: "",
      toolCalls: 0,
      lastEventAt: Date.now(),
      recentTools: [],
    };
    deps.activities.set(activityKey, activity);
    deps.startProgressReporting(ctx);
    deps.logProgress(ctx, {
      kind: "start",
      role: activity.role,
      stage: locked.stage,
      text: lifecycleText("start", label),
    });

    let abortReason: string | undefined;
    const runChild = async () => {
      abortReason = undefined;
      activity.toolCalls = 0;
      activity.recentTools = [];
      activity.label = "";
      let stopChild = () => {};
      const spawned = deps.host.start({
        args,
        cwd: ctx.cwd,
        env: childProcessEnv(role, deps.statePath(), process.env, {
          serviceName: service?.name,
          taskId: assignment?.id,
        }),
        onOutput: () => {
          activity.lastEventAt = Date.now();
        },
        onProgress: (update) => {
          if (update.kind === "tool") {
            activity.toolCalls += 1;
            activity.recentTools.push(update.label);
            if (activity.recentTools.length > 40)
              activity.recentTools.splice(0, activity.recentTools.length - 40);
            if (repeatLimit && isRepeatedToolLoop(activity.recentTools, repeatLimit)) {
              abortReason = `${label} repeated ${repeatLimit} identical tool calls and was stopped.`;
              stopChild();
              return;
            }
          }
          const shouldPost =
            update.kind === "tool" || Boolean(update.label && update.label !== activity.label);
          activity.label = update.label;
          activity.lastEventAt = Date.now();
          if (shouldPost) {
            deps.logProgress(ctx, {
              kind: update.kind === "tool" ? "tool" : "stage",
              role: activity.role,
              label: update.label,
              text: toolLogText(activity.role, update.label),
            });
          } else {
            deps.refreshUi(ctx, deps.store.load());
          }
          if (activity.toolCalls >= budget) {
            abortReason = `${label} hit the ${budget} tool-call budget and was stopped.`;
            stopChild();
          }
        },
      });
      stopChild = spawned.abort;
      activity.abort = spawned.abort;
      deps.setAbortChild(spawned.abort);
      deps.aborts.add(spawned.abort);
      try {
        return await spawned.done;
      } finally {
        deps.aborts.delete(spawned.abort);
        if (deps.getAbortChild() === spawned.abort) deps.setAbortChild(undefined);
      }
    };

    let result = await runChild();
    for (let attempt = 0; attempt < 2 && result.code !== 0; attempt += 1) {
      const unknown = parseUnknownFlags(result.output).filter((flag) => args.includes(flag));
      if (!unknown.length) break;
      rememberRejectedFlags(unknown);
      const retryArgs = adaptArgsForUnknownFlags(args, unknown);
      if (retryArgs.join("\u0000") === args.join("\u0000")) break;
      args = retryArgs;
      deps.notify(
        ctx,
        `devteam: host rejected ${unknown.join(", ")}; retrying ${label} without them.`,
        "warning",
      );
      result = await runChild();
    }

    deps.activities.delete(activityKey);
    deps.stopProgressReporting(ctx);

    const next = deps.store.load() ?? latest;
    if (next.halted || next.stage !== locked.stage) {
      deps.persist({
        ...next,
        pipelineLocked: false,
        pendingHandoff: next.halted ? undefined : next.pendingHandoff,
      });
      deps.logProgress(ctx, {
        kind: "finish",
        role: activity.role,
        text: `${label} ${next.halted ? "stopped" : "skipped"}`,
      });
      return { ok: false, error: next.halted ? "stopped by user" : "step skipped" };
    }
    if (!assignment) deps.persist({ ...next, pipelineLocked: false });

    const elapsed = formatElapsed(Date.now() - activity.startedAt);
    const failItem = (error: string) => {
      if (assignment?.list === "scout") {
        mutateRun(deps.statePath(), deps.agentDir(), (current) => ({
          ...current,
          scoutItems: setScoutStatus(current.scoutItems, assignment.id, {
            status: "failed",
            error,
          }),
          lastError: error,
          pipelineLocked: false,
        }));
      } else if (assignment) {
        mutateRun(deps.statePath(), deps.agentDir(), (current) => ({
          ...current,
          workItems: setItemStatus(current.workItems, assignment.id, { status: "failed", error }),
          lastError: error,
          pipelineLocked: false,
        }));
      } else {
        deps.persist({ ...next, pipelineLocked: false, lastError: error, currentRole: role });
      }
      deps.logProgress(
        ctx,
        { kind: "error", role: activity.role, text: `${label} failed: ${error}` },
        "error",
      );
      return { ok: false, error };
    };

    if (result.code !== 0 && abortReason) {
      return failItem(abortReason);
    }

    if (activity.toolCalls >= budget && result.code !== 0) {
      return failItem(
        `${label} exceeded ${budget} tool calls after ${elapsed} (${activity.label || "last action unknown"}).`,
      );
    }

    if (result.code !== 0 && !next.pendingHandoff) {
      const error = formatChildFailure(role, result, args);
      if (assignment) return failItem(`${label} failed: ${error}`);
      deps.persist({ ...next, pipelineLocked: false, lastError: error, currentRole: role });
      deps.logProgress(
        ctx,
        { kind: "error", role: activity.role, text: `${label} failed. ${error}` },
        "error",
      );
      return { ok: false, error };
    }

    deps.logProgress(ctx, {
      kind: "finish",
      role: activity.role,
      stage: next.stage,
      text: lifecycleText("finish", label, { elapsed, toolCalls: activity.toolCalls }),
    });

    const after = deps.store.load() ?? next;
    if (assignment) {
      const doneAction = assignment.list === "scout" ? "scout_done" : "implementor_done";
      if (after.pendingHandoff?.action === doneAction) {
        mutateRun(deps.statePath(), deps.agentDir(), (current) => ({
          ...current,
          pendingHandoff: undefined,
        }));
      }
      if (assignment.list === "scout") {
        const item = findScout(deps.store.load()?.scoutItems, assignment.id);
        if (item?.status !== "done") {
          if (!item?.findings?.trim()) {
            return failItem(`${label} finished without scout findings or a handoff.`);
          }
          mutateRun(deps.statePath(), deps.agentDir(), (current) => ({
            ...current,
            scoutItems: setScoutStatus(current.scoutItems, assignment.id, {
              status: "done",
              error: undefined,
              findings: item.findings,
            }),
          }));
        }
      } else {
        const item = findItem(deps.store.load()?.workItems, assignment.id);
        if (item?.status !== "done") {
          return failItem(`${label} finished without implementor_done handoff.`);
        }
      }
      return { ok: true };
    }

    const bashFailed =
      (role === "tester" || role === "linter") && !after.pendingHandoff
        ? bashFailedFromChildOutput(result.stdout)
        : undefined;
    const resolved = deps.persist(
      step(
        deps.store.load() ?? after,
        { type: "child_exit", role, bashFailed, globs: config?.paths },
        config?.paths,
      ),
    );
    if (resolved.pendingHandoff || resolved.stage !== locked.stage || resolved.halted) {
      return { ok: true };
    }
    const error = `${label} finished without a handoff.`;
    deps.persist({ ...resolved, pipelineLocked: false, lastError: error, currentRole: role });
    return { ok: false, error };
  }

  return { run };
}

export type ChildRunner = ReturnType<typeof createChildRunner>;
