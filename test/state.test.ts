import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import {
  closeSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
  utimesSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { mock, test } from "node:test";
import { withStateLock } from "../src/lock.ts";
import {
  clearRunFiles,
  classifyFindingLine,
  emptyRun,
  hasBlockFindings,
  loadRun,
  mutateRun,
  normalizeStack,
  parseFindings,
  parseCommandOutcome,
  readCurrentJobId,
  renderRunMarkdown,
  runPaths,
  saveRun,
  updateSection,
  workflowStatePaths,
  writeCurrentJobId,
} from "../src/state.ts";
import {
  applyHandoffTool,
  applyMockupTool,
  applyStateTool,
  resolveMockupRel,
} from "../src/tools.ts";

test("state lock times out without running callback or removing another owner", () => {
  const dir = mkdtempSync(join(tmpdir(), "state-lock-"));
  const path = join(dir, "run.json");
  const lock = `${path}.lock`;
  mkdirSync(lock);
  utimesSync(lock, new Date(0), new Date(0));
  let now = 0;
  const clock = mock.method(Date, "now", () => (now += 10_000));
  let called = false;
  try {
    assert.throws(
      () =>
        withStateLock(path, () => {
          called = true;
        }),
      /Timed out acquiring state lock/,
    );
    assert.equal(called, false);
    assert.equal(existsSync(lock), true);
  } finally {
    clock.mock.restore();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("state lock leaves a replacement owner's lock intact", () => {
  const dir = mkdtempSync(join(tmpdir(), "state-lock-"));
  const path = join(dir, "run.json");
  const lock = `${path}.lock`;
  try {
    withStateLock(path, () => {
      renameSync(lock, `${lock}.old`);
      mkdirSync(lock);
    });
    assert.equal(existsSync(lock), true);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("saveRun replaces snapshots atomically", () => {
  const dir = mkdtempSync(join(tmpdir(), "state-atomic-"));
  const path = join(dir, "run.json");
  try {
    saveRun(path, emptyRun("session", "old"));
    const oldSnapshot = openSync(path, "r");
    try {
      saveRun(path, emptyRun("session", "new"));
      assert.equal(JSON.parse(readFileSync(oldSnapshot, "utf8")).task, "old");
      assert.equal(loadRun(path)?.task, "new");
    } finally {
      closeSync(oldSnapshot);
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("concurrent processes preserve all mutations and publish coherent aliases", async () => {
  const dir = mkdtempSync(join(tmpdir(), "state-concurrent-"));
  const path = runPaths(dir, "job").json;
  saveRun(path, emptyRun("session", "task", "job"), dir);
  const module = new URL("../src/state.ts", import.meta.url).href;
  const script = `
    import { mutateRun } from ${JSON.stringify(module)};
    for (let i = 0; i < 20; i++) {
      mutateRun(process.argv[1], process.argv[2], run => ({
        ...run, spec: (run.spec || "") + "x"
      }));
    }
  `;
  try {
    await Promise.all(
      Array.from(
        { length: 4 },
        () =>
          new Promise<void>((resolve, reject) => {
            const child = spawn(
              process.execPath,
              ["--experimental-strip-types", "--input-type=module", "-e", script, path, dir],
              { stdio: "inherit" },
            );
            child.on("error", reject);
            child.on("exit", (code) =>
              code === 0 ? resolve() : reject(new Error(`child exited ${code}`)),
            );
          }),
      ),
    );
    assert.equal(loadRun(path)?.spec?.length, 80);
    assert.deepEqual(JSON.parse(readFileSync(workflowStatePaths(dir).json, "utf8")), loadRun(path));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("mutation refuses corrupt canonical state and recovers after publication failure", () => {
  const dir = mkdtempSync(join(tmpdir(), "state-recovery-"));
  const path = runPaths(dir, "job").json;
  const aliases = workflowStatePaths(dir);
  try {
    saveRun(path, emptyRun("session", "task", "job"), dir);
    writeFileSync(path, "{broken");
    assert.throws(() => mutateRun(path, dir, (run) => ({ ...run, task: "lost" })));
    assert.equal(readFileSync(path, "utf8"), "{broken");
    saveRun(path, emptyRun("session", "restored", "job"), dir);
    rmSync(aliases.md);
    mkdirSync(aliases.md);
    assert.throws(() => mutateRun(path, dir, (run) => ({ ...run, task: "committed" })));
    assert.equal(loadRun(path)?.task, "committed");
    rmSync(aliases.md, { recursive: true });
    mutateRun(path, dir, (run) => ({ ...run, spec: "recovered" }));
    assert.equal(JSON.parse(readFileSync(aliases.json, "utf8")).spec, "recovered");
    assert.match(readFileSync(aliases.md, "utf8"), /recovered/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("clear-on-new-task removes json and mockup dir", () => {
  const agentDir = mkdtempSync(join(tmpdir(), "devteam-agent-"));
  const sessionId = "sess-1";
  const paths = runPaths(agentDir, sessionId);
  const run = emptyRun(sessionId, "do a thing");
  saveRun(paths.json, run);
  applyMockupTool(
    {
      load: () => loadRun(paths.json),
      save: (next) => saveRun(paths.json, next),
      mutate: (change) => mutateRun(paths.json, undefined, change),
      agentDir: () => agentDir,
      sessionId: () => sessionId,
    },
    { action: "write", content: "<html>hi</html>" },
  );
  assert.equal(readFileSync(paths.mockupFile, "utf8"), "<html>hi</html>");
  clearRunFiles(agentDir, sessionId);
  assert.equal(loadRun(paths.json), undefined);
  assert.equal(existsSync(paths.workflowStateJson), false);
  assert.equal(existsSync(paths.workflowStateMd), false);
});

test("saveRun writes workflow_state aliases under the agent dir not a plugin folder", () => {
  const agentDir = mkdtempSync(join(tmpdir(), "devteam-agent-"));
  const sessionId = "sess-alias";
  const paths = runPaths(agentDir, sessionId);
  const aliases = workflowStatePaths(agentDir);
  saveRun(paths.json, emptyRun(sessionId, "find me"), agentDir);
  assert.equal(existsSync(paths.json), true);
  assert.equal(aliases.json, paths.workflowStateJson);
  const copy = JSON.parse(readFileSync(aliases.json, "utf8"));
  assert.equal(copy.task, "find me");
  const md = readFileSync(aliases.md, "utf8");
  assert.match(md, /find me/);
  assert.match(md, /workflow_state/);
  assert.match(md, /Not stored in the plugin/);
});

test("two pi sessions keep separate current jobs", () => {
  const agentDir = mkdtempSync(join(tmpdir(), "devteam-agent-"));
  writeCurrentJobId(agentDir, "job-a", "sess-a");
  writeCurrentJobId(agentDir, "job-b", "sess-b");
  assert.equal(readCurrentJobId(agentDir, "sess-a"), "job-a");
  assert.equal(readCurrentJobId(agentDir, "sess-b"), "job-b");
  assert.equal(readCurrentJobId(agentDir, "sess-c"), undefined);
  const runA = emptyRun("sess-a", "task a", "job-a");
  saveRun(runPaths(agentDir, "job-a").json, runA, agentDir);
  assert.equal(readCurrentJobId(agentDir, "sess-a"), "job-a");
  assert.equal(readCurrentJobId(agentDir, "sess-b"), "job-b");
  // No alias merge: sess-b sees nothing, mutate creates nothing from sess-a.
  assert.equal(loadRun(runPaths(agentDir, "job-b").json), undefined);
  assert.equal(
    mutateRun(runPaths(agentDir, "job-b").json, agentDir, (c) => c),
    undefined,
  );
  assert.equal(loadRun(runPaths(agentDir, "job-b").json), undefined);
});
test("block vs note tags win over keyword heuristics", () => {
  const block = classifyFindingLine("- [block] src/api.ts: missing spec field");
  const note = classifyFindingLine("- [note] src/api.ts: long method smell");
  assert.equal(block.severity, "block");
  assert.equal(block.axis, "spec");
  assert.deepEqual(block.files, ["src/api.ts"]);
  assert.equal(note.severity, "note");
  assert.equal(hasBlockFindings([block, note]), true);
  assert.equal(hasBlockFindings([note]), false);
});

test("parseFindings reads markdown lists", () => {
  const findings = parseFindings("- [block] a.ts: missing\n- [note] b.ts: warning smell");
  assert.equal(findings[0]?.severity, "block");
  assert.equal(findings[1]?.severity, "note");
});

test("updateSection stores wantMockup and layers", () => {
  let run = emptyRun("s", "task");
  run = updateSection(run, "wantMockup", "yes");
  run = updateSection(run, "layersNeeded", "database, frontend");
  assert.equal(run.wantMockup, true);
  assert.deepEqual(run.layersNeeded, ["database", "frontend"]);
  run = updateSection(run, "wantMockup", "no");
  assert.equal(run.wantMockup, false);
});

test("normalizeStack fills missing arrays from planner partial objects", () => {
  const stack = normalizeStack({ frontend: "react", backend: "node" });
  assert.deepEqual(stack?.database, []);
  assert.deepEqual(stack?.matchedIds, []);
  assert.equal(stack?.frontend, "react");
});

test("renderRunMarkdown does not throw on partial stack", () => {
  const run = emptyRun("s", "Add settings");
  run.stage = "error";
  run.lastError = "plan_critic failed";
  run.stack = { frontend: "react", backend: "express" } as typeof run.stack;
  const md = renderRunMarkdown(run);
  assert.match(md, /Add settings/);
  assert.match(md, /react/);
  assert.match(md, /plan_critic failed/);
});

test("updateSection stack normalizes missing database", () => {
  let run = emptyRun("s", "task");
  run = updateSection(run, "stack", { frontend: "vue" });
  assert.deepEqual(run.stack?.database, []);
  assert.equal(run.stack?.frontend, "vue");
});

test("renderRunMarkdown includes stage and stack", () => {
  const run = emptyRun("s", "Add settings");
  run.stage = "planner";
  run.stack = {
    frontend: "angular",
    backend: "dotnet",
    database: ["postgres"],
    tester: [],
    extra: [],
    uiSurface: "web",
    matchedIds: ["angular", "dotnet", "postgres"],
    backends: ["dotnet"],
    services: [],
  };
  const md = renderRunMarkdown(run);
  assert.match(md, /Add settings/);
  assert.match(md, /angular/);
});

test("devteam_state get/replace and handoff pending", () => {
  const agentDir = mkdtempSync(join(tmpdir(), "devteam-agent-"));
  const sessionId = "s2";
  const path = runPaths(agentDir, sessionId).json;
  saveRun(path, emptyRun(sessionId, "task"));
  const store = {
    load: () => loadRun(path),
    save: (run: ReturnType<typeof emptyRun>) => saveRun(path, run),
    mutate: (
      change: (run: ReturnType<typeof emptyRun>) => ReturnType<typeof emptyRun> | undefined,
    ) => mutateRun(path, undefined, change),
    agentDir: () => agentDir,
    sessionId: () => sessionId,
  };
  const replaced = applyStateTool(store, { action: "replace", section: "spec", value: "A spec" });
  assert.equal(replaced.isError, undefined);
  const got = applyStateTool(store, { action: "get", section: "spec" });
  assert.match(got.text, /A spec/);
  const handoff = applyHandoffTool(store, { action: "plan_ready", summary: "ready" });
  assert.equal(handoff.terminate, true);
  assert.equal(loadRun(path)?.pendingHandoff?.action, "plan_ready");
});
test("scout handoff rejects blank findings and accepts recovery", () => {
  let run = emptyRun("scout", "task");
  run.scoutItems = [{ id: "a", title: "Research", files: [], status: "running", attempts: 1 }];
  const store = {
    load: () => run,
    save: (next: typeof run) => {
      run = next;
    },
    mutate: (change: (run: typeof run) => typeof run | undefined) => {
      run = change(run) ?? run;
      return run;
    },
    agentDir: () => "",
    sessionId: () => "scout",
    taskId: () => "a",
  };
  for (const summary of [undefined, "", " \n "]) {
    const result = applyHandoffTool(store, { action: "scout_done", summary });
    assert.equal(result.isError, true);
    assert.equal(result.terminate, false);
    assert.equal(run.scoutItems?.[0]?.status, "running");
  }
  const result = applyHandoffTool(store, { action: "scout_done", summary: "Found src/main.ts" });
  assert.equal(result.terminate, true);
  assert.equal(run.scoutItems?.[0]?.findings, "Found src/main.ts");
  assert.equal(run.scoutItems?.[0]?.status, "done");
});
test("devteam_state get accepts a section list and rejects unknown names", () => {
  const agentDir = mkdtempSync(join(tmpdir(), "devteam-agent-"));
  const sessionId = "s3";
  const path = runPaths(agentDir, sessionId).json;
  saveRun(path, emptyRun(sessionId, "scoped task"));
  const store = {
    load: () => loadRun(path),
    save: (run: ReturnType<typeof emptyRun>) => saveRun(path, run),
    mutate: (
      change: (run: ReturnType<typeof emptyRun>) => ReturnType<typeof emptyRun> | undefined,
    ) => mutateRun(path, undefined, change),
    agentDir: () => agentDir,
    sessionId: () => sessionId,
  };
  applyStateTool(store, { action: "replace", section: "spec", value: "A spec" });
  const got = applyStateTool(store, { action: "get", sections: ["task", "spec"] });
  assert.equal(got.isError, undefined);
  assert.deepEqual(JSON.parse(got.text), { task: "scoped task", spec: "A spec" });
  const bad = applyStateTool(store, { action: "get", sections: ["spec", "nope"] });
  assert.equal(bad.isError, true);
});

test("parseCommandOutcome uses exit codes and blocks, not log regex", () => {
  assert.deepEqual(parseCommandOutcome({ exitCode: 0, log: "1 failed, 0 error" }), {
    log: "1 failed, 0 error",
    failed: false,
  });
  assert.deepEqual(parseCommandOutcome({ exitCode: 1, log: "ok" }), { log: "ok", failed: true });
  assert.equal(parseCommandOutcome("Error: optional config missing").failed, undefined);
  assert.equal(parseCommandOutcome("failed: true\n1 error").failed, true);
  assert.equal(parseCommandOutcome("- [block] tests did not run").failed, true);
  let run = emptyRun("s", "task");
  run = updateSection(run, "testResults", JSON.stringify({ exitCode: 0, log: "Error: skipped" }));
  assert.equal(run.testFailed, false);
  run = updateSection(run, "lintResults", "error TS2304");
  assert.equal(run.lintErrors, undefined);
  run = updateSection(run, "testFindings", "- [block] src/a.ts: missing coverage");
  assert.equal(run.testFailed, true);
  assert.equal(run.reviewFindings?.[0]?.severity, "block");
});

test("mockup path cannot escape the mockup directory", () => {
  assert.equal(resolveMockupRel("../secret"), undefined);
  assert.equal(resolveMockupRel("index.html"), "index.html");
  assert.equal(resolveMockupRel("css/app.css"), "css/app.css");
});
