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

function eventText(event: ProgressEvent): string {
  return event.text;
}

function extractRenderedText(value: unknown): string {
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

export function registerDevteamRenderers(pi: unknown): void {
  const host = pi as SessionHost;
  const Text = loadTextCtor();
  const render = (value: unknown, theme?: { fg?: (key: string, text: string) => string }) => {
    const text = extractRenderedText(value);
    if (!text || !Text) return undefined;
    const painted = theme?.fg ? theme.fg("muted", text) : text;
    return new Text(painted, 0, 0);
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

/** Persist a transcript line. Prefer sendMessage so the TUI rebuilds live. */
export function postSessionLine(
  pi: unknown,
  event: ProgressEvent,
  opts?: { streaming?: boolean },
): "entry" | "message" | "none" {
  const host = pi as SessionHost;
  const text = eventText(event);
  if (!text) return "none";
  const data = { ...event, text };

  // sendMessage with no deliverAs steers a live parent turn. Children usually
  // run while the parent is idle; skip the message path if it is not.
  if (!opts?.streaming && typeof host.sendMessage === "function") {
    try {
      host.sendMessage(
        {
          customType: "devteam",
          content: text,
          display: true,
          details: data,
          attribution: "agent",
        },
        { triggerTurn: false },
      );
      return "message";
    } catch {
      /* fall through */
    }
  }

  try {
    host.appendEntry?.("devteam", data);
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
