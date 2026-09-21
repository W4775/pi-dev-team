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
import { listJobs, loadJob, newJobId, renderJobList, resolveJobRef } from "./jobs.ts";
import { processChildHost, createChildRunner } from "./child-runner.ts";
import {
  activityLine,
  formatElapsed,
  resolveChildIdleMs,
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
import { isOmpHost } from "./spawn.ts";
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
import { DEFAULT_PROGRESS_EVERY_MS, HANDOFF_ACTIONS } from "./types.ts";
import { findItem, itemsRemaining, nextWave, retryableItems } from "./work.ts";
import { compileScoutNotes, nextScoutWave } from "./scout.ts";
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

  let sessionId = "session";
  let jobId = "session";
  let config: ProjectConfig | null = null;
  let catalog: Catalog | undefined;
  let defaultTools: string[] | undefined;
  let abortChild: (() => void) | undefined;
  let advancing = false;
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
    sessionId: () => jobId,
    taskId: () => childTaskId,
  };

  function statePath(): string {
    if (childStatePath) return childStatePath;
    return runPaths(agentDirSafe(), jobId).json;
  }

  function getCatalog(): Catalog {
    catalog ??= loadCatalog();
    return catalog;
  }

  function persist(run: RunState): RunState {
    if (run.jobId) jobId = run.jobId;
    store.save(run);
    return run;
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
    const loaded = loadJob(agentDirSafe(), picked.jobId) ?? loadRun(picked.file);
    if (!loaded) {
      notify(ctx, `Could not load job ${picked.jobId}.`, "error");
      return;
    }
    abortAllChildren();
    jobId = picked.jobId;
    if (loaded.sessionId) sessionId = loaded.sessionId;
    const attached = persist(
      attachRunForResume({
        ...loaded,
        jobId: picked.jobId,
        cwd: loaded.cwd ?? ctx.cwd,
      }),
    );
    notify(
      ctx,
      `Resumed job ${picked.jobId} at ${attached.stage} (progress kept). ${attached.task || ""}`.trim(),
    );

    const next = persist(step(attached));
    if (next.stage === "done") {
      applyParentTools(next);
      refreshUi(ctx, next);
      notify(ctx, "This job is finished. /devteam status shows the draft commit message.");
      return;
    }

    if (needsParentKick(next.stage)) {
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
    pi.setActiveTools(intersect(all, ["read", "grep", "find", "ls", "glob", "devteam_state"]));
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

  async function runWave(ctx: ExtensionContext, run: RunState, wave: WorkItem[]): Promise<void> {
    const ids = new Set(wave.map((item) => item.id));
    persist({
      ...run,
      pipelineLocked: true,
      workItems: (run.workItems ?? []).map((item) =>
        ids.has(item.id)
          ? { ...item, status: "running" as const, attempts: item.attempts + 1, error: undefined }
          : item,
      ),
    });
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

        if (!itemsRemaining(current.workItems).length) {
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
          persist(enterReview(current));
          return;
        }

        const wave = nextWave(current.workItems, config?.parallel);
        if (!wave.length) {
          persist(
            enterReview({
              ...current,
              lastError:
                current.lastError ?? "Work items were blocked; continuing to review the slice.",
            }),
          );
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
    persist({
      ...run,
      pipelineLocked: true,
      scoutItems: (run.scoutItems ?? []).map((item) =>
        ids.has(item.id)
          ? { ...item, status: "running" as const, attempts: item.attempts + 1, error: undefined }
          : item,
      ),
    });
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
        if (!itemsRemaining(current.scoutItems).length) {
          persist(
            goToStage(
              { ...current, scoutNotes: compileScoutNotes(current.scoutItems, current.scoutNotes) },
              "planner",
            ),
          );
          return;
        }
        const wave = nextScoutWave(current.scoutItems, config?.parallel);
        if (!wave.length) {
          persist(
            goToStage(
              { ...current, scoutNotes: compileScoutNotes(current.scoutItems, current.scoutNotes) },
              "planner",
            ),
          );
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
        return applyCritiqueDecisions(
          latest,
          items.map((item) => ({ id: item.id, decision: "accept" as const })),
        );
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
            await runDelegatedScouts(ctx, run);
            const afterScout = store.load();
            if (!afterScout || afterScout.halted) return;
            run = afterScout;
            continue;
          }
          case "spawn_work": {
            await runDelegatedWork(ctx, run);
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
      if (!childRole && ctx) queuePipelineAdvance(ctx);
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
      const items = ["continue", "list", "status", "stop", "clear", "mockup", "skip"].map(
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
              : "Usage: /devteam <task> | continue | list | status | mockup | skip | stop | clear",
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
              const paths = runPaths(agentDirSafe(), sessionId);
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
          standDown(ctx);
          clearRunFiles(agentDirSafe(), jobId);
          persist(emptyRun(sessionId, "", jobId));
          applyParentTools(store.load());
          if (ctx.hasUI) ctx.ui.notify("Cleared /devteam run state.", "info");
          return;
        }

        if (sub === "stop") {
          const run = store.load();
          standDown(ctx);
          abortParentTurn(ctx);
          if (!run || run.stage === "idle") {
            if (ctx.hasUI) ctx.ui.notify("No /devteam run to stop.", "warning");
            return;
          }
          persist(applyStop(run));
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

        if (sub === "continue" && restText.toLowerCase() === "list") {
          await showJobList(ctx);
          return;
        }

        if (
          (sub === "continue" || sub === "resume") &&
          restText &&
          restText.toLowerCase() !== "list"
        ) {
          if (run?.pipelineLocked || advancing) {
            notify(ctx, "devteam is busy. /devteam stop to abort this step.", "warning");
            return;
          }
          await resumeJob(ctx, restText);
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

        if (sub === "skip" && !restText) {
          if (!run || run.stage === "idle") {
            if (ctx.hasUI) ctx.ui.notify("No /devteam run to skip.", "warning");
            return;
          }
          abortAllChildren();
          abortParentTurn(ctx);
          resetDialogAbort();
          const latest = store.load() ?? run;
          const unlocked = { ...latest, pipelineLocked: false, pendingHandoff: undefined };
          const next = applySkip(unlocked);
          if (
            next.stage === run.stage &&
            next.pauseReason === run.pauseReason &&
            next.spec === run.spec &&
            next.wantMockup === run.wantMockup &&
            next.wantDemo === run.wantDemo
          ) {
            persist(next);
            notify(
              ctx,
              run.halted
                ? "Nothing to skip. /devteam continue resumes this step."
                : "Nothing to skip at this stage.",
            );
            return;
          }
          persist(next);
          notify(ctx, `Skipping: ${run.stage} → ${next.stage}.`);
          if (advancing) return;
          await advancePipeline(ctx, next);
          return;
        }

        const task = trimmed;
        if (run?.pipelineLocked) {
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
      sessionId = sessionIdFromContext(ctx);
      jobId = readCurrentJobId(agentDirSafe(), sessionId) || sessionId;
      config = loadDevteamConfig(ctx.cwd, projectTrusted(ctx), PROJECT_CONFIG_DIRS);
      try {
        defaultTools = pi.getActiveTools();
      } catch {
        defaultTools = undefined;
      }

      if (childRole) return;

      const run = store.load();
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
    standDown();
    abortChild = undefined;
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

  pi.on("before_agent_start", (event, _ctx) => {
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
    if (childRole) return;
    queuePipelineAdvance(ctx as ExtensionContext);
  });

  pi.on("tool_call", (event, ctx) => {
    if (!childRole) {
      const run = store.load();
      if (!run || run.stage === "idle" || run.stage === "done") return;
    }
    const role = currentRole(ctx);
    const current = store.load();
    const service = serviceByName(
      current?.stack?.services,
      childServiceName ?? current?.currentService,
    );
    const assigned =
      childRole === "scout" ? undefined : findItem(current?.workItems, childTaskId)?.files;
    const writePath = isWriteTool(event.toolName) ? writePathFromInput(event.input) : undefined;
    if (writePath) {
      const gate = gateWrite(role, writePath, ctx.cwd, config ?? undefined, service, assigned);
      if (gate.block) return { block: true, reason: gate.reason };
    }
    if (isToolCallEventType("bash", event)) {
      const gate = gateBash(
        role,
        event.input.command,
        config ?? undefined,
        current?.stack?.services,
      );
      if (gate.block) return { block: true, reason: gate.reason };
    }
  });
}
