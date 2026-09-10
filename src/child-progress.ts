/**
 * Isolated children run with `--mode json`. This turns each event into a
 * one-line label, and throws away streamed tokens that are not a real action
 * ("hub", "the", a single path fragment).
 */

import {
  DEFAULT_BUILD_TOOL_CALLS,
  DEFAULT_MAX_TOOL_CALLS,
  DEFAULT_REPEAT_TOOL_ABORT,
  MAX_TOOL_CALLS_CAP,
  SCOUT_MAX_TOOL_CALLS,
} from "./types.ts";

export type ProgressUpdate = {
  kind: "tool" | "text";
  label: string;
  toolCallId?: string;
};

const MUTATING_TOOL_PREFIX = /^(edit|write|bash|handoff|mockup)\b/i;

const TOOL_EVENT_TYPES = new Set([
  "tool",
  "toolCall",
  "tool_call",
  "tool-call",
  "tool_use",
  "tool-use",
  "tool_start",
  "tool_started",
  "assistant_tool_call",
]);

const TEXT_EVENT_TYPES = new Set(["text", "assistant", "assistant_message", "message", "content"]);
const PATH_KEYS = ["path", "file", "file_path", "filePath", "target", "filename", "notebook_path"];
const COMMAND_KEYS = ["command", "cmd", "script"];
const QUERY_KEYS = ["pattern", "query", "regex", "search"];

function firstString(source: Record<string, unknown> | undefined, keys: string[]): string | undefined {
  if (!source) return undefined;
  for (const key of keys) {
    const value = source[key];
    if (typeof value === "string" && value.trim()) return value.trim();
  }
  return undefined;
}

function firstNumber(source: Record<string, unknown> | undefined, keys: string[]): string | undefined {
  if (!source) return undefined;
  for (const key of keys) {
    const value = source[key];
    if (typeof value === "number" && Number.isFinite(value)) return String(value);
    if (typeof value === "string" && value.trim() && Number.isFinite(Number(value))) return value.trim();
  }
  return undefined;
}

function toolArgs(node: Record<string, unknown> | undefined): Record<string, unknown> | undefined {
  if (!node) return undefined;
  const direct = node.input ?? node.args ?? node.parameters ?? node.arguments;
  if (direct && typeof direct === "object" && !Array.isArray(direct)) {
    return direct as Record<string, unknown>;
  }
  const call = node.toolCall;
  if (call && typeof call === "object" && !Array.isArray(call)) {
    const nested = call as Record<string, unknown>;
    const fromCall = nested.arguments ?? nested.input ?? nested.args ?? nested.parameters;
    if (fromCall && typeof fromCall === "object" && !Array.isArray(fromCall)) {
      return fromCall as Record<string, unknown>;
    }
  }
  return undefined;
}

function toolCallIdOf(node: Record<string, unknown>, type = ""): string | undefined {
  const fromField = firstString(node, ["toolCallId"]);
  if (fromField) return fromField;
  // `id` is the call id on toolcall_start / content items. It is *not* safe
  // on tool_execution_start — hosts also put a session or envelope id there,
  // which would drop every tool after the first.
  if (
    type === "toolcall_start" ||
    type === "tool" ||
    type === "toolCall" ||
    type === "tool_call" ||
    type === "tool-call" ||
    type === "tool_use" ||
    type === "tool-use" ||
    type === "assistant_tool_call"
  ) {
    return firstString(node, ["id", "callId"]);
  }
  return undefined;
}

function shorten(text: string, max: number): string {
  const clean = text.replace(/\s+/g, " ").trim();
  return clean.length > max ? `${clean.slice(0, max - 1)}…` : clean;
}

function tail(path: string, segments = 3): string {
  const parts = path.replaceAll("\\", "/").split("/").filter(Boolean);
  return parts.length <= segments ? path.replaceAll("\\", "/") : `…/${parts.slice(-segments).join("/")}`;
}

export function describeToolCall(name: string, input: unknown): string {
  const tool = name.trim();
  const args = input && typeof input === "object" && !Array.isArray(input) ? (input as Record<string, unknown>) : undefined;
  const path = firstString(args, PATH_KEYS);
  const command = firstString(args, COMMAND_KEYS);
  const query = firstString(args, QUERY_KEYS);

  if (tool === "bash" && command) return `bash: ${shorten(command, 60)}`;
  if (tool === "devteam_handoff") {
    const action = firstString(args, ["action"]);
    return action ? `handoff: ${action}` : "handoff";
  }
  if (tool === "devteam_state") {
    const action = firstString(args, ["action"]) ?? "get";
    const section = firstString(args, ["section"]);
    return section ? `state ${action} ${section}` : `state ${action}`;
  }
  if (tool === "devteam_mockup") {
    const action = firstString(args, ["action"]) ?? "write";
    return `mockup ${action}`;
  }
  if (path) {
    const offset = firstNumber(args, ["offset", "offsetLines", "startLine", "start"]);
    const limit = firstNumber(args, ["limit", "line_limit", "count", "endLine"]);
    const range = offset || limit ? `:${offset ?? "0"}+${limit ?? "?"}` : "";
    return `${tool} ${tail(path)}${range}`;
  }
  if (query) return `${tool} "${shorten(query, 40)}"`;
  if (command) return `${tool}: ${shorten(command, 60)}`;
  return tool;
}

