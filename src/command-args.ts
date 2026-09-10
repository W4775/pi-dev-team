/** Normalize /devteam command arguments from Pi or Oh My Pi. */
export function parseDevteamArgs(args: unknown): { trimmed: string; sub: string; rest: string } {
  let raw = "";
  if (typeof args === "string") {
    raw = args;
  } else if (Array.isArray(args)) {
    raw = args.map((item) => String(item ?? "")).join(" ");
  } else if (args && typeof args === "object") {
    const obj = args as Record<string, unknown>;
    if (typeof obj.text === "string") raw = obj.text;
    else if (typeof obj.args === "string") raw = obj.args;
  }
  raw = raw.trim().replace(/^\/?devteam\b/i, "").trim();
  if (!raw) return { trimmed: "", sub: "", rest: "" };
  const [head, ...parts] = raw.split(/\s+/);
  return {
    trimmed: raw,
    sub: (head ?? "").toLowerCase(),
    rest: parts.join(" ").trim(),
  };
}
