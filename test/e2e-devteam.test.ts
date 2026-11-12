import assert from "node:assert/strict";
import { chmodSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
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

  const builtins = ["read", "grep", "find", "ls", "glob", "bash", "ask"].map((name) => ({
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
    for (const handler of listeners.get(event) ?? []) handler(payload, ctx);
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