/**
 * Streamed assistant text arrives as one token at a time. A lone word like
 * "hub" is not a status — only keep labels that name a tool, a path, or a
 * full sentence.
 */
export function isUsefulLabel(label: string, kind: "tool" | "text"): boolean {
  const text = label.replace(/\s+/g, " ").trim();
  if (!text) return false;
  if (kind === "tool") return text.length >= 2;
  if (/[./\\:]/.test(text) || /\s/.test(text)) return text.length >= 8;
  return text.length >= 16;
}

function updateFromContentItem(item: unknown): ProgressUpdate | undefined {
  if (!item || typeof item !== "object") return undefined;
  const node = item as Record<string, unknown>;
  const type = typeof node.type === "string" ? node.type : "";
  if (TOOL_EVENT_TYPES.has(type)) {
    const name = firstString(node, ["name", "toolName", "tool"]);
    if (!name) return undefined;
    const label = describeToolCall(name, toolArgs(node));
    return isUsefulLabel(label, "tool")
      ? { kind: "tool", label, toolCallId: toolCallIdOf(node, type) }
      : undefined;
  }
  const text = firstString(node, ["text", "content"]);
  if (text && isUsefulLabel(text, "text")) return { kind: "text", label: shorten(text, 100) };
  return undefined;
}

const TOOL_START_TYPES = new Set([...TOOL_EVENT_TYPES, "tool_execution_start"]);

/** Streaming / lifecycle events. Never treat these as a new tool call. */
const IGNORE_TYPES = new Set([
  "session",
  "agent_start",
  "agent_end",
  "turn_start",
  "turn_end",
  "message_start",
  "message_end",
  "thinking_start",
  "thinking_delta",
  "thinking_end",
  "thinking_level_changed",
  "text_start",
  "text_delta",
  "text_end",
  "toolcall_delta",
  "toolcall_end",
  "tool_execution_update",
  "tool_execution_end",
  // Oh My Pi `--mode json` emits one of these per streamed tool chunk, with
  // top-level `toolName`. Counting them as calls aborts after one `read`.
  "tool_stream_update",
  "auto_compaction_start",
  "auto_compaction_end",
  "auto_retry_start",
  "auto_retry_end",
  "notice",
  "done",
]);

function toolLabel(node: Record<string, unknown>, type = ""): ProgressUpdate | undefined {
  const name = firstString(node, ["toolName", "tool", "name"]);
  if (!name) return undefined;
  const label = describeToolCall(name, toolArgs(node));
  return isUsefulLabel(label, "tool")
    ? { kind: "tool", label, toolCallId: toolCallIdOf(node, type || String(node.type ?? "")) }
    : undefined;
}

export function progressFromEvent(event: unknown): ProgressUpdate | undefined {
  if (!event || typeof event !== "object") return undefined;
  const node = event as Record<string, unknown>;
  const type = typeof node.type === "string" ? node.type : "";

  if (type === "message_update") {
    const inner = node.assistantMessageEvent;
    if (inner && typeof inner === "object") return progressFromEvent(inner);
    return undefined;
  }

  if (IGNORE_TYPES.has(type)) return undefined;

  if (type === "toolcall_start") {
    const update = toolLabel(node, type);
    if (!update) return undefined;
    // Count the start as the call. Later tool_execution_start with the same
    // toolCallId is de-duped; a richer label (path) still updates the UI.
    return { ...update, toolCallId: update.toolCallId ?? firstString(node, ["id", "callId"]) };
  }

  if (TOOL_START_TYPES.has(type)) return toolLabel(node, type);

  const message = node.message;
  if (message && typeof message === "object") {
    const content = (message as Record<string, unknown>).content;
    if (Array.isArray(content)) {
      for (let i = content.length - 1; i >= 0; i -= 1) {
        const update = updateFromContentItem(content[i]);
        if (update) return update;
      }
    }
    const text = firstString(message as Record<string, unknown>, ["text", "content"]);
    if (text && isUsefulLabel(text, "text")) return { kind: "text", label: shorten(text, 100) };
  }

  if (Array.isArray(node.content)) {
    for (let i = node.content.length - 1; i >= 0; i -= 1) {
      const update = updateFromContentItem(node.content[i]);
      if (update) return update;
    }
  }

  if (TEXT_EVENT_TYPES.has(type) || !type) {
    const text = firstString(node, ["text", "content", "delta"]);
    if (text && isUsefulLabel(text, "text")) return { kind: "text", label: shorten(text, 100) };
  }

  return undefined;
}

export function progressFromLine(line: string): ProgressUpdate | undefined {
  const trimmed = line.trim();
  if (!trimmed || !trimmed.startsWith("{")) return undefined;
  try {
    return progressFromEvent(JSON.parse(trimmed));
  } catch {
    return undefined;
  }
}

