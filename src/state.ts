import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { matchAnyGlob } from "./glob.ts";
import { withStateLock } from "./lock.ts";
import { normalizeServices, renderServices } from "./services.ts";
import { normalizeWorkItems, renderWorkItems } from "./work.ts";
import { normalizeScoutItems, renderScoutItems } from "./scout.ts";
import { withCritiqueItems } from "./critique.ts";
import type { Finding, ImplementorLayer, PauseReason, RoleName, RunState, StackDetection, Stage, UiSurface } from "./types.ts";

export const STATE_SECTIONS = [
  "task",
  "spec",
  "layersNeeded",
  "filesToChange",
  "uiSurface",
  "wantMockup",
  "stack",
  "workItems",
  "scoutItems",
  "scoutNotes",
  "planCritiqueNotes",
  "designTokens",
  "uiPrimitives",
  "designPlan",
  "mockupPath",
  "mockupVersion",
  "designCritiqueNotes",
  "databaseNotes",
  "backendNotes",
  "frontendNotes",
  "generalNotes",
  "openQuestions",
  "reviewFindings",
  "testResults",
  "lintResults",
  "commitMessageDraft",
  "currentStatus",
  "nextAgent",
] as const;

export type StateSection = (typeof STATE_SECTIONS)[number];

export function emptyRun(sessionId: string, task = "", jobId?: string): RunState {
  const now = new Date().toISOString();
  const job = jobId || sessionId || "session";
  return {
    version: 1,
    sessionId,
    jobId: job,
    task,
    stage: "idle",
    pipelineLocked: false,
    implementorQueue: [],
    implementorIndex: 0,
    serviceQueue: [],
    serviceIndex: 0,
    designRejectCount: 0,
    fixRound: { review: 0, test: 0, lint: 0 },
    createdAt: now,
    updatedAt: now,
  };
}

export function runPaths(agentDir: string, sessionId: string) {
  const safe = sessionId.replace(/[^\w.-]+/g, "_") || "session";
  const dir = join(agentDir, "devteam", "runs");
  const aliases = workflowStatePaths(agentDir);
  return {
    json: join(dir, `${safe}.json`),
    workflowStateJson: aliases.json,
    workflowStateMd: aliases.md,
    mockupDir: join(dir, safe, "mockup"),
    mockupFile: join(dir, safe, "mockup", "index.html"),
  };
}

export function currentJobPointerPath(agentDir: string) {
  return join(agentDir, "devteam", "current");
}

export function readCurrentJobId(agentDir: string): string | undefined {
  const path = currentJobPointerPath(agentDir);
  if (!existsSync(path)) return undefined;
  try {
    const id = readFileSync(path, "utf8").trim();
    return id || undefined;
  } catch {
    return undefined;
  }
}

export function writeCurrentJobId(agentDir: string, jobId: string): void {
  mkdirSync(join(agentDir, "devteam"), { recursive: true });
  writeFileSync(currentJobPointerPath(agentDir), `${jobId}\n`);
}
export function workflowStatePaths(agentDir: string) {
  const dir = join(agentDir, "devteam");
  return {
    json: join(dir, "workflow_state.json"),
    md: join(dir, "workflow_state.md"),
  };
}

function asStringList(value: unknown): string[] {
  if (Array.isArray(value)) return value.map(String).filter(Boolean);
  if (typeof value === "string" && value.trim()) return [value];
  return [];
}

function asOptionalString(value: unknown): string | undefined {
  if (typeof value === "string" && value.trim()) return value;
  if (Array.isArray(value) && typeof value[0] === "string" && value[0].trim()) return value[0];
  return undefined;
}

export function normalizeStack(raw: unknown, fallbackUi?: UiSurface): StackDetection | undefined {
  if (!raw || typeof raw !== "object") return undefined;
  const o = raw as Record<string, unknown>;
  const ui = o.uiSurface;
  const uiSurface: UiSurface =
    ui === "web" || ui === "native" || ui === "terminal" || ui === "none" ? ui : (fallbackUi ?? "none");
  const backend = asOptionalString(o.backend);
  const backends = asStringList(o.backends);
  return {
    frontend: asOptionalString(o.frontend),
    backend: backend ?? backends[0],
    backends: backends.length ? backends : backend ? [backend] : [],
    database: asStringList(o.database),
    tester: asStringList(o.tester),
    extra: asStringList(o.extra),
    uiSurface,
    matchedIds: asStringList(o.matchedIds),
    services: normalizeServices(o.services),
  };
}

