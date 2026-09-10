import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";
import { formatElapsed, type ChildActivity } from "./child-progress.ts";
import type { RoleName, RunState, Stage } from "./types.ts";

const STAGE_LABELS: Record<Stage, string> = {
  idle: "idle",
  scout_orchestrate: "scout",
  scout: "scout",
  planner: "plan",
  plan_critic: "plan critic",
  plan_review: "plan review",
  mockup_opt_in: "mockup",
  designer: "design",
  design_critic: "design critic",
  build_it_pause: "implement",
  orchestrate: "implement",
  implement: "implement",
  reviewer: "review",
  fix_review: "fix",
  tester: "test",
  fix_test: "fix",
  linter: "lint",
  fix_lint: "fix",
  commit_message: "commit",
  done: "done",
  error: "error",
};

export type ProgressKind = "start" | "tool" | "finish" | "error" | "stage";

export type ProgressEvent = {
  kind: ProgressKind;
  text: string;
  role?: string;
  stage?: string;
  label?: string;
};

export type UiSurface = {
  hasUI?: boolean;
  ui?: {
    setWidget?: (key: string, content: string[] | undefined, options?: { placement?: string }) => void;
    setStatus?: (key: string, text: string | undefined) => void;
    setWorkingMessage?: (message?: string) => void;
    setWorkingVisible?: (visible: boolean) => void;
    notify?: (message: string, type?: "info" | "warning" | "error") => void;
  };
};

type SessionHost = {
  appendEntry?: (customType: string, data?: unknown) => void;
  sendMessage?: (
    message: {
      customType: string;
      content: string;
      display: boolean;
      details?: unknown;
      attribution?: string;
    },
    options?: { triggerTurn?: boolean; deliverAs?: string },
  ) => unknown;
  registerEntryRenderer?: (customType: string, renderer: (...args: never[]) => unknown) => void;
  registerMessageRenderer?: (customType: string, renderer: (...args: never[]) => unknown) => void;
};

function loadTextCtor(): (new (text: string, padX?: number, padY?: number) => unknown) | undefined {
  const from = [import.meta.url];
  if (process.argv[1]) {
    try {
      from.push(pathToFileURL(process.argv[1]).href);
    } catch {
      /* ignore */
    }
  }
  for (const url of from) {
    const require = createRequire(url);
    for (const spec of ["@oh-my-pi/pi-tui", "@earendil-works/pi-tui"]) {
      try {
        const mod = require(spec) as { Text?: new (text: string, padX?: number, padY?: number) => unknown };
        if (typeof mod.Text === "function") return mod.Text;
      } catch {
        /* optional peer */
      }
    }
  }
  return undefined;
}

export function stageLabel(stage: Stage | undefined): string {
  if (!stage) return "";
  return STAGE_LABELS[stage] ?? stage.replaceAll("_", " ");
}

export function roleLabel(role: string | RoleName | undefined): string {
  if (!role) return "";
  return String(role).replaceAll("_", " ");
}

function uniqueRoles(activities: ChildActivity[], fallback?: string): string {
  const names = [...new Set(activities.map((activity) => roleLabel(activity.role)).filter(Boolean))];
  if (names.length) return names.join(", ");
  return roleLabel(fallback);
}

/** One-line widget: step · role · elapsed. */
export function widgetLine(
  run: RunState | undefined,
  activities: ChildActivity[] = [],
  now = Date.now(),
): string | undefined {
  if (!run || run.stage === "idle") return undefined;
  if (run.halted) {
    const step = stageLabel(run.stage);
    return ["stopped", step].filter(Boolean).join(" · ") || "stopped";
  }
  const step = stageLabel(run.stage);
  const roles = uniqueRoles(activities, run.currentRole ?? run.interactiveRole);
  const elapsed = activities.length
    ? formatElapsed(now - Math.min(...activities.map((activity) => activity.startedAt)))
    : "";
  return [step, roles, elapsed].filter(Boolean).join(" · ") || undefined;
}

