import assert from "node:assert/strict";
import { test } from "node:test";
import { emptyRun } from "../src/state.ts";
import {
  acceptMockupChoice,
  applyContinue,
  applyHandoff,
  applySkip,
  applyStop,
  applyCritiqueDecisions,
  attachRunForResume,
  autoResumeGate,
  canFix,
  inferHandoffAction,
  mapBlockedFilesToImplementors,
  nextAfterPlanCritic,
  parseLayers,
  shouldOfferMockup,
  startImplementation,
  startScouting,
  startSequentialImplementation,
} from "../src/pipeline.ts";
import { MAX_FIX_ROUNDS } from "../src/types.ts";
import type { RunState } from "../src/types.ts";

function run(partial: Partial<RunState>): RunState {
  return { ...emptyRun("s", "task"), ...partial };
}

test("shouldOfferMockup only for frontend + web", () => {
  assert.equal(shouldOfferMockup(run({ layersNeeded: ["frontend"], uiSurface: "web" })), true);
  assert.equal(shouldOfferMockup(run({ layersNeeded: ["frontend"], uiSurface: "native" })), false);
  assert.equal(shouldOfferMockup(run({ layersNeeded: ["backend"], uiSurface: "web" })), false);
  assert.equal(shouldOfferMockup(run({ layersNeeded: ["general"], uiSurface: "web" })), false);
});

test("nextAfterPlanCritic honors wantMockup and skip-designer when no web UI", () => {
  assert.equal(
    nextAfterPlanCritic(run({ layersNeeded: ["frontend"], uiSurface: "web" })),
    "orchestrate",
  );
  assert.equal(
    nextAfterPlanCritic(run({ layersNeeded: ["frontend"], uiSurface: "web", wantMockup: true })),
    "designer",
  );
  assert.equal(
    nextAfterPlanCritic(run({ layersNeeded: ["frontend"], uiSurface: "web", wantMockup: false })),
    "orchestrate",
  );
  assert.equal(
    nextAfterPlanCritic(run({ layersNeeded: ["frontend"], uiSurface: "native" })),
    "orchestrate",
  );
  assert.equal(nextAfterPlanCritic(run({ layersNeeded: ["backend"] })), "orchestrate");
});

test("critic approve starts implementation unless mockups were already requested", () => {
  const next = applyHandoff(
    run({ stage: "plan_critic", layersNeeded: ["frontend"], uiSurface: "web" }),
    "critic_approve",
  );
  assert.equal(next.stage, "orchestrate");
  assert.equal(next.currentRole, "orchestrator");

  const designed = applyHandoff(
    run({ stage: "plan_critic", layersNeeded: ["frontend"], uiSurface: "web", wantMockup: true }),
    "critic_approve",
  );
  assert.equal(designed.stage, "designer");
});

test("skip at mockup opt-in declines designer and starts implementation", () => {
  const next = applySkip(run({ stage: "mockup_opt_in", layersNeeded: ["frontend"], uiSurface: "web" }));
  assert.equal(next.wantMockup, false);
  assert.equal(next.stage, "orchestrate");
});

test("continue at mockup opt-in starts designer", () => {
  const next = applyContinue(run({ stage: "mockup_opt_in" }));
  assert.equal(next.wantMockup, true);
  assert.equal(next.stage, "designer");
});

test("chat yes/no at mockup opt-in", () => {
  const yes = acceptMockupChoice(run({ stage: "mockup_opt_in" }), true);
  const no = acceptMockupChoice(run({ stage: "mockup_opt_in" }), false);
  assert.equal(yes.stage, "designer");
  assert.equal(no.stage, "orchestrate");
});

test("skip at the leftover build-it gate starts implementation", () => {
  const paused = run({ stage: "build_it_pause", pauseReason: "build_it", layersNeeded: ["backend"] });
  const next = applySkip(paused);
  assert.equal(next.stage, "orchestrate");
});

