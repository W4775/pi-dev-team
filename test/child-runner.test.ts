import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { createChildRunner, type ChildHostPort } from "../src/child-runner.ts";
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