export function lifecycleText(
  kind: Exclude<ProgressKind, "tool">,
  role: string,
  extra?: { elapsed?: string; toolCalls?: number; error?: string; stage?: string },
): string {
  const name = roleLabel(role) || extra?.stage || "devteam";
  if (kind === "start") return `Starting ${name}`;
  if (kind === "error") return `${name} failed${extra?.error ? `: ${extra.error}` : ""}`;
  if (kind === "stage") return extra?.stage ? `${extra.stage}` : name;
  const calls =
    extra?.toolCalls != null
      ? ` · ${extra.toolCalls} ${extra.toolCalls === 1 ? "tool call" : "tool calls"}`
      : "";
  return `${name} finished${extra?.elapsed ? ` in ${extra.elapsed}` : ""}${calls}`;
}

export function toolLogText(role: string, label: string): string {
  return `${roleLabel(role)}  ${label}`;
}

export type ProgressBlockStatus = "running" | "finished" | "error";

export type ProgressBlock = {
  id: string;
  groupKey: string;
  status: ProgressBlockStatus;
  startedAt: number;
  endedAt?: number;
  activeCount: number;
  toolCalls: number;
  lines: string[];
  error?: string;
};

const MAX_PROGRESS_LINES = 20;

type LiveTextNode = { setText?: (text: string) => unknown };
type PostedPayload = { content: string; text?: string; details?: unknown };
type PostedBlock = { via: "message" | "entry"; payload: PostedPayload };

let blockSeq = 0;
const blocksById = new Map<string, ProgressBlock>();
const openByGroup = new Map<string, ProgressBlock>();
const liveNodes = new Map<string, LiveTextNode>();
const postedById = new Map<string, PostedBlock>();

export function resetProgressFeed(): void {
  blockSeq = 0;
  blocksById.clear();
  openByGroup.clear();
  liveNodes.clear();
  postedById.clear();
}

/** Critic, scout, backend, … — strip `/item` suffixes so parallel children share a block. */
export function progressGroupKey(event: Pick<ProgressEvent, "role" | "stage">): string {
  const role = event.role?.trim();
  if (role) return role.split("/")[0] || role;
  if (event.stage) return event.stage;
  return "devteam";
}

export function formatProgressBlock(block: ProgressBlock, now = Date.now()): string {
  const title = roleLabel(block.groupKey) || "devteam";
  const elapsed = formatElapsed((block.endedAt ?? now) - block.startedAt);
  const callWord = block.toolCalls === 1 ? "tool" : "tools";
  const callPhrase = `${block.toolCalls} ${block.toolCalls === 1 ? "tool call" : "tool calls"}`;
  let header: string;
  if (block.status === "error") {
    const detail = block.error?.trim();
    header = detail && !detail.toLowerCase().startsWith(title.toLowerCase())
      ? `${title} failed: ${detail}`
      : detail || `${title} failed`;
  } else if (block.status === "finished") {
    header = `${title} finished in ${elapsed} · ${callPhrase}`;
  } else {
    header = block.toolCalls > 0 ? `${title} · ${elapsed} · ${block.toolCalls} ${callWord}` : `${title} · ${elapsed}`;
  }
  const hidden = Math.max(0, block.lines.length - MAX_PROGRESS_LINES);
  const visible = block.lines.slice(-MAX_PROGRESS_LINES);
  const omitted = hidden > 0 ? [`  … ${hidden} earlier`] : [];
  return [header, ...omitted, ...visible.map((line) => `  ${line}`)].join("\n");
}

function detailsRecord(value: unknown): Record<string, unknown> | undefined {
  if (!value || typeof value !== "object") return undefined;
  const node = value as Record<string, unknown>;
  if (node.details && typeof node.details === "object") return node.details as Record<string, unknown>;
  if (node.data && typeof node.data === "object") return node.data as Record<string, unknown>;
  return node;
}

function blockFromValue(value: unknown): ProgressBlock | undefined {
  const details = detailsRecord(value);
  if (!details) return undefined;
  const id = details.id;
  if (typeof id === "string" && blocksById.has(id)) return blocksById.get(id);
  if (typeof details.groupKey === "string" && Array.isArray(details.lines)) return details as unknown as ProgressBlock;
  return undefined;
}

