import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { HandoffAction } from "./types.ts";
import { HANDOFF_ACTIONS } from "./types.ts";
import { getSection, renderRunMarkdown, runPaths, STATE_SECTIONS, type StateSection, updateSection } from "./state.ts";
import { setItemStatus } from "./work.ts";
import { setScoutStatus } from "./scout.ts";
import type { RunState } from "./types.ts";

export function isStateSection(value: string): value is StateSection {
  return (STATE_SECTIONS as readonly string[]).includes(value);
}

export function isHandoffAction(value: string): value is HandoffAction {
  return (HANDOFF_ACTIONS as readonly string[]).includes(value);
}

export function resolveMockupRel(file = "index.html"): string | undefined {
  const rel = file.replaceAll("\\", "/").replace(/^\/+/, "");
  if (!rel || rel.includes("..") || rel.startsWith("/")) return undefined;
  return rel;
}

export type Store = {
  load(): RunState | undefined;
  save(run: RunState): void;
  mutate?(change: (run: RunState) => RunState | undefined): RunState | undefined;
  agentDir(): string;
  sessionId(): string;
  taskId?: () => string | undefined;
};

export function applyStateTool(
  store: Store,
  params: { action: string; section?: string; value?: string },
): { text: string; isError?: boolean } {
  const run = store.load();
  if (!run) return { text: "No active /devteam run. Start one with /devteam <task>.", isError: true };

  if (params.action === "get") {
    if (params.section) {
      if (!isStateSection(params.section)) {
        return { text: `Unknown section: ${params.section}`, isError: true };
      }
      return { text: JSON.stringify(getSection(run, params.section) ?? null, null, 2) };
    }
    return { text: renderRunMarkdown(run, {
      canonicalPath: runPaths(store.agentDir(), store.sessionId()).json,
      aliasPath: runPaths(store.agentDir(), store.sessionId()).workflowStateJson,
    }) };
  }

  if (!params.section || !isStateSection(params.section)) {
    return { text: "replace/append require a valid section name.", isError: true };
  }

  const section = params.section;
  const applyValue = (current: RunState): unknown => {
    if (params.action === "append") {
      const prev = getSection(current, section);
      const prevText = typeof prev === "string" ? prev : prev == null ? "" : JSON.stringify(prev);
      return prevText ? `${prevText}\n${params.value ?? ""}` : (params.value ?? "");
    }
    if (section === "layersNeeded" || section === "wantMockup") {
      return params.value ?? "";
    }
    if (section === "filesToChange" || section === "stack" || section === "reviewFindings" || section === "workItems" || section === "scoutItems") {
      try {
        return params.value ? JSON.parse(params.value) : params.value;
      } catch {
        return params.value;
      }
    }
    return params.value ?? "";
  };

  const write = (change: (current: RunState) => RunState) => {
    if (store.mutate) {
      store.mutate(change);
      return;
    }
    store.save(change(run));
  };

  write((current) => updateSection(current, section, applyValue(current)));
  return { text: `Updated ${section}.` };
}

export function applyHandoffTool(
  store: Store,
  params: { action: string; summary?: string },
): { text: string; terminate: boolean; isError?: boolean } {
  const run = store.load();
  if (!run) return { text: "No active /devteam run.", terminate: false, isError: true };
  if (!isHandoffAction(params.action)) {
    return { text: `Unknown handoff action: ${params.action}`, terminate: false, isError: true };
  }
  const taskId = store.taskId?.();
  const write = (change: (current: RunState) => RunState) => {
    if (store.mutate) store.mutate(change);
    else store.save(change(run));
  };
  if (taskId && params.action === "implementor_done") {
    write((current) => ({
      ...current,
      workItems: setItemStatus(current.workItems, taskId, {
        status: "done",
        error: undefined,
        summary: params.summary,
      }),
      currentStatus: params.summary ?? `item ${taskId} done`,
      updatedAt: new Date().toISOString(),
    }));
    return {
      text: `Marked work item ${taskId} done. That does not advance the whole pipeline.`,
      terminate: true,
    };
  }
  if (taskId && params.action === "scout_done") {
    write((current) => ({
      ...current,
      scoutItems: setScoutStatus(current.scoutItems, taskId, {
        status: "done",
        error: undefined,
        findings: params.summary,
      }),
      currentStatus: params.summary ?? `scout ${taskId} done`,
      updatedAt: new Date().toISOString(),
    }));
    return {
      text: `Recorded scout ${taskId} findings. That does not start the planner yet.`,
      terminate: true,
    };
  }
  write((current) => ({
    ...current,
    pendingHandoff: { action: params.action, summary: params.summary },
    currentStatus: params.summary ?? `handoff:${params.action}`,
    updatedAt: new Date().toISOString(),
  }));
  return {
    text: `Recorded handoff ${params.action}. The pipeline is advancing.`,
    terminate: true,
  };
}

export function applyMockupTool(
  store: Store,
  params: { action: string; content?: string; file?: string },
): { text: string; isError?: boolean } {
  const run = store.load();
  if (!run) return { text: "No active /devteam run.", isError: true };
  const paths = runPaths(store.agentDir(), store.sessionId());
  const rel = resolveMockupRel(params.file ?? "index.html");
  if (!rel) {
    return { text: "Invalid mockup file path.", isError: true };
  }
  const abs = join(paths.mockupDir, rel);

  if (params.action === "path") {
    return { text: paths.mockupFile };
  }

  if (params.action === "read") {
    try {
      return { text: readFileSync(abs, "utf8") };
    } catch {
      return { text: `No mockup at ${abs}`, isError: true };
    }
  }

  if (params.action === "write") {
    mkdirSync(dirname(abs), { recursive: true });
    writeFileSync(abs, params.content ?? "", "utf8");
    const version = (run.mockupVersion ?? 0) + 1;
    store.save({
      ...run,
      mockupPath: paths.mockupFile,
      mockupVersion: version,
      updatedAt: new Date().toISOString(),
    });
    return { text: `Wrote mockup to ${abs} (v${version}). Open with /devteam mockup.` };
  }

  return { text: `Unknown mockup action: ${params.action}`, isError: true };
}
