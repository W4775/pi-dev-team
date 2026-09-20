import { hasBlockFindings, layerFromFile } from "./state.ts";
import { isMultiService, serviceQueueForLayer, servicesForFiles } from "./services.ts";
import {
  applyServiceDefaults,
  failedItems,
  itemsForLayer,
  itemsRemaining,
  layersFromItems,
  normalizeWorkItems,
  retryableItems,
} from "./work.ts";
import { compileScoutNotes, retryableScouts } from "./scout.ts";
import { formatCritiqueForPlanner, parseCritiqueItems, rejectUndecided } from "./critique.ts";
import type {
  CritiqueItem,
  Finding,
  HandoffAction,
  ImplementorLayer,
  PauseReason,
  ProjectConfig,
  RoleName,
  RunState,
  Stage,
  UiSurface,
  WorkItem,
} from "./types.ts";
import {
  IMPLEMENTOR_LAYERS,
  MAX_DEMO_ROUNDS,
  MAX_DESIGN_REJECTS,
  MAX_FIX_ROUNDS,
} from "./types.ts";

const LAYER_SET = new Set<string>(IMPLEMENTOR_LAYERS);

export function layersListed(layersNeeded: string[] | undefined): ImplementorLayer[] {
  return (layersNeeded ?? [])
    .map((item) => item.trim().toLowerCase())
    .filter((item): item is ImplementorLayer => LAYER_SET.has(item));
}

function orderedLayers(present: Iterable<ImplementorLayer>): ImplementorLayer[] {
  const set = new Set(present);
  return IMPLEMENTOR_LAYERS.filter((layer) => set.has(layer));
}

function layerNote(
  run: Pick<RunState, "databaseNotes" | "backendNotes" | "frontendNotes" | "generalNotes">,
  layer: ImplementorLayer,
): string | undefined {
  if (layer === "database") return run.databaseNotes;
  if (layer === "backend") return run.backendNotes;
  if (layer === "frontend") return run.frontendNotes;
  return run.generalNotes;
}

function layersFromFiles(files: RunState["filesToChange"]): ImplementorLayer[] {
  return IMPLEMENTOR_LAYERS.filter((layer) => (files?.[layer] ?? []).length > 0);
}

function layersFromNotes(
  run: Pick<RunState, "databaseNotes" | "backendNotes" | "frontendNotes" | "generalNotes">,
): ImplementorLayer[] {
  return IMPLEMENTOR_LAYERS.filter((layer) => Boolean(layerNote(run, layer)?.trim()));
}

/**
 * Layers this change actually needs. Empty notes/files for a layer mean skip
 * that implementor, even if the repo has that stack.
 */
export function implementorAllowList(
  run: Pick<
    RunState,
    | "layersNeeded"
    | "filesToChange"
    | "databaseNotes"
    | "backendNotes"
    | "frontendNotes"
    | "generalNotes"
  >,
): ImplementorLayer[] {
  const listed = layersListed(run.layersNeeded);
  const fromNotes = layersFromNotes(run);
  const fromFiles = layersFromFiles(run.filesToChange);
  const briefed = orderedLayers([...fromNotes, ...fromFiles]);
  if (briefed.length && listed.length) {
    const both = orderedLayers(briefed.filter((layer) => listed.includes(layer)));
    return both.length ? both : briefed;
  }
  if (briefed.length) return briefed;
  return orderedLayers(listed);
}

/** Queue of implementors to spawn. Falls back to general only when nothing was specified. */
export function neededImplementors(
  run: Pick<
    RunState,
    | "workItems"
    | "layersNeeded"
    | "filesToChange"
    | "databaseNotes"
    | "backendNotes"
    | "frontendNotes"
    | "generalNotes"
  >,
): ImplementorLayer[] {
  const fromItems = layersFromItems(run.workItems);
  const allow = implementorAllowList(run);
  if (fromItems.length) {
    if (allow.length) {
      const clipped = orderedLayers(fromItems.filter((layer) => allow.includes(layer)));
      return clipped.length ? clipped : fromItems;
    }
    return fromItems;
  }
  if (allow.length) return allow;
  return ["general"];
}

export function parseLayers(layersNeeded: string[] | undefined): ImplementorLayer[] {
  const requested = orderedLayers(layersListed(layersNeeded));
  return requested.length > 0 ? requested : ["general"];
}

export function uiSurfaceOf(run: Pick<RunState, "uiSurface" | "stack">): UiSurface {
  return run.uiSurface ?? run.stack?.uiSurface ?? "none";
}

export function shouldOfferMockup(
  run: Pick<RunState, "layersNeeded" | "uiSurface" | "stack">,
): boolean {
  const listed = layersListed(run.layersNeeded);
  return listed.includes("frontend") && uiSurfaceOf(run) === "web";
}
export function shouldOfferDemo(
  run: Pick<RunState, "layersNeeded" | "uiSurface" | "stack" | "wantDemo">,
): boolean {
  if (run.wantDemo !== true) return false;
  return shouldOfferMockup(run);
}

