import { randomUUID } from "node:crypto";
import { hostname } from "node:os";
import { join } from "node:path";
import { spawn } from "node:child_process";
import { Type } from "typebox";
import { StringEnum } from "@earendil-works/pi-ai";
import {
  getAgentDir,
  isToolCallEventType,
  PROJECT_CONFIG_DIRS,
  withFileMutationQueue,
  type ExtensionAPI,
  type ExtensionContext,
} from "./pi-host.ts";
import { onAgentIdle, projectTrusted, sessionIdFromContext } from "./host-compat.ts";
import { loadCatalog } from "./catalog.ts";
import { loadDevteamConfig } from "./config.ts";
import { parseDevteamArgs } from "./command-args.ts";
import { listJobs, newJobId, renderJobList, resolveJobRef } from "./jobs.ts";
import { processChildHost, createChildRunner } from "./child-runner.ts";
import {
  activityLine,
  formatElapsed,
  resolveMaxToolCalls,
  resolveChildIdleMs,
  describeToolCall,
  isRepeatedToolLoop,
  resolveRepeatToolAbort,
  type ChildActivity,
} from "./child-progress.ts";
import { detectStack } from "./detect-stack.ts";
import { isMultiService, renderServices, serviceByName } from "./services.ts";
import { captureGit } from "./git.ts";
import {
  isolatedRoleFromFlag,
  gateBash,
  gateWrite,
  isWriteTool,
  writePathFromInput,
} from "./permissions.ts";
import {
  acceptDemoChoice,
  acceptMockupChoice,
  activeRole,
  applyContinue,
  applyCritiqueDecisions,
  reopenImplementation,
  applyDemoReview,
  applySkip,
  applyStop,
  attachRunForResume,
  continueHint,
  enterReview,
  goToStage,
  needsParentKick,
  parseYesNo,
  phaseOf,
  proceedAfterPlan,
  scoutSkipNeedsJudge,
  shouldSkipScout,
  startScouting,
  step,
} from "./pipeline.ts";
import { inferScoutSkipFromJudge } from "./judge.ts";
import { isOmpHost, mapToolsForHost, resolveChildModel, toolsForRole } from "./spawn.ts";
import { loadRolePrompt } from "./roles.ts";
import {
  clearRunFiles,
  emptyRun,
  loadRun,
  mutateRun,
  readCurrentJobId,
  renderRunMarkdown,
  runPaths,
  saveRun,
  STATE_SECTIONS,
} from "./state.ts";
import { applyHandoffTool, applyMockupTool, applyStateTool, type Store } from "./tools.ts";
import type {
  Catalog,
  IsolatedRole,
  ProjectConfig,
  RoleName,
  RunState,
  WorkItem,
  ChildAssignment,
} from "./types.ts";
import { DEFAULT_PROGRESS_EVERY_MS, HANDOFF_ACTIONS, ISOLATED_ROLES } from "./types.ts";
import { findItem, itemsRemaining, nextWave, retryableItems } from "./work.ts";
import { compileScoutNotes, nextScoutWave, retryableScouts } from "./scout.ts";
import {
  applyChrome,
  clearChrome,
  postSessionLine,
  registerDevteamRenderers,
  tickProgressFeed,
} from "./ui-progress.ts";
import { formatAskAnswers, promptQuestions, type AskQuestion } from "./ask-ui.ts";
import { parseCritiqueItems } from "./critique.ts";

const PARENT_PLANNER_TOOLS = [
  "read",
  "grep",
  "find",
  "ls",
  "glob",
  "bash",
  "ask",
  "devteam_ask",
  "devteam_state",
  "devteam_handoff",
];
const PARENT_DESIGNER_TOOLS = [...PARENT_PLANNER_TOOLS, "devteam_mockup"];

function agentDirSafe(): string {
  try {
    return getAgentDir();
  } catch {
    return join(process.env.HOME ?? ".", ".omp", "agent");
  }
}

function intersect(all: string[], allow: string[]): string[] {
  const set = new Set(all);
  const picked = allow.filter((name) => set.has(name));
  return picked.length > 0 ? picked : allow;
}

function notify(ctx: ExtensionContext, text: string, level: "info" | "warning" | "error" = "info") {
  if (!ctx.hasUI) return;
  try {
    ctx.ui.notify(text, level);
  } catch {
    /* ignore */
  }
}

async function waitForIdleTimed(ctx: ExtensionContext, ms = 5000): Promise<void> {
  try {
    await Promise.race([
      ctx.waitForIdle(),
      new Promise<void>((resolve) => {
        setTimeout(resolve, ms).unref();
      }),
    ]);
  } catch {
    /* ignore */
  }
}

function openPath(filePath: string): void {
  const cmd =
    process.platform === "darwin" ? "open" : process.platform === "win32" ? "start" : "xdg-open";
  try {
    spawn(cmd, [filePath], { detached: true, stdio: "ignore" }).unref();
  } catch {
    /* ignore */
  }
}

