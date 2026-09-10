import assert from "node:assert/strict";
import { test } from "node:test";
import {
  applyChrome,
  lifecycleText,
  postSessionLine,
  roleLabel,
  stageLabel,
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

test("every tool is posted to the transcript so the stack is visible live", () => {
  const messages: Array<{ content: string; display?: boolean } > = [];
  const options: Array<{ triggerTurn?: boolean } | undefined> = [];
  const pi = {
    sendMessage: (message: { content: string; display?: boolean }, opts?: { triggerTurn?: boolean }) => {
      messages.push(message);
      options.push(opts);
    },
  };
  assert.equal(postSessionLine(pi, { kind: "start", text: "Starting backend" }), "message");
  assert.equal(postSessionLine(pi, { kind: "tool", text: "backend  edit src/api.ts", role: "backend" }), "message");
  assert.equal(postSessionLine(pi, { kind: "tool", text: "backend  write src/api.ts", role: "backend" }), "message");
  assert.equal(postSessionLine(pi, { kind: "finish", text: "backend finished in 0:12 · 2 tool calls" }), "message");
  assert.deepEqual(
    messages.map((message) => message.content),
    ["Starting backend", "backend  edit src/api.ts", "backend  write src/api.ts", "backend finished in 0:12 · 2 tool calls"],
  );
  assert.equal(messages.every((message) => message.display === true), true);
  assert.equal(options.every((opts) => opts?.triggerTurn === false), true);
});

test("does not sendMessage while the parent turn is streaming (that would steer)", () => {
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
    postSessionLine(pi, { kind: "tool", text: "backend  edit src/api.ts" }, { streaming: true }),
    "entry",
  );
  assert.equal(messages.length, 0);
  assert.equal(entries.length, 1);
});

test("without sendMessage, appendEntry still records the stack", () => {
  const entries: unknown[] = [];
  const pi = {
    appendEntry: (_type: string, data: unknown) => {
      entries.push(data);
    },
  };
  assert.equal(postSessionLine(pi, { kind: "tool", text: "backend  read src/api.ts" }), "entry");
  assert.equal(entries.length, 1);
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
