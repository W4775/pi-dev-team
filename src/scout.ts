import type { ScoutItem, WorkItemStatus } from "./types.ts";
import { MAX_SCOUTS, MAX_WORK_ITEM_ATTEMPTS, WORK_ITEM_STATUSES } from "./types.ts";
import { resolveParallel } from "./work.ts";

function asStatus(value: unknown): WorkItemStatus {
  const text = String(value ?? "").trim().toLowerCase();
  return (WORK_ITEM_STATUSES as readonly string[]).includes(text) ? (text as WorkItemStatus) : "pending";
}

function asList(value: unknown): string[] {
  if (Array.isArray(value)) return value.map((item) => String(item ?? "").trim()).filter(Boolean);
  if (typeof value === "string") {
    return value
      .split(/[,\n]/)
      .map((item) => item.trim())
      .filter(Boolean);
  }
  return [];
}

function slug(text: string, fallback: string): string {
  const base = text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 28);
  return base || fallback;
}

export function normalizeScoutItems(raw: unknown): ScoutItem[] {
  let source: unknown = raw;
  if (typeof source === "string") {
    try {
      source = JSON.parse(source);
    } catch {
      return [];
    }
  }
  if (source && typeof source === "object" && !Array.isArray(source)) {
    const wrapped = (source as Record<string, unknown>).items ?? (source as Record<string, unknown>).scoutItems;
    if (Array.isArray(wrapped)) source = wrapped;
  }
  if (!Array.isArray(source)) return [];

  const used = new Set<string>();
  const items: ScoutItem[] = [];
  for (const [index, entry] of source.entries()) {
    if (!entry || typeof entry !== "object") continue;
    if (items.length >= MAX_SCOUTS) break;
    const node = entry as Record<string, unknown>;
    const title = String(node.title ?? node.name ?? node.task ?? "").trim() || `scout ${index + 1}`;
    let id = String(node.id ?? "").trim() || `scout-${slug(title, String(index + 1))}`;
    while (used.has(id)) id = `${id}-${index + 1}`;
    used.add(id);
    const service = String(node.service ?? node.serviceName ?? "").trim();
    const findings = typeof node.findings === "string" && node.findings.trim() ? node.findings.trim() : undefined;
    items.push({
      id,
      title,
      details: typeof node.details === "string" && node.details.trim() ? node.details.trim() : undefined,
      files: asList(node.files ?? node.paths),
      service: service || undefined,
      status: asStatus(node.status),
      attempts: Number.isFinite(Number(node.attempts)) ? Number(node.attempts) : 0,
      findings,
      error: typeof node.error === "string" && node.error.trim() ? node.error.trim() : undefined,
    });
  }
  return items;
}

/** Scouts are read-only, so overlapping paths may run together. */
export function nextScoutWave(items: ScoutItem[] | undefined, maxParallel = 3): ScoutItem[] {
  const all = items ?? [];
  if (all.some((item) => item.status === "running")) return [];
  const limit = resolveParallel(maxParallel);
  return all.filter((item) => item.status === "pending").slice(0, limit);
}

export function setScoutStatus(
  items: ScoutItem[] | undefined,
  id: string,
  patch: Partial<Pick<ScoutItem, "status" | "findings" | "error" | "attempts">>,
): ScoutItem[] {
  return (items ?? []).map((item) => (item.id === id ? { ...item, ...patch } : item));
}

export function findScout(items: ScoutItem[] | undefined, id: string | undefined): ScoutItem | undefined {
  if (!id) return undefined;
  return (items ?? []).find((item) => item.id === id);
}

export function compileScoutNotes(items: ScoutItem[] | undefined, existing?: string): string {
  const fromItems = (items ?? [])
    .map((item) => {
      const body = item.findings?.trim() || item.error || "";
      if (!body && item.status !== "done") return "";
      return `### ${item.title} (${item.id})\n${body || "(no findings stored)"}`;
    })
    .filter(Boolean)
    .join("\n\n");
  if (existing?.trim()) return existing.trim();
  return fromItems;
}

export function retryableScouts(items: ScoutItem[] | undefined): ScoutItem[] {
  return (items ?? []).filter((item) => item.status === "failed" && item.attempts < MAX_WORK_ITEM_ATTEMPTS);
}

export function renderScoutItems(items: ScoutItem[] | undefined): string {
  const all = items ?? [];
  if (!all.length) return "";
  const mark: Record<WorkItemStatus, string> = { pending: " ", running: "~", done: "x", failed: "!" };
  return all
    .map((item) => {
      const files = item.files.length ? ` — ${item.files.slice(0, 4).join(", ")}` : "";
      const note = item.error ? ` (${item.error})` : item.findings ? " (findings)" : "";
      return `- [${mark[item.status]}] ${item.title}${files}${note}`;
    })
    .join("\n");
}
