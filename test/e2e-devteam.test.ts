import assert from "node:assert/strict";
import { chmodSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { register } from "node:module";
import { test } from "node:test";
import { resetProgressFeed } from "../src/ui-progress.ts";
import { loadRun, readCurrentJobId, runPaths } from "../src/state.ts";

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