test("continue at planner with a spec starts the plan critic", () => {
  const next = applyContinue(run({ stage: "planner", spec: "Ship settings page" }));
  assert.equal(next.stage, "plan_critic");
});

test("continue at planner without a spec is a no-op", () => {
  const paused = run({ stage: "planner" });
  const next = applyContinue(paused);
  assert.equal(next, paused);
});

test("attaching a job for resume keeps stage and spec", () => {
  const paused = run({
    stage: "planner",
    spec: "Ship settings page",
    jobId: "abc123",
    pipelineLocked: true,
  });
  const next = attachRunForResume(paused);
  assert.equal(next.stage, "planner");
  assert.equal(next.spec, "Ship settings page");
  assert.equal(next.pipelineLocked, false);
  assert.equal(next.interactiveRole, "planner");
});

test("continue after error retries the failed role", () => {
  const next = applyContinue(
    run({ stage: "error", currentRole: "plan_critic", lastError: "child exited 1" }),
  );
  assert.equal(next.stage, "plan_critic");
  assert.equal(next.lastError, undefined);
});

test("polyglot backends run one implementor pass per service", () => {
  const started = startSequentialImplementation(
    run({
      layersNeeded: ["backend"],
      stack: {
        frontend: undefined,
        backend: undefined,
        backends: [],
        database: [],
        tester: [],
        extra: [],
        uiSurface: "none",
        matchedIds: [],
        services: [
          {
            name: "api",
            root: "services/api",
            layer: "backend",
            languages: ["go"],
            paths: ["services/api/**"],
            skills: [],
            test: ["go test ./..."],
            lint: ["go vet ./..."],
            source: "detected",
          },
          {
            name: "scoring",
            root: "services/scoring",
            layer: "backend",
            languages: ["python"],
            paths: ["services/scoring/**"],
            skills: [],
            test: ["pytest"],
            lint: ["ruff check ."],
            source: "detected",
          },
        ],
      },
    }),
  );
  assert.equal(started.stage, "implement");
  assert.deepEqual(started.serviceQueue, ["api", "scoring"]);
  assert.equal(started.currentService, "api");

  const afterApi = applyHandoff(started, "implementor_done");
  assert.equal(afterApi.stage, "implement");
  assert.equal(afterApi.currentService, "scoring");
  assert.equal(afterApi.currentRole, "backend");

  const afterScoring = applyHandoff(afterApi, "implementor_done");
  assert.equal(afterScoring.stage, "reviewer");
});

test("continue at build-it starts the orchestrator", () => {
  const next = applyContinue(
    run({ stage: "build_it_pause", layersNeeded: ["frontend", "database", "backend"] }),
  );
  assert.equal(next.stage, "orchestrate");
  assert.deepEqual(next.implementorQueue, ["database", "backend", "frontend"]);
  assert.equal(next.currentRole, "orchestrator");
});

test("leftover pause gates auto-resume into the next role", () => {
  const gated = autoResumeGate(run({ stage: "build_it_pause", layersNeeded: ["backend"] }));
  assert.equal(gated.stage, "orchestrate");
  assert.equal(gated.currentRole, "orchestrator");
});

test("critic revise pauses for the user instead of looping the planner", () => {
  const next = applyHandoff(
    run({
      stage: "plan_critic",
      layersNeeded: ["backend"],
      planCritique: {
        notes: JSON.stringify([{ id: "c1", title: "Empty state", text: "Specify it." }]),
        replacedScope: false,
      },
    }),
    "critic_revise",
  );
  assert.equal(next.stage, "plan_review");
  assert.equal(next.planCritique?.reviewed, false);
  assert.equal(next.planCritique?.items?.[0]?.title, "Empty state");
});