export function loadRun(path: string): RunState | undefined {
  if (!existsSync(path)) return undefined;
  try {
    const run = JSON.parse(readFileSync(path, "utf8")) as RunState;
    if (run.stack) run.stack = normalizeStack(run.stack, run.uiSurface) ?? run.stack;
    if (!run.fixRound) run.fixRound = { review: 0, test: 0, lint: 0 };
    if (!Array.isArray(run.serviceQueue)) run.serviceQueue = [];
    if (typeof run.serviceIndex !== "number") run.serviceIndex = 0;
    if (run.workItems) run.workItems = normalizeWorkItems(run.workItems);
    if (run.scoutItems) run.scoutItems = normalizeScoutItems(run.scoutItems);
    if (!run.jobId) run.jobId = basename(path, ".json") || run.sessionId || "session";
    return run;
  } catch {
    return undefined;
  }
}

export function loadPreferredRun(sessionPath: string, aliasPath: string): RunState | undefined {
  const session = loadRun(sessionPath);
  const alias = sessionPath === aliasPath ? undefined : loadRun(aliasPath);
  if (!session) return alias;
  if (!alias) return session;
  if (session.stage === "idle" && alias.stage !== "idle") return alias;
  if (alias.stage === "idle" && session.stage !== "idle") return session;
  return (alias.updatedAt ?? "") > (session.updatedAt ?? "") ? alias : session;
}

export function saveRun(path: string, run: RunState, agentDir?: string): void {
  mkdirSync(dirname(path), { recursive: true });
  run.updatedAt = new Date().toISOString();
  const json = `${JSON.stringify(run, null, 2)}\n`;
  writeFileSync(path, json);
  if (agentDir) {
    const aliases = workflowStatePaths(agentDir);
    mkdirSync(dirname(aliases.json), { recursive: true });
    writeFileSync(aliases.json, json);
    writeFileSync(
      aliases.md,
      `${renderRunMarkdown(run, { canonicalPath: path, aliasPath: aliases.json })}\n`,
    );
    if (run.jobId) writeCurrentJobId(agentDir, run.jobId);
  }
}

export function mutateRun(
  path: string,
  agentDir: string | undefined,
  change: (run: RunState) => RunState | undefined,
): RunState | undefined {
  return withStateLock(path, () => {
    const current = agentDir
      ? loadPreferredRun(path, workflowStatePaths(agentDir).json)
      : loadRun(path);
    if (!current) return undefined;
    const next = change(current);
    if (!next) return current;
    saveRun(path, next, agentDir);
    return next;
  });
}

export function clearRunFiles(agentDir: string, sessionId: string): void {
  const paths = runPaths(agentDir, sessionId);
  for (const file of [paths.json, paths.workflowStateJson, paths.workflowStateMd]) {
    try {
      rmSync(file, { force: true });
    } catch {
      /* ignore */
    }
  }
  try {
    rmSync(dirname(paths.mockupDir), { recursive: true, force: true });
  } catch {
    /* ignore */
  }
}

export function getSection(run: RunState, section: StateSection): unknown {
  switch (section) {
    case "task":
      return run.task;
    case "spec":
      return run.spec;
    case "layersNeeded":
      return run.layersNeeded;
    case "filesToChange":
      return run.filesToChange;
    case "uiSurface":
      return run.uiSurface;
    case "wantMockup":
      return run.wantMockup;
    case "stack":
      return run.stack;
    case "workItems":
      return run.workItems;
    case "scoutItems":
      return run.scoutItems;
    case "scoutNotes":
      return run.scoutNotes;
    case "planCritiqueNotes":
      return run.planCritique?.notes;
    case "designTokens":
      return run.designTokens;
    case "uiPrimitives":
      return run.uiPrimitives;
    case "designPlan":
      return run.designPlan;
    case "mockupPath":
      return run.mockupPath;
    case "mockupVersion":
      return run.mockupVersion;
    case "designCritiqueNotes":
      return run.designCritiqueNotes;
    case "databaseNotes":
      return run.databaseNotes;
    case "backendNotes":
      return run.backendNotes;
    case "frontendNotes":
      return run.frontendNotes;
    case "generalNotes":
      return run.generalNotes;
    case "openQuestions":
      return run.openQuestions;
    case "reviewFindings":
      return run.reviewFindings;
    case "testResults":
      return run.testResults;
    case "lintResults":
      return run.lintResults;
    case "commitMessageDraft":
      return run.commitMessageDraft;
    case "currentStatus":
      return run.currentStatus;
    case "nextAgent":
      return run.nextAgent;
    default:
      return undefined;
  }
}