export function proceedAfterLint(run: RunState): RunState {
  if (shouldOfferDemo(run)) {
    return goToStage(
      stamp(run, { pauseReason: undefined, demoRound: (run.demoRound ?? 0) + 1 }),
      "demo",
      { currentRole: "demo" },
    );
  }
  if (run.wantDemo === undefined && shouldOfferMockup(run)) {
    return goToStage(stamp(run, { pauseReason: undefined }), "demo_opt_in");
  }
  return goToStage(stamp(run, { pauseReason: undefined }), "commit_message", {
    currentRole: "commit_message",
  });
}

export function nextAfterPlanCritic(run: RunState): Stage {
  return proceedAfterPlan(run).stage;
}

/** After the spec is approved, ask for a mockup the same way lint asks for a demo. */
export function proceedAfterPlan(run: RunState): RunState {
  if (run.wantMockup === true && shouldOfferMockup(run)) {
    return goToStage(stamp(run, { pauseReason: undefined }), "designer");
  }
  if (run.wantMockup === undefined && shouldOfferMockup(run)) {
    return goToStage(stamp(run, { pauseReason: undefined }), "mockup_opt_in");
  }
  return startImplementation(
    stamp(run, { wantMockup: run.wantMockup === true, pauseReason: undefined }),
  );
}

export function parseYesNo(text: string): boolean | null {
  const t = text.trim().toLowerCase();
  if (["y", "yes", "yeah", "yep", "sure", "ok", "okay"].includes(t)) return true;
  if (["n", "no", "nope", "nah", "skip"].includes(t)) return false;
  return null;
}

export function isPaused(run: RunState): boolean {
  if (run.halted) return true;
  if (run.pipelineLocked) return false;
  return run.stage === "plan_review";
}

/** Turn a leftover idle gate into the next running stage. */
export function autoResumeGate(run: RunState): RunState {
  if (run.halted || run.pipelineLocked) return run;
  if (run.stage === "build_it_pause") return applyContinue(run);
  if (run.pauseReason === "plan_rewrite") return applyContinue(run);
  if (
    run.stage === "implement" &&
    failedItems(run.workItems).length &&
    !itemsRemaining(run.workItems).length
  ) {
    return retryableItems(run.workItems).length ? applyContinue(run) : applySkip(run);
  }
  return run;
}

function stamp(run: RunState, patch: Partial<RunState>): RunState {
  return { ...run, ...patch, updatedAt: new Date().toISOString() };
}

export function pauseForStage(stage: Stage): PauseReason | undefined {
  if (stage === "plan_review") return "plan_review";
  if (stage === "mockup_opt_in") return "mockup_opt_in";
  if (stage === "demo_opt_in") return "demo_opt_in";
  if (stage === "demo_review") return "demo_review";
  if (stage === "build_it_pause") return "build_it";
  return undefined;
}

export function goToStage(run: RunState, stage: Stage, extra?: Partial<RunState>): RunState {
  const pauseReason = extra && "pauseReason" in extra ? extra.pauseReason : pauseForStage(stage);
  const defaultInteractive =
    stage === "planner" ? "planner" : stage === "designer" ? "designer" : undefined;
  const interactiveRole =
    extra && "interactiveRole" in extra ? extra.interactiveRole : defaultInteractive;
  return stamp(run, {
    ...extra,
    stage,
    pauseReason,
    interactiveRole,
    currentRole: extra?.currentRole ?? interactiveRole,
    pipelineLocked: extra?.pipelineLocked ?? false,
    halted: extra && "halted" in extra ? extra.halted : false,
    pendingHandoff: extra && "pendingHandoff" in extra ? extra.pendingHandoff : undefined,
  });
}

export function applyStop(run: RunState): RunState {
  return stamp(run, {
    halted: true,
    pipelineLocked: false,
    pendingHandoff: undefined,
    currentStatus: "stopped by user",
    lastError: undefined,
  });
}

export function applySkip(run: RunState): RunState {
  if (run.pipelineLocked) return run;
  const current = run.halted
    ? stamp(run, { halted: false, lastError: undefined, currentStatus: undefined })
    : run;

  if (current.pauseReason === "plan_rewrite") {
    const restored = stamp(current, {
      spec: current.originalSpec ?? current.spec,
      layersNeeded: current.originalLayersNeeded ?? current.layersNeeded,
      planRewriteResolved: true,
      pauseReason: undefined,
    });
    return proceedAfterPlan(restored);
  }

  if (current.stage === "plan_critic" || current.stage === "plan_review") {
    return proceedAfterPlan(stampCritique(current, rejectUndecided(critiqueItems(current)), true));
  }

  if (current.stage === "planner" && current.spec?.trim()) {
    return proceedAfterPlan(current);
  }

  if (current.stage === "mockup_opt_in") {
    return proceedAfterPlan(stamp(current, { wantMockup: false }));
  }
  if (current.stage === "demo_opt_in") {
    return proceedAfterLint(stamp(current, { wantDemo: false }));
  }
  if (current.stage === "demo_review") {
    return goToStage(stamp(current, { pauseReason: undefined }), "commit_message", {
      currentRole: "commit_message",
    });
  }

  if (current.pauseReason === "design_reject_max") {
    return startImplementation(stamp(current, { pauseReason: undefined, wantMockup: true }));
  }

  if (current.stage === "designer" || current.stage === "design_critic") {
    return proceedAfterPlan(stamp(current, { wantMockup: false }));
  }

  if (current.stage === "build_it_pause") {
    return startImplementation(current);
  }

  if (current.stage === "scout_orchestrate" || current.stage === "scout") {
    return goToStage(
      stamp(current, { scoutNotes: compileScoutNotes(current.scoutItems, current.scoutNotes) }),
      "planner",
    );
  }

  if (current.stage === "orchestrate") {
    return startSequentialImplementation(current);
  }

  if (current.stage === "implement") {
    return enterReview(stamp(current, { workItems: markRemainingSkipped(current.workItems) }));
  }

  if (
    current.stage === "reviewer" ||
    current.stage === "fix_review" ||
    current.pauseReason === "fix_review_max"
  ) {
    return afterReviewPass(stamp(current, { pauseReason: undefined }));
  }

  if (
    current.stage === "tester" ||
    current.stage === "fix_test" ||
    current.pauseReason === "fix_test_max"
  ) {
    return goToStage(stamp(current, { pauseReason: undefined }), "linter", {
      currentRole: "linter",
    });
  }

  if (
    current.stage === "linter" ||
    current.stage === "fix_lint" ||
    current.pauseReason === "fix_lint_max"
  ) {
    return proceedAfterLint(stamp(current, { pauseReason: undefined }));
  }

  return current === run ? run : current;
}