test("accepting critic items sends the planner a filtered list; rejecting all starts implementation", () => {
  const reviewing = applyHandoff(
    run({
      stage: "plan_critic",
      layersNeeded: ["backend"],
      spec: "Ship the API",
      planCritique: {
        notes: JSON.stringify([
          { id: "c1", title: "Empty state", text: "Specify it." },
          { id: "c2", title: "New stack", text: "Use Rails." },
        ]),
        replacedScope: false,
      },
    }),
    "critic_revise",
  );
  const patched = applyCritiqueDecisions(reviewing, [
    { id: "c1", decision: "accept" },
    { id: "c2", decision: "reject" },
  ]);
  assert.equal(patched.stage, "planner");
  assert.equal(patched.planCritique?.reviewed, true);
  assert.match(patched.planCritique?.notes ?? "", /Accepted/);
  assert.match(patched.planCritique?.notes ?? "", /Empty state/);
  assert.match(patched.planCritique?.notes ?? "", /Rejected/);

  const approved = applyHandoff(patched, "plan_ready");
  assert.equal(approved.stage, "orchestrate");

  const none = applyCritiqueDecisions(reviewing, [
    { id: "c1", decision: "reject" },
    { id: "c2", decision: "reject" },
  ]);
  assert.equal(none.stage, "orchestrate");
});

test("skip at plan critic or plan review keeps the spec and continues", () => {
  const critic = applySkip(run({ stage: "plan_critic", layersNeeded: ["backend"], spec: "Ship it" }));
  assert.equal(critic.stage, "orchestrate");

  const review = applySkip(
    run({
      stage: "plan_review",
      layersNeeded: ["backend"],
      spec: "Ship it",
      planCritique: { notes: "holes", replacedScope: false, items: [{ id: "c1", title: "Hole", text: "Fix it" }] },
    }),
  );
  assert.equal(review.stage, "orchestrate");
});

test("skip at planner with a spec starts implementation instead of another critic loop", () => {
  const next = applySkip(run({ stage: "planner", spec: "Ship settings page", layersNeeded: ["backend"] }));
  assert.equal(next.stage, "orchestrate");
});

test("stop halts the current step; continue resumes it; auto-resume does not", () => {
  const stopped = applyStop(run({ stage: "plan_critic", pipelineLocked: true, pendingHandoff: { action: "critic_revise" } }));
  assert.equal(stopped.halted, true);
  assert.equal(stopped.pipelineLocked, false);
  assert.equal(stopped.pendingHandoff, undefined);
  assert.equal(autoResumeGate(stopped).stage, "plan_critic");
  const resumed = applyContinue(stopped);
  assert.equal(resumed.halted, false);
  assert.equal(resumed.stage, "plan_critic");
});

test("design critic approve starts implementation", () => {
  const next = applyHandoff(run({ stage: "design_critic", layersNeeded: ["frontend"] }), "critic_approve");
  assert.equal(next.stage, "orchestrate");
});

test("empty layers needed routes to general only", () => {
  assert.deepEqual(parseLayers(undefined), ["general"]);
  assert.deepEqual(parseLayers([]), ["general"]);
  const next = startImplementation(run({ layersNeeded: [] }));
  assert.equal(next.stage, "orchestrate");
  assert.deepEqual(next.implementorQueue, ["general"]);
});

test("plan rewrite skip restores original spec and keeps executing", () => {
  const next = applySkip(
    run({
      stage: "planner",
      pauseReason: "plan_rewrite",
      spec: "new spec",
      originalSpec: "old spec",
      layersNeeded: ["frontend"],
      originalLayersNeeded: ["backend"],
    }),
  );
  assert.equal(next.spec, "old spec");
  assert.deepEqual(next.layersNeeded, ["backend"]);
  assert.equal(next.stage, "orchestrate");
});

test("implementor_done walks the queue then reviewer", () => {
  const first = applyHandoff(
    run({
      stage: "implement",
      implementorQueue: ["database", "frontend"],
      implementorIndex: 0,
      currentRole: "database",
    }),
    "implementor_done",
  );
  assert.equal(first.currentRole, "frontend");
  assert.equal(first.implementorIndex, 1);
  const second = applyHandoff(first, "implementor_done");
  assert.equal(second.stage, "reviewer");
});

