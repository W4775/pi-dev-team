import assert from "node:assert/strict";
import { test } from "node:test";
import {
  applyChrome,
  formatProgressBlock,
  lifecycleText,
  postSessionLine,
  progressGroupKey,
  resetProgressFeed,
  roleLabel,
  stageLabel,
  tickProgressFeed,
  toolLogText,
  widgetLine,
} from "../src/ui-progress.ts";
import { emptyRun } from "../src/state.ts";
import type { ChildActivity } from "../src/child-progress.ts";

function activity(partial: Partial<ChildActivity> & Pick<ChildActivity, "role" | "startedAt">): ChildActivity {
  return {
    label: "",
    toolCalls: 0,
    lastEventAt: partial.startedAt,
    recentTools: [],
    ...partial,
  };
}

test("widget is one line: step, role, elapsed", () => {
  const now = 1_000_000;
  const run = { ...emptyRun("s", "task"), stage: "implement" as const, currentRole: "backend" as const };
  assert.equal(widgetLine(run, [], now), "implement · backend");
  assert.equal(
    widgetLine(
      run,
      [activity({ role: "backend", startedAt: now - 83_000, label: "read src/api.ts" })],
      now,
    ),
    "implement · backend · 1:23",
  );
  assert.equal(widgetLine({ ...run, stage: "plan_review", halted: true }, [], now), "stopped · plan review");
});

test("widget names parallel children without extra help text", () => {
  const now = 1_000_000;
  const run = { ...emptyRun("s", "task"), stage: "scout" as const };
  const line = widgetLine(
    run,
    [
      activity({ role: "scout/ui", startedAt: now - 5_000 }),
      activity({ role: "scout/api", startedAt: now - 4_000 }),
    ],
    now,
  );
  assert.equal(line, "scout · scout/ui, scout/api · 0:05");
});

test("stage and role labels are short", () => {
  assert.equal(stageLabel("scout_orchestrate"), "scout");
  assert.equal(stageLabel("plan_critic"), "plan critic");
  assert.equal(roleLabel("planner_orchestrator"), "planner orchestrator");
});

test("lifecycle and tool log copy", () => {
  assert.equal(lifecycleText("start", "backend"), "Starting backend");
  assert.equal(lifecycleText("finish", "backend", { elapsed: "1:23", toolCalls: 14 }), "backend finished in 1:23 · 14 tool calls");
  assert.equal(toolLogText("backend", "read src/api.ts"), "backend  read src/api.ts");
});

test("progress groups parallel children of the same role", () => {
  assert.equal(progressGroupKey({ role: "plan_critic" }), "plan_critic");
  assert.equal(progressGroupKey({ role: "scout/ui" }), "scout");
  assert.equal(progressGroupKey({ role: "backend/api" }), "backend");
});

test("progress block lists actions under one header", () => {
  const text = formatProgressBlock(
    {
      id: "plan_critic-1",
      groupKey: "plan_critic",
      status: "running",
      startedAt: 0,
      activeCount: 1,
      toolCalls: 2,
      lines: ["plan critic  read spec.md", "plan critic  state get"],
    },
    12_000,
  );
  assert.equal(
    text,
    ["plan critic · 0:12 · 2 tools", "  plan critic  read spec.md", "  plan critic  state get"].join("\n"),
  );
});

test("one role's tools update a single transcript message", () => {
  resetProgressFeed();
  const now = 1_000_000;
  const messages: Array<{ content: string; display?: boolean; details?: { id?: string } }> = [];
  const options: Array<{ triggerTurn?: boolean } | undefined> = [];
  const pi = {
    sendMessage: (message: { content: string; display?: boolean }, opts?: { triggerTurn?: boolean }) => {
      messages.push(message);
      options.push(opts);
    },
  };
  assert.equal(
    postSessionLine(pi, { kind: "start", text: "Starting plan critic", role: "plan_critic" }, { now }),
    "message",
  );
  assert.equal(
    postSessionLine(
      pi,
      { kind: "tool", text: "plan critic  read spec.md", role: "plan_critic", label: "read spec.md" },
      { now: now + 4_000 },
    ),
    "message",
  );
  assert.equal(
    postSessionLine(
      pi,
      { kind: "tool", text: "plan critic  state get", role: "plan_critic", label: "state get" },
      { now: now + 8_000 },
    ),
    "message",
  );
  assert.equal(
    postSessionLine(
      pi,
      { kind: "finish", text: "plan critic finished in 0:12 · 2 tool calls", role: "plan_critic" },
      { now: now + 12_000 },
    ),
    "message",
  );
  assert.equal(messages.length, 1);
  assert.match(messages[0].content, /^plan critic finished in 0:12 · 2 tool calls\n  plan critic  read spec.md\n  plan critic  state get$/);
  assert.equal(messages[0].display, true);
  assert.equal(options.every((opts) => opts?.triggerTurn === false), true);
});