function withLayerServices(
  run: RunState,
  layer: ImplementorLayer | undefined,
): Pick<RunState, "serviceQueue" | "serviceIndex" | "currentService"> {
  const queue = serviceQueueForLayer(run.stack?.services, layer);
  return {
    serviceQueue: queue,
    serviceIndex: 0,
    currentService: queue[0],
  };
}

export function filesForLayer(run: RunState, layer: ImplementorLayer | undefined): string[] {
  if (!layer) return [];
  const fromItems = itemsForLayer(run.workItems, layer).flatMap((item) => item.files);
  const unique = [...new Set(fromItems.filter(Boolean))];
  if (unique.length) return unique;
  return run.filesToChange?.[layer] ?? [];
}

export function reviewScope(run: RunState): {
  reviewLayer?: ImplementorLayer;
  reviewFiles: string[];
} {
  if (run.reviewLayer) {
    return { reviewLayer: run.reviewLayer, reviewFiles: filesForLayer(run, run.reviewLayer) };
  }
  const fromItems = [
    ...new Set((run.workItems ?? []).flatMap((item) => item.files).filter(Boolean)),
  ];
  if (fromItems.length) return { reviewFiles: fromItems };
  const fromListed = [
    ...new Set(IMPLEMENTOR_LAYERS.flatMap((layer) => run.filesToChange?.[layer] ?? [])),
  ];
  return { reviewFiles: fromListed };
}

function markRemainingSkipped(items: RunState["workItems"]): RunState["workItems"] {
  if (!items?.length) return items;
  return items.map((item) =>
    item.status === "pending" || item.status === "running"
      ? { ...item, status: "done" as const, summary: item.summary ?? "skipped by user" }
      : item,
  );
}

/** After the slice is implemented, review the whole diff once. */
export function enterReview(run: RunState): RunState {
  return goToStage(
    stamp(run, {
      reviewFindings: undefined,
      lastError: undefined,
      reviewLayer: undefined,
    }),
    "reviewer",
    {
      currentRole: "reviewer",
      fixRound: { ...run.fixRound, review: 0 },
    },
  );
}

/** After slice review passes (or is skipped/capped), start tester. */
export function afterReviewPass(run: RunState): RunState {
  return goToStage(stamp(run, { pauseReason: undefined, reviewLayer: undefined }), "tester", {
    currentRole: "tester",
  });
}

const FILE_EXT =
  /\b(?:[\w.-]+\/)*[\w.-]+\.(?:ts|tsx|js|jsx|mjs|cjs|mts|cts|go|py|rs|cs|vue|svelte|css|scss|html|sql|prisma|json|toml|yml|yaml|md|graphql|proto)\b/i;
