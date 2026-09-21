import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { createChildRunner, type ChildHostPort } from "../src/child-runner.ts";
import { clearJudgeCache } from "../src/judge.ts";
import type { ExtensionContext } from "../src/pi-host.ts";
import { emptyRun, saveRun } from "../src/state.ts";
import type { ChildActivity } from "../src/child-progress.ts";
import type { Catalog, RunState } from "../src/types.ts";
import type { Store } from "../src/tools.ts";
import type { ChildResult, SpawnedChild } from "../src/child-process.ts";

function scriptedHost(results: ChildResult[], onStart?: (args: string[]) => void): ChildHostPort {
  return {
    start(opts) {
      onStart?.(opts.args);
      const result = results.shift() ?? { code: 0, stderr: "", stdout: "", output: "" };
      const spawned: SpawnedChild = {
        process: {} as SpawnedChild["process"],
        abort() {},
        done: Promise.resolve(result),
      };
      return spawned;
    },
  };
}

function ctx(cwd: string): ExtensionContext {
  return { cwd, hasUI: false } as ExtensionContext;
}

test("child runner infers a missing reviewer handoff through step", async () => {
  const dir = mkdtempSync(join(tmpdir(), "devteam-child-"));
  const statePath = join(dir, "run.json");
  let run: RunState = {
    ...emptyRun("s", "task", "job"),
    stage: "reviewer",
    currentRole: "reviewer",
    reviewFindings: [{ axis: "spec", severity: "note", text: "looks fine" }],
  };
  saveRun(statePath, run, dir);
  const store: Store = {
    load: () => run,
    save(next) {
      run = next;
      saveRun(statePath, next, dir);
    },
    mutate(change) {
      const next = change(run);
      if (next) {
        run = next;
        saveRun(statePath, next, dir);
      }
      return run;
    },
    agentDir: () => dir,
    sessionId: () => "job",
  };
  const catalog: Catalog = { maxSkillsPerChild: 3, stacks: [] };
  const activities = new Map<string, ChildActivity>();
  const aborts = new Set<() => void>();
  let abortChild: (() => void) | undefined;
  const started: string[][] = [];
  const runner = createChildRunner({
    host: scriptedHost([{ code: 0, stderr: "", stdout: "", output: "ok" }], (args) =>
      started.push(args),
    ),
    store,
    persist(next) {
      run = next;
      saveRun(statePath, next, dir);
      return next;
    },
    statePath: () => statePath,
    agentDir: () => dir,
    catalog: () => catalog,
    config: () => null,
    modelId: () => undefined,
    thinking: () => undefined,
    activities,
    aborts,
    getAbortChild: () => abortChild,
    setAbortChild: (fn) => {
      abortChild = fn;
    },
    startProgressReporting() {},
    stopProgressReporting() {},
    logProgress() {},
    notify() {},
    refreshUi() {},
  });

  const out = await runner.run(ctx(dir), run, "reviewer");
  assert.equal(out.ok, true, out.error);
  assert.equal(run.stage, "tester");
  assert.equal(started.length, 1);
});

test("child runner retries once when the host rejects unknown flags", async () => {
  const dir = mkdtempSync(join(tmpdir(), "devteam-child-"));
  const statePath = join(dir, "run.json");
  let run: RunState = {
    ...emptyRun("s", "task", "job"),
    stage: "commit_message",
    currentRole: "commit_message",
    commitMessageDraft: "feat: ship it",
  };
  saveRun(statePath, run, dir);
  const store: Store = {
    load: () => run,
    save(next) {
      run = next;
      saveRun(statePath, next, dir);
    },
    agentDir: () => dir,
    sessionId: () => "job",
  };
  const catalog: Catalog = { maxSkillsPerChild: 3, stacks: [] };
  const activities = new Map<string, ChildActivity>();
  const aborts = new Set<() => void>();
  let abortChild: (() => void) | undefined;
  const results: ChildResult[] = [
    { code: 1, stderr: "unknown option '-a'", stdout: "", output: "unknown option '-a'" },
    { code: 0, stderr: "", stdout: "", output: "" },
  ];
  const runner = createChildRunner({
    host: scriptedHost(results),
    store,
    persist(next) {
      run = next;
      saveRun(statePath, next, dir);
      return next;
    },
    statePath: () => statePath,
    agentDir: () => dir,
    catalog: () => catalog,
    config: () => null,
    modelId: () => undefined,
    thinking: () => undefined,
    activities,
    aborts,
    getAbortChild: () => abortChild,
    setAbortChild: (fn) => {
      abortChild = fn;
    },
    startProgressReporting() {},
    stopProgressReporting() {},
    logProgress() {},
    notify() {},
    refreshUi() {},
  });

  const out = await runner.run(ctx(dir), run, "commit_message");
  assert.equal(out.ok, true, out.error);
  assert.equal(run.stage, "done");
});