function extractRenderedText(value: unknown): string {
  const block = blockFromValue(value);
  if (block) return formatProgressBlock(block);
  if (!value || typeof value !== "object") return "";
  const node = value as Record<string, unknown>;
  if (typeof node.content === "string") return node.content;
  const data = node.data;
  if (data && typeof data === "object") {
    const text = (data as Record<string, unknown>).text;
    if (typeof text === "string") return text;
  }
  return typeof node.text === "string" ? node.text : "";
}

function openBlock(groupKey: string, now: number): { block: ProgressBlock; fresh: boolean } {
  const existing = openByGroup.get(groupKey);
  if (existing && existing.activeCount > 0) return { block: existing, fresh: false };
  const block: ProgressBlock = {
    id: `${groupKey}-${++blockSeq}`,
    groupKey,
    status: "running",
    startedAt: now,
    activeCount: 0,
    toolCalls: 0,
    lines: [],
  };
  blocksById.set(block.id, block);
  openByGroup.set(groupKey, block);
  return { block, fresh: true };
}

function applyProgressEvent(block: ProgressBlock, event: ProgressEvent, now: number): void {
  if (event.kind === "start") {
    block.status = "running";
    block.activeCount += 1;
    block.endedAt = undefined;
    block.error = undefined;
    return;
  }
  if (event.kind === "tool" || event.kind === "stage") {
    if (block.activeCount === 0) block.activeCount = 1;
    block.status = "running";
    const line = (event.text || event.label || "").trim();
    if (line && block.lines[block.lines.length - 1] !== line) block.lines.push(line);
    if (event.kind === "tool") block.toolCalls += 1;
    return;
  }
  if (event.kind !== "finish" && event.kind !== "error") return;
  block.activeCount = Math.max(0, block.activeCount - 1);
  if (event.kind === "error") {
    block.error = event.text;
    if (block.activeCount === 0) {
      block.status = "error";
      block.endedAt = now;
    } else if (event.text) {
      block.lines.push(event.text);
    }
    return;
  }
  if (block.activeCount === 0) {
    block.status = "finished";
    block.endedAt = now;
    return;
  }
  if (event.text) block.lines.push(event.text);
}

function detailsBlockId(details: unknown): string | undefined {
  if (!details || typeof details !== "object") return undefined;
  const id = (details as { id?: unknown }).id;
  return typeof id === "string" ? id : undefined;
}

function patchSessionEntries(sessionManager: unknown, blockId: string, text: string): void {
  const getEntries = (sessionManager as { getEntries?: () => unknown[] } | undefined)?.getEntries;
  if (typeof getEntries !== "function") return;
  let entries: unknown[];
  try {
    entries = getEntries();
  } catch {
    return;
  }
  for (const entry of entries) {
    if (!entry || typeof entry !== "object") continue;
    const rec = entry as Record<string, unknown>;
    if (rec.type === "custom_message" && rec.customType === "devteam" && detailsBlockId(rec.details) === blockId) {
      rec.content = text;
    }
    const message = rec.message;
    if (message && typeof message === "object") {
      const msg = message as Record<string, unknown>;
      if (msg.customType === "devteam" && detailsBlockId(msg.details) === blockId) {
        msg.content = text;
      }
    }
  }
}

function paintPosted(block: ProgressBlock, text: string, sessionManager?: unknown): void {
  const posted = postedById.get(block.id);
  if (posted) {
    posted.payload.content = text;
    if ("text" in posted.payload) posted.payload.text = text;
  }
  const node = liveNodes.get(block.id);
  if (node && typeof node.setText === "function") {
    try {
      node.setText(text);
    } catch {
      /* host Text without live updates */
    }
  }
  patchSessionEntries(sessionManager, block.id, text);
}

/** Refresh elapsed time on running transcript blocks while a child is quiet. */
export function tickProgressFeed(opts?: { now?: number; sessionManager?: unknown }): void {
  const now = opts?.now ?? Date.now();
  for (const block of blocksById.values()) {
    if (block.status !== "running" || block.activeCount <= 0) continue;
    paintPosted(block, formatProgressBlock(block, now), opts?.sessionManager);
  }
}