export function updateSection(run: RunState, section: StateSection, value: unknown): RunState {
  const next = { ...run, updatedAt: new Date().toISOString() };
  switch (section) {
    case "task":
      next.task = String(value ?? "");
      break;
    case "spec":
      next.spec = String(value ?? "");
      break;
    case "layersNeeded":
      next.layersNeeded = Array.isArray(value) ? value.map(String) : String(value ?? "").split(/[,\s]+/).filter(Boolean);
      break;
    case "filesToChange":
      next.filesToChange = (value ?? {}) as RunState["filesToChange"];
      break;
    case "uiSurface":
      next.uiSurface = value as RunState["uiSurface"];
      if (next.stack) next.stack = { ...next.stack, uiSurface: next.uiSurface ?? next.stack.uiSurface };
      break;
    case "wantMockup":
      if (value === true || value === "true" || value === "yes") next.wantMockup = true;
      else if (value === false || value === "false" || value === "no") next.wantMockup = false;
      else next.wantMockup = undefined;
      break;
    case "stack":
      next.stack = normalizeStack(value, next.uiSurface ?? next.stack?.uiSurface);
      break;
    case "workItems":
      next.workItems = normalizeWorkItems(value);
      break;
    case "scoutItems":
      next.scoutItems = normalizeScoutItems(value);
      break;
    case "scoutNotes":
      next.scoutNotes = String(value ?? "");
      break;
    case "planCritiqueNotes": {
      const notes = String(value ?? "");
      next.planCritique = withCritiqueItems(next.planCritique, notes);
      break;
    }
    case "designTokens":
      next.designTokens = String(value ?? "");
      break;
    case "uiPrimitives":
      next.uiPrimitives = String(value ?? "");
      break;
    case "designPlan":
      next.designPlan = String(value ?? "");
      break;
    case "mockupPath":
      next.mockupPath = String(value ?? "");
      break;
    case "mockupVersion":
      next.mockupVersion = Number(value) || 0;
      break;
    case "designCritiqueNotes":
      next.designCritiqueNotes = String(value ?? "");
      break;
    case "databaseNotes":
      next.databaseNotes = String(value ?? "");
      break;
    case "backendNotes":
      next.backendNotes = String(value ?? "");
      break;
    case "frontendNotes":
      next.frontendNotes = String(value ?? "");
      break;
    case "generalNotes":
      next.generalNotes = String(value ?? "");
      break;
    case "openQuestions":
      next.openQuestions = String(value ?? "");
      break;
    case "reviewFindings":
      next.reviewFindings = parseFindings(value);
      break;
    case "testResults": {
      const text = String(value ?? "");
      next.testResults = text;
      next.testFailed = /fail|error|not ok|FAILED/i.test(text) && !/0 fail/i.test(text);
      break;
    }
    case "lintResults": {
      const text = String(value ?? "");
      next.lintResults = text;
      next.lintErrors = /\berror\b/i.test(text) && !/0 error/i.test(text);
      break;
    }
    case "commitMessageDraft":
      next.commitMessageDraft = String(value ?? "");
      break;
    case "currentStatus":
      next.currentStatus = String(value ?? "");
      break;
    case "nextAgent":
      next.nextAgent = String(value ?? "");
      break;
    default:
      break;
  }
  return next;
}

export function parseFindings(value: unknown): Finding[] {
  if (Array.isArray(value)) {
    return value.map((item) => {
      if (typeof item === "string") return classifyFindingLine(item);
      const obj = item as Finding;
      return {
        axis: obj.axis === "spec" ? "spec" : "standards",
        severity: obj.severity === "note" ? "note" : "block",
        text: String(obj.text ?? ""),
        files: obj.files,
      };
    });
  }
  const text = String(value ?? "");
  return text
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean)
    .map(classifyFindingLine);
}