const SRC_PATH =
  /(?:^|[\s`'"(])(?:\.\/)?(?:src|app|lib|pkg|internal|cmd|services|backend|frontend|server|client|packages|apps)\/[\w./-]+/;

/** True when the task already points at a concrete file or src-tree path. */
export function taskNamesAFile(task: string | undefined): boolean {
  const text = task?.trim() ?? "";
  if (!text) return false;
  if (FILE_EXT.test(text)) return true;
  return SRC_PATH.test(text);
}

export function shouldSkipScout(run: Pick<RunState, "task" | "stack">): boolean {
  if (isMultiService(run.stack?.services)) return false;
  return taskNamesAFile(run.task);
}

export function startScouting(run: RunState): RunState {
  if (shouldSkipScout(run)) {
    return goToStage(run, "planner", {
      currentRole: "planner",
      pauseReason: undefined,
    });
  }
  return goToStage(run, "scout_orchestrate", {
    currentRole: "planner_orchestrator",
    pauseReason: undefined,
  });
}

export function shouldSkipImplementationOrchestrator(
  run: Pick<
    RunState,
    | "workItems"
    | "layersNeeded"
    | "filesToChange"
    | "databaseNotes"
    | "backendNotes"
    | "frontendNotes"
    | "generalNotes"
  >,
): boolean {
  if (run.workItems?.length) return true;
  const layers = neededImplementors({ ...run, workItems: undefined });
  if (layers.length <= 1) return true;
  return layers.every((layer) => (run.filesToChange?.[layer] ?? []).length > 0);
}

export function workItemsFromPlan(run: RunState): WorkItem[] {
  const layers = neededImplementors({ ...run, workItems: undefined });
  return normalizeWorkItems(
    layers.map((layer) => {
      const details = layerNote(run, layer)?.trim();
      const heading = details
        ?.split("\n")
        .find((line) => line.trim())
        ?.trim();
      return {
        id: `${layer}-slice`,
        layer,
        title: heading?.slice(0, 80) || `${layer} work`,
        details: details || undefined,
        files: [...(run.filesToChange?.[layer] ?? [])],
        dependsOn: [],
        status: "pending",
      };
    }),
  );
}

export function startImplementation(run: RunState): RunState {
  const queue = neededImplementors(run);
  if (shouldSkipImplementationOrchestrator(run)) {
    const prepared = applyServiceDefaults(
      run.workItems?.length ? run.workItems : workItemsFromPlan(run),
      run.stack?.services,
    );
    if (!prepared.length) return startSequentialImplementation(run);
    const nextQueue = neededImplementors({ ...run, workItems: prepared });
    return goToStage(stamp(run, { workItems: prepared }), "implement", {
      implementorQueue: nextQueue.length ? nextQueue : queue,
      implementorIndex: 0,
      currentRole: prepared[0]?.layer ?? queue[0],
      pauseReason: undefined,
    });
  }
  return goToStage(run, "orchestrate", {
    implementorQueue: queue,
    implementorIndex: 0,
    currentRole: "orchestrator",
    pauseReason: undefined,
  });
}

export function startSequentialImplementation(run: RunState): RunState {
  const queue = neededImplementors({ ...run, workItems: undefined });
  return goToStage(run, "implement", {
    implementorQueue: queue,
    implementorIndex: 0,
    currentRole: queue[0],
    pauseReason: undefined,
    workItems: undefined,
    ...withLayerServices(run, queue[0]),
  });
}

export function stageForRole(role: RoleName | undefined): Stage | undefined {
  if (!role) return undefined;
  if (
    role === "planner" ||
    role === "designer" ||
    role === "plan_critic" ||
    role === "design_critic" ||
    role === "reviewer" ||
    role === "tester" ||
    role === "linter" ||
    role === "demo" ||
    role === "commit_message"
  ) {
    return role;
  }
  if (role === "database" || role === "backend" || role === "frontend" || role === "general") {
    return "implement";
  }
  if (role === "planner_orchestrator") return "scout_orchestrate";
  if (role === "scout") return "scout";
  if (role === "orchestrator") return "orchestrate";
  return undefined;
}

export function attachRunForResume(run: RunState): RunState {
  const interactiveRole =
    run.stage === "planner"
      ? "planner"
      : run.stage === "designer"
        ? "designer"
        : run.interactiveRole;
  return stamp(run, {
    pipelineLocked: false,
    pendingHandoff: undefined,
    lastError: undefined,
    interactiveRole,
    currentRole: run.currentRole ?? interactiveRole,
  });
}

export function continueHint(run: RunState): string {
  if (run.pauseReason === "fix_review_max") {
    return "Review did not pass after 3 fix rounds. /devteam continue proceeds to the tester; /devteam skip does the same.";
  }
  if (run.pauseReason === "fix_test_max") {
    return "Tests did not pass after 3 fix rounds. /devteam continue proceeds to the linter; /devteam skip does the same.";
  }
  if (run.pauseReason === "fix_lint_max") {
    return "Lint did not pass after 3 fix rounds. /devteam continue proceeds; /devteam skip does the same.";
  }
  if (run.pauseReason === "design_reject_max") {
    return "Design critic rejected the mockup twice. /devteam continue starts implementation anyway; /devteam skip does the same.";
  }
  if (run.halted) {
    return `Stopped at ${run.stage}. /devteam continue resumes this step; /devteam skip skips it.`;
  }
  if (run.pipelineLocked) return "devteam is busy. /devteam stop to abort this step.";
  if (run.stage === "idle") return "No /devteam run to continue.";
  if (run.stage === "done") return "This run is finished. Start a new task with /devteam <task>.";
  if (run.stage === "plan_review") {
    return "Review each critic suggestion (Accept / Reject / Other), or /devteam skip to keep the current spec.";
  }
  if (run.stage === "implement" && failedItems(run.workItems).length) {
    return retryableItems(run.workItems).length
      ? "A work item failed. /devteam continue retries it; /devteam skip sends remaining work to the reviewer."
      : "Work items failed twice. /devteam continue or /devteam skip sends this slice to the reviewer.";
  }
  if (run.stage === "planner" && !run.spec?.trim()) {
    return "Planner is still in this chat. Answer with the ask picker until a spec is stored, then it will hand off to the plan critic.";
  }
  if (run.stage === "designer" && !run.mockupPath) {
    return "Designer is still in this chat. Wait for a mockup, or /devteam skip to implement without one.";
  }
  if (run.stage === "mockup_opt_in") {
    return "Want an HTML mockup before implementation? Answer yes or no, or /devteam skip to implement without one.";
  }
  if (run.stage === "demo_opt_in") {
    return "Answer yes to watch a live demo, or /devteam skip to finish without one.";
  }
  if (run.stage === "demo_review") {
    return "Accept the demo, or request changes to loop back to the planner (max 2 demos).";
  }
  return `Nothing to continue at stage ${run.stage}. Try /devteam status.`;
}

export function applyContinue(run: RunState): RunState {
  if (run.pipelineLocked) return run;
  const current = run.halted
    ? stamp(run, { halted: false, lastError: undefined, currentStatus: undefined })
    : run;

  if (current.pauseReason === "fix_review_max") {
    return afterReviewPass(stamp(current, { pauseReason: undefined }));
  }
  if (current.pauseReason === "fix_test_max") {
    return goToStage(stamp(current, { pauseReason: undefined }), "linter", {
      currentRole: "linter",
    });
  }
  if (current.pauseReason === "fix_lint_max") {
    return proceedAfterLint(stamp(current, { pauseReason: undefined }));
  }
  if (current.pauseReason === "design_reject_max") {
    return startImplementation(stamp(current, { pauseReason: undefined, wantMockup: true }));
  }

  if (
    run.halted &&
    (needsParentKick(current.stage) ||
      needsIsolatedChild(current.stage) ||
      needsUserReview(current.stage))
  ) {
    return current;
  }

  if (current.stage === "mockup_opt_in") {
    return goToStage(stamp(current, { wantMockup: true }), "designer");
  }
  if (current.stage === "demo_opt_in") {
    return goToStage(stamp(current, { wantDemo: true }), "demo", { currentRole: "demo" });
  }

  if (current.pauseReason === "plan_rewrite") {
    const accepted = stamp(current, { planRewriteResolved: true, pauseReason: undefined });
    return proceedAfterPlan(accepted);
  }

  if (current.stage === "build_it_pause") {
    return startImplementation(current);
  }

  if (current.stage === "plan_review") {
    return stamp(current, { lastError: undefined });
  }

  if (current.stage === "scout" && retryableScouts(current.scoutItems).length) {
    const ids = new Set(retryableScouts(current.scoutItems).map((item) => item.id));
    return stamp(current, {
      pipelineLocked: false,
      lastError: undefined,
      scoutItems: (current.scoutItems ?? []).map((item) =>
        ids.has(item.id) ? { ...item, status: "pending", error: undefined } : item,
      ),
    });
  }
  if (current.stage === "scout" || current.stage === "scout_orchestrate") {
    return stamp(current, { lastError: undefined, pipelineLocked: false });
  }

  if (current.stage === "implement") {
    const retry = retryableItems(current.workItems);
    if (retry.length) {
      const ids = new Set(retry.map((item) => item.id));
      return stamp(current, {
        pipelineLocked: false,
        lastError: undefined,
        workItems: (current.workItems ?? []).map((item) =>
          ids.has(item.id) ? { ...item, status: "pending", error: undefined } : item,
        ),
      });
    }
    if (failedItems(current.workItems).length) {
      return enterReview(current);
    }
  }

  if (current.stage === "error") {
    const stage = stageForRole(current.currentRole) ?? "plan_critic";
    return goToStage(stamp(current, { lastError: undefined }), stage, {
      currentRole: current.currentRole,
    });
  }

  if (current.stage === "planner") {
    if (current.spec?.trim() && !current.planCritique?.reviewed)
      return applyHandoff(current, "plan_ready");
    return current === run ? run : current;
  }

  if (current.stage === "designer") {
    if (current.mockupPath) return applyHandoff(current, "design_ready");
    return current === run ? run : current;
  }

  if (needsIsolatedChild(current.stage)) {
    return stamp(current, {
      lastError: undefined,
      pendingHandoff: undefined,
      pipelineLocked: false,
    });
  }

  return current === run ? run : current;
}

export function acceptMockupChoice(run: RunState, want: boolean): RunState {
  if (run.stage !== "mockup_opt_in") return run;
  return want ? applyContinue(run) : applySkip(run);
}

export function acceptDemoChoice(run: RunState, want: boolean): RunState {
  if (run.stage !== "demo_opt_in") return run;
  return want ? applyContinue(run) : applySkip(run);
}

export function applyDemoReview(run: RunState, accepted: boolean, feedback?: string): RunState {
  if (run.stage !== "demo_review") return run;
  if (accepted || (run.demoRound ?? 0) >= MAX_DEMO_ROUNDS) {
    return goToStage(stamp(run, { pauseReason: undefined }), "commit_message", {
      currentRole: "commit_message",
    });
  }
  return goToStage(
    stamp(run, { pauseReason: undefined, demoFeedback: feedback?.trim() || undefined }),
    "planner",
  );
}

export function canFix(run: RunState, kind: "review" | "test" | "lint"): boolean {
  return run.fixRound[kind] < MAX_FIX_ROUNDS;
}

function parkAtCap(run: RunState, pauseReason: PauseReason, lastError: string): RunState {
  return stamp(run, {
    pauseReason,
    halted: true,
    pipelineLocked: false,
    pendingHandoff: undefined,
    lastError,
    currentStatus: lastError,
  });
}

export function filesFromFindings(findings: Finding[] | undefined): string[] {
  const files: string[] = [];
  for (const finding of findings ?? []) {
    if (finding.severity !== "block") continue;
    if (finding.files?.length) files.push(...finding.files);
  }
  return [...new Set(files)];
}

export function mapBlockedFilesToImplementors(
  files: string[],
  run: Pick<RunState, "filesToChange">,
  globs?: ProjectConfig["paths"],
): ImplementorLayer[] {
  const seen = new Set<ImplementorLayer>();
  for (const file of files) {
    const layer = layerFromFile(file, run.filesToChange, globs) ?? "general";
    seen.add(layer);
  }
  const ordered = IMPLEMENTOR_LAYERS.filter((layer) => seen.has(layer));
  return ordered.length > 0 ? [...ordered] : ["general"];
}

export function activeRole(run: RunState): RoleName | undefined {
  if (run.stage === "scout_orchestrate") return "planner_orchestrator";
  if (run.stage === "scout") return "scout";
  if (run.stage === "orchestrate") return "orchestrator";
  if (
    run.stage === "implement" ||
    run.stage === "fix_review" ||
    run.stage === "fix_test" ||
    run.stage === "fix_lint"
  ) {
    return run.implementorQueue[run.implementorIndex] ?? run.currentRole;
  }
  if (run.stage === "planner") return "planner";
  if (run.stage === "plan_critic") return "plan_critic";
  if (run.stage === "designer") return "designer";
  if (run.stage === "design_critic") return "design_critic";
  if (run.stage === "reviewer") return "reviewer";
  if (run.stage === "tester") return "tester";
  if (run.stage === "linter") return "linter";
  if (run.stage === "demo") return "demo";
  if (run.stage === "commit_message") return "commit_message";
  return run.currentRole;
}

function startFix(
  run: RunState,
  stage: "fix_review" | "fix_test" | "fix_lint",
  kind: "review" | "test" | "lint",
  files: string[],
  globs?: ProjectConfig["paths"],
): RunState {
  const mapped = mapBlockedFilesToImplementors(files, run, globs);
  const queue = kind === "review" && run.reviewLayer ? [run.reviewLayer] : mapped;
  const layer = queue[0];
  const serviceQueue =
    layer && files.length
      ? servicesForFiles(run.stack?.services, files, layer)
      : serviceQueueForLayer(run.stack?.services, layer);
  return goToStage(run, stage, {
    implementorQueue: queue,
    implementorIndex: 0,
    currentRole: queue[0],
    reviewLayer: kind === "review" ? (run.reviewLayer ?? layer) : run.reviewLayer,
    fixRound: { ...run.fixRound, [kind]: run.fixRound[kind] + 1 },
    pauseReason: undefined,
    serviceQueue,
    serviceIndex: 0,
    currentService: serviceQueue[0],
  });
}

function nextService(run: RunState): RunState | undefined {
  const queue = run.serviceQueue ?? [];
  const nextIndex = (run.serviceIndex ?? 0) + 1;
  if (nextIndex >= queue.length) return undefined;
  return stamp(run, {
    serviceIndex: nextIndex,
    currentService: queue[nextIndex],
    pendingHandoff: undefined,
    pipelineLocked: false,
  });
}

function advanceQueue(run: RunState, nextStage: Stage): RunState {
  const nextIndex = run.implementorIndex + 1;
  if (nextIndex < run.implementorQueue.length) {
    const currentRole = run.implementorQueue[nextIndex];
    return stamp(run, {
      implementorIndex: nextIndex,
      currentRole,
      pendingHandoff: undefined,
      pipelineLocked: false,
      ...withLayerServices(run, currentRole),
    });
  }
  return goToStage(run, nextStage);
}

export function applyHandoff(
  run: RunState,
  action: HandoffAction,
  globs?: ProjectConfig["paths"],
): RunState {
  const cleared = stamp(run, { pendingHandoff: undefined });

  switch (action) {
    case "plan_ready":
      if (cleared.planCritique?.reviewed) {
        return proceedAfterPlan(cleared);
      }
      return goToStage(
        stamp(cleared, {
          originalSpec: cleared.spec,
          originalLayersNeeded: cleared.layersNeeded,
        }),
        "plan_critic",
        { currentRole: "plan_critic", interactiveRole: undefined },
      );

    case "critic_revise":
      if (cleared.stage === "plan_critic" || cleared.currentRole === "plan_critic") {
        return goToStage(stampCritique(cleared, critiqueItems(cleared), false), "plan_review");
      }
      if (cleared.stage === "design_critic" || cleared.currentRole === "design_critic") {
        const rejects = cleared.designRejectCount + 1;
        const counted = stamp(cleared, { designRejectCount: rejects });
        if (rejects >= MAX_DESIGN_REJECTS) {
          return parkAtCap(
            stamp(counted, { wantMockup: true }),
            "design_reject_max",
            "Design critic rejected the mockup twice. /devteam continue starts implementation; /devteam skip does the same.",
          );
        }
        return goToStage(counted, "designer");
      }
      return cleared;

    case "critic_approve":
      if (cleared.stage === "plan_critic" || cleared.currentRole === "plan_critic") {
        return proceedAfterPlan(cleared);
      }
      if (cleared.stage === "design_critic" || cleared.currentRole === "design_critic") {
        return startImplementation(cleared);
      }
      return cleared;

    case "design_ready":
      return goToStage(cleared, "design_critic", { currentRole: "design_critic" });

    case "scout_planned": {
      const items = cleared.scoutItems ?? [];
      if (!items.length) return goToStage(cleared, "planner");
      return goToStage(cleared, "scout", { currentRole: "scout" });
    }

    case "scout_done": {
      if (itemsRemaining(cleared.scoutItems).length) {
        return stamp(cleared, { pipelineLocked: false });
      }
      return goToStage(
        stamp(cleared, { scoutNotes: compileScoutNotes(cleared.scoutItems, cleared.scoutNotes) }),
        "planner",
      );
    }

    case "work_planned": {
      const allow = implementorAllowList(cleared);
      const prepared = applyServiceDefaults(cleared.workItems ?? [], cleared.stack?.services);
      const workItems = allow.length
        ? prepared.filter((item) => allow.includes(item.layer))
        : prepared;
      const withServices = stamp(cleared, { workItems });
      if (!withServices.workItems?.length) {
        return startSequentialImplementation(withServices);
      }
      const queue = neededImplementors(withServices);
      return goToStage(withServices, "implement", {
        implementorQueue: queue,
        implementorIndex: 0,
        currentRole: queue[0],
      });
    }

    case "implementor_done": {
      if (cleared.stage === "implement" && (cleared.workItems?.length ?? 0) > 0) {
        if (itemsRemaining(cleared.workItems).length) {
          return stamp(cleared, { pipelineLocked: false });
        }
        if (retryableItems(cleared.workItems).length) {
          return stamp(cleared, { pipelineLocked: false });
        }
        return enterReview(cleared);
      }
      const more = nextService(cleared);
      if (more) return more;
      if (cleared.stage === "fix_review") return advanceQueue(cleared, "reviewer");
      if (cleared.stage === "fix_test") return advanceQueue(cleared, "tester");
      if (cleared.stage === "fix_lint") return advanceQueue(cleared, "linter");
      if (cleared.stage === "implement") {
        const nextIndex = cleared.implementorIndex + 1;
        if (nextIndex < cleared.implementorQueue.length) {
          const currentRole = cleared.implementorQueue[nextIndex];
          return stamp(cleared, {
            implementorIndex: nextIndex,
            currentRole,
            pendingHandoff: undefined,
            pipelineLocked: false,
            ...withLayerServices(cleared, currentRole),
          });
        }
      }
      return enterReview(cleared);
    }

    case "qa_pass":
      if (cleared.stage === "reviewer" || cleared.stage === "fix_review") {
        return afterReviewPass(cleared);
      }
      if (cleared.stage === "tester" || cleared.stage === "fix_test") {
        return goToStage(cleared, "linter", { currentRole: "linter" });
      }
      if (cleared.stage === "linter" || cleared.stage === "fix_lint") {
        return proceedAfterLint(stamp(cleared, { pauseReason: undefined }));
      }
      if (cleared.stage === "demo") {
        return goToStage(stamp(cleared, { pauseReason: undefined }), "demo_review");
      }
      return goToStage(cleared, "commit_message", { currentRole: "commit_message" });

    case "qa_fail": {
      if (cleared.stage === "reviewer" || cleared.stage === "fix_review") {
        if (!canFix(cleared, "review")) {
          return parkAtCap(
            cleared,
            "fix_review_max",
            "Review did not pass after 3 fix rounds. /devteam continue proceeds to the tester; /devteam skip does the same.",
          );
        }
        return startFix(
          cleared,
          "fix_review",
          "review",
          filesFromFindings(cleared.reviewFindings),
          globs,
        );
      }
      if (cleared.stage === "tester" || cleared.stage === "fix_test") {
        if (!canFix(cleared, "test")) {
          return parkAtCap(
            cleared,
            "fix_test_max",
            "Tests did not pass after 3 fix rounds. /devteam continue proceeds to the linter; /devteam skip does the same.",
          );
        }
        return startFix(
          cleared,
          "fix_test",
          "test",
          filesFromFindings(cleared.reviewFindings),
          globs,
        );
      }
      if (!canFix(cleared, "lint")) {
        return parkAtCap(
          cleared,
          "fix_lint_max",
          "Lint did not pass after 3 fix rounds. /devteam continue proceeds; /devteam skip does the same.",
        );
      }
      return startFix(
        cleared,
        "fix_lint",
        "lint",
        filesFromFindings(cleared.reviewFindings),
        globs,
      );
    }

    case "commit_drafted":
      return goToStage(cleared, "done", { currentRole: undefined, interactiveRole: undefined });

    default:
      return cleared;
  }
}

export function needsUserReview(stage: Stage): boolean {
  return stage === "plan_review";
}

export function needsIsolatedChild(stage: Stage): boolean {
  return (
    stage === "scout_orchestrate" ||
    stage === "scout" ||
    stage === "plan_critic" ||
    stage === "design_critic" ||
    stage === "orchestrate" ||
    stage === "implement" ||
    stage === "fix_review" ||
    stage === "fix_test" ||
    stage === "fix_lint" ||
    stage === "reviewer" ||
    stage === "tester" ||
    stage === "linter" ||
    stage === "demo" ||
    stage === "commit_message"
  );
}

export function needsParentKick(stage: Stage): boolean {
  return stage === "planner" || stage === "designer";
}

function critiqueItems(run: RunState): CritiqueItem[] {
  if (run.planCritique?.items?.length) return run.planCritique.items;
  return parseCritiqueItems(run.planCritique?.notes);
}

function stampCritique(run: RunState, items: CritiqueItem[], reviewed: boolean): RunState {
  const notes = reviewed ? formatCritiqueForPlanner(items) : (run.planCritique?.notes ?? "");
  return stamp(run, {
    planCritique: {
      notes: notes || run.planCritique?.notes || "",
      replacedScope: run.planCritique?.replacedScope ?? false,
      items,
      reviewed,
    },
    pauseReason: undefined,
  });
}

export function applyCritiqueDecisions(
  run: RunState,
  decisions: Array<{ id: string; decision: "accept" | "reject"; userNote?: string }>,
): RunState {
  const byId = new Map(decisions.map((entry) => [entry.id, entry]));
  const items = critiqueItems(run).map((item) => {
    const hit = byId.get(item.id);
    return hit
      ? { ...item, decision: hit.decision, userNote: hit.userNote }
      : { ...item, decision: item.decision ?? "reject" };
  });
  const next = stampCritique(run, items, true);
  if (!items.some((item) => item.decision === "accept")) return proceedAfterPlan(next);
  return goToStage(next, "planner");
}

export function stackLayerForRole(
  role: RoleName | undefined,
): "frontend" | "backend" | "database" | "tester" | "general" | undefined {
  if (role === "frontend" || role === "backend" || role === "database" || role === "general") {
    return role;
  }
  if (role === "tester") return "tester";
  if (role === "orchestrator") return "general";
  if (role === "planner_orchestrator" || role === "scout") return "general";
  if (role === "reviewer") return "general";
  return undefined;
}

function notesLookLikeApproval(notes: string | undefined): boolean {
  const text = notes?.trim() ?? "";
  if (!text) return false;
  return /^(approved|lgtm|looks good|no issues|no holes)\b/i.test(text) && text.length < 80;
}

function hasNotebookText(value: string | undefined): boolean {
  return Boolean(value?.trim());
}

function layerNotesFor(
  run: Pick<RunState, "databaseNotes" | "backendNotes" | "frontendNotes" | "generalNotes">,
  role: RoleName | undefined,
): string | undefined {
  if (role === "database") return run.databaseNotes;
  if (role === "backend") return run.backendNotes;
  if (role === "frontend") return run.frontendNotes;
  if (role === "general") return run.generalNotes;
  return undefined;
}

/** When a child exits cleanly without calling handoff, recover the intended action from run state. */
export function inferHandoffAction(
  role: RoleName | undefined,
  run: RunState,
): HandoffAction | undefined {
  if (role === "plan_critic") {
    if (!hasNotebookText(run.planCritique?.notes) && !critiqueItems(run).length) return undefined;
    return notesLookLikeApproval(run.planCritique?.notes) ? "critic_approve" : "critic_revise";
  }
  if (role === "design_critic") {
    if (!hasNotebookText(run.designCritiqueNotes)) return undefined;
    return notesLookLikeApproval(run.designCritiqueNotes) ? "critic_approve" : "critic_revise";
  }
  if (role === "planner_orchestrator") return run.scoutItems?.length ? "scout_planned" : undefined;
  if (role === "scout") {
    const items = run.scoutItems ?? [];
    if (!items.length) return undefined;
    if (itemsRemaining(items).length) return undefined;
    if (items.some((item) => !item.findings?.trim())) return undefined;
    return "scout_done";
  }
  if (role === "orchestrator") return run.workItems?.length ? "work_planned" : undefined;
  if (role === "database" || role === "backend" || role === "frontend" || role === "general") {
    return hasNotebookText(layerNotesFor(run, role)) ? "implementor_done" : undefined;
  }
  if (role === "reviewer") {
    if (hasBlockFindings(run.reviewFindings)) return "qa_fail";
    if (run.reviewFindings?.length) return "qa_pass";
    return undefined;
  }
  if (role === "tester") {
    if (run.testFailed === true || hasBlockFindings(run.reviewFindings)) return "qa_fail";
    if (run.testFailed === false) return "qa_pass";
    if (run.reviewFindings?.length) return "qa_pass";
    return undefined;
  }
  if (role === "linter") {
    if (run.lintErrors === true || hasBlockFindings(run.reviewFindings)) return "qa_fail";
    if (run.lintErrors === false) return "qa_pass";
    if (run.reviewFindings?.length) return "qa_pass";
    return undefined;
  }
  if (role === "demo") return hasNotebookText(run.demoNotes) ? "qa_pass" : undefined;
  if (role === "commit_message")
    return run.commitMessageDraft?.trim() ? "commit_drafted" : undefined;
  return undefined;
}
