import assert from "node:assert/strict";
import { test } from "node:test";
import {
  activityLine,
  createProgressParser,
  describeToolCall,
  isRepeatedToolLoop,
  isUsefulLabel,
  progressFromLine,
  resolveChildIdleMs,
  resolveMaxToolCalls,
  resolveRepeatToolAbort,
} from "../src/child-progress.ts";

test("tool calls keep the path, streamed tokens like hub do not", () => {
  assert.equal(describeToolCall("read", { path: "src/app/hub.tsx" }), "read src/app/hub.tsx");
  assert.equal(isUsefulLabel("hub", "text"), false);
  assert.equal(isUsefulLabel("the", "text"), false);
  assert.equal(isUsefulLabel("read src/app/hub.tsx", "tool"), true);
  assert.equal(progressFromLine(JSON.stringify({ type: "text", text: "hub" })), undefined);
  assert.equal(
    progressFromLine(JSON.stringify({ type: "tool", name: "read", input: { path: "src/app/hub.tsx" } }))?.label,
    "read src/app/hub.tsx",
  );
});

test("activity line names the last useful action and the call count", () => {
  const now = 1_000_000;
  const line = activityLine(
    { role: "frontend", startedAt: now - 72_000, label: "read src/app/hub.tsx", toolCalls: 12, lastEventAt: now, recentTools: [] },
    now,
  );
  assert.match(line, /frontend/);
  assert.match(line, /1:12/);
  assert.match(line, /12 tool calls/);
  assert.match(line, /read src\/app\/hub\.tsx/);
  assert.equal(line.includes(" · hub"), false);
});

test("tool-call budget defaults to 80 and clamps", () => {
  assert.equal(resolveMaxToolCalls(undefined), 80);
  assert.equal(resolveMaxToolCalls(0), 80);
  assert.equal(resolveMaxToolCalls(12), 12);
  assert.equal(resolveMaxToolCalls(9999), 400);
});

test("idle timeout defaults to 8 minutes and can be disabled", () => {
  assert.equal(resolveChildIdleMs(undefined), 480_000);
  assert.equal(resolveChildIdleMs(0), 0);
  assert.equal(resolveChildIdleMs(60), 60_000);
});

test("repeat-tool abort defaults to 8 and detects a stuck label", () => {
  assert.equal(resolveRepeatToolAbort(undefined), 8);
  assert.equal(resolveRepeatToolAbort(0), 0);
  assert.equal(isRepeatedToolLoop(["read a", "read a", "read a"], 3), true);
  assert.equal(isRepeatedToolLoop(["read a", "read b", "read a"], 3), false);
  assert.equal(isRepeatedToolLoop(["read a", "read a"], 3), false);
});

test("thinking and text token deltas are not tool calls", () => {
  assert.equal(
    progressFromLine(
      JSON.stringify({
        type: "message_update",
        assistantMessageEvent: { type: "thinking_delta", contentIndex: 0, delta: "see" },
      }),
    ),
    undefined,
  );
  assert.equal(
    progressFromLine(
      JSON.stringify({
        type: "message_update",
        assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: "I" },
      }),
    ),
    undefined,
  );
  assert.equal(
    progressFromLine(
      JSON.stringify({
        type: "message_update",
        assistantMessageEvent: { type: "toolcall_delta", contentIndex: 1, delta: '{"path"' },
      }),
    ),
    undefined,
  );
});

test("Oh My Pi tool_stream_update chunks are not new tool calls", () => {
  assert.equal(
    progressFromLine(JSON.stringify({ type: "tool_stream_update", toolCallId: "call_1", toolName: "read" })),
    undefined,
  );
  const parser = createProgressParser();
  const chunks = Array.from({ length: 12 }, () =>
    JSON.stringify({ type: "tool_stream_update", toolCallId: "call_1", toolName: "read" }),
  );
  const tools = parser.push(`${chunks.join("\n")}\n`).filter((update) => update.kind === "tool");
  assert.equal(tools.length, 0);
});

test("tool_execution_update is the same call, not a new one", () => {
  const start = progressFromLine(
    JSON.stringify({
      type: "tool_execution_start",
      toolCallId: "call_1",
      toolName: "read",
      args: { path: "skills/grilling/SKILL.md" },
    }),
  );
  assert.equal(start?.kind, "tool");
  assert.match(start?.label ?? "", /read .*SKILL\.md/);
  assert.equal(
    progressFromLine(
      JSON.stringify({
        type: "tool_execution_update",
        toolCallId: "call_1",
        toolName: "read",
        args: { path: "skills/grilling/SKILL.md" },
        partialResult: { content: [{ type: "text", text: "more of the file" }] },
      }),
    ),
    undefined,
  );
  assert.equal(
    progressFromLine(
      JSON.stringify({
        type: "tool_execution_end",
        toolCallId: "call_1",
        toolName: "read",
        result: { content: [{ type: "text", text: "full file" }] },
        isError: false,
      }),
    ),
    undefined,
  );
});

test("a streamed read plus thinking tokens is one tool call, not a repeat loop", () => {
  const parser = createProgressParser();
  const lines = [
    { type: "session", version: 3, id: "s1" },
    { type: "agent_start" },
    { type: "turn_start" },
    {
      type: "message_update",
      assistantMessageEvent: { type: "thinking_delta", contentIndex: 0, delta: "Checking" },
    },
    {
      type: "message_update",
      assistantMessageEvent: { type: "thinking_delta", contentIndex: 0, delta: " skills" },
    },
    {
      type: "message_update",
      assistantMessageEvent: { type: "thinking_delta", contentIndex: 0, delta: " availability" },
    },
    {
      type: "message_update",
      assistantMessageEvent: { type: "toolcall_start", contentIndex: 1, id: "call_1", toolName: "read" },
    },
    {
      type: "tool_execution_start",
      toolCallId: "call_1",
      toolName: "read",
      args: { path: "roles/planner_orchestrator.md" },
    },
    ...Array.from({ length: 12 }, () => ({
      type: "tool_execution_update",
      toolCallId: "call_1",
      toolName: "read",
      args: { path: "roles/planner_orchestrator.md" },
    })),
    {
      type: "tool_execution_end",
      toolCallId: "call_1",
      toolName: "read",
      result: { content: [{ type: "text", text: "prompt" }] },
      isError: false,
    },
  ];
  const updates = parser.push(`${lines.map((event) => JSON.stringify(event)).join("\n")}\n`);
  const tools = updates.filter((update) => update.kind === "tool").map((update) => update.label);
  assert.equal(tools.length, 1);
  assert.equal(isRepeatedToolLoop(tools, 8), false);
});