export function classifyFindingLine(line: string): Finding {
  const lower = line.toLowerCase();
  const axis: Finding["axis"] = lower.includes("spec") ? "spec" : "standards";
  const fileMatch = line.match(/\[(?:block|note)\]\s+([^:]+):/i);
  const files = fileMatch ? [fileMatch[1].trim()] : undefined;

  if (/\[note\]/i.test(line) && !/\[block\]/i.test(line)) {
    return { axis, severity: "note", text: line, files };
  }
  if (/\[block\]/i.test(line)) {
    return { axis, severity: "block", text: line, files };
  }

  const isNote =
    lower.startsWith("note:") ||
    lower.includes("smell") ||
    lower.includes("warning") ||
    lower.includes("judgement") ||
    lower.includes("judgment");
  const isBlock =
    lower.startsWith("block:") ||
    lower.includes("missing") ||
    lower.includes("violation") ||
    lower.includes("error");
  let severity: Finding["severity"] = "note";
  if (isBlock && !isNote) severity = "block";
  if (isNote && !isBlock) severity = "note";
  if (isBlock && isNote) severity = lower.startsWith("block:") ? "block" : "note";
  if (!isBlock && !isNote && (lower.includes("must") || lower.includes("fail"))) severity = "block";
  return { axis, severity, text: line, files };
}

export function hasBlockFindings(findings: Finding[] | undefined): boolean {
  return Boolean(findings?.some((f) => f.severity === "block"));
}

