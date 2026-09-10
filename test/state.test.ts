import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import {
  clearRunFiles,
  classifyFindingLine,
  emptyRun,
  hasBlockFindings,
  loadRun,
  normalizeStack,
  parseFindings,
  renderRunMarkdown,
  runPaths,
  saveRun,
  updateSection,
  workflowStatePaths,
} from "../src/state.ts";
import { applyHandoffTool, applyMockupTool, applyStateTool, resolveMockupRel } from "../src/tools.ts";

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

test("mockup path cannot escape the mockup directory", () => {
  assert.equal(resolveMockupRel("../secret"), undefined);
  assert.equal(resolveMockupRel("index.html"), "index.html");
  assert.equal(resolveMockupRel("css/app.css"), "css/app.css");
});