export function createProgressParser(): {
  push(chunk: string): ProgressUpdate[];
  flush(): ProgressUpdate[];
} {
  let buffer = "";
  const seenToolCalls = new Set<string>();
  const lastLabel = new Map<string, string>();
  const take = (update: ProgressUpdate | undefined): ProgressUpdate | undefined => {
    if (!update) return undefined;
    if (update.kind === "tool" && update.toolCallId) {
      if (seenToolCalls.has(update.toolCallId)) {
        if (update.label && update.label !== lastLabel.get(update.toolCallId)) {
          lastLabel.set(update.toolCallId, update.label);
          return { kind: "text", label: update.label };
        }
        return undefined;
      }
      seenToolCalls.add(update.toolCallId);
      lastLabel.set(update.toolCallId, update.label);
    }
    return update;
  };
  return {
    push(chunk: string): ProgressUpdate[] {
      buffer += chunk;
      const lines = buffer.split(/\r?\n/);
      buffer = lines.pop() ?? "";
      const updates: ProgressUpdate[] = [];
      for (const line of lines) {
        const update = take(progressFromLine(line));
        if (update) updates.push(update);
      }
      return updates;
    },
    flush(): ProgressUpdate[] {
      const rest = buffer;
      buffer = "";
      const update = take(progressFromLine(rest));
      return update ? [update] : [];
    },
  };
}

const BUILD_TOOL_ROLES = new Set([
  "database",
  "backend",
  "frontend",
  "general",
  "reviewer",
  "tester",
  "linter",
]);

export function defaultMaxToolCalls(role?: string): number {
  if (role === "scout") return SCOUT_MAX_TOOL_CALLS;
  if (role && BUILD_TOOL_ROLES.has(role)) return DEFAULT_BUILD_TOOL_CALLS;
  return DEFAULT_MAX_TOOL_CALLS;
}

export function resolveMaxToolCalls(configured?: number, role?: string): number {
  const fallback = defaultMaxToolCalls(role);
  const cap = role === "scout" ? SCOUT_MAX_TOOL_CALLS : MAX_TOOL_CALLS_CAP;
  const value = Number(configured);
  if (!Number.isFinite(value) || value < 1) return Math.min(fallback, cap);
  return Math.min(Math.floor(value), cap);
}

export function resolveChildIdleMs(configured?: number): number {
  const value = Number(configured);
  if (!Number.isFinite(value)) return 480_000;
  if (value <= 0) return 0;
  return Math.max(30, Math.min(value, 3600)) * 1000;
}

export function resolveRepeatToolAbort(configured?: number): number {
  const value = Number(configured);
  if (!Number.isFinite(value)) return DEFAULT_REPEAT_TOOL_ABORT;
  if (value <= 0) return 0;
  return Math.min(Math.floor(value), 40);
}

function looksLikeTargetedCall(label: string): boolean {
  return /\s/.test(label.trim());
}

/** Edit/write/bash on the same file is normal implementor work, not a stuck loop. */
export function isMutatingToolLabel(label: string): boolean {
  return MUTATING_TOOL_PREFIX.test(label.trim());
}

/**
 * True when the last `limit` calls are the same *inspect* of the same target.
 * Bare names (`read` with no path) and mutating tools never count — those are
 * how a frontend pass actually works.
 */
export function isRepeatedToolLoop(labels: string[], limit: number): boolean {
  if (limit < 2 || labels.length < limit) return false;
  const streak = labels.slice(-limit);
  const first = streak[0]?.trim() ?? "";
  if (!first || !looksLikeTargetedCall(first) || isMutatingToolLabel(first)) return false;
  return streak.every((label) => label === streak[0]);
}

export function formatElapsed(ms: number): string {
  const total = Math.max(0, Math.round(ms / 1000));
  const minutes = Math.floor(total / 60);
  const seconds = total % 60;
  return `${minutes}:${String(seconds).padStart(2, "0")}`;
}

export type ChildActivity = {
  role: string;
  startedAt: number;
  label: string;
  toolCalls: number;
  lastEventAt: number;
  recentTools: string[];
  abort?: () => void;
};

export function elapsedSuffix(activities: ChildActivity[], locked = false, now = Date.now()): string {
  if (!activities.length) return locked ? " (running)" : "";
  const startedAt = Math.min(...activities.map((activity) => activity.startedAt));
  return ` (${formatElapsed(now - startedAt)})`;
}

export function activityLine(activity: ChildActivity, now = Date.now()): string {
  const elapsed = formatElapsed(now - activity.startedAt);
  const idle = now - activity.lastEventAt;
  const detail = activity.label || (idle > 20_000 ? "thinking" : "starting up");
  const calls = activity.toolCalls === 1 ? "1 tool call" : `${activity.toolCalls} tool calls`;
  const quiet = idle > 60_000 ? ` · quiet for ${formatElapsed(idle)}` : "";
  return `${activity.role.replaceAll("_", " ")} · ${elapsed} · ${calls} · ${detail}${quiet}`;
}
