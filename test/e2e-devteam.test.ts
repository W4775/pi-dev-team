import assert from "node:assert/strict";
import { chmodSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { hostname, tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { register } from "node:module";
import { test } from "node:test";
import { resetProgressFeed } from "../src/ui-progress.ts";
import {
  emptyRun,
  loadRun,
  readCurrentJobId,
  runPaths,
  saveRun,
  writeCurrentJobId,
} from "../src/state.ts";

register(new URL("./helpers/e2e-loader.mjs", import.meta.url));

const helpersDir = dirname(fileURLToPath(import.meta.url));
const fakeChild = join(helpersDir, "helpers", "fake-pi-child.mjs");

type ToolSpec = {
  name: string;
  execute: (
    id: string,
    params: Record<string, unknown>,
    signal?: AbortSignal,
    onUpdate?: unknown,
    ctx?: unknown,
  ) => Promise<unknown>;
};

type CommandSpec = {
  handler: (args: string, ctx: unknown) => Promise<void>;
};

function createHost() {
  const tools = new Map<string, ToolSpec>();
  const commands = new Map<string, CommandSpec>();
  const listeners = new Map<string, Array<(event: unknown, ctx: unknown) => unknown>>();
  const messages: Array<{ kind: string; text?: string; payload?: unknown }> = [];
  const notifications: string[] = [];
  let activeTools: string[] = [];

  const builtins = ["read", "grep", "find", "ls", "glob", "bash", "ask", "task"].map((name) => ({
    name,
    execute: async () => ({ content: [{ type: "text", text: name }] }),
  }));

  const pi = {
    registerFlag() {},
    getFlag() {
      return undefined;
    },
    registerTool(tool: ToolSpec) {
      tools.set(tool.name, tool);
    },
    registerCommand(name: string, spec: CommandSpec) {
      commands.set(name, spec);
    },
    on(event: string, handler: (event: unknown, ctx: unknown) => unknown) {
      const list = listeners.get(event) ?? [];
      list.push(handler);
      listeners.set(event, list);
    },
    getAllTools() {
      return [...builtins, ...tools.values()];
    },
    getActiveTools() {
      return activeTools.length ? activeTools : pi.getAllTools().map((tool) => tool.name);
    },
    setActiveTools(names: string[]) {
      activeTools = names;
    },
    async sendUserMessage(text: string) {
      messages.push({ kind: "user", text });
    },
    async sendMessage(payload: { content?: string; customType?: string }, opts?: unknown) {
      messages.push({
        kind: "send",
        text: typeof payload?.content === "string" ? payload.content : undefined,
        payload: { payload, opts },
      });
    },
    setSessionName() {},
    registerEntryRenderer() {},
    registerMessageRenderer() {},
  };

  function emit(event: string, payload: unknown, ctx: unknown) {
    return (listeners.get(event) ?? []).map((handler) => handler(payload, ctx));
  }

  return { pi, tools, commands, messages, notifications, emit };
}

function createContext(cwd: string, notifications: string[]) {
  return {
    cwd,
    hasUI: true,
    ui: {
      notify(text: string) {
        notifications.push(text);
      },
      async confirm(_title: string, _message: string) {
        return false;
      },
      setWidget() {},
      setStatus() {},
      setWorkingMessage() {},
      setWorkingVisible() {},
      async askDialog(
        questions: Array<{ id: string; question: string; options: Array<{ label: string }> }>,
      ) {
        return {
          kind: "submit" as const,
          results: questions.map((question) => ({
            id: question.id,
            selectedOptions: [question.options[0]?.label ?? "Accept"],
          })),
        };
      },
      async select(_title: string, options: Array<string | { label: string }>) {
        const first = options[0];
        return typeof first === "string" ? first : first?.label;
      },
    },
    async waitForIdle() {},
    isIdle() {
      return true;
    },
    sessionManager: { getSessionId: () => "e2e-session" },
    isProjectTrusted: () => true,
    model: { id: "test-model" },
  };
}

async function bootDevteam(root: string) {
  resetProgressFeed();
  process.env.DEVTEAM_E2E_AGENT_DIR = join(root, "agent");
  process.env.HOME = root;
  process.env.DEVTEAM_HOST = "pi";
  mkdirSync(process.env.DEVTEAM_E2E_AGENT_DIR, { recursive: true });

  const wrapper = join(root, "fake-pi");
  writeFileSync(
    wrapper,
    `#!/bin/sh\nexec ${JSON.stringify(process.execPath)} ${JSON.stringify(fakeChild)} "$@"\n`,
  );
  chmodSync(wrapper, 0o755);
  process.env.PI_SUBPROCESS_CMD = wrapper;

  const { default: activate } = await import("../src/index.ts");
  const host = createHost();
  activate(host.pi);
  const ctx = createContext(join(root, "repo"), host.notifications);
  mkdirSync(ctx.cwd, { recursive: true });
  writeFileSync(
    join(ctx.cwd, "package.json"),
    JSON.stringify({ name: "fixture", version: "0.0.0" }),
  );
  host.emit("session_start", {}, ctx);
  return { host, ctx, agentDir: process.env.DEVTEAM_E2E_AGENT_DIR };
}

test("/devteam survives the first planner prompt and ask picker", async () => {
  const root = mkdtempSync(join(tmpdir(), "devteam-e2e-"));
  const { host, ctx, agentDir } = await bootDevteam(root);
  const command = host.commands.get("devteam");
  assert.ok(command, "devteam command should register");

  await command.handler("Add a settings page for profile and notifications", ctx);

  const jobId = readCurrentJobId(agentDir, "e2e-session");
  assert.ok(jobId, "a job should be created after /devteam");
  const run = loadRun(runPaths(agentDir, jobId).json);
  assert.ok(run, "run state should persist");
  assert.equal(run.stage, "planner");
  assert.equal(run.task, "Add a settings page for profile and notifications");
  assert.ok(
    run.scoutItems?.some((item) => item.status === "done"),
    "scout wave should finish",
  );
  assert.match(
    host.messages.map((message) => message.text ?? "").join("\n"),
    /Start the \/devteam planner/,
  );

  const ask = host.tools.get("devteam_ask");
  assert.ok(ask, "devteam_ask should register");
  const result = (await ask.execute(
    "ask-1",
    {
      questions: [
        {
          id: "q1",
          question: "Where should settings live?",
          options: ["Existing settings route", "New top-level page"],
        },
      ],
    },
    undefined,
    undefined,
    ctx,
  )) as { content: Array<{ text: string }> };
  assert.match(result.content[0]?.text ?? "", /Existing settings route/);
  assert.equal(run.stage, "planner");
  assert.equal(run.halted, false);
  assert.notEqual(run.stage, "error");
});

test("/devteam status reports the canonical job state path", async () => {
  const root = mkdtempSync(join(tmpdir(), "devteam-status-"));
  const { host, ctx, agentDir } = await bootDevteam(root);
  const run = emptyRun("e2e-session", "status", "status-job");
  const canonicalPath = runPaths(agentDir, run.jobId).json;
  saveRun(canonicalPath, run, agentDir);
  writeCurrentJobId(agentDir, run.jobId, "e2e-session");
  host.emit("session_start", {}, ctx);

  await host.commands.get("devteam")!.handler("status", ctx);

  assert.ok(loadRun(canonicalPath), "canonical job state should exist");
  assert.ok(host.notifications.at(-1)?.includes(canonicalPath));
  assert.ok(!host.notifications.at(-1)?.includes(runPaths(agentDir, "e2e-session").json));
});

test("failed prerequisite is retried and blocked dependent never reaches review", async () => {
  const root = mkdtempSync(join(tmpdir(), "devteam-blocked-"));
  const { host, ctx, agentDir } = await bootDevteam(root);
  const run = {
    ...emptyRun("e2e-session", "implement dependency", "blocked-job"),
    stage: "implement" as const,
    cwd: ctx.cwd,
    workItems: [
      {
        id: "first",
        layer: "general" as const,
        title: "First",
        files: ["first.ts"],
        dependsOn: [],
        status: "pending" as const,
        attempts: 0,
      },
      {
        id: "second",
        layer: "general" as const,
        title: "Second",
        files: ["second.ts"],
        dependsOn: ["first"],
        status: "pending" as const,
        attempts: 0,
      },
    ],
  };
  saveRun(runPaths(agentDir, run.jobId).json, run, agentDir);
  await host.commands.get("devteam")!.handler(`continue ${run.jobId}`, ctx);
  const result = loadRun(runPaths(agentDir, run.jobId).json)!;
  assert.equal(result.stage, "implement");
  assert.equal(result.workItems?.[0]?.status, "failed");
  assert.equal(result.workItems?.[0]?.attempts, 2);
  assert.equal(result.workItems?.[1]?.status, "pending");
  assert.match(result.lastError ?? "", /blocked|failed/i);
});

test("session restart preserves ambiguous locked work until manually recovered", async () => {
  const root = mkdtempSync(join(tmpdir(), "devteam-restart-"));
  const { host, ctx, agentDir } = await bootDevteam(root);
  const run = {
    ...emptyRun("e2e-session", "resume", "restart-job"),
    stage: "implement" as const,
    pipelineLocked: true,
    workItems: [
      {
        id: "first",
        layer: "general" as const,
        title: "First",
        files: ["first.ts"],
        dependsOn: [],
        status: "running" as const,
        attempts: 1,
      },
    ],
  };
  saveRun(runPaths(agentDir, run.jobId).json, run, agentDir);
  writeCurrentJobId(agentDir, run.jobId, "e2e-session");
  host.emit("session_start", {}, ctx);
  const restored = loadRun(runPaths(agentDir, run.jobId).json)!;
  assert.equal(restored.pipelineLocked, true);
  assert.equal(restored.workItems?.[0]?.status, "running");
  await host.commands.get("devteam")!.handler(`continue ${run.jobId}`, ctx);
  assert.equal(loadRun(runPaths(agentDir, run.jobId).json)?.workItems?.[0]?.status, "running");
});

test("session startup and job selection do not reset an owned wave", async () => {
  const root = mkdtempSync(join(tmpdir(), "devteam-owned-"));
  const { host, ctx, agentDir } = await bootDevteam(root);
  const owned = {
    ...emptyRun("other-session", "active work", "owned-job"),
    stage: "implement" as const,
    pipelineLocked: true,
    pipelineOwner: "another-orchestrator",
    workItems: [
      {
        id: "active",
        layer: "general" as const,
        title: "Active",
        files: [],
        dependsOn: [],
        status: "running" as const,
        attempts: 1,
      },
    ],
  };
  const path = runPaths(agentDir, owned.jobId).json;
  saveRun(path, owned, agentDir);
  await host.commands.get("devteam")!.handler(`continue ${owned.jobId}`, ctx);
  assert.equal(loadRun(path)?.pipelineOwner, owned.pipelineOwner);
  assert.equal(loadRun(path)?.workItems?.[0]?.status, "running");
  writeCurrentJobId(agentDir, owned.jobId, "e2e-session");
  host.emit("session_start", {}, ctx);
  const restored = loadRun(path)!;
  assert.equal(restored.pipelineLocked, true);
  assert.equal(restored.pipelineOwner, owned.pipelineOwner);
  assert.equal(restored.workItems?.[0]?.status, "running");
});

test("exhausted scout failure does not advance to planner", async () => {
  const root = mkdtempSync(join(tmpdir(), "devteam-scout-failure-"));
  const { host, ctx, agentDir } = await bootDevteam(root);
  const run = {
    ...emptyRun("e2e-session", "scout", "scout-job"),
    stage: "scout" as const,
    scoutItems: [
      {
        id: "s1",
        title: "Map repo",
        files: [],
        status: "failed" as const,
        attempts: 2,
        error: "failed",
      },
    ],
  };
  saveRun(runPaths(agentDir, run.jobId).json, run, agentDir);
  await host.commands.get("devteam")!.handler(`continue ${run.jobId}`, ctx);
  const result = loadRun(runPaths(agentDir, run.jobId).json)!;
  assert.equal(result.stage, "scout");
  assert.match(result.lastError ?? "", /incomplete/i);
  await host.commands.get("devteam")!.handler("continue", ctx);
  const recovered = loadRun(runPaths(agentDir, run.jobId).json)!;
  assert.equal(recovered.stage, "planner");
  assert.equal(recovered.scoutItems?.[0]?.status, "done");
  assert.equal(recovered.scoutItems?.[0]?.attempts, 3);
});

test("headless plan review does not accept critic suggestions", async () => {
  const root = mkdtempSync(join(tmpdir(), "devteam-plan-consent-"));
  const { host, ctx, agentDir } = await bootDevteam(root);
  const run = {
    ...emptyRun("e2e-session", "plan", "plan-job"),
    stage: "plan_review" as const,
    planCritique: {
      notes: "Review",
      replacedScope: false,
      items: [{ id: "c1", title: "Suggestion", text: "Change plan" }],
    },
  };
  saveRun(runPaths(agentDir, run.jobId).json, run, agentDir);
  await host.commands.get("devteam")!.handler(`continue ${run.jobId}`, { ...ctx, hasUI: false });
  const result = loadRun(runPaths(agentDir, run.jobId).json)!;
  assert.equal(result.stage, "plan_review");
  assert.notEqual(result.planCritique?.items?.[0]?.decision, "accept");
  assert.match(result.lastError ?? "", /explicit decisions/i);
});

test("native assignment claims bind one active attempt to its actual agent", async () => {
  const root = mkdtempSync(join(tmpdir(), "devteam-native-"));
  const { ctx, agentDir } = await bootDevteam(root);
  const token = "01234567-89ab-cdef-0123-456789abcdef";
  const run = {
    ...emptyRun("parent", "task", "native1"),
    cwd: ctx.cwd,
    stage: "implement" as const,
    pipelineLocked: true,
    workItems: [
      {
        id: "one",
        layer: "general" as const,
        title: "One",
        files: ["src/a.ts"],
        dependsOn: [],
        status: "running" as const,
        attempts: 1,
        native: { token, attempt: 1, parentId: "Main", expectedAgentId: "Worker-2" },
      },
    ],
  };
  saveRun(runPaths(agentDir, run.jobId).json, run, agentDir);
  // Load after registering the test-only host module loader.
  const { default: activate } = await import("../src/index.ts");
  const worker = createHost();
  activate(worker.pi);
  const workerCtx = {
    ...ctx,
    agent: { kind: "sub", name: "devteam-implementor", id: "Worker-2", parentId: "Main" },
  };
  worker.emit("session_start", {}, workerCtx);
  const bind = worker.tools.get("devteam_bind")!;
  await assert.rejects(
    bind.execute("bad", { jobId: "../native1", token }, undefined, undefined, workerCtx),
  );
  await bind.execute("ok", { jobId: "native1", token }, undefined, undefined, workerCtx);
  assert.equal(
    loadRun(runPaths(agentDir, "native1").json)?.workItems?.[0]?.native?.agentId,
    "Worker-2",
  );
  await assert.rejects(
    bind.execute("other", { jobId: "native1", token }, undefined, undefined, {
      ...workerCtx,
      agent: { ...workerCtx.agent, id: "Intruder" },
    }),
  );
});

test("OMP native wave rewrites task and accepts only claimed settled result", async () => {
  const root = mkdtempSync(join(tmpdir(), "devteam-native-wave-"));
  const { host, ctx, agentDir } = await bootDevteam(root);
  process.env.DEVTEAM_HOST = "omp";
  const mainCtx = { ...ctx, agent: { kind: "main", id: "Main", name: "main" } };
  const run = {
    ...emptyRun("e2e-session", "implement feature", "nativewave1"),
    cwd: ctx.cwd,
    stage: "implement" as const,
    workItems: [
      {
        id: "one",
        layer: "general" as const,
        title: "One",
        files: ["src/a.ts"],
        dependsOn: [],
        status: "pending" as const,
        attempts: 0,
      },
    ],
  };
  const path = runPaths(agentDir, run.jobId).json;
  saveRun(path, run, agentDir);
  await host.commands.get("devteam")!.handler(`continue ${run.jobId}`, mainCtx);
  const assignment = loadRun(path)!.workItems![0];
  assert.equal(assignment.status, "running");
  const [rewrite] = host.emit(
    "tool_call",
    {
      toolName: "task",
      toolCallId: "call1",
      input: { context: "ignored", tasks: [{ task: "ignored", solutionSpace: "ignored" }] },
    },
    mainCtx,
  ) as Array<{ input: { tasks: Array<{ name: string; agent: string; task: string }> } }>;
  assert.equal(rewrite.input.tasks[0].name, assignment.native!.expectedAgentId);
  assert.equal(rewrite.input.tasks[0].agent, "devteam-implementor");
  assert.match(rewrite.input.tasks[0].task, new RegExp(assignment.native!.token));
  const { default: activate } = await import("../src/index.ts");
  const worker = createHost();
  activate(worker.pi);
  const workerCtx = {
    ...ctx,
    agent: {
      kind: "sub",
      name: "devteam-implementor",
      id: assignment.native!.expectedAgentId,
      parentId: "Main",
    },
  };
  worker.emit("session_start", {}, workerCtx);
  await worker.tools
    .get("devteam_bind")!
    .execute(
      "bind",
      { jobId: run.jobId, token: assignment.native!.token },
      undefined,
      undefined,
      workerCtx,
    );
  await worker.tools
    .get("devteam_handoff")!
    .execute("done", { action: "implementor_done" }, undefined, undefined, workerCtx);
  host.emit(
    "tool_result",
    {
      toolName: "task",
      toolCallId: "call1",
      details: { results: [{ id: assignment.native!.expectedAgentId, exitCode: 0 }] },
    },
    mainCtx,
  );
  assert.equal(loadRun(path)!.workItems![0].status, "done");
  assert.equal(loadRun(path)!.workItems![0].native, undefined);
});

test("startup preserves locked native work owned by another orchestrator", async () => {
  const root = mkdtempSync(join(tmpdir(), "devteam-native-recovery-"));
  const { host, ctx, agentDir } = await bootDevteam(root);
  const run = {
    ...emptyRun("e2e-session", "active native work", "nativeowned1"),
    cwd: ctx.cwd,
    stage: "implement" as const,
    pipelineLocked: true,
    pipelineOwner: "other-owner",
    workItems: [
      {
        id: "one",
        layer: "general" as const,
        title: "One",
        files: ["src/a.ts"],
        dependsOn: [],
        status: "running" as const,
        attempts: 1,
        native: {
          token: "01234567-89ab-cdef-0123-456789abcdef",
          attempt: 1,
          parentId: "Main",
          expectedAgentId: "Worker",
          agentId: "Worker",
        },
      },
    ],
  };
  const path = runPaths(agentDir, run.jobId).json;
  saveRun(path, run, agentDir);
  const originalItems = loadRun(path)!.workItems;
  writeCurrentJobId(agentDir, run.jobId, "e2e-session");
  host.emit("session_start", {}, ctx);
  const restored = loadRun(path)!;
  assert.equal(restored.pipelineOwner, "other-owner");
  assert.equal(restored.pipelineLocked, true);
  assert.deepEqual(restored.workItems, originalItems);
  await host.commands.get("devteam")!.handler("continue", ctx);
  assert.deepEqual(loadRun(path)!.workItems, originalItems);
  assert.ok(host.notifications.some((text) => text.includes("Native work may still be active")));
});

test("startup preserves locked native work without a recorded owner", async () => {
  const root = mkdtempSync(join(tmpdir(), "devteam-native-unowned-"));
  const { host, ctx, agentDir } = await bootDevteam(root);
  const run = {
    ...emptyRun("e2e-session", "active native work", "nativeunowned1"),
    cwd: ctx.cwd,
    stage: "implement" as const,
    pipelineLocked: true,
    workItems: [
      {
        id: "one",
        layer: "general" as const,
        title: "One",
        files: ["src/a.ts"],
        dependsOn: [],
        status: "running" as const,
        attempts: 1,
        native: {
          token: "01234567-89ab-cdef-0123-456789abcdef",
          attempt: 1,
          parentId: "Main",
          expectedAgentId: "Worker",
        },
      },
    ],
  };
  const path = runPaths(agentDir, run.jobId).json;
  saveRun(path, run, agentDir);
  const originalItems = loadRun(path)!.workItems;
  writeCurrentJobId(agentDir, run.jobId, "e2e-session");
  host.emit("session_start", {}, ctx);
  assert.equal(loadRun(path)!.pipelineLocked, true);
  assert.deepEqual(loadRun(path)!.workItems, originalItems);
  await host.commands.get("devteam")!.handler("stop", ctx);
  assert.equal(loadRun(path)!.pipelineLocked, true);
});

test("native stop invalidates in-flight result and retains stopped work", async () => {
  const root = mkdtempSync(join(tmpdir(), "devteam-native-stop-"));
  const { host, ctx, agentDir } = await bootDevteam(root);
  process.env.DEVTEAM_HOST = "omp";
  let aborted = false;
  const mainCtx = {
    ...ctx,
    abort: () => {
      aborted = true;
    },
    agent: { kind: "main", id: "Main", name: "main" },
  };
  const run = {
    ...emptyRun("e2e-session", "stop work", "nativestop1"),
    cwd: ctx.cwd,
    stage: "implement" as const,
    workItems: [
      {
        id: "one",
        layer: "general" as const,
        title: "One",
        files: ["src/a.ts"],
        dependsOn: [],
        status: "pending" as const,
        attempts: 0,
      },
    ],
  };
  const path = runPaths(agentDir, run.jobId).json;
  saveRun(path, run, agentDir);
  await host.commands.get("devteam")!.handler(`continue ${run.jobId}`, mainCtx);
  const item = loadRun(path)!.workItems![0];
  host.emit(
    "tool_call",
    {
      toolName: "task",
      toolCallId: "cancelled",
      input: { task: "ignored", solutionSpace: "ignored" },
    },
    mainCtx,
  );
  await host.commands.get("devteam")!.handler("stop", mainCtx);
  assert.equal(aborted, true);
  assert.equal(loadRun(path)!.halted, true);
  host.emit(
    "tool_result",
    {
      toolName: "task",
      toolCallId: "cancelled",
      details: { results: [{ id: item.native!.expectedAgentId, exitCode: 0 }] },
    },
    mainCtx,
  );
  assert.equal(loadRun(path)!.halted, true);
  assert.notEqual(loadRun(path)!.workItems![0].status, "done");
});

test("native flat task rewrite fails closed when result is missing", async () => {
  const root = mkdtempSync(join(tmpdir(), "devteam-native-flat-"));
  const { host, ctx, agentDir } = await bootDevteam(root);
  process.env.DEVTEAM_HOST = "omp";
  const mainCtx = { ...ctx, agent: { kind: "main", id: "Main", name: "main" } };
  const run = {
    ...emptyRun("e2e-session", "flat work", "nativeflat1"),
    cwd: ctx.cwd,
    stage: "implement" as const,
    workItems: [
      {
        id: "one",
        layer: "general" as const,
        title: "One",
        files: ["src/a.ts"],
        dependsOn: [],
        status: "pending" as const,
        attempts: 0,
      },
    ],
  };
  const path = runPaths(agentDir, run.jobId).json;
  saveRun(path, run, agentDir);
  await host.commands.get("devteam")!.handler(`continue ${run.jobId}`, mainCtx);
  const item = loadRun(path)!.workItems![0];
  const [rewrite] = host.emit(
    "tool_call",
    {
      toolName: "task",
      toolCallId: "flat",
      input: { steps: ["ignored"], solutionSpace: "ignored" },
    },
    mainCtx,
  ) as Array<{
    input: { name: string; agent: string; steps: string[]; tasks?: unknown };
  }>;
  assert.equal(rewrite.input.name, item.native!.expectedAgentId);
  assert.equal(rewrite.input.agent, "devteam-implementor");
  assert.match(rewrite.input.steps[0], new RegExp(item.native!.token));
  assert.equal(rewrite.input.tasks, undefined);
  host.emit(
    "tool_result",
    { toolName: "task", toolCallId: "flat", details: { results: [] } },
    mainCtx,
  );
  assert.equal(loadRun(path)!.workItems![0].status, "failed");
  assert.match(loadRun(path)!.workItems![0].error ?? "", /failed|handoff/i);
});

test("native recovery requires confirmation and refuses a known live owner", async () => {
  const root = mkdtempSync(join(tmpdir(), "devteam-recover-confirm-"));
  const { host, ctx, agentDir } = await bootDevteam(root);
  const run = {
    ...emptyRun("e2e-session", "recover", "recover-native"),
    stage: "implement" as const,
    pipelineLocked: true,
    pipelineOwner: "unknown-owner",
    workItems: [
      {
        id: "one",
        layer: "general" as const,
        title: "One",
        files: ["one.ts"],
        dependsOn: ["blocked"],
        status: "running" as const,
        attempts: 1,
        native: { token: "old-token", attempt: 1, parentId: "Main", expectedAgentId: "Old" },
      },
      {
        id: "blocked",
        layer: "general" as const,
        title: "Blocked",
        files: [],
        dependsOn: [],
        status: "failed" as const,
        attempts: 2,
      },
    ],
  };
  const path = runPaths(agentDir, run.jobId).json;
  saveRun(path, run, agentDir);
  writeCurrentJobId(agentDir, run.jobId, "e2e-session");
  host.emit("session_start", {}, ctx);
  await host.commands.get("devteam")!.handler("continue", ctx);
  assert.equal(loadRun(path)?.workItems?.[0]?.native?.token, "old-token");
  ctx.hasUI = false;
  await host.commands.get("devteam")!.handler("continue", ctx);
  assert.equal(loadRun(path)?.workItems?.[0]?.native?.token, "old-token");
  ctx.hasUI = true;
  ctx.ui.confirm = async () => true;
  saveRun(
    path,
    {
      ...run,
      workItems: [
        {
          ...run.workItems[0]!,
          native: { ...run.workItems[0]!.native, host: hostname(), pid: process.pid },
        },
      ],
    },
    agentDir,
  );
  await host.commands.get("devteam")!.handler("continue", ctx);
  assert.equal(loadRun(path)?.workItems?.[0]?.native?.token, "old-token");
  saveRun(path, run, agentDir);
  await host.commands.get("devteam")!.handler("continue", ctx);
  assert.equal(loadRun(path)?.workItems?.[0]?.native, undefined);
  assert.equal(loadRun(path)?.workItems?.[0]?.status, "pending");
});

test("late native result cannot modify or unlock a newer attempt", async () => {
  const root = mkdtempSync(join(tmpdir(), "devteam-stale-result-"));
  const { host, ctx, agentDir } = await bootDevteam(root);
  process.env.DEVTEAM_HOST = "omp";
  const mainCtx = { ...ctx, agent: { kind: "main", id: "Main", name: "main" } };
  const run = {
    ...emptyRun("e2e-session", "work", "stale-native"),
    cwd: ctx.cwd,
    stage: "implement" as const,
    workItems: [
      {
        id: "one",
        layer: "general" as const,
        title: "One",
        files: ["one.ts"],
        dependsOn: [],
        status: "pending" as const,
        attempts: 0,
      },
    ],
  };
  const path = runPaths(agentDir, run.jobId).json;
  saveRun(path, run, agentDir);
  await host.commands.get("devteam")!.handler(`continue ${run.jobId}`, mainCtx);
  const old = loadRun(path)!;
  host.emit(
    "tool_call",
    {
      toolName: "task",
      toolCallId: "old-call",
      input: { task: "ignored", solutionSpace: "ignored" },
    },
    mainCtx,
  );
  const item = old.workItems![0]!;
  const replacement = {
    ...old,
    pipelineLocked: true,
    workItems: [
      {
        ...item,
        attempts: item.attempts + 1,
        native: {
          ...item.native!,
          attempt: item.attempts + 1,
          token: "new-token",
          expectedAgentId: "NewAgent",
        },
      },
    ],
  };
  saveRun(path, replacement, agentDir);
  host.emit(
    "tool_result",
    {
      toolName: "task",
      toolCallId: "old-call",
      details: { results: [{ id: item.native!.expectedAgentId, exitCode: 0 }] },
    },
    mainCtx,
  );
  const after = loadRun(path)!;
  assert.equal(after.pipelineLocked, true);
  assert.deepEqual(after.workItems, replacement.workItems);
});
