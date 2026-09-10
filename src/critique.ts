import type { CritiqueItem, PlanCritique } from "./types.ts";

export function parseCritiqueItems(notes: string | undefined): CritiqueItem[] {
  const trimmed = notes?.trim() ?? "";
  if (!trimmed) return [];

  const fromJson = itemsFromJson(trimmed);
  if (fromJson?.length) return fromJson;

  const fenced = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fenced?.[1]) {
    const nested = itemsFromJson(fenced[1].trim());
    if (nested?.length) return nested;
  }

  const bullets = itemsFromMarkdown(trimmed);
  if (bullets.length) return bullets;

  return [{ id: "c1", title: firstLine(trimmed), text: trimmed }];
}

export function formatCritiqueForPlanner(items: CritiqueItem[]): string {
  const accepted = items.filter((item) => item.decision === "accept");
  const rejected = items.filter((item) => item.decision === "reject");
  const lines: string[] = [];
  if (accepted.length) {
    lines.push("Accepted (apply these):");
    for (const item of accepted) lines.push(formatItemLine(item));
  }
  if (rejected.length) {
    lines.push("", "Rejected (do not apply):");
    for (const item of rejected) lines.push(formatItemLine(item));
  }
  return lines.join("\n").trim();
}

export function withCritiqueItems(critique: PlanCritique | undefined, notes: string): PlanCritique {
  return {
    notes,
    replacedScope: critique?.replacedScope || looksLikeReplacedScope(notes),
    items: parseCritiqueItems(notes),
    reviewed: false,
  };
}

export function rejectUndecided(items: CritiqueItem[]): CritiqueItem[] {
  return items.map((item) => ({ ...item, decision: item.decision ?? "reject" }));
}

function formatItemLine(item: CritiqueItem): string {
  const note = item.userNote?.trim() ? ` — user: ${item.userNote.trim()}` : "";
  return `- ${item.title}: ${item.text}${note}`;
}

function itemsFromJson(text: string): CritiqueItem[] | undefined {
  try {
    const value = JSON.parse(text) as unknown;
    const list = Array.isArray(value)
      ? value
      : value && typeof value === "object" && Array.isArray((value as { items?: unknown }).items)
        ? (value as { items: unknown[] }).items
        : undefined;
    if (!list) return undefined;
    const items = list
      .map((entry, index) => itemFromUnknown(entry, index))
      .filter((item): item is CritiqueItem => Boolean(item));
    return items.length ? items : undefined;
  } catch {
    return undefined;
  }
}

function itemFromUnknown(entry: unknown, index: number): CritiqueItem | undefined {
  if (typeof entry === "string" && entry.trim()) {
    return { id: `c${index + 1}`, title: firstLine(entry), text: entry.trim() };
  }
  if (!entry || typeof entry !== "object") return undefined;
  const node = entry as Record<string, unknown>;
  const text = [node.text, node.notes, node.body, node.suggestion]
    .map((value) => (typeof value === "string" ? value.trim() : ""))
    .find(Boolean);
  if (!text) return undefined;
  const title =
    (typeof node.title === "string" && node.title.trim()) ||
    firstLine(text);
  const id = typeof node.id === "string" && node.id.trim() ? node.id.trim() : `c${index + 1}`;
  return { id, title, text };
}

function itemsFromMarkdown(notes: string): CritiqueItem[] {
  const items: CritiqueItem[] = [];
  let current: { title: string; lines: string[] } | undefined;

  const flush = () => {
    if (!current) return;
    const text = current.lines.join("\n").trim();
    if (!text) return;
    items.push({ id: `c${items.length + 1}`, title: current.title, text });
    current = undefined;
  };

  for (const line of notes.split(/\n/)) {
    const match = line.match(/^\s*(?:[-*]|\d+[.)])\s+(.*)$/);
    if (match?.[1]) {
      flush();
      current = { title: firstLine(match[1]), lines: [match[1]] };
      continue;
    }
    if (current) current.lines.push(line);
  }
  flush();
  return items;
}

function firstLine(text: string): string {
  const line = text.replace(/\s+/g, " ").trim();
  return line.length > 80 ? `${line.slice(0, 79)}…` : line;
}

function looksLikeReplacedScope(notes: string): boolean {
  return /replacedScope:\s*true/i.test(notes) || /replaced the (spec|scope|layers)/i.test(notes);
}