export function renderRunMarkdown(
  run: RunState,
  files?: { canonicalPath?: string; aliasPath?: string },
): string {
  const lines: string[] = [
    `# Devteam run`,
    ``,
    `- **Task:** ${run.task || "(none)"}`,
    `- **Job:** ${run.jobId || "—"}`,
    `- **Stage:** ${run.stage}${run.pauseReason ? ` (paused: ${run.pauseReason})` : ""}`,
    `- **Locked:** ${run.pipelineLocked ? "yes" : "no"}`,
    `- **Want mockup:** ${run.wantMockup === undefined ? "unset" : run.wantMockup ? "yes" : "no"}`,
  ];
  if (run.stack) {
    const database = Array.isArray(run.stack.database) ? run.stack.database.join(",") : String(run.stack.database ?? "");
    const matched = Array.isArray(run.stack.matchedIds) ? run.stack.matchedIds.join(", ") : String(run.stack.matchedIds ?? "");
    const backends = run.stack.backends?.length ? run.stack.backends.join(",") : run.stack.backend;
    lines.push(
      `- **Stack:** frontend=${run.stack.frontend ?? "—"} backend=${backends || "—"} database=${database || "—"} ui=${run.stack.uiSurface ?? "—"}`,
    );
    lines.push(`- **Matched:** ${matched || "—"}`);
  }
  if (run.resolvedSkills) {
    for (const [layer, skills] of Object.entries(run.resolvedSkills)) {
      const desc = skills
        .map((s) => (s.source === "unresolved" ? `${s.name} (unresolved)` : `${s.name} [${s.source}]`))
        .join(", ");
      lines.push(`- **Skills (${layer}):** ${desc || "workflow skills only"}`);
    }
  }
  if (run.gitBaseline) lines.push(`- **Git baseline:** ${run.gitBaseline}${run.dirtyAtStart ? " (dirty tree at start)" : ""}`);
  if (run.layersNeeded?.length) lines.push(`- **Layers needed:** ${run.layersNeeded.join(", ")}`);
  if (run.reviewLayer) lines.push(`- **Review layer:** ${run.reviewLayer}`);
  if (run.currentService) lines.push(`- **Current service:** ${run.currentService}`);
  if (run.stack?.services?.length) lines.push(``, `## Services`, ``, renderServices(run.stack.services));
  if (run.scoutItems?.length) lines.push(``, `## Scout items`, ``, renderScoutItems(run.scoutItems));
  if (run.scoutNotes) lines.push(``, `## Scout notes`, ``, run.scoutNotes);
  if (run.workItems?.length) lines.push(``, `## Work items`, ``, renderWorkItems(run.workItems));
  if (run.spec) lines.push(``, `## Spec`, ``, run.spec);
  if (run.planCritique?.notes || run.planCritique?.items?.length) {
    lines.push(``, `## Plan critique`, ``, run.planCritique.notes || "");
    if (run.planCritique.items?.length) {
      for (const item of run.planCritique.items) {
        const mark = item.decision === "accept" ? "accept" : item.decision === "reject" ? "reject" : "pending";
        lines.push(`- [${mark}] ${item.title}: ${item.text}`);
      }
    }
  }
  if (run.designTokens) lines.push(``, `## Design tokens`, ``, run.designTokens);
  if (run.uiPrimitives) lines.push(``, `## UI primitives`, ``, run.uiPrimitives);
  if (run.designPlan) lines.push(``, `## Design plan`, ``, run.designPlan);
  if (run.mockupPath) lines.push(``, `- **Mockup:** ${run.mockupPath} (v${run.mockupVersion ?? 1})`);
  if (run.designCritiqueNotes) lines.push(``, `## Design critique`, ``, run.designCritiqueNotes);
  if (run.databaseNotes) lines.push(``, `## Database`, ``, run.databaseNotes);
  if (run.backendNotes) lines.push(``, `## Backend`, ``, run.backendNotes);
  if (run.frontendNotes) lines.push(``, `## Frontend`, ``, run.frontendNotes);
  if (run.generalNotes) lines.push(``, `## General`, ``, run.generalNotes);
  if (run.openQuestions) lines.push(``, `## Open questions`, ``, run.openQuestions);
  if (run.reviewFindings?.length) {
    lines.push(``, `## Review findings`);
    for (const f of run.reviewFindings) {
      lines.push(`- **${f.severity}/${f.axis}:** ${f.text}`);
    }
  }
  if (run.testResults) lines.push(``, `## Tests`, ``, run.testResults);
  if (run.lintResults) lines.push(``, `## Lint`, ``, run.lintResults);
  if (run.commitMessageDraft) lines.push(``, `## Commit message draft`, ``, "```", run.commitMessageDraft, "```");
  if (run.currentStatus) lines.push(``, `## Status`, ``, run.currentStatus);
  if (run.lastError) lines.push(``, `## Last error`, ``, run.lastError);
  lines.push(``, `_Fix rounds:_ review ${run.fixRound.review}, test ${run.fixRound.test}, lint ${run.fixRound.lint}`);
  if (files?.canonicalPath || files?.aliasPath) {
    lines.push(``, `## Files`, ``);
    if (files.aliasPath) {
      lines.push(`- **workflow_state:** \`${files.aliasPath}\``);
    }
    if (files.canonicalPath) {
      lines.push(`- **Session JSON:** \`${files.canonicalPath}\``);
    }
    lines.push(`- Not stored in the plugin install folder.`);
  }
  return lines.join("\n");
}

export function setStage(run: RunState, stage: Stage, extra?: { pauseReason?: PauseReason; role?: RoleName }): RunState {
  return {
    ...run,
    stage,
    pauseReason: extra?.pauseReason,
    currentRole: extra?.role,
    interactiveRole: extra?.role === "planner" || extra?.role === "designer" ? extra.role : undefined,
    pipelineLocked: false,
    updatedAt: new Date().toISOString(),
  };
}

export function layerFromFile(
  file: string,
  filesToChange: RunState["filesToChange"],
  globs?: Partial<Record<ImplementorLayer, string[]>>,
): ImplementorLayer | undefined {
  if (filesToChange) {
    for (const layer of ["database", "backend", "frontend", "general"] as ImplementorLayer[]) {
      const listed = filesToChange[layer] ?? [];
      if (listed.some((p) => file.endsWith(p) || p.endsWith(file) || file.includes(p))) return layer;
    }
  }
  if (globs) {
    for (const layer of ["database", "backend", "frontend", "general"] as ImplementorLayer[]) {
      const patterns = globs[layer];
      if (patterns && matchAnyGlob(patterns, file)) return layer;
    }
  }
  if (/(migrat|schema|prisma|sql|models?)/i.test(file)) return "database";
  if (/(server|api|route|controller|endpoint)/i.test(file)) return "backend";
  if (/(component|app\/|pages\/|ui\/|\.tsx$|\.vue$|\.css$)/i.test(file)) return "frontend";
  return undefined;
}