export default function (pi: ExtensionAPI) {
  registerDevteamRenderers(pi);
  pi.registerFlag("devteam-role", {
    description: "Internal: specialist role for an isolated /devteam child",
    type: "string",
  });
  pi.registerFlag("devteam-state", {
    description: "Internal: path to the /devteam run JSON for an isolated child",
    type: "string",
  });
  pi.registerFlag("devteam-service", {
    description: "Internal: service name for a polyglot implementor child",
    type: "string",
  });

  pi.registerFlag("devteam-task", {
    description: "Internal: work item id for an implementor subagent",
    type: "string",
  });

  const childRole = isolatedRoleFromFlag(pi.getFlag("devteam-role") ?? process.env.DEVTEAM_ROLE);
  const childStateRaw = pi.getFlag("devteam-state") ?? process.env.DEVTEAM_STATE;
  const childStatePath =
    typeof childStateRaw === "string" && childStateRaw.length > 0 ? childStateRaw : undefined;
  const childServiceName =
    (typeof pi.getFlag("devteam-service") === "string"
      ? pi.getFlag("devteam-service")
      : undefined) ?? process.env.DEVTEAM_SERVICE;
  const childTaskId =
    (typeof pi.getFlag("devteam-task") === "string"
      ? (pi.getFlag("devteam-task") as string)
      : undefined) ?? process.env.DEVTEAM_TASK;
  type NativeEntry = {
    kind: "work" | "scout" | "role";
    role: IsolatedRole;
    id?: string;
    assignment?: ChildAssignment;
    native: NonNullable<WorkItem["native"]>;
    prompt: string;
  };
  let nativeJobId: string | undefined;
  let nativeTaskId: string | undefined;
  let nativeAgentId: string | undefined;
  let nativeParentId: string | undefined;
  let nativeAttempt: number | undefined;
  let nativeKind: NativeEntry["kind"] | undefined;
  let nativeRole: IsolatedRole | undefined;
  let nativeToolCalls = 0;
  let nativeRecentTools: string[] = [];
  let nativeIdleTimer: ReturnType<typeof setTimeout> | undefined;
  function stopNativeTimer(): void {
    clearTimeout(nativeIdleTimer);
    nativeIdleTimer = undefined;
  }
  function touchNative(ctx: ExtensionContext): void {
    stopNativeTimer();
    const idleMs = resolveChildIdleMs(config?.childIdle);
    if (!idleMs || !nativeAssignment(ctx)) return;
    nativeIdleTimer = setTimeout(() => {
      nativeIdleTimer = undefined;
      if (nativeAssignment(ctx)) abortParentTurn(ctx);
    }, idleMs);
    nativeIdleTimer.unref?.();
  }
  let nativeDispatch:
    | { marker: string; items: NativeEntry[]; calls: Map<string, NativeEntry[]>; stale: boolean }
    | undefined;
  let nativeResumeQueued = false;
  type NativeAgent = { kind?: string; id?: string; name?: string; parentId?: string };
  function nativeAgent(ctx: ExtensionContext): NativeAgent | undefined {
    const agent = (ctx as ExtensionContext & { agent?: NativeAgent }).agent;
    return agent?.kind === "sub" &&
      (agent.name === "devteam-implementor" ||
        ISOLATED_ROLES.some((role) => agent.name === `devteam-${role.replaceAll("_", "-")}`))
      ? agent
      : undefined;
  }

  function nativeAssignment(ctx: ExtensionContext): NativeEntry | undefined {
    const agent = nativeAgent(ctx);
    if (
      !agent ||
      !nativeJobId ||
      !nativeKind ||
      !nativeRole ||
      agent.id !== nativeAgentId ||
      agent.parentId !== nativeParentId
    )
      return undefined;
    const run = store.load();
    if (!run || run.jobId !== nativeJobId || run.halted || !run.pipelineLocked) return undefined;
    const item =
      nativeKind === "work"
        ? run.workItems?.find((v) => v.id === nativeTaskId)
        : nativeKind === "scout"
          ? run.scoutItems?.find((v) => v.id === nativeTaskId)
          : undefined;
    const identity = nativeKind === "role" ? run.nativeRole?.native : item?.native;
    if (
      !identity ||
      identity.agentId !== agent.id ||
      identity.parentId !== agent.parentId ||
      identity.attempt !== nativeAttempt ||
      (nativeKind === "role" ? run.nativeRole?.stage !== run.stage : item?.status !== "running")
    )
      return undefined;
    return {
      kind: nativeKind,
      role: nativeRole,
      id: nativeTaskId,
      native: identity,
      prompt: "",
      assignment: item
        ? {
            id: item.id,
            title: item.title,
            details: item.details,
            files: item.files,
            service: item.service,
            list: nativeKind === "scout" ? "scout" : "work",
          }
        : undefined,
    };
  }

  let sessionId = "session";
  let jobId = "session";
  let config: ProjectConfig | null = null;
  let catalog: Catalog | undefined;
  let defaultTools: string[] | undefined;
  let abortChild: (() => void) | undefined;
  let advancing = false;
  const owner = randomUUID();
  let dialogAbort = new AbortController();
  const childAborts = new Set<() => void>();
  const childActivities = new Map<string, ChildActivity>();
  let progressTimer: ReturnType<typeof setInterval> | undefined;
  let lastProgressNotify = 0;

  function abortAllChildren(): void {
    abortChild?.();
    for (const abort of childAborts) {
      try {
        abort();
      } catch {
        /* ignore */
      }
    }
    childAborts.clear();
  }
  function standDown(ctx?: ExtensionContext): void {
    nativeDispatch = undefined;
    abortAllChildren();
    resetDialogAbort();
    childActivities.clear();
    if (progressTimer) {
      clearInterval(progressTimer);
      progressTimer = undefined;
    }
    if (ctx && !childRole) clearChrome(ctx);
  }

  function haltWorkflow(ctx: ExtensionContext, run: RunState): RunState {
    standDown(ctx);
    abortParentTurn(ctx);
    applyParentTools(undefined);
    return persist(applyStop(run));
  }

  function refreshUi(ctx: ExtensionContext, run: RunState | undefined) {
    if (childRole) return;
    if (
      !run ||
      run.stage === "idle" ||
      run.stage === "done" ||
      run.stage === "error" ||
      run.halted
    ) {
      clearChrome(ctx);
      return;
    }
    applyChrome(ctx, run, runningActivities());
  }

  function abortParentTurn(ctx: ExtensionContext): void {
    try {
      (ctx as { abort?: () => void }).abort?.();
    } catch {
      /* ignore */
    }
  }

  function resetDialogAbort(): void {
    try {
      dialogAbort.abort();
    } catch {
      /* ignore */
    }
    dialogAbort = new AbortController();
  }

  function progressEveryMs(): number {
    const configured = Number(config?.progressEvery);
    if (Number.isFinite(configured)) {
      if (configured <= 0) return 0;
      return Math.max(5, Math.min(configured, 600)) * 1000;
    }
    return DEFAULT_PROGRESS_EVERY_MS;
  }

  function runningActivities(): ChildActivity[] {
    return [...childActivities.values()];
  }

  function reportProgress(ctx: ExtensionContext, force = false): void {
    refreshUi(ctx, store.load());
    const activities = runningActivities();
    if (!activities.length) return;
    const every = progressEveryMs();
    if (!every && !force) return;
    if (!force && Date.now() - lastProgressNotify < every) return;
    lastProgressNotify = Date.now();
    notify(ctx, `devteam: ${activities.map((activity) => activityLine(activity)).join(" · ")}`);
  }

  function startProgressReporting(ctx: ExtensionContext): void {
    if (progressTimer) return;
    lastProgressNotify = Date.now();
    progressTimer = setInterval(() => {
      if (!childActivities.size) {
        stopProgressReporting(ctx);
        return;
      }
      const idleMs = resolveChildIdleMs(config?.childIdle);
      if (idleMs) {
        for (const activity of childActivities.values()) {
          if (Date.now() - activity.lastEventAt > idleMs) {
            notify(
              ctx,
              `devteam: ${activity.role} went quiet for ${formatElapsed(idleMs)} and was stopped. /devteam continue retries.`,
              "error",
            );
            activity.abort?.();
          }
        }
      }
      refreshUi(ctx, store.load());
      tickProgressFeed({ sessionManager: ctx.sessionManager });
      reportProgress(ctx);
    }, 2000);
    progressTimer.unref?.();
  }

  function stopProgressReporting(ctx: ExtensionContext): void {
    if (childActivities.size) return;
    if (progressTimer) clearInterval(progressTimer);
    progressTimer = undefined;
    refreshUi(ctx, store.load());
  }

  const store: Store = {
    load() {
      return loadRun(statePath());
    },
    save(run) {
      saveRun(statePath(), run, agentDirSafe());
    },
    mutate(change) {
      return mutateRun(statePath(), agentDirSafe(), change);
    },
    agentDir: () => agentDirSafe(),
    sessionId: () => nativeJobId ?? jobId,
    taskId: () => childTaskId ?? nativeTaskId,
  };

  function statePath(): string {
    if (nativeJobId) return runPaths(agentDirSafe(), nativeJobId).json;
    if (childStatePath) return childStatePath;
    return runPaths(agentDirSafe(), jobId).json;
  }

  function getCatalog(): Catalog {
    catalog ??= loadCatalog();
    return catalog;
  }

  function persist(run: RunState): RunState {
    if (run.jobId) jobId = run.jobId;
    const next = advancing ? { ...run, pipelineOwner: owner } : run;
    store.save(next);
    return next;
  }

  const childRunner = createChildRunner({
    host: processChildHost(),
    store,
    persist,
    statePath,
    agentDir: agentDirSafe,
    catalog: getCatalog,
    config: () => config,
    trusted: projectTrusted,
    modelId,
    thinking: thinkingOf,
    activities: childActivities,
    aborts: childAborts,
    getAbortChild: () => abortChild,
    setAbortChild: (fn) => {
      abortChild = fn;
    },
    startProgressReporting,
    stopProgressReporting,
    logProgress,
    notify,
    refreshUi,
  });

  function jobsInAgent() {
    return listJobs(agentDirSafe(), jobId);
  }

  async function showJobList(ctx: ExtensionContext) {
    const text = renderJobList(jobsInAgent());
    notify(ctx, text);
    const host = pi as ExtensionAPI & {
      sendMessage?: (message: unknown, opts?: { triggerTurn?: boolean }) => unknown;
    };
    if (typeof host.sendMessage === "function") {
      try {
        await host.sendMessage(
          { customType: "devteam-jobs", content: text, display: true, attribution: "user" },
          { triggerTurn: false },
        );
      } catch {
        /* notify is enough */
      }
    }
  }

  async function resumeJob(ctx: ExtensionContext, ref: string) {
    const jobs = jobsInAgent();
    const picked = resolveJobRef(jobs, ref);
    if (!picked) {
      notify(ctx, `No job matches "${ref}". /devteam list to see saved jobs.`, "warning");
      return;
    }
    const path = runPaths(agentDirSafe(), picked.jobId).json;
    const initial = loadRun(path);
    if (initial && (initial.pipelineOwner || initial.pipelineLocked)) {
      const native = [
        ...(initial.workItems?.flatMap((item) => (item.native ? [item.native] : [])) ?? []),
        ...(initial.scoutItems?.flatMap((item) => (item.native ? [item.native] : [])) ?? []),
        ...(initial.nativeRole ? [initial.nativeRole.native] : []),
      ];
      if (!initial.pipelineLocked || !native.length) {
        notify(
          ctx,
          "Job is owned or locked; its owner cannot be safely recovered here.",
          "warning",
        );
        return;
      }
      const live = native.some((identity) => {
        if (!identity?.pid || identity.host !== hostname()) return false;
        try {
          process.kill(identity.pid, 0);
          return true;
        } catch (error) {
          return (error as NodeJS.ErrnoException).code !== "ESRCH";
        }
      });
      if (advancing || nativeDispatch || live) {
        notify(
          ctx,
          "Native work is still active; wait for it to finish before continuing.",
          "warning",
        );
        return;
      }
      if (!ctx.hasUI || typeof ctx.ui.confirm !== "function") {
        notify(
          ctx,
          "Native work has an unknown owner. Interactive confirmation is required to recover it.",
          "warning",
        );
        return;
      }
      const confirmed = await ctx.ui.confirm(
        "Recover interrupted native work?",
        "Verify that every previous host, worker, and subprocess for this job has stopped. Continuing while any remain active can cause simultaneous edits and data loss. Have you verified they are all stopped?",
      );
      if (!confirmed) return;
      const snapshot = JSON.stringify(initial);
      const recovered = mutateRun(path, agentDirSafe(), (current) => {
        if (JSON.stringify(current) !== snapshot || advancing || nativeDispatch) return undefined;
        return {
          ...current,
          pipelineOwner: undefined,
          pipelineLocked: false,
          workItems: current.workItems?.map((item) =>
            item.native ? { ...item, status: "pending" as const, native: undefined } : item,
          ),
          scoutItems: current.scoutItems?.map((item) =>
            item.native ? { ...item, status: "pending" as const, native: undefined } : item,
          ),
          nativeRole: undefined,
          pendingHandoff: current.nativeRole ? undefined : current.pendingHandoff,
        };
      });
      if (!recovered) {
        notify(ctx, "Job changed during recovery; inspect its status and try again.", "warning");
        return;
      }
    }
    let blocked = false;
    const attached = mutateRun(path, agentDirSafe(), (loaded) => {
      if (loaded.pipelineOwner || loaded.pipelineLocked) {
        blocked = true;
        return undefined;
      }
      return {
        ...attachRunForResume(loaded),
        jobId: picked.jobId,
        cwd: loaded.cwd ?? ctx.cwd,
        pipelineOwner: owner,
      };
    });
    if (!attached) {
      notify(
        ctx,
        blocked
          ? "Job is owned or locked. Use /devteam continue after verifying its workers have stopped."
          : `Could not load job ${picked.jobId}.`,
        "warning",
      );
      return;
    }
    jobId = picked.jobId;
    if (attached.sessionId) sessionId = attached.sessionId;
    notify(
      ctx,
      `Resumed job ${picked.jobId} at ${attached.stage} (progress kept). ${attached.task || ""}`.trim(),
    );

    const next = persist(step(attached.halted ? applyContinue(attached) : attached));
    if (next.stage === "done") {
      store.mutate((current) => ({ ...current, pipelineOwner: undefined }));
      applyParentTools(next);
      refreshUi(ctx, next);
      notify(ctx, "This job is finished. /devteam status shows the draft commit message.");
      return;
    }

    if (needsParentKick(next.stage)) {
      store.mutate((current) => ({ ...current, pipelineOwner: undefined }));
      applyParentTools(next);
      refreshUi(ctx, next);
      await kickParent(ctx, next, { resume: true });
      return;
    }

    await advancePipeline(ctx, next);
  }

  function logProgress(
    ctx: ExtensionContext,
    event: {
      kind: "start" | "tool" | "finish" | "error" | "stage";
      text: string;
      role?: string;
      stage?: string;
      label?: string;
    },
    toast?: "info" | "warning" | "error",
  ) {
    const streaming =
      typeof (ctx as { isIdle?: () => boolean }).isIdle === "function"
        ? !(ctx as { isIdle: () => boolean }).isIdle()
        : false;
    const posted = postSessionLine(pi, event, { streaming, sessionManager: ctx.sessionManager });
    if (toast === "error" || toast === "warning" || posted === "none") {
      notify(ctx, event.text, toast ?? "info");
    }
    refreshUi(ctx, store.load());
  }

  function currentRole(_ctx: ExtensionContext): RoleName | undefined {
    if (childRole) return childRole;
    const run = store.load();
    return run?.interactiveRole ?? activeRole(run ?? emptyRun(sessionId)) ?? run?.currentRole;
  }

  function applyParentTools(run: RunState | undefined) {
    if (childRole) return;
    const all = pi.getAllTools().map((tool) => tool.name);
    if (!defaultTools) defaultTools = pi.getActiveTools();
    if (!run || run.stage === "idle" || run.stage === "done" || run.stage === "error") {
      if (defaultTools?.length) pi.setActiveTools(intersect(all, defaultTools));
      return;
    }
    if (run.interactiveRole === "designer") {
      pi.setActiveTools(intersect(all, PARENT_DESIGNER_TOOLS));
      return;
    }
    if (run.interactiveRole === "planner") {
      pi.setActiveTools(intersect(all, PARENT_PLANNER_TOOLS));
      return;
    }
    pi.setActiveTools(
      intersect(all, [
        "read",
        "grep",
        "find",
        "ls",
        "glob",
        "devteam_state",
        ...(nativeDispatch ? ["task"] : []),
      ]),
    );
  }

  function modelId(ctx: ExtensionContext): string | undefined {
    const model = ctx.model as { id?: string } | undefined;
    return model?.id;
  }

  function thinkingOf(ctx: ExtensionContext): string | undefined {
    const level = (ctx as { thinkingLevel?: string }).thinkingLevel;
    return typeof level === "string" ? level : undefined;
  }

  async function deliverUserPrompt(text: string) {
    const host = pi as ExtensionAPI & {
      sendMessage?: (message: unknown, opts?: { triggerTurn?: boolean }) => unknown;
    };
    if (typeof host.sendMessage === "function") {
      try {
        await host.sendMessage(
          { customType: "devteam-kick", content: text, display: true, attribution: "user" },
          { triggerTurn: true },
        );
        return;
      } catch {
        /* fall through to sendUserMessage */
      }
    }
    await pi.sendUserMessage(text);
  }

  async function kickParent(ctx: ExtensionContext, run: RunState, opts?: { resume?: boolean }) {
    applyParentTools(run);
    refreshUi(ctx, run);
    if (run.stage === "planner") {
      if (run.planCritique?.reviewed) {
        const notes = run.planCritique.notes?.trim() || "No critic items were accepted.";
        await deliverUserPrompt(
          [
            "The user reviewed the plan critic. Apply ONLY the accepted items.",
            "Do not re-read scout notes from scratch. Do not re-ask settled decisions. Do not expand scope.",
            "Patch the stored spec, then call devteam_handoff with action plan_ready. Implementation starts after that — there is no second critic pass.",
            `Job: ${run.jobId}`,
            `Task: ${run.task || "(none)"}`,
            notes,
            "First action: devteam_state with action get, then update the spec section.",
          ]
            .filter(Boolean)
            .join("\n\n"),
        );
        return;
      }
      if (opts?.resume) {
        await deliverUserPrompt(
          [
            "Resume the existing /devteam planner. Do not start a new workflow. Do not discard stored spec, layers, or notes.",
            `Job: ${run.jobId}`,
            `Task: ${run.task || "(none)"}`,
            run.spec?.trim()
              ? `Spec already stored. Grill only remaining holes, then call devteam_handoff with plan_ready when the spec is complete.\n\n${run.spec.slice(0, 6000)}`
              : "No spec stored yet. Continue grilling from unanswered questions. Do not re-ask decisions already in devteam_state.",
            run.openQuestions ? `Open questions:\n${run.openQuestions}` : "",
            run.demoFeedback?.trim()
              ? `Demo feedback (user watched the live demo, patch the spec for exactly this):\n${run.demoFeedback}`
              : "",
            run.demoNotes?.trim() ? `Demo notes:\n${run.demoNotes.slice(0, 4000)}` : "",
            run.scoutNotes?.trim()
              ? `Scout notes (facts about this repo):\n${run.scoutNotes.slice(0, 8000)}`
              : "",
            "First action: devteam_state with action get.",
          ]
            .filter(Boolean)
            .join("\n\n"),
        );
        return;
      }
      await deliverUserPrompt(
        [
          "Start the /devteam planner for this task.",
          "Grill until the spec is complete. Persist every decision with devteam_state.",
          "Scout notes are facts about this repo. Do not re-ask the user things they already answer. Name real files and types from those notes.",
          "Infer layersNeeded for THIS change only (database, backend, frontend, general) — omit layers with no work. Those names pick specialists for one slice, not a serial review factory. Write a short briefing into that layer's notes; leave the others blank so those implementors are skipped. Also store uiSurface.",
          "If the user already said whether they want HTML mockups, store wantMockup. Leave it unset to ask after the spec is approved.",
          "If the user already said whether they want a live headed demo after QA, store wantDemo.",
          "When the spec is ready, call devteam_handoff with action plan_ready.",
          `Task:\n${run.task}`,
          run.scoutNotes?.trim() ? `Scout notes:\n${run.scoutNotes.slice(0, 8000)}` : "",
          run.stack
            ? `Detected stack: ${JSON.stringify({
                frontend: run.stack.frontend,
                backend: run.stack.backends?.length ? run.stack.backends : run.stack.backend,
                database: run.stack.database,
                uiSurface: run.stack.uiSurface,
              })}`
            : "",
          isMultiService(run.stack?.services)
            ? [
                "This repository is split into services, each with its own language and toolchain:",
                renderServices(run.stack?.services),
                "Name the service each piece of the spec lands in, and write every cross-service contract (endpoint, payload, status codes, errors) explicitly.",
              ].join("\n")
            : "",
        ]
          .filter(Boolean)
          .join("\n"),
      );
      return;
    }
    if (run.stage === "designer") {
      if (opts?.resume) {
        await deliverUserPrompt(
          [
            "Resume the existing /devteam designer. Do not start a new workflow.",
            `Job: ${run.jobId}`,
            run.mockupPath
              ? `A mockup already exists at ${run.mockupPath}. Refine it with devteam_mockup; do not throw it away unless it is empty.`
              : "No mockup stored yet. Continue from the spec via devteam_state.",
            "When the user is happy, call devteam_handoff with action design_ready.",
          ].join("\n"),
        );
        return;
      }
      await deliverUserPrompt(
        [
          "Start designer mode for this /devteam run.",
          "Read the spec via devteam_state. Follow the frontend-design skill.",
          "Write a self-contained HTML mockup with devteam_mockup. Do not edit the repo.",
          "When the user is happy, call devteam_handoff with action design_ready.",
        ].join("\n"),
      );
    }
  }

  async function spawnRole(
    ctx: ExtensionContext,
    run: RunState,
    role: IsolatedRole,
    assignment?: ChildAssignment,
  ) {
    return childRunner.run(ctx, run, role, assignment);
  }

  async function scheduleNative(
    ctx: ExtensionContext,
    incoming: RunState,
    kind: NativeEntry["kind"],
    role?: IsolatedRole,
  ): Promise<void> {
    let current = store.load() ?? incoming;
    if (kind === "work" && !nextWave(current.workItems, config?.parallel).length) {
      const ids = new Set(retryableItems(current.workItems).map((item) => item.id));
      if (ids.size)
        current = persist({
          ...current,
          workItems: current.workItems?.map((item) =>
            ids.has(item.id)
              ? { ...item, status: "pending", error: undefined, native: undefined }
              : item,
          ),
        });
    }
    if (kind === "scout" && !nextScoutWave(current.scoutItems, config?.parallel).length) {
      const ids = new Set(retryableScouts(current.scoutItems).map((item) => item.id));
      if (ids.size)
        current = persist({
          ...current,
          scoutItems: current.scoutItems?.map((item) =>
            ids.has(item.id)
              ? { ...item, status: "pending", error: undefined, native: undefined }
              : item,
          ),
        });
    }
    const wave =
      kind === "work"
        ? nextWave(current.workItems, config?.parallel)
        : kind === "scout"
          ? nextScoutWave(current.scoutItems, config?.parallel)
          : [];
    if (kind !== "role" && !wave.length) {
      if (kind === "scout" && !(current.scoutItems ?? []).some((item) => item.status !== "done"))
        persist(
          goToStage(
            { ...current, scoutNotes: compileScoutNotes(current.scoutItems, current.scoutNotes) },
            "planner",
          ),
        );
      else if (
        kind === "work" &&
        !itemsRemaining(current.workItems).length &&
        !(current.workItems ?? []).some((item) => item.status === "failed")
      )
        persist(enterReview(current));
      else
        persist({
          ...current,
          pipelineLocked: false,
          lastError: `${kind === "scout" ? "Scouting" : "Implementation"} is incomplete. Use /devteam status, /devteam continue, or /devteam skip.`,
        });
      return;
    }
    const parentId = (ctx as ExtensionContext & { agent?: NativeAgent }).agent?.id;
    if (!parentId)
      throw new Error("OMP main agent identity unavailable; cannot schedule native workers.");
    const identity = (attempt: number, role: IsolatedRole, title = "") => ({
      token: randomUUID(),
      attempt,
      parentId,
      expectedAgentId: `${`${role} ${title}`
        .replace(/[^a-zA-Z0-9]+(.)?/g, (_, next: string | undefined) => next?.toUpperCase() ?? "")
        .replace(/^./, (first) => first.toUpperCase())
        .slice(0, 12)}${randomUUID().replaceAll("-", "").slice(0, 20)}`,
      host: hostname(),
      pid: process.pid,
    });
    const entries: NativeEntry[] =
      kind === "role"
        ? [{ kind, role: role!, native: identity(1, role!), prompt: "" }]
        : wave.map((item) => ({
            kind,
            role: kind === "scout" ? "scout" : (item as WorkItem).layer,
            id: item.id,
            native: identity(
              item.attempts + 1,
              kind === "scout" ? "scout" : (item as WorkItem).layer,
              item.title,
            ),
            prompt: "",
            assignment: {
              id: item.id,
              title: item.title,
              details: item.details,
              files: item.files,
              service: item.service,
              list: kind === "scout" ? "scout" : "work",
            },
          }));
    const updated = store.mutate((run) => ({
      ...run,
      pipelineLocked: true,
      lastError: undefined,
      currentRole: kind === "role" ? role : run.currentRole,
      nativeRole:
        kind === "role"
          ? { role: role!, stage: run.stage, native: entries[0].native }
          : run.nativeRole,
      workItems:
        kind === "work"
          ? run.workItems?.map((item) => {
              const entry = entries.find((v) => v.id === item.id);
              return entry
                ? {
                    ...item,
                    status: "running" as const,
                    attempts: entry.native.attempt,
                    error: undefined,
                    native: entry.native,
                  }
                : item;
            })
          : run.workItems,
      scoutItems:
        kind === "scout"
          ? run.scoutItems?.map((item) => {
              const entry = entries.find((v) => v.id === item.id);
              return entry
                ? {
                    ...item,
                    status: "running" as const,
                    attempts: entry.native.attempt,
                    error: undefined,
                    native: entry.native,
                  }
                : item;
            })
          : run.scoutItems,
    }));
    if (!updated) throw new Error("Cannot persist native assignments.");
    for (const entry of entries) {
      const prepared = childRunner.prepare(ctx, updated, entry.role, entry.assignment);
      for (const warning of prepared.warnings) notify(ctx, warning, "warning");
      entry.prompt = [
        `Claim assignment first: call devteam_bind with jobId ${jobId} and token ${entry.native.token}.`,
        prepared.rolePrompt,
        prepared.childUserPrompt,
      ].join("\n\n");
    }
    const marker = randomUUID();
    nativeDispatch = { marker, items: entries, calls: new Map(), stale: false };
    applyParentTools(updated);
    await deliverUserPrompt(
      `Devteam scheduler ${marker}: call the native task tool now. Use one task call with a tasks array if available, otherwise one flat task call. Arguments will be replaced by the scheduler. Do not perform the work yourself.`,
    );
  }

  function resumeNativePipeline(ctx: ExtensionContext): void {
    if (nativeResumeQueued) return;
    nativeResumeQueued = true;
    queueMicrotask(() => {
      nativeResumeQueued = false;
      const run = store.load();
      if (run && !run.halted && !nativeDispatch) void advancePipeline(ctx, run);
    });
  }

  function failNativeDispatch(ctx: ExtensionContext, reason: string): void {
    const dispatch = nativeDispatch;
    if (!dispatch) return;
    nativeDispatch = undefined;
    store.mutate((run) => ({
      ...run,
      pipelineLocked: false,
      workItems: run.workItems?.map((item) =>
        dispatch.items.some(
          (assigned) => assigned.id === item.id && assigned.native?.token === item.native?.token,
        )
          ? { ...item, status: "failed" as const, error: reason, native: undefined }
          : item,
      ),
      scoutItems: run.scoutItems?.map((item) =>
        dispatch.items.some(
          (assigned) =>
            assigned.kind === "scout" &&
            assigned.id === item.id &&
            assigned.native.token === item.native?.token,
        )
          ? { ...item, status: "failed" as const, error: reason, native: undefined }
          : item,
      ),
      nativeRole: dispatch.items.some(
        (entry) => entry.kind === "role" && entry.native.token === run.nativeRole?.native.token,
      )
        ? undefined
        : run.nativeRole,
      lastError: reason,
    }));
    applyParentTools(store.load());
    resumeNativePipeline(ctx);
  }

  async function runWave(ctx: ExtensionContext, run: RunState, wave: WorkItem[]): Promise<void> {
    const ids = new Set(wave.map((item) => item.id));
    store.mutate((current) => ({
      ...current,
      pipelineLocked: true,
      workItems: (current.workItems ?? []).map((item) =>
        ids.has(item.id)
          ? { ...item, status: "running" as const, attempts: item.attempts + 1, error: undefined }
          : item,
      ),
    }));
    await Promise.all(
      wave.map((item) =>
        spawnRole(ctx, store.load() ?? run, item.layer, { ...item, list: "work" }),
      ),
    );
  }

  async function runDelegatedWork(ctx: ExtensionContext, incoming: RunState): Promise<void> {
    let run = persist({ ...incoming, pipelineLocked: true });
    try {
      for (;;) {
        const current = store.load() ?? run;
        if (current.halted) return;
        if (current.stage !== "implement") return;

        const wave = nextWave(current.workItems, config?.parallel);
        if (!wave.length) {
          const retry = retryableItems(current.workItems);
          if (retry.length) {
            const ids = new Set(retry.map((item) => item.id));
            run = persist({
              ...current,
              lastError: undefined,
              workItems: (current.workItems ?? []).map((item) =>
                ids.has(item.id) ? { ...item, status: "pending" as const, error: undefined } : item,
              ),
            });
            continue;
          }
          if (
            !itemsRemaining(current.workItems).length &&
            !(current.workItems ?? []).some((item) => item.status === "failed")
          ) {
            persist(enterReview(current));
          } else {
            persist({
              ...current,
              lastError:
                "Implementation is blocked or failed. Use /devteam status for details, /devteam retry to retry failed work, or /devteam skip to review incomplete work.",
            });
          }
          return;
        }
        await runWave(ctx, current, wave);
        run = store.load() ?? current;
      }
    } finally {
      const current = store.load();
      if (current?.pipelineLocked && !current.halted)
        persist({ ...current, pipelineLocked: false });
    }
  }

  async function runScoutWave(
    ctx: ExtensionContext,
    run: RunState,
    wave: NonNullable<RunState["scoutItems"]>,
  ): Promise<void> {
    const ids = new Set(wave.map((item) => item.id));
    store.mutate((current) => ({
      ...current,
      pipelineLocked: true,
      scoutItems: (current.scoutItems ?? []).map((item) =>
        ids.has(item.id)
          ? { ...item, status: "running" as const, attempts: item.attempts + 1, error: undefined }
          : item,
      ),
    }));
    await Promise.all(
      wave.map((item) =>
        spawnRole(ctx, store.load() ?? run, "scout", {
          id: item.id,
          title: item.title,
          details: item.details,
          files: item.files,
          service: item.service,
          list: "scout",
        }),
      ),
    );
  }

  async function runDelegatedScouts(ctx: ExtensionContext, incoming: RunState): Promise<void> {
    let run = persist({ ...incoming, pipelineLocked: true });
    try {
      for (;;) {
        const current = store.load() ?? run;
        if (current.halted) return;
        if (current.stage !== "scout") return;
        const wave = nextScoutWave(current.scoutItems, config?.parallel);
        if (!wave.length) {
          const retry = retryableScouts(current.scoutItems);
          if (retry.length) {
            const ids = new Set(retry.map((item) => item.id));
            run = persist({
              ...current,
              lastError: undefined,
              scoutItems: (current.scoutItems ?? []).map((item) =>
                ids.has(item.id) ? { ...item, status: "pending" as const, error: undefined } : item,
              ),
            });
            continue;
          }
          if ((current.scoutItems ?? []).some((item) => item.status !== "done")) {
            persist({
              ...current,
              lastError:
                "Scouting is incomplete. Use /devteam status for details, /devteam continue to retry failed scouts, or /devteam skip to proceed without scouting.",
            });
          } else {
            persist(
              goToStage(
                {
                  ...current,
                  scoutNotes: compileScoutNotes(current.scoutItems, current.scoutNotes),
                },
                "planner",
              ),
            );
          }
          return;
        }
        await runScoutWave(ctx, current, wave);
        run = store.load() ?? current;
      }
    } finally {
      const current = store.load();
      if (current?.pipelineLocked) persist({ ...current, pipelineLocked: false });
    }
  }

  async function presentPlanReview(
    ctx: ExtensionContext,
    run: RunState,
  ): Promise<RunState | undefined> {
    const items = run.planCritique?.items?.length
      ? run.planCritique.items
      : parseCritiqueItems(run.planCritique?.notes);
    if (!items.length) return proceedAfterPlan(run);

    logProgress(ctx, {
      kind: "start",
      role: "plan review",
      stage: "plan_review",
      text: `Review ${items.length} critic ${items.length === 1 ? "suggestion" : "suggestions"}`,
    });

    const questions: AskQuestion[] = items.map((item) => ({
      id: item.id,
      question: `${item.title}\n\n${item.text}`,
      options: ["Accept", "Reject"],
    }));
    const answers = await promptQuestions(ctx, questions, { signal: dialogAbort.signal });
    const latest = store.load() ?? run;
    if (latest.halted || latest.stage !== "plan_review") return latest;
    if (!answers) {
      const ui = ctx.ui as { select?: unknown; askDialog?: unknown } | undefined;
      if (!ctx.hasUI || (!ui?.select && !ui?.askDialog)) {
        persist({
          ...latest,
          pipelineLocked: false,
          lastError:
            "Plan review requires explicit decisions. Resume in an interactive session or /devteam skip to keep the spec.",
        });
        return undefined;
      }
      haltWorkflow(ctx, latest);
      notify(
        ctx,
        "Stopped at plan review. /devteam continue to review again, or /devteam skip to keep the spec.",
        "warning",
      );
      return undefined;
    }

    const decisions = answers.map((answer) => {
      const custom = answer.custom?.trim();
      if (custom) return { id: answer.id, decision: "accept" as const, userNote: custom };
      const label = answer.selected.join(" ").toLowerCase();
      if (label.includes("reject")) return { id: answer.id, decision: "reject" as const };
      return { id: answer.id, decision: "accept" as const };
    });
    const next = applyCritiqueDecisions(latest, decisions);
    for (const item of next.planCritique?.items ?? []) {
      const mark = item.decision === "accept" ? "accept" : "reject";
      logProgress(ctx, {
        kind: "tool",
        role: "plan review",
        label: `${mark} ${item.title}`,
        text: `plan review  ${mark} ${item.title}`,
      });
    }
    return next;
  }

  async function presentDemoReview(
    ctx: ExtensionContext,
    run: RunState,
  ): Promise<RunState | undefined> {
    logProgress(ctx, {
      kind: "start",
      role: "demo review",
      stage: "demo_review",
      text: `Demo round ${run.demoRound ?? 1}: accept or request changes`,
    });
    const answers = await promptQuestions(
      ctx,
      [
        {
          id: "demo",
          question: `Demo notes:\n\n${run.demoNotes?.trim() || "(no notes recorded)"}\n\nAccept, or request changes to loop back to the planner?`,
          options: ["Accept", "Request changes"],
        },
      ],
      { signal: dialogAbort.signal },
    );
    const latest = store.load() ?? run;
    if (latest.halted || latest.stage !== "demo_review") return latest;
    if (!answers) {
      if (!ctx.hasUI) return applyDemoReview(latest, true);
      haltWorkflow(ctx, latest);
      notify(
        ctx,
        "Stopped at demo review. /devteam continue to review again, or /devteam skip to finish.",
        "warning",
      );
      return undefined;
    }
    const answer = answers[0];
    const feedback = answer?.custom?.trim();
    const accepted =
      !feedback && (answer?.selected.join(" ").toLowerCase().includes("accept") ?? true);
    const next = applyDemoReview(latest, accepted, feedback);
    logProgress(ctx, {
      kind: "tool",
      role: "demo review",
      label: accepted ? "accept" : "request changes",
      text: accepted
        ? "demo review  accept"
        : `demo review  request changes${feedback ? `: ${feedback}` : ""}`,
    });
    if (!accepted && next.stage === "commit_message") {
      notify(ctx, "Demo round cap reached. Finishing with the commit message.", "warning");
    }
    return next;
  }

  async function advancePipeline(ctx: ExtensionContext, incoming: RunState) {
    if (advancing) return;
    let claimed = false;
    const existing = store.mutate((current) => {
      if (current.pipelineOwner && current.pipelineOwner !== owner) return undefined;
      claimed = true;
      return { ...current, pipelineOwner: owner };
    });
    if (!claimed || !existing) {
      notify(ctx, "devteam run is owned by another orchestrator.", "warning");
      return;
    }
    advancing = true;
    try {
      let run = incoming;
      for (;;) {
        run = persist(step(run, undefined, config?.paths));
        const phase = phaseOf(run);
        switch (phase) {
          case "halted":
            persist({ ...run, pipelineLocked: false });
            standDown(ctx);
            applyParentTools(undefined);
            notify(ctx, continueHint(run));
            return;
          case "done":
            standDown(ctx);
            applyParentTools(run);
            if (ctx.hasUI) {
              ctx.ui.notify(
                run.commitMessageDraft
                  ? "devteam: commit message drafted (not committed). See /devteam status."
                  : "devteam: finished.",
                "info",
              );
            }
            return;
          case "error":
            standDown(ctx);
            applyParentTools(run);
            return;
          case "ask_plan": {
            const reviewed = await presentPlanReview(ctx, run);
            if (!reviewed || reviewed.halted) return;
            run = persist(reviewed);
            continue;
          }
          case "ask_demo": {
            const reviewed = await presentDemoReview(ctx, run);
            if (!reviewed || reviewed.halted) return;
            run = persist(reviewed);
            continue;
          }
          case "kick_parent":
            persist(run);
            await kickParent(ctx, run, {
              resume: Boolean(run.spec?.trim() || run.planCritique?.reviewed),
            });
            return;
          case "ask_opt_in":
            persist(run);
            applyParentTools(run);
            refreshUi(ctx, run);
            notify(
              ctx,
              run.stage === "demo_opt_in"
                ? "QA passed. Want a live headed demo of the change? Answer yes or no, or /devteam skip to finish without one."
                : "Want an HTML mockup before implementation? Answer yes or no, or /devteam skip to implement without one.",
            );
            return;
          case "spawn_scouts": {
            if (isOmpHost()) {
              await scheduleNative(ctx, run, "scout");
              if (nativeDispatch) return;
            } else await runDelegatedScouts(ctx, run);
            const afterScout = store.load();
            if (!afterScout || afterScout.halted) return;
            if (afterScout.stage === "scout") {
              applyParentTools(afterScout);
              refreshUi(ctx, afterScout);
              notify(
                ctx,
                afterScout.lastError ?? "devteam: scouting stalled. /devteam status for details.",
                "warning",
              );
              return;
            }
            run = afterScout;
            continue;
          }
          case "spawn_work": {
            if (isOmpHost()) {
              await scheduleNative(ctx, run, "work");
              if (nativeDispatch) return;
            } else {
              await runDelegatedWork(ctx, run);
            }
            const afterWork = store.load();
            if (!afterWork || afterWork.halted) return;
            if (afterWork.stage === "implement") {
              run = persist(step(afterWork, undefined, config?.paths));
              if (run.halted) return;
              if (run.stage === "implement") {
                applyParentTools(run);
                refreshUi(ctx, run);
                notify(
                  ctx,
                  run.lastError ?? "devteam: implementation stalled. /devteam status for details.",
                  "warning",
                );
                return;
              }
              continue;
            }
            run = afterWork;
            continue;
          }
          case "spawn_child": {
            const role = activeRole(run);
            if (!role || role === "planner" || role === "designer") {
              persist({
                ...run,
                lastError: `No isolated role for stage ${run.stage}`,
                stage: "error",
              });
              return;
            }
            if (isOmpHost()) {
              await scheduleNative(ctx, run, "role", role);
              return;
            }
            await spawnRole(ctx, run, role);
            const after = store.load();
            if (!after || after.halted) return;
            if (after.stage !== run.stage || after.stage === "error" || after.pendingHandoff) {
              run = after;
              continue;
            }
            if (after.lastError) return;
            if (ctx.hasUI) {
              ctx.ui.notify(
                `devteam: ${role} finished without a handoff. Check /devteam status.`,
                "warning",
              );
            }
            return;
          }
          default:
            return;
        }
      }
    } finally {
      store.mutate((current) =>
        current.pipelineOwner === owner ? { ...current, pipelineOwner: undefined } : undefined,
      );
      advancing = false;
      refreshUi(ctx, store.load());
    }
  }

  function queuePipelineAdvance(ctx: ExtensionContext | undefined) {
    if (!ctx) return;
    queueMicrotask(() => {
      const latest = store.load();
      if (
        childRole ||
        latest?.halted ||
        !latest?.pendingHandoff ||
        latest.pipelineLocked ||
        advancing
      )
        return;
      void advancePipeline(ctx, latest);
    });
  }

  async function startTask(ctx: ExtensionContext, task: string) {
    standDown(ctx);
    const taken = jobsInAgent().map((job) => job.jobId);
    jobId = newJobId(taken);
    const git = captureGit(ctx.cwd);
    const detection = detectStack(getCatalog(), { cwd: ctx.cwd, config: config ?? undefined });
    let run = emptyRun(sessionId, task, jobId);
    run.stack = detection;
    run.uiSurface = detection.uiSurface;
    run.gitBaseline = git.baseline;
    run.dirtyAtStart = git.dirty;
    run.cwd = ctx.cwd;
    const heuristicSkip = shouldSkipScout(run);
    let skipScout = heuristicSkip;
    if (scoutSkipNeedsJudge(run)) {
      skipScout =
        (await inferScoutSkipFromJudge({
          run,
          cwd: ctx.cwd,
          omp: isOmpHost(),
        })) === true;
    }
    run = startScouting(run, skipScout);
    persist(run);
    const skippedScout = run.stage === "planner";
    logProgress(ctx, {
      kind: "stage",
      stage: run.stage,
      role: skippedScout ? "planner" : "planner_orchestrator",
      text: skippedScout
        ? heuristicSkip
          ? "Planner. Scouts skipped — the task already names the files."
          : "Planner. Scouts skipped via @tiny — the task already names the files."
        : "Scouting the repo. The planner will ask questions after that.",
    });
    if (git.dirty && ctx.hasUI) {
      ctx.ui.notify(
        "Working tree was dirty at start. Reviewer will diff against HEAD anyway.",
        "warning",
      );
    }
    try {
      pi.setSessionName(task.slice(0, 72));
    } catch {
      /* ignore */
    }
    await advancePipeline(ctx, run);
  }

  pi.registerTool({
    name: "devteam_bind",
    label: "Bind devteam assignment",
    description: "Bind a native devteam implementor to its assigned work item.",
    parameters: Type.Object({ jobId: Type.String(), token: Type.String() }),
    async execute(_id, params, _signal, _onUpdate, ctx) {
      if (!ctx) throw new Error("Native agent context required.");
      const agent = nativeAgent(ctx);
      if (
        !agent?.id ||
        !agent.parentId ||
        !/^[a-z0-9]+$/.test(params.jobId) ||
        !/^[0-9a-f-]{36}$/.test(params.token)
      )
        throw new Error("Invalid native assignment claim.");
      const path = runPaths(agentDirSafe(), params.jobId).json;
      let matched:
        | { kind: NativeEntry["kind"]; role: IsolatedRole; id?: string; attempt: number }
        | undefined;
      mutateRun(path, agentDirSafe(), (run) => {
        if (run.jobId !== params.jobId || run.cwd !== ctx.cwd || run.halted || !run.pipelineLocked)
          return undefined;
        const valid = (identity: WorkItem["native"], role: IsolatedRole) =>
          identity?.token === params.token &&
          identity.parentId === agent.parentId &&
          identity.expectedAgentId === agent.id &&
          (!identity.agentId || identity.agentId === agent.id) &&
          (agent.name === `devteam-${role.replaceAll("_", "-")}` ||
            (agent.name === "devteam-implementor" &&
              ["database", "backend", "frontend", "general"].includes(role)));
        const work =
          run.stage === "implement"
            ? run.workItems?.find(
                (item) =>
                  item.status === "running" &&
                  item.native?.attempt === item.attempts &&
                  valid(item.native, item.layer),
              )
            : undefined;
        const scout =
          run.stage === "scout"
            ? run.scoutItems?.find(
                (item) =>
                  item.status === "running" &&
                  item.native?.attempt === item.attempts &&
                  valid(item.native, "scout"),
              )
            : undefined;
        const single =
          run.nativeRole?.stage === run.stage && valid(run.nativeRole.native, run.nativeRole.role)
            ? run.nativeRole
            : undefined;
        if (work?.native) {
          matched = { kind: "work", role: work.layer, id: work.id, attempt: work.attempts };
          return {
            ...run,
            workItems: run.workItems?.map((item) =>
              item.id === work.id
                ? { ...item, native: { ...work.native!, agentId: agent.id } }
                : item,
            ),
          };
        }
        if (scout?.native) {
          matched = { kind: "scout", role: "scout", id: scout.id, attempt: scout.attempts };
          return {
            ...run,
            scoutItems: run.scoutItems?.map((item) =>
              item.id === scout.id
                ? { ...item, native: { ...scout.native!, agentId: agent.id } }
                : item,
            ),
          };
        }
        if (single) {
          matched = { kind: "role", role: single.role, attempt: single.native.attempt };
          return {
            ...run,
            nativeRole: { ...single, native: { ...single.native, agentId: agent.id } },
          };
        }
        return undefined;
      });
      if (!matched) throw new Error("Native assignment claim rejected.");
      nativeJobId = params.jobId;
      nativeTaskId = matched.id;
      nativeKind = matched.kind;
      nativeRole = matched.role;
      nativeAgentId = agent.id;
      nativeParentId = agent.parentId;
      nativeAttempt = matched.attempt;
      nativeToolCalls = 0;
      nativeRecentTools = [];
      touchNative(ctx);
      return {
        content: [
          {
            type: "text" as const,
            text: `Bound ${matched.role}${matched.id ? ` ${matched.id}` : ""}.`,
          },
        ],
      };
    },
  });

  pi.registerTool({
    name: "devteam_state",
    label: "Devteam state",
    description:
      "Read or update the current /devteam run notebook stored in the Pi agent directory.",
    promptSnippet: "Get or update /devteam run-state sections",
    promptGuidelines: [
      "Use devteam_state to persist specs, tickets, notes, and findings. Never write workflow files into the user repository.",
    ],
    parameters: Type.Object({
      action: StringEnum(["get", "replace", "append"] as const),
      section: Type.Optional(
        Type.String({ description: `Section to update. One of: ${STATE_SECTIONS.join(", ")}` }),
      ),
      sections: Type.Optional(
        Type.Array(Type.String(), {
          description: `Get only these sections. One of: ${STATE_SECTIONS.join(", ")}`,
        }),
      ),
      value: Type.Optional(
        Type.String({
          description: "Replacement or appended text (JSON allowed for some sections)",
        }),
      ),
    }),
    async execute(_id, params) {
      const result = applyStateTool(store, params);
      if (result.isError) throw new Error(result.text);
      return { content: [{ type: "text" as const, text: result.text }] };
    },
  });

  pi.registerTool({
    name: "devteam_ask",
    label: "Devteam ask",
    description:
      "Ask the user a round of grilling questions as selectable options. The UI adds Other so they can type a custom answer.",
    promptSnippet: "Ask the user grilling questions with selectable options",
    promptGuidelines: [
      "Use devteam_ask (or the host ask tool) for grilling. Never ask the user to type q1:1. Do not add an Other option; the UI adds it.",
    ],
    parameters: Type.Object({
      questions: Type.Array(
        Type.Object({
          id: Type.String({ description: "Stable id, e.g. q1" }),
          question: Type.String(),
          options: Type.Array(Type.String(), {
            description: "2-5 short labels. Do not include Other.",
          }),
          recommended: Type.Optional(
            Type.Number({ description: "0-based index of the recommended option" }),
          ),
        }),
      ),
    }),
    async execute(_id, params, signal, _onUpdate, ctx) {
      if (childRole) throw new Error("devteam_ask is only for the parent planner/designer.");
      if (!ctx?.hasUI) throw new Error("devteam_ask needs an interactive session.");
      const questions = Array.isArray(params.questions) ? params.questions : [];
      if (!questions.length) throw new Error("Pass at least one question.");
      const answers = await promptQuestions(
        ctx,
        questions.map((question, index) => ({
          id: String(question.id || `q${index + 1}`),
          question: String(question.question ?? ""),
          options: (question.options ?? []).map((option) => String(option)),
          recommended: typeof question.recommended === "number" ? question.recommended : undefined,
        })),
        { signal: signal ?? dialogAbort.signal },
      );
      if (!answers) {
        const ui = ctx.ui as { select?: unknown; askDialog?: unknown } | undefined;
        if (!ui?.select && !ui?.askDialog) {
          throw new Error(
            "No option picker on this host. Ask in chat with numbered options, and say they can type a custom answer.",
          );
        }
        throw new Error("User cancelled the question.");
      }
      return { content: [{ type: "text" as const, text: formatAskAnswers(answers) }] };
    },
  });

  pi.registerTool({
    name: "devteam_handoff",
    label: "Devteam handoff",
    description: "Advance the /devteam pipeline when the current role is finished.",
    promptSnippet: "Finish this role and advance the /devteam pipeline",
    promptGuidelines: [
      "Use devteam_handoff when the current role's work is complete. Pass action plan_ready, critic_approve, critic_revise, design_ready, scout_planned, scout_done, work_planned, implementor_done, qa_pass, qa_fail, or commit_drafted.",
    ],
    parameters: Type.Object({
      action: StringEnum(HANDOFF_ACTIONS),
      summary: Type.Optional(Type.String({ description: "Short note stored on the run" })),
    }),
    async execute(_id, params, _signal, _onUpdate, ctx) {
      const result = applyHandoffTool(store, params);
      if (result.isError) throw new Error(result.text);
      if (!childRole && ctx && !nativeAgent(ctx)) queuePipelineAdvance(ctx);
      return {
        content: [{ type: "text" as const, text: result.text }],
        terminate: result.terminate,
      };
    },
  });

  pi.registerTool({
    name: "devteam_mockup",
    label: "Devteam mockup",
    description:
      "Read or write the HTML mockup for the current /devteam run. Files live next to run state, not in the repo.",
    promptSnippet: "Read or write the /devteam HTML mockup",
    promptGuidelines: [
      "Use devteam_mockup to write self-contained HTML mockups. Do not write mockups into the user working tree.",
    ],
    parameters: Type.Object({
      action: StringEnum(["read", "write", "path"] as const),
      content: Type.Optional(
        Type.String({ description: "HTML (or CSS/JS) file contents for write" }),
      ),
      file: Type.Optional(
        Type.String({
          description: "Relative file inside the mockup directory. Default index.html",
        }),
      ),
    }),
    async execute(_id, params, _signal, _onUpdate, _ctx) {
      if (params.action === "write") {
        const paths = runPaths(agentDirSafe(), sessionId);
        const rel = params.file?.replaceAll("\\", "/").replace(/^\/+/, "") || "index.html";
        const abs = join(paths.mockupDir, rel);
        return await withFileMutationQueue(abs, async () => {
          const result = applyMockupTool(store, params);
          if (result.isError) throw new Error(result.text);
          return { content: [{ type: "text" as const, text: result.text }] };
        });
      }
      const result = applyMockupTool(store, params);
      if (result.isError) throw new Error(result.text);
      return { content: [{ type: "text" as const, text: result.text }] };
    },
  });

  pi.registerCommand("devteam", {
    description:
      "Run the /devteam workflow: scout, plan, build a vertical slice with specialists, review once, test, optional demo",
    getArgumentCompletions: (prefix: string) => {
      const items = ["continue", "list", "status", "stop", "clear", "mockup", "skip", "retry"].map(
        (value) => ({
          value,
          label: value,
        }),
      );
      const p = prefix.trim().toLowerCase();
      return p ? items.filter((item) => item.value.startsWith(p)) : items;
    },
    handler: async (args, ctx) => {
      if (childRole) {
        notify(ctx, "Nested /devteam is disabled in specialist runs.", "warning");
        return;
      }
      try {
        await waitForIdleTimed(ctx);

        const { trimmed, sub, rest: restText } = parseDevteamArgs(args);

        if (!trimmed) {
          const run = store.load();
          notify(
            ctx,
            run && run.stage !== "idle"
              ? `devteam is at ${run.stage}. Try /devteam status.`
              : "Usage: /devteam <task> | continue | retry | list | status | mockup | skip | stop | clear",
          );
          return;
        }

        if (sub === "list" && !restText) {
          await showJobList(ctx);
          return;
        }

        if (sub === "status") {
          const run = store.load();
          let text = "No active /devteam run.";
          if (run) {
            try {
              const paths = runPaths(agentDirSafe(), jobId);
              text = renderRunMarkdown(run, {
                canonicalPath: paths.json,
                aliasPath: paths.workflowStateJson,
              });
            } catch (err) {
              const detail = err instanceof Error ? err.message : String(err);
              text = `devteam: status render failed: ${detail}\n\n${JSON.stringify(run, null, 2).slice(0, 4000)}`;
            }
          }
          if (ctx.hasUI) ctx.ui.notify(text, "info");
          return;
        }

        if (sub === "clear") {
          const active = store.load();
          if (
            (active?.pipelineOwner && active.pipelineOwner !== owner) ||
            (active?.pipelineLocked && !advancing)
          ) {
            notify(
              ctx,
              "devteam run may still be active. Verify its workers have stopped and use /devteam continue to recover interrupted native work.",
              "warning",
            );
            return;
          }
          if (advancing) {
            notify(
              ctx,
              "devteam is stopping. Wait for the current step to finish before clearing.",
              "warning",
            );
            return;
          }
          standDown(ctx);
          clearRunFiles(agentDirSafe(), jobId);
          persist(emptyRun(sessionId, "", jobId));
          applyParentTools(store.load());
          if (ctx.hasUI) ctx.ui.notify("Cleared /devteam run state.", "info");
          return;
        }

        if (sub === "stop") {
          const active = store.load();
          if (
            (active?.pipelineOwner && active.pipelineOwner !== owner) ||
            (active?.pipelineLocked && !advancing && !nativeDispatch)
          ) {
            notify(
              ctx,
              "devteam run may still be active. Verify its workers have stopped and use /devteam continue to recover interrupted native work.",
              "warning",
            );
            return;
          }
          const run = store.load();
          standDown(ctx);
          abortParentTurn(ctx);
          if (!run || run.stage === "idle") {
            if (ctx.hasUI) ctx.ui.notify("No /devteam run to stop.", "warning");
            return;
          }
          store.mutate?.(applyStop);
          applyParentTools(undefined);
          return;
        }

        if (sub === "mockup") {
          const run = store.load();
          const path = run?.mockupPath ?? runPaths(agentDirSafe(), sessionId).mockupFile;
          if (!run?.mockupPath) {
            if (ctx.hasUI)
              ctx.ui.notify(
                "No mockup yet. Opt in after planning, then wait for the designer.",
                "info",
              );
            return;
          }
          if (ctx.hasUI) ctx.ui.notify(`Mockup: ${path}`, "info");
          openPath(path);
          return;
        }

        const run = store.load();
        if (
          (sub === "continue" || sub === "resume") &&
          restText.toLowerCase() !== "list" &&
          (restText ||
            (run?.pipelineLocked &&
              (run.nativeRole ||
                run.workItems?.some((item) => item.native) ||
                run.scoutItems?.some((item) => item.native))))
        ) {
          await resumeJob(ctx, restText || run!.jobId);
          return;
        }
        if (
          (run?.pipelineOwner && run.pipelineOwner !== owner) ||
          (run?.pipelineLocked && !advancing && !(sub === "skip" && nativeDispatch))
        ) {
          notify(
            ctx,
            "devteam run may still be active. Verify its workers have stopped and use /devteam continue to recover interrupted native work.",
            "warning",
          );
          return;
        }

        if (sub === "continue" && restText.toLowerCase() === "list") {
          await showJobList(ctx);
          return;
        }

        if (sub === "continue" && !restText) {
          if (!run || run.stage === "idle") {
            notify(ctx, "No /devteam run to continue.", "warning");
            return;
          }
          if (run.pipelineLocked || advancing) {
            notify(ctx, "devteam is busy. /devteam stop to abort this step.", "warning");
            return;
          }
          const next = applyContinue(run);
          if (next === run) {
            notify(ctx, continueHint(run), "warning");
            return;
          }
          persist(next);
          notify(ctx, `Continuing: ${run.stage} → ${next.stage}.`);
          await advancePipeline(ctx, next);
          return;
        }

        if (sub === "retry") {
          if (!run || run.stage === "idle") {
            notify(ctx, "No /devteam run to retry.", "warning");
            return;
          }
          if (run.pipelineLocked || advancing) {
            notify(ctx, "devteam is busy. /devteam stop to abort this step.", "warning");
            return;
          }
          const ids = restText ? restText.split(/\s+/).filter(Boolean) : undefined;
          const reopened = reopenImplementation(run, ids);
          if (!reopened.ok) {
            notify(ctx, reopened.error, "warning");
            return;
          }
          persist(reopened.run);
          const retried = (
            ids ??
            (run.workItems ?? []).filter((item) => item.status === "failed").map((item) => item.id)
          ).join(" ");
          notify(ctx, `Retrying ${retried}. ${run.stage} → implement.`);
          await advancePipeline(ctx, reopened.run);
          return;
        }

        if (sub === "skip" && !restText) {
          if (!run || run.stage === "idle") {
            if (ctx.hasUI) ctx.ui.notify("No /devteam run to skip.", "warning");
            return;
          }
          standDown(ctx);
          abortParentTurn(ctx);
          resetDialogAbort();
          const next = store.mutate?.((latest) =>
            applySkip({
              ...latest,
              pipelineLocked: false,
              pendingHandoff: undefined,
              nativeRole: undefined,
            }),
          );
          if (!next) return;
          if (
            next.stage === run.stage &&
            next.pauseReason === run.pauseReason &&
            next.spec === run.spec &&
            next.wantMockup === run.wantMockup &&
            next.wantDemo === run.wantDemo
          ) {
            notify(
              ctx,
              run.halted
                ? "Nothing to skip. /devteam continue resumes this step."
                : "Nothing to skip at this stage.",
            );
            return;
          }
          notify(ctx, `Skipping: ${run.stage} → ${next.stage}.`);
          if (advancing) return;
          await advancePipeline(ctx, next);
          return;
        }

        const task = trimmed;
        if (run?.pipelineLocked || advancing) {
          notify(ctx, "devteam is busy. /devteam stop first, or wait.", "warning");
          return;
        }
        await startTask(ctx, task);
      } catch (err) {
        notify(
          ctx,
          `devteam command failed: ${err instanceof Error ? err.message : String(err)}`,
          "error",
        );
      }
    },
  });

  pi.on("session_start", (_event, ctx) => {
    try {
      if (advancing) return;
      sessionId = sessionIdFromContext(ctx);
      jobId = readCurrentJobId(agentDirSafe(), sessionId) || sessionId;
      config = loadDevteamConfig(ctx.cwd, projectTrusted(ctx), PROJECT_CONFIG_DIRS);
      try {
        defaultTools = pi.getActiveTools();
      } catch {
        defaultTools = undefined;
      }

      if (childRole || nativeAgent(ctx)) return;

      const run = store.load();
      if (
        run?.pipelineLocked &&
        (run.nativeRole ||
          run.workItems?.some((item) => item.native) ||
          run.scoutItems?.some((item) => item.native))
      ) {
        notify(
          ctx,
          "Native work may still be active. Verify all previous hosts, workers, and subprocesses have stopped, then use /devteam continue.",
          "warning",
        );
      }
      if (run?.jobId) jobId = run.jobId;
      applyParentTools(run);
      refreshUi(ctx, run);
    } catch (err) {
      const message = `devteam session_start failed: ${err instanceof Error ? err.message : String(err)}`;
      try {
        if (ctx.hasUI) ctx.ui.notify(message, "error");
      } catch {
        /* ignore */
      }
    }
  });

  pi.on("session_shutdown", () => {
    stopNativeTimer();
    standDown();
    abortChild = undefined;
  });

  pi.on("message_update", (_event, ctx) => {
    if (nativeAgent(ctx)) touchNative(ctx);
  });
  pi.on("agent_end", (_event, ctx) => {
    if (nativeAgent(ctx)) stopNativeTimer();
  });

  pi.on("input", (event, ctx) => {
    if (childRole) return;
    if (event.source === "extension") return;
    const run = store.load();
    if (!run) return;

    if (run.stage === "mockup_opt_in") {
      const answer = parseYesNo(event.text);
      if (answer === null) return;
      const next = persist(acceptMockupChoice(run, answer));
      queueMicrotask(() => {
        void advancePipeline(ctx, next);
      });
      return { action: "handled" as const };
    }
    if (run.stage === "demo_opt_in") {
      const answer = parseYesNo(event.text);
      if (answer === null) return;
      const next = persist(acceptDemoChoice(run, answer));
      queueMicrotask(() => {
        void advancePipeline(ctx, next);
      });
      return { action: "handled" as const };
    }
  });

  pi.on("before_agent_start", (event, ctx) => {
    if (nativeAgent(ctx)) return;
    const run = store.load();
    const role = childRole ?? run?.interactiveRole;
    applyParentTools(run);

    if (!role || (role !== "planner" && role !== "designer" && !childRole)) return;

    try {
      const extra = loadRolePrompt(role);
      return { systemPrompt: `${event.systemPrompt}\n\n${extra}` };
    } catch {
      return;
    }
  });

  onAgentIdle(pi, (_event, ctx) => {
    if (childRole || nativeAgent(ctx as ExtensionContext)) return;
    queuePipelineAdvance(ctx as ExtensionContext);
  });

  // OMP emits this only after queued turns and task calls have settled.
  if (isOmpHost()) {
    const on = pi.on as unknown as (
      event: string,
      handler: (event: unknown, ctx: ExtensionContext) => unknown,
    ) => void;
    on("session_stop", (_event, ctx) => {
      if (nativeDispatch && !nativeDispatch.calls.size)
        failNativeDispatch(ctx, "Native task call was not dispatched.");
    });
    on("before_subagent_spawn", (event) => {
      if (!nativeDispatch) return;
      const spawn = event as { agent?: string | { name?: string; id?: string }; spawnKey?: string };
      const name = typeof spawn.agent === "string" ? spawn.agent : spawn.agent?.name;
      const id = typeof spawn.agent === "object" ? spawn.agent?.id : undefined;
      const pending = [...nativeDispatch.calls.values()].flat();
      const entry = pending.find(
        (item) =>
          name === `devteam-${item.role.replaceAll("_", "-")}` &&
          (!id || id === item.native.expectedAgentId) &&
          (!spawn.spawnKey ||
            !pending.some((candidate) => candidate.native.expectedAgentId === spawn.spawnKey) ||
            spawn.spawnKey === item.native.expectedAgentId),
      );
      if (!entry) return;
      const run = store.load();
      return { model: resolveChildModel(entry.role, undefined, config?.models, true, run?.stage) };
    });
  }

  pi.on("tool_call", (event, ctx) => {
    if (!nativeAgent(ctx) && !childRole && event.toolName === "task" && nativeDispatch) {
      const dispatch = nativeDispatch;
      const input = event.input as Record<string, unknown>;
      const batch = Array.isArray(input.tasks);
      const selected = batch ? dispatch.items : dispatch.items.slice(0, 1);
      if (!selected.length) return { block: true, reason: "No native assignments remain." };
      const tasks = selected.map((item) => {
        const base = {
          name: item.native.expectedAgentId,
          agent: `devteam-${item.role.replaceAll("_", "-")}`,
          solutionSpace: "Complete assigned devteam role within specified scope.",
        };
        const template = batch ? (input.tasks as Record<string, unknown>[])[0] : input;
        return template && Array.isArray(template.steps)
          ? { ...base, steps: [item.prompt] }
          : { ...base, task: item.prompt };
      });
      const callId = (event as { toolCallId?: string }).toolCallId;
      if (!callId) return { block: true, reason: "Native task call has no identity." };
      dispatch.calls.set(callId, selected);
      dispatch.items = dispatch.items.filter((item) => !selected.includes(item));
      return { input: batch ? { context: `Devteam job ${jobId}`, tasks } : tasks[0] };
    }
    const native = nativeAgent(ctx);
    const assignment = native ? nativeAssignment(ctx) : undefined;
    if (native && event.toolName !== "devteam_bind") {
      if (!assignment) {
        if (["read", "grep", "glob", "find", "yield"].includes(event.toolName)) return;
        return { block: true, reason: "Bind an active devteam assignment first." };
      }
      touchNative(ctx);
      if (event.toolName !== "devteam_handoff" && event.toolName !== "yield") {
        nativeToolCalls += 1;
        nativeRecentTools.push(describeToolCall(event.toolName, event.input));
        if (nativeRecentTools.length > 40) nativeRecentTools.shift();
        const repeat = resolveRepeatToolAbort(config?.repeatToolAbort);
        const reason =
          nativeToolCalls > resolveMaxToolCalls(config?.maxToolCalls, assignment.role)
            ? "Devteam role tool-call budget exceeded."
            : isRepeatedToolLoop(nativeRecentTools, repeat)
              ? "Devteam role repeated an identical inspection."
              : undefined;
        if (reason) {
          stopNativeTimer();
          abortParentTurn(ctx);
          return { block: true, reason };
        }
      }
      if (
        ![...mapToolsForHost(toolsForRole(assignment.role), true), "yield"].includes(event.toolName)
      )
        return { block: true, reason: "Tool unavailable to this devteam role." };
      const input = event.input as Record<string, unknown>;
      const handoffs: Record<IsolatedRole, string[]> = {
        planner_orchestrator: ["scout_planned"],
        scout: ["scout_done"],
        plan_critic: ["critic_approve", "critic_revise"],
        design_critic: ["critic_approve", "critic_revise"],
        orchestrator: ["work_planned"],
        database: ["implementor_done"],
        backend: ["implementor_done"],
        frontend: ["implementor_done"],
        general: ["implementor_done"],
        reviewer: ["qa_pass", "qa_fail"],
        tester: ["qa_pass", "qa_fail"],
        linter: ["qa_pass", "qa_fail"],
        demo: ["qa_pass", "qa_fail"],
        commit_message: ["commit_drafted"],
      };
      if (
        event.toolName === "devteam_handoff" &&
        !handoffs[assignment.role].includes(String(input.action))
      )
        return { block: true, reason: "Handoff unavailable to this devteam role." };
      if (
        event.toolName === "devteam_state" &&
        input.action !== "get" &&
        (assignment.role === "scout" ||
          (["database", "backend", "frontend", "general"].includes(assignment.role) &&
            input.section !== `${assignment.role}Notes`))
      )
        return { block: true, reason: "State section unavailable to this devteam role." };
      if (isWriteTool(event.toolName) && !writePathFromInput(event.input)) {
        const patch = (event.input as Record<string, unknown>).input;
        if (event.toolName !== "edit" || typeof patch !== "string" || /^MV\s/m.test(patch))
          return { block: true, reason: "Cannot verify write path against assignment." };
        const paths = [...patch.matchAll(/^\[([^#\r\n]+)#[0-9A-F]{4}\]$/gm)].map(
          (match) => match[1],
        );
        if (!paths.length) return { block: true, reason: "Cannot verify edit paths." };
        const run = store.load();
        const service = serviceByName(
          run?.stack?.services,
          assignment.assignment?.service ?? run?.currentService,
        );
        for (const path of paths) {
          const gate = gateWrite(
            assignment.role,
            path,
            ctx.cwd,
            config ?? undefined,
            service,
            assignment.kind === "work" ? assignment.assignment?.files : undefined,
            run ? runPaths(agentDirSafe(), run.jobId).demoDir : undefined,
          );
          if (gate.block) return { block: true, reason: gate.reason };
        }
      }
    }
    if (!childRole && !native) {
      const run = store.load();
      if (!run || run.stage === "idle" || run.stage === "done") return;
    }
    const role = assignment?.role ?? currentRole(ctx);
    const current = store.load();
    const service = serviceByName(
      current?.stack?.services,
      assignment?.assignment?.service ?? childServiceName ?? current?.currentService,
    );
    const assigned = native
      ? assignment?.kind === "work"
        ? assignment.assignment?.files
        : undefined
      : childRole === "scout"
        ? undefined
        : findItem(current?.workItems, childTaskId)?.files;
    const demoDir = current ? runPaths(agentDirSafe(), current.jobId).demoDir : undefined;
    const writePath = isWriteTool(event.toolName) ? writePathFromInput(event.input) : undefined;
    if (writePath) {
      const gate = gateWrite(
        role,
        writePath,
        ctx.cwd,
        config ?? undefined,
        service,
        assigned,
        demoDir,
      );
      if (gate.block) return { block: true, reason: gate.reason };
    }
    if (isToolCallEventType("bash", event)) {
      const gate = gateBash(
        role,
        event.input.command,
        config ?? undefined,
        current?.stack?.services,
        demoDir,
      );
      if (gate.block) return { block: true, reason: gate.reason };
    }
  });

  pi.on("tool_result", async (event, ctx) => {
    if (event.toolName !== "task" || !nativeDispatch || nativeAgent(ctx)) return;
    const dispatch = nativeDispatch;
    const callId = (event as { toolCallId?: string }).toolCallId;
    const assigned = callId ? dispatch.calls.get(callId) : undefined;
    if (!assigned) return;
    dispatch.calls.delete(callId!);
    const details = (
      event as {
        details?: {
          results?: Array<{
            id?: string;
            exitCode?: number;
            error?: string;
            aborted?: boolean;
            output?: string;
          }>;
        };
        isError?: boolean;
      }
    ).details;
    const finished = !dispatch.items.length && !dispatch.calls.size;
    const singleton = assigned.find((entry) => entry.kind === "role");
    const snapshot = singleton ? store.load() : undefined;
    const singleResult =
      singleton && details?.results?.find((item) => item.id === singleton.native.expectedAgentId);
    let inferred: RunState | undefined;
    if (
      singleton &&
      snapshot &&
      !snapshot.halted &&
      snapshot.pipelineLocked &&
      snapshot.nativeRole?.native.token === singleton.native.token &&
      snapshot.nativeRole.native.agentId === singleton.native.expectedAgentId &&
      snapshot.nativeRole.stage === snapshot.stage &&
      !snapshot.pendingHandoff &&
      !event.isError &&
      singleResult?.exitCode === 0 &&
      !singleResult.aborted
    ) {
      try {
        inferred = await childRunner.completeNative(
          ctx,
          snapshot,
          singleton.role,
          singleResult.output ?? "",
        );
      } catch (error) {
        inferred = { ...snapshot, lastError: `Native result inference failed: ${String(error)}` };
      }
    }
    if (nativeDispatch !== dispatch) return;
    store.mutate((run) => {
      const identityFor = (entry: NativeEntry) =>
        entry.kind === "role"
          ? run.nativeRole?.native
          : entry.kind === "scout"
            ? run.scoutItems?.find((item) => item.id === entry.id)?.native
            : run.workItems?.find((item) => item.id === entry.id)?.native;
      if (
        run.halted ||
        !run.pipelineLocked ||
        assigned.some((entry) => {
          const identity = identityFor(entry);
          return (
            !identity ||
            identity.token !== entry.native.token ||
            identity.attempt !== entry.native.attempt ||
            identity.parentId !== entry.native.parentId ||
            identity.expectedAgentId !== entry.native.expectedAgentId ||
            (identity.agentId && identity.agentId !== identity.expectedAgentId) ||
            (entry.kind === "role"
              ? run.nativeRole?.stage !== run.stage
              : run.stage !== (entry.kind === "scout" ? "scout" : "implement"))
          );
        })
      ) {
        dispatch.stale = true;
        return undefined;
      }
      let next = { ...run };
      for (const entry of assigned) {
        const identity = identityFor(entry)!;
        const result = details?.results?.find((item) => item.id === identity.expectedAgentId);
        const success =
          !event.isError &&
          result?.exitCode === 0 &&
          !result.aborted &&
          identity.agentId === identity.expectedAgentId;
        const error =
          result?.error || `Native ${entry.role} failed or finished without a valid handoff.`;
        if (entry.kind === "role") {
          next = { ...next, nativeRole: undefined };
          if (!success) next = { ...next, pendingHandoff: undefined, lastError: error };
          else if (!next.pendingHandoff) {
            if (
              inferred &&
              snapshot &&
              JSON.stringify(next) === JSON.stringify({ ...snapshot, nativeRole: undefined })
            ) {
              next = { ...inferred, nativeRole: undefined };
            } else {
              next = { ...next, lastError: error };
            }
            if (next.stage === run.stage && !next.pendingHandoff && !next.halted)
              next = { ...next, lastError: next.lastError ?? error };
          }
        } else if (entry.kind === "scout") {
          next = {
            ...next,
            scoutItems: next.scoutItems?.map((item) =>
              item.id !== entry.id
                ? item
                : success && item.status === "done" && item.findings?.trim()
                  ? { ...item, native: undefined }
                  : {
                      ...item,
                      status: "failed" as const,
                      findings: undefined,
                      native: undefined,
                      error,
                    },
            ),
          };
        } else {
          next = {
            ...next,
            workItems: next.workItems?.map((item) =>
              item.id !== entry.id
                ? item
                : success && item.status === "done"
                  ? { ...item, native: undefined }
                  : { ...item, status: "failed" as const, native: undefined, error },
            ),
          };
        }
      }
      return { ...next, pipelineLocked: finished && !dispatch.stale ? false : next.pipelineLocked };
    });
    if (finished) {
      nativeDispatch = undefined;
      if (!dispatch.stale) {
        const latest = store.load();
        applyParentTools(latest);
        if (!(assigned.some((entry) => entry.kind === "role") && latest?.lastError))
          resumeNativePipeline(ctx);
      }
    } else if (!dispatch.stale && dispatch.items.length && !dispatch.calls.size) {
      void deliverUserPrompt(
        `Devteam scheduler ${dispatch.marker}: call native task again for remaining assignments.`,
      );
    }
  });
}
