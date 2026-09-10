/**
 * Isolated children run with `--mode json`. This turns each event into a
 * one-line label, and throws away streamed tokens that are not a real action
 * ("hub", "the", a single path fragment).
 */

export type ProgressUpdate = {
  kind: "tool" | "text";
  label: string;
};

const TOOL_EVENT_TYPES = new Set([
  "tool",
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
  const args = input && typeof input === "object" ? (input as Record<string, unknown>) : undefined;
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
  if (path) return `${tool} ${tail(path)}`;
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
    const label = describeToolCall(name, node.input ?? node.args ?? node.parameters);
    return isUsefulLabel(label, "tool") ? { kind: "tool", label } : undefined;
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

function toolLabel(node: Record<string, unknown>): ProgressUpdate | undefined {
  const name = firstString(node, ["toolName", "tool", "name"]);
  if (!name) return undefined;
  const label = describeToolCall(name, node.input ?? node.args ?? node.parameters ?? node.toolCall);
  return isUsefulLabel(label, "tool") ? { kind: "tool", label } : undefined;
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
    const update = toolLabel(node);
    return update ? { kind: "text", label: update.label } : undefined;
  }

  if (TOOL_START_TYPES.has(type)) return toolLabel(node);

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
  return {
    push(chunk: string): ProgressUpdate[] {
      buffer += chunk;
      const lines = buffer.split(/\r?\n/);
      buffer = lines.pop() ?? "";
      const updates: ProgressUpdate[] = [];
      for (const line of lines) {
        const update = progressFromLine(line);
        if (update) updates.push(update);
      }
      return updates;
    },
    flush(): ProgressUpdate[] {
      const rest = buffer;
      buffer = "";
      const update = progressFromLine(rest);
      return update ? [update] : [];
    },
  };
}

export function resolveMaxToolCalls(configured?: number): number {
  const value = Number(configured);
  if (!Number.isFinite(value) || value < 1) return 80;
  return Math.min(Math.floor(value), 400);
}

export function resolveChildIdleMs(configured?: number): number {
  const value = Number(configured);
  if (!Number.isFinite(value)) return 480_000;
  if (value <= 0) return 0;
  return Math.max(30, Math.min(value, 3600)) * 1000;
}

export function resolveRepeatToolAbort(configured?: number): number {
  const value = Number(configured);
  if (!Number.isFinite(value)) return 8;
  if (value <= 0) return 0;
  return Math.min(Math.floor(value), 40);
}

/** True when the last `limit` tool labels are identical. */
export function isRepeatedToolLoop(labels: string[], limit: number): boolean {
  if (limit < 2 || labels.length < limit) return false;
  const tail = labels.slice(-limit);
  return tail.every((label) => label === tail[0]);
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
