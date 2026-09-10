import assert from "node:assert/strict";
import { test } from "node:test";
import {
  activityLine,
  createProgressParser,
  describeToolCall,
  isMutatingToolLabel,
  isRepeatedToolLoop,
  isUsefulLabel,
  progressFromLine,
  resolveChildIdleMs,
  resolveMaxToolCalls,
  resolveRepeatToolAbort,
} from "../src/child-progress.ts";

test("tool calls keep the path, streamed tokens like hub do not", () => {
  assert.equal(describeToolCall("read", { path: "src/app/hub.tsx" }), "read src/app/hub.tsx");
  assert.equal(describeToolCall("read", { path: "src/app/hub.tsx", offset: 80, limit: 80 }), "read src/app/hub.tsx:80+80");
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

test("tool-call budget is higher for implementors and the reviewer", () => {
  assert.equal(resolveMaxToolCalls(undefined), 80);
  assert.equal(resolveMaxToolCalls(undefined, "plan_critic"), 80);
  assert.equal(resolveMaxToolCalls(undefined, "backend"), 200);
  assert.equal(resolveMaxToolCalls(undefined, "reviewer"), 200);
  assert.equal(resolveMaxToolCalls(undefined, "scout"), 40);
  assert.equal(resolveMaxToolCalls(0, "backend"), 200);
  assert.equal(resolveMaxToolCalls(12, "backend"), 12);
  assert.equal(resolveMaxToolCalls(9999, "reviewer"), 400);
  assert.equal(resolveMaxToolCalls(9999, "scout"), 40);
});

test("idle timeout defaults to 8 minutes and can be disabled", () => {
  assert.equal(resolveChildIdleMs(undefined), 480_000);
  assert.equal(resolveChildIdleMs(0), 0);
  assert.equal(resolveChildIdleMs(60), 60_000);
});

test("repeat-tool abort ignores edits, bare names, and paginated reads", () => {
  assert.equal(resolveRepeatToolAbort(undefined), 8);
  assert.equal(resolveRepeatToolAbort(0), 0);
  assert.equal(isMutatingToolLabel("edit src/app/page.tsx"), true);
  assert.equal(isMutatingToolLabel("read src/app/page.tsx"), false);
  const edits = Array.from({ length: 8 }, () => "edit src/app/hub.tsx");
  assert.equal(isRepeatedToolLoop(edits, 8), false);
  const writes = Array.from({ length: 8 }, () => "write src/app/hub.tsx");
  assert.equal(isRepeatedToolLoop(writes, 8), false);
  const bash = Array.from({ length: 8 }, () => "bash: npm test");
  assert.equal(isRepeatedToolLoop(bash, 8), false);
  const bareReads = Array.from({ length: 8 }, () => "read");
  assert.equal(isRepeatedToolLoop(bareReads, 8), false);
  assert.equal(isRepeatedToolLoop(["read a", "read a", "read a"], 3), true);
  assert.equal(isRepeatedToolLoop(["read a", "read b", "read a"], 3), false);
  assert.equal(isRepeatedToolLoop(["read a", "read a"], 3), false);
  assert.equal(
    isRepeatedToolLoop(["read src/app/hub.tsx:0+80", "read src/app/hub.tsx:80+80", "read src/app/hub.tsx:160+80"], 3),
    false,
  );
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

test("duplicate events for the same toolCallId count as one call", () => {
  const parser = createProgressParser();
  const lines = [
    { type: "tool_execution_start", toolCallId: "call_1", toolName: "edit", args: { path: "src/app/hub.tsx" } },
    { type: "tool", name: "edit", id: "call_1", input: { path: "src/app/hub.tsx" } },
    { type: "tool_execution_start", toolCallId: "call_1", toolName: "edit", args: { path: "src/app/hub.tsx" } },
  ];
  const tools = parser.push(`${lines.map((event) => JSON.stringify(event)).join("\n")}\n`).filter((update) => update.kind === "tool");
  assert.equal(tools.length, 1);
});

test("eight frontend edits of the same file are not a stuck loop", () => {
  const parser = createProgressParser();
  const lines = Array.from({ length: 8 }, (_, i) => ({
    type: "tool_execution_start",
    toolCallId: `edit_${i}`,
    toolName: "edit",
    args: { path: "src/app/hub.tsx" },
  }));
  const tools = parser.push(`${lines.map((event) => JSON.stringify(event)).join("\n")}\n`).filter((update) => update.kind === "tool");
  assert.equal(tools.length, 8);
  assert.equal(isRepeatedToolLoop(tools.map((update) => update.label), 8), false);
});

test("eight start events with no path do not abort as identical reads", () => {
  const parser = createProgressParser();
  const lines = Array.from({ length: 8 }, (_, i) => ({
    type: "tool_execution_start",
    toolCallId: `read_${i}`,
    toolName: "read",
  }));
  const tools = parser.push(`${lines.map((event) => JSON.stringify(event)).join("\n")}\n`).filter((update) => update.kind === "tool");
  assert.equal(tools.length, 8);
  assert.equal(tools.every((update) => update.label === "read"), true);
  assert.equal(isRepeatedToolLoop(tools.map((update) => update.label), 8), false);
});