test("qa_fail starts a fix round until the cap", () => {
  let current = run({
    stage: "reviewer",
    reviewFindings: [{ axis: "spec", severity: "block", text: "- [block] src/db.ts: missing", files: ["src/db.ts"] }],
  });
  for (let i = 0; i < MAX_FIX_ROUNDS; i++) {
    assert.equal(canFix(current, "review"), true);
    current = applyHandoff(current, "qa_fail");
    assert.equal(current.stage, "fix_review");
    current = { ...current, stage: "reviewer", reviewFindings: current.reviewFindings };
  }
  assert.equal(canFix(current, "review"), false);
  const capped = applyHandoff(current, "qa_fail");
  assert.equal(capped.stage, "tester");
  assert.equal(capped.pauseReason, undefined);
});

test("skip after review accepts blockers and goes to tester", () => {
  const next = applySkip(run({ stage: "reviewer", pauseReason: "fix_review_max" }));
  assert.equal(next.stage, "tester");
});

test("blocked files map to implementor layers in pipeline order", () => {
  const layers = mapBlockedFilesToImplementors(
    ["src/components/Page.tsx", "prisma/schema.prisma", "src/server/api.ts"],
    {},
  );
  assert.deepEqual(layers, ["database", "backend", "frontend"]);
});

test("qa_pass reviewer → tester → linter → commit message", () => {
  const t = applyHandoff(run({ stage: "reviewer" }), "qa_pass");
  assert.equal(t.stage, "tester");
  const l = applyHandoff(t, "qa_pass");
  assert.equal(l.stage, "linter");
  const c = applyHandoff(l, "qa_pass");
  assert.equal(c.stage, "commit_message");
  const done = applyHandoff(c, "commit_drafted");
  assert.equal(done.stage, "done");
});

test("work_planned with items starts implement; empty items fall back to sequential", () => {
  const planned = applyHandoff(
    run({
      stage: "orchestrate",
      currentRole: "orchestrator",
      layersNeeded: ["backend", "frontend"],
      workItems: [
        {
          id: "route",
          layer: "backend",
          title: "POST /od",
          files: ["src/server/**"],
          dependsOn: [],
          status: "pending",
          attempts: 0,
        },
      ],
    }),
    "work_planned",
  );
  assert.equal(planned.stage, "implement");
  assert.equal(planned.currentRole, "backend");
  assert.equal(planned.workItems?.length, 1);

  const sequential = applyHandoff(
    run({ stage: "orchestrate", currentRole: "orchestrator", layersNeeded: ["backend"] }),
    "work_planned",
  );
  assert.equal(sequential.stage, "implement");
  assert.equal(sequential.workItems?.length ?? 0, 0);
  assert.equal(sequential.currentRole, "backend");
});

test("implementor_done with remaining work items does not skip to reviewer", () => {
  const next = applyHandoff(
    run({
      stage: "implement",
      implementorQueue: ["backend"],
      currentRole: "backend",
      workItems: [
        {
          id: "a",
          layer: "backend",
          title: "a",
          files: ["src/a.ts"],
          dependsOn: [],
          status: "done",
          attempts: 1,
        },
        {
          id: "b",
          layer: "backend",
          title: "b",
          files: ["src/b.ts"],
          dependsOn: [],
          status: "pending",
          attempts: 0,
        },
      ],
    }),
    "implementor_done",
  );
  assert.equal(next.stage, "implement");
});

test("continue retries failed work items; skip sends them to review", () => {
  const failed = run({
    stage: "implement",
    workItems: [
      {
        id: "a",
        layer: "backend",
        title: "a",
        files: ["src/a.ts"],
        dependsOn: [],
        status: "failed",
        attempts: 1,
        error: "exited 1",
      },
    ],
  });
  const retried = applyContinue(failed);
  assert.equal(retried.stage, "implement");
  assert.equal(retried.workItems?.[0]?.status, "pending");

  const skipped = applySkip(failed);
  assert.equal(skipped.stage, "reviewer");

  const autoRetry = autoResumeGate(failed);
  assert.equal(autoRetry.workItems?.[0]?.status, "pending");

  const exhausted = autoResumeGate({
    ...failed,
    workItems: failed.workItems?.map((item) => ({ ...item, attempts: 2 })),
  });
  assert.equal(exhausted.stage, "reviewer");
});