export function registerDevteamRenderers(pi: unknown): void {
  const host = pi as SessionHost;
  const Text = loadTextCtor();
  const render = (value: unknown, theme?: { fg?: (key: string, text: string) => string }) => {
    const text = extractRenderedText(value);
    if (!text || !Text) return undefined;
    const painted = theme?.fg ? theme.fg("muted", text) : text;
    const node = new Text(painted, 0, 0) as LiveTextNode;
    const block = blockFromValue(value);
    if (block) liveNodes.set(block.id, node);
    return node;
  };
  try {
    host.registerEntryRenderer?.("devteam", ((entry: unknown, _opts: unknown, theme: { fg?: (key: string, text: string) => string }) =>
      render(entry, theme)) as (...args: never[]) => unknown);
  } catch {
    /* host without entry renderers */
  }
  try {
    host.registerMessageRenderer?.("devteam", ((message: unknown, _opts: unknown, theme: { fg?: (key: string, text: string) => string }) =>
      render(message, theme)) as (...args: never[]) => unknown);
  } catch {
    /* host without message renderers */
  }
}

/** One transcript block per role, updated in place as that role's tools run. */
export function postSessionLine(
  pi: unknown,
  event: ProgressEvent,
  opts?: { streaming?: boolean; now?: number; sessionManager?: unknown },
): "entry" | "message" | "none" {
  const host = pi as SessionHost;
  const now = opts?.now ?? Date.now();
  const groupKey = progressGroupKey(event);
  const opened = openByGroup.get(groupKey);
  const { block, fresh } =
    opened && opened.activeCount > 0 ? { block: opened, fresh: false } : openBlock(groupKey, now);
  applyProgressEvent(block, event, now);
  const text = formatProgressBlock(block, now);
  if (!text) return "none";

  const already = postedById.get(block.id);
  if (!fresh && already) {
    paintPosted(block, text, opts?.sessionManager);
    return already.via;
  }

  // sendMessage with no deliverAs steers a live parent turn. Children usually
  // run while the parent is idle; skip the message path if it is not.
  if (!opts?.streaming && typeof host.sendMessage === "function") {
    try {
      const payload: PostedPayload & {
        customType: string;
        display: boolean;
        attribution: string;
      } = {
        customType: "devteam",
        content: text,
        display: true,
        details: block,
        attribution: "agent",
      };
      host.sendMessage(payload, { triggerTurn: false });
      postedById.set(block.id, { via: "message", payload });
      paintPosted(block, text, opts?.sessionManager);
      return "message";
    } catch {
      /* fall through */
    }
  }

  try {
    const data = { ...block, text };
    host.appendEntry?.("devteam", data);
    postedById.set(block.id, { via: "entry", payload: data });
    paintPosted(block, text, opts?.sessionManager);
    return "entry";
  } catch {
    return "none";
  }
}

function clearLoaderAndFooter(ui: NonNullable<UiSurface["ui"]>): void {
  try {
    ui.setWorkingMessage?.();
    ui.setWorkingVisible?.(false);
    ui.setStatus?.("devteam", undefined);
  } catch {
    /* ignore */
  }
}

export function applyChrome(
  ctx: UiSurface,
  run: RunState | undefined,
  activities: ChildActivity[],
  now = Date.now(),
): void {
  if (!ctx.hasUI || !ctx.ui) return;
  const widget = widgetLine(run, activities, now);
  try {
    ctx.ui.setWidget?.("devteam", widget ? [widget] : undefined);
  } catch {
    try {
      ctx.ui.setWidget?.("devteam", widget ? [widget] : []);
    } catch {
      /* ignore */
    }
  }
  // Live tools already go in the transcript; don't also paint them on the loader/footer.
  clearLoaderAndFooter(ctx.ui);
}

export function clearChrome(ctx: UiSurface): void {
  if (!ctx.hasUI || !ctx.ui) return;
  try {
    ctx.ui.setWidget?.("devteam", undefined);
  } catch {
    try {
      ctx.ui.setWidget?.("devteam", []);
    } catch {
      /* ignore */
    }
  }
  clearLoaderAndFooter(ctx.ui);
}