function runnerHarness(
  run: RunState,
  dir: string,
  extra: Partial<Parameters<typeof createChildRunner>[0]> = {},
) {
  const statePath = join(dir, "run.json");
  saveRun(statePath, run, dir);
  const store: Store = {
    load: () => run,
    save(next) {
      run = next;
      saveRun(statePath, next, dir);
    },
    mutate(change) {
      const next = change(run);
      if (next) {
        run = next;
        saveRun(statePath, next, dir);
      }
      return run;
    },
    agentDir: () => dir,
    sessionId: () => "job",
  };
  const activities = new Map<string, ChildActivity>();
  const aborts = new Set<() => void>();
  let abortChild: (() => void) | undefined;
  const runner = createChildRunner({
    host: extra.host ?? scriptedHost([{ code: 0, stderr: "", stdout: "", output: "ok" }]),
    store,
    persist(next) {
      run = next;
      saveRun(statePath, next, dir);
      return next;
    },
    statePath: () => statePath,
    agentDir: () => dir,
    catalog: extra.catalog ?? (() => ({ maxSkillsPerChild: 3, stacks: [] })),
    config: extra.config ?? (() => null),
    modelId: extra.modelId ?? (() => undefined),
    thinking: extra.thinking ?? (() => undefined),
    isOmp: extra.isOmp,
    judgeComplete: extra.judgeComplete,
    activities: extra.activities ?? activities,
    aborts: extra.aborts ?? aborts,
    getAbortChild: extra.getAbortChild ?? (() => abortChild),
    setAbortChild:
      extra.setAbortChild ??
      ((fn) => {
        abortChild = fn;
      }),
    startProgressReporting: extra.startProgressReporting ?? (() => {}),
    stopProgressReporting: extra.stopProgressReporting ?? (() => {}),
    logProgress: extra.logProgress ?? (() => {}),
    notify: extra.notify ?? (() => {}),
    refreshUi: extra.refreshUi ?? (() => {}),
  });
  return {
    runner,
    get run() {
      return run;
    },
  };
}

test("child runner uses @tiny when heuristics miss a handoff", async () => {
  const dir = mkdtempSync(join(tmpdir(), "devteam-child-"));
  const started: string[][] = [];
  let judged = 0;
  const harness = runnerHarness(
    {
      ...emptyRun("s", "task", "job"),
      stage: "reviewer",
      currentRole: "reviewer",
    },
    dir,
    {
      host: scriptedHost(
        [{ code: 0, stderr: "", stdout: "notes look good", output: "notes look good" }],
        (args) => started.push(args),
      ),
      judgeComplete: async () => {
        judged += 1;
        return { text: '{"action":"qa_pass"}' };
      },
    },
  );
  const out = await harness.runner.run(ctx(dir), harness.run, "reviewer");
  assert.equal(out.ok, true, out.error);
  assert.equal(harness.run.stage, "tester");
  assert.equal(judged, 1);
  assert.equal(started.length, 1);
});