test("parallel scouts share one block; a later critic pass is a new message", () => {
  resetProgressFeed();
  const now = 1_000_000;
  const messages: Array<{ content: string }> = [];
  const pi = {
    sendMessage: (message: { content: string }) => {
      messages.push(message);
    },
  };
  postSessionLine(pi, { kind: "start", text: "Starting scout/ui", role: "scout/ui" }, { now });
  postSessionLine(pi, { kind: "start", text: "Starting scout/api", role: "scout/api" }, { now });
  postSessionLine(
    pi,
    { kind: "tool", text: "scout/ui  read src/App.tsx", role: "scout/ui", label: "read src/App.tsx" },
    { now: now + 1_000 },
  );
  postSessionLine(
    pi,
    { kind: "tool", text: "scout/api  grep handler", role: "scout/api", label: "grep handler" },
    { now: now + 2_000 },
  );
  assert.equal(messages.length, 1);
  assert.match(messages[0].content, /scout\/ui {2}read src\/App\.tsx/);
  assert.match(messages[0].content, /scout\/api {2}grep handler/);

  postSessionLine(pi, { kind: "finish", text: "scout/ui finished", role: "scout/ui" }, { now: now + 3_000 });
  postSessionLine(pi, { kind: "finish", text: "scout/api finished", role: "scout/api" }, { now: now + 5_000 });
  assert.equal(messages.length, 1);

  postSessionLine(pi, { kind: "start", text: "Starting plan critic", role: "plan_critic" }, { now: now + 6_000 });
  assert.equal(messages.length, 2);
  postSessionLine(pi, { kind: "finish", text: "plan critic finished", role: "plan_critic" }, { now: now + 7_000 });
  postSessionLine(pi, { kind: "start", text: "Starting plan critic", role: "plan_critic" }, { now: now + 8_000 });
  assert.equal(messages.length, 3);
});

test("does not sendMessage while the parent turn is streaming (that would steer)", () => {
  resetProgressFeed();
  const messages: unknown[] = [];
  const entries: unknown[] = [];
  const pi = {
    sendMessage: (message: unknown) => {
      messages.push(message);
    },
    appendEntry: (_type: string, data: unknown) => {
      entries.push(data);
    },
  };
  assert.equal(
    postSessionLine(pi, { kind: "tool", text: "backend  edit src/api.ts", role: "backend" }, { streaming: true }),
    "entry",
  );
  assert.equal(
    postSessionLine(pi, { kind: "tool", text: "backend  write src/api.ts", role: "backend" }, { streaming: true }),
    "entry",
  );
  assert.equal(messages.length, 0);
  assert.equal(entries.length, 1);
});

test("updates the persisted custom_message so a transcript rebuild keeps the stack", () => {
  resetProgressFeed();
  const entry: { type: string; customType: string; content: string; details?: unknown } = {
    type: "custom_message",
    customType: "devteam",
    content: "",
  };
  const pi = {
    sendMessage: (message: { content: string; details?: unknown }) => {
      entry.content = message.content;
      entry.details = message.details;
    },
  };
  const sessionManager = { getEntries: () => [entry] };
  postSessionLine(pi, { kind: "start", text: "Starting backend", role: "backend" }, { sessionManager });
  postSessionLine(
    pi,
    { kind: "tool", text: "backend  edit src/api.ts", role: "backend", label: "edit src/api.ts" },
    { sessionManager },
  );
  assert.match(entry.content, /backend {2}edit src\/api\.ts/);
});

test("running progress block elapsed ticks without a new tool event", () => {
  resetProgressFeed();
  const now = 1_000_000;
  const messages: Array<{ content: string }> = [];
  const pi = {
    sendMessage: (message: { content: string }) => {
      messages.push(message);
    },
  };
  postSessionLine(pi, { kind: "start", text: "Starting frontend", role: "frontend" }, { now });
  assert.match(messages[0]?.content ?? "", /frontend · 0:00/);
  tickProgressFeed({ now: now + 45_000 });
  assert.match(messages[0]?.content ?? "", /frontend · 0:45/);
});

test("without sendMessage, appendEntry still records the stack", () => {
  resetProgressFeed();
  const entries: Array<{ text?: string }> = [];
  const pi = {
    appendEntry: (_type: string, data: { text?: string }) => {
      entries.push(data);
    },
  };
  assert.equal(postSessionLine(pi, { kind: "tool", text: "backend  read src/api.ts", role: "backend" }), "entry");
  assert.equal(postSessionLine(pi, { kind: "tool", text: "backend  write src/api.ts", role: "backend" }), "entry");
  assert.equal(entries.length, 1);
  assert.match(String(entries[0].text), /backend {2}read src\/api\.ts/);
  assert.match(String(entries[0].text), /backend {2}write src\/api\.ts/);
});

test("applyChrome writes a one-line widget and clears the loader and footer", () => {
  const widgets: unknown[] = [];
  const working: unknown[] = [];
  const visible: unknown[] = [];
  const status: unknown[] = [];
  const ctx = {
    hasUI: true,
    ui: {
      setWidget: (_key: string, content: unknown) => {
        widgets.push(content);
      },
      setStatus: (_key: string, text: unknown) => {
        status.push(text);
      },
      setWorkingMessage: (message?: string) => {
        working.push(message);
      },
      setWorkingVisible: (show: boolean) => {
        visible.push(show);
      },
    },
  };
  const now = 1_000_000;
  applyChrome(
    ctx,
    { ...emptyRun("s", "task"), stage: "implement", currentRole: "backend" },
    [activity({ role: "backend", startedAt: now - 5_000, lastEventAt: now, label: "read src/api.ts" })],
    now,
  );
  assert.deepEqual(widgets.at(-1), ["implement · backend · 0:05"]);
  assert.equal(working.at(-1), undefined);
  assert.equal(visible.at(-1), false);
  assert.equal(status.at(-1), undefined);
});
