/** Host-API shims. Oh My Pi does not implement Pi's project-trust gate. */

export function projectTrusted(ctx: { isProjectTrusted?: () => boolean }): boolean {
  if (typeof ctx.isProjectTrusted !== "function") return true;
  try {
    return ctx.isProjectTrusted();
  } catch {
    return true;
  }
}

type FlagHost = {
  registerFlag?: (name: string, options: { description: string; type: "string" }) => void;
  getFlag?: (name: string) => unknown;
};

/** Hosts without a flag API (or that reject unknown flags) fall back to env vars. */
export function registerFlagSafe(pi: unknown, name: string, description: string): void {
  const host = pi as FlagHost;
  if (typeof host.registerFlag !== "function") return;
  try {
    host.registerFlag(name, { description, type: "string" });
  } catch {
    /* flag already registered or unsupported */
  }
}

export function getFlagSafe(pi: unknown, name: string): string | undefined {
  const host = pi as FlagHost;
  if (typeof host.getFlag !== "function") return undefined;
  try {
    const value = host.getFlag(name);
    return typeof value === "string" && value.length > 0 ? value : undefined;
  } catch {
    return undefined;
  }
}

export function sessionIdFromContext(ctx: { sessionManager?: { getSessionId?: () => string } }): string {
  try {
    const id = ctx.sessionManager?.getSessionId?.();
    if (typeof id === "string" && id.trim()) return id;
  } catch {
    /* Oh My Pi / older Pi */
  }
  return "session";
}

/** Pi emits `agent_settled`; Oh My Pi emits `agent_end`. Subscribe to both. */
export function onAgentIdle(
  pi: unknown,
  handler: (event: { willContinue?: boolean }, ctx: unknown) => void,
): void {
  const host = pi as { on?: (event: string, handler: (...args: never[]) => unknown) => void };
  if (typeof host.on !== "function") return;
  for (const name of ["agent_end", "agent_settled"] as const) {
    try {
      host.on(name, ((event: { willContinue?: boolean }, ctx: unknown) => {
        if (event?.willContinue) return;
        handler(event, ctx);
      }) as (...args: never[]) => unknown);
    } catch {
      /* host without this event */
    }
  }
}