test("child runner does not call @tiny when heuristics already infer", async () => {
  const dir = mkdtempSync(join(tmpdir(), "devteam-child-"));
  let judged = 0;
  const harness = runnerHarness(
    {
      ...emptyRun("s", "task", "job"),
      stage: "reviewer",
      currentRole: "reviewer",
      reviewFindings: [{ axis: "spec", severity: "note", text: "looks fine" }],
    },
    dir,
    {
      judgeComplete: async () => {
        judged += 1;
        return { text: '{"action":"qa_fail"}' };
      },
    },
  );
  const out = await harness.runner.run(ctx(dir), harness.run, "reviewer");
  assert.equal(out.ok, true, out.error);
  assert.equal(harness.run.stage, "tester");
  assert.equal(judged, 0);
});

test("child runner fail-opens when @tiny cannot infer a handoff", async () => {
  const dir = mkdtempSync(join(tmpdir(), "devteam-child-"));
  const harness = runnerHarness(
    {
      ...emptyRun("s", "task", "job"),
      stage: "reviewer",
      currentRole: "reviewer",
    },
    dir,
    {
      judgeComplete: async () => ({ error: "timeout" }),
    },
  );
  const out = await harness.runner.run(ctx(dir), harness.run, "reviewer");
  assert.equal(out.ok, false);
  assert.match(out.error ?? "", /without a handoff/);
  assert.equal(harness.run.stage, "reviewer");
});

test("tester @tiny code_bug becomes qa_fail", async () => {
  clearJudgeCache();
  const dir = mkdtempSync(join(tmpdir(), "devteam-child-"));
  let judged = 0;
  const stdout = "error TS2322: Type 'string' is not assignable";
  const harness = runnerHarness(
    {
      ...emptyRun("s", "task", "job"),
      stage: "tester",
      currentRole: "tester",
    },
    dir,
    {
      host: scriptedHost([{ code: 0, stderr: "", stdout, output: stdout }]),
      judgeComplete: async () => {
        judged += 1;
        return { text: '{"failureClass":"code_bug"}' };
      },
    },
  );
  const out = await harness.runner.run(ctx(dir), harness.run, "tester");
  assert.equal(out.ok, true, out.error);
  assert.equal(harness.run.stage, "fix_test");
  assert.equal(harness.run.testFailed, true);
  assert.equal(judged, 1);
});

test("tester @tiny environment parks instead of fixing code", async () => {
  clearJudgeCache();
  const dir = mkdtempSync(join(tmpdir(), "devteam-child-"));
  const stdout = "sh: eslint: command not found";
  const harness = runnerHarness(
    {
      ...emptyRun("s", "task", "job"),
      stage: "tester",
      currentRole: "tester",
    },
    dir,
    {
      host: scriptedHost([{ code: 0, stderr: "", stdout, output: stdout }]),
      judgeComplete: async () => ({ text: '{"failureClass":"environment"}' }),
    },
  );
  const out = await harness.runner.run(ctx(dir), harness.run, "tester");
  assert.equal(out.ok, false);
  assert.match(out.error ?? "", /environment/);
  assert.equal(harness.run.halted, true);
  assert.equal(harness.run.stage, "tester");
});

test("tester skips bash judge when every bash exited 0", async () => {
  clearJudgeCache();
  const dir = mkdtempSync(join(tmpdir(), "devteam-child-"));
  let judged = 0;
  const stdout = `${JSON.stringify({ type: "tool_execution_end", toolName: "bash", exitCode: 0 })}\n`;
  const harness = runnerHarness(
    {
      ...emptyRun("s", "task", "job"),
      stage: "tester",
      currentRole: "tester",
    },
    dir,
    {
      host: scriptedHost([{ code: 0, stderr: "", stdout, output: stdout }]),
      judgeComplete: async () => {
        judged += 1;
        return { text: '{"failureClass":"code_bug"}' };
      },
    },
  );
  const out = await harness.runner.run(ctx(dir), harness.run, "tester");
  assert.equal(out.ok, true, out.error);
  assert.equal(harness.run.stage, "linter");
  assert.equal(harness.run.testFailed, false);
  assert.equal(judged, 0);
});
