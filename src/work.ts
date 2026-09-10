import { matchAnyGlob } from "./glob.ts";
import { serviceByName } from "./services.ts";
import type { ImplementorLayer, ServiceInfo, WorkItem, WorkItemStatus } from "./types.ts";
import {
  DEFAULT_PARALLEL,
  IMPLEMENTOR_LAYERS,
  MAX_PARALLEL,
  MAX_WORK_ITEM_ATTEMPTS,
  WORK_ITEM_STATUSES,
} from "./types.ts";

const LAYER_SET = new Set<string>(IMPLEMENTOR_LAYERS);

function asLayer(value: unknown): ImplementorLayer {
  const text = String(value ?? "").trim().toLowerCase();
  return LAYER_SET.has(text) ? (text as ImplementorLayer) : "general";
}

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

export function normalizeWorkItems(raw: unknown): WorkItem[] {
  let source: unknown = raw;
  if (typeof source === "string") {
    try {
      source = JSON.parse(source);
    } catch {
      return [];
    }
  }
  if (source && typeof source === "object" && !Array.isArray(source)) {
    const wrapped = (source as Record<string, unknown>).items ?? (source as Record<string, unknown>).workItems;
    if (Array.isArray(wrapped)) source = wrapped;
  }
  if (!Array.isArray(source)) return [];

  const used = new Set<string>();
  const items: WorkItem[] = [];
  for (const [index, entry] of source.entries()) {
    if (!entry || typeof entry !== "object") continue;
    const node = entry as Record<string, unknown>;
    const layer = asLayer(node.layer ?? node.role);
    const title = String(node.title ?? node.name ?? node.task ?? "").trim() || `${layer} work ${index + 1}`;
    let id = String(node.id ?? "").trim() || `${layer}-${slug(title, String(index + 1))}`;
    while (used.has(id)) id = `${id}-${index + 1}`;
    used.add(id);
    const service = String(node.service ?? node.serviceName ?? "").trim();
    items.push({
      id,
      layer,
      service: service || undefined,
      title,
      details: typeof node.details === "string" && node.details.trim() ? node.details.trim() : undefined,
      files: asList(node.files ?? node.paths),
      dependsOn: asList(node.dependsOn ?? node.depends_on ?? node.after),
      status: asStatus(node.status),
      attempts: Number.isFinite(Number(node.attempts)) ? Number(node.attempts) : 0,
      summary: typeof node.summary === "string" && node.summary.trim() ? node.summary.trim() : undefined,
      error: typeof node.error === "string" && node.error.trim() ? node.error.trim() : undefined,
    });
  }

  const ids = new Set(items.map((item) => item.id));
  for (const item of items) item.dependsOn = item.dependsOn.filter((dep) => ids.has(dep) && dep !== item.id);
  return items;
}

export function applyServiceDefaults(items: WorkItem[], services: ServiceInfo[] | undefined): WorkItem[] {
  if (!services?.length) return items;
  return items.map((item) => {
    const service = serviceByName(services, item.service);
    if (!service) return item;
    return {
      ...item,
      service: service.name,
      files: item.files.length ? item.files : [...service.paths],
    };
  });
}

export function resolveParallel(configured: number | undefined): number {
  const value = Number(configured);
  if (!Number.isFinite(value) || value < 1) return DEFAULT_PARALLEL;
  return Math.min(Math.floor(value), MAX_PARALLEL);
}

function pathsCollide(a: string[], b: string[]): boolean {
  if (!a.length || !b.length) return true;
  return a.some((left) =>
    b.some((right) => left === right || matchAnyGlob([left], right) || matchAnyGlob([right], left)),
  );
}

export function nextWave(items: WorkItem[] | undefined, maxParallel = DEFAULT_PARALLEL): WorkItem[] {
  const all = items ?? [];
  if (all.some((item) => item.status === "running")) return [];
  const limit = resolveParallel(maxParallel);
  const done = new Set(all.filter((item) => item.status === "done").map((item) => item.id));

  for (const layer of IMPLEMENTOR_LAYERS) {
    const inLayer = all.filter((item) => item.layer === layer);
    if (!inLayer.length) continue;
    const unfinished = inLayer.filter((item) => item.status === "pending");
    if (!unfinished.length) {
      if (inLayer.some((item) => item.status === "failed")) return [];
      continue;
    }

    const wave: WorkItem[] = [];
    for (const item of unfinished) {
      if (item.dependsOn.some((dep) => !done.has(dep))) continue;
      if (wave.some((picked) => pathsCollide(picked.files, item.files))) continue;
      wave.push(item);
      if (wave.length >= limit) break;
    }
    if (!wave.length) {
      // Still unfinished in this layer (deps or collisions) — do not skip ahead.
      return [];
    }
    if (wave.some((item) => !item.files.length)) return [wave[0] as WorkItem];
    return wave;
  }
  return [];
}

export function itemsForLayer(items: WorkItem[] | undefined, layer: ImplementorLayer | undefined): WorkItem[] {
  if (!layer) return [];
  return (items ?? []).filter((item) => item.layer === layer);
}

export function itemsRemaining<T extends { status: WorkItemStatus }>(items: T[] | undefined): T[] {
  return (items ?? []).filter((item) => item.status === "pending" || item.status === "running");
}

export function layerRemaining(items: WorkItem[] | undefined, layer: ImplementorLayer | undefined): WorkItem[] {
  return itemsRemaining(itemsForLayer(items, layer));
}

export function failedItems<T extends { status: WorkItemStatus }>(items: T[] | undefined): T[] {
  return (items ?? []).filter((item) => item.status === "failed");
}

export function retryableItems<T extends { status: WorkItemStatus; attempts: number }>(items: T[] | undefined): T[] {
  return failedItems(items).filter((item) => item.attempts < MAX_WORK_ITEM_ATTEMPTS);
}

export function setItemStatus(
  items: WorkItem[] | undefined,
  id: string,
  patch: Partial<Pick<WorkItem, "status" | "summary" | "error" | "attempts">>,
): WorkItem[] {
  return (items ?? []).map((item) => (item.id === id ? { ...item, ...patch } : item));
}

export function findItem(items: WorkItem[] | undefined, id: string | undefined): WorkItem | undefined {
  if (!id) return undefined;
  return (items ?? []).find((item) => item.id === id);
}

export function layersFromItems(items: WorkItem[] | undefined): ImplementorLayer[] {
  const present = new Set((items ?? []).map((item) => item.layer));
  return IMPLEMENTOR_LAYERS.filter((layer) => present.has(layer));
}

export function renderWorkItems(items: WorkItem[] | undefined): string {
  const all = items ?? [];
  if (!all.length) return "";
  const mark: Record<WorkItemStatus, string> = { pending: " ", running: "~", done: "x", failed: "!" };
  return all
    .map((item) => {
      const files = item.files.length ? ` — ${item.files.slice(0, 4).join(", ")}` : "";
      const note = item.error ? ` (${item.error})` : item.summary ? ` (${item.summary})` : "";
      const where = item.service ? `${item.layer}/${item.service}` : item.layer;
      return `- [${mark[item.status]}] **${where}** ${item.title}${files}${note}`;
    })
    .join("\n");
}