test("inferHandoffAction recovers critic, implementor, QA, and orchestrator exits", () => {
  assert.equal(inferHandoffAction("plan_critic", run({ planCritique: { notes: "Approved", replacedScope: false } })), "critic_approve");
  assert.equal(inferHandoffAction("plan_critic", run({ planCritique: { notes: "Missing acceptance criteria for X", replacedScope: false } })), "critic_revise");
  assert.equal(inferHandoffAction("backend", run({ stage: "implement" })), "implementor_done");
  assert.equal(inferHandoffAction("reviewer", run({ reviewFindings: [] })), "qa_pass");
  assert.equal(
    inferHandoffAction("tester", run({ testFailed: true, reviewFindings: [] })),
    "qa_fail",
  );
  assert.equal(
    inferHandoffAction("orchestrator", run({ workItems: [{ id: "a", layer: "backend", title: "a", files: [], dependsOn: [], status: "pending", attempts: 0 }] })),
    "work_planned",
  );
  assert.equal(inferHandoffAction("orchestrator", run({})), undefined);
  assert.equal(inferHandoffAction("commit_message", run({ commitMessageDraft: "feat: x" })), "commit_drafted");
});

test("a new job starts at the planner orchestrator", () => {
  const next = startScouting(run({ task: "Add settings" }));
  assert.equal(next.stage, "scout_orchestrate");
  assert.equal(next.currentRole, "planner_orchestrator");
});

test("scout_planned with items runs scouts; empty list starts the planner", () => {
  const planned = applyHandoff(
    run({
      stage: "scout_orchestrate",
      currentRole: "planner_orchestrator",
      scoutItems: [
        {
          id: "ui",
          title: "Existing settings UI",
          files: ["src/app/**"],
          status: "pending",
          attempts: 0,
        },
      ],
    }),
    "scout_planned",
  );
  assert.equal(planned.stage, "scout");
  assert.equal(planned.currentRole, "scout");

  const empty = applyHandoff(run({ stage: "scout_orchestrate", currentRole: "planner_orchestrator" }), "scout_planned");
  assert.equal(empty.stage, "planner");
});

test("scout_done with remaining items stays; last scout starts the planner", () => {
  const mid = applyHandoff(
    run({
      stage: "scout",
      scoutItems: [
        { id: "a", title: "a", files: [], status: "done", attempts: 1, findings: "found a" },
        { id: "b", title: "b", files: [], status: "pending", attempts: 0 },
      ],
    }),
    "scout_done",
  );
  assert.equal(mid.stage, "scout");

  const last = applyHandoff(
    run({
      stage: "scout",
      scoutItems: [{ id: "a", title: "a", files: [], status: "done", attempts: 1, findings: "found a" }],
    }),
    "scout_done",
  );
  assert.equal(last.stage, "planner");
  assert.match(last.scoutNotes ?? "", /found a/);
});

test("skip during scouting starts the planner with whatever findings exist", () => {
  const next = applySkip(
    run({
      stage: "scout",
      scoutItems: [{ id: "a", title: "a", files: [], status: "done", attempts: 1, findings: "routes in src/server" }],
    }),
  );
  assert.equal(next.stage, "planner");
  assert.match(next.scoutNotes ?? "", /src\/server/);
});

test("inferHandoffAction recovers scout orchestrator and scout exits", () => {
  assert.equal(
    inferHandoffAction(
      "planner_orchestrator",
      run({ scoutItems: [{ id: "a", title: "a", files: [], status: "pending", attempts: 0 }] }),
    ),
    "scout_planned",
  );
  assert.equal(inferHandoffAction("planner_orchestrator", run({})), undefined);
  assert.equal(inferHandoffAction("scout", run({ stage: "scout" })), "scout_done");
});
