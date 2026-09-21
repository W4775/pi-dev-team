import { spawnPiChild } from "./child-process.ts";
import { expectedHandoffActions, isOmpHost } from "./spawn.ts";
import type { HandoffAction, IsolatedRole, RunState } from "./types.ts";

export const JUDGE_MODEL = "@tiny";
export const JUDGE_FALLBACK_MODEL = "@smol";
export const JUDGE_TIMEOUT_MS = 15_000;
export const JUDGE_CACHE_MS = 120_000;
export const JUDGE_STATE_CHARS = 4000;

export type JudgeQuestion =
  | { id: string; type: "bool"; ask: string }
  | { id: string; type: "choice"; ask: string; options: string[] }
  | { id: string; type: "score"; ask: string; levels: string[] };

export type JudgeAnswers = Record<string, unknown>;

export type JudgeResult =
  | { ok: true; answers: JudgeAnswers; model: string }
  | { ok: false; error: string };

export type JudgeComplete = (input: {
  prompt: string;
  model: string;
  timeoutMs: number;
  cwd: string;
}) => Promise<{ text: string } | { error: string }>;

export type JudgeOpts = {
  complete?: JudgeComplete;
  model?: string;
  fallbackModel?: string;
  timeoutMs?: number;
  cacheMs?: number;
  now?: number;
  omp?: boolean;
  cwd?: string;
};

type CacheEntry = { expires: number; result: Extract<JudgeResult, { ok: true }> };

const cache = new Map<string, CacheEntry>();
const inflight = new Map<string, Promise<JudgeResult>>();

export function clearJudgeCache(): void {
  cache.clear();
  inflight.clear();
}

export function extractJsonObject(text: string): Record<string, unknown> | undefined {
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/i)?.[1];
  const candidates = [text.trim(), fenced?.trim() ?? ""].filter(Boolean);
  for (const candidate of candidates) {
    const parsed = parseObject(candidate);
    if (parsed) return parsed;
    const start = candidate.indexOf("{");
    if (start < 0) continue;
    let end = candidate.lastIndexOf("}");
    while (end > start) {
      const sliced = parseObject(candidate.slice(start, end + 1));
      if (sliced) return sliced;
      end = candidate.lastIndexOf("}", end - 1);
    }
  }
  return undefined;
}

export function extractAssistantText(stdout: string): string {
  const parts: string[] = [];
  for (const line of stdout.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed.startsWith("{")) continue;
    let event: Record<string, unknown>;
    try {
      event = JSON.parse(trimmed) as Record<string, unknown>;
    } catch {
      continue;
    }
    const type = typeof event.type === "string" ? event.type.toLowerCase() : "";
    if (
      type &&
      /tool|usage|error|system/.test(type) &&
      !/text|assistant|message|content/.test(type)
    ) {
      continue;
    }
    const text = collectText(event);
    if (text) parts.push(text);
  }
  if (parts.length) return parts.join("");
  return stdout;
}

export function parseJudgeAnswers(
  text: string,
  questions: JudgeQuestion[],
): JudgeAnswers | undefined {
  const obj = extractJsonObject(extractAssistantText(text));
  if (!obj) return undefined;
  const answers: JudgeAnswers = {};
  for (const question of questions) {
    const raw = obj[question.id];
    if (raw === undefined) return undefined;
    if (question.type === "bool") {
      if (raw === true || raw === "true" || raw === 1 || raw === "1") answers[question.id] = true;
      else if (raw === false || raw === "false" || raw === 0 || raw === "0")
        answers[question.id] = false;
      else return undefined;
      continue;
    }
    if (question.type === "choice") {
      const value = typeof raw === "string" ? raw.trim() : "";
      if (!question.options.includes(value)) return undefined;
      answers[question.id] = value;
      continue;
    }
    if (
      typeof raw === "number" &&
      Number.isInteger(raw) &&
      raw >= 0 &&
      raw < question.levels.length
    ) {
      answers[question.id] = raw;
      continue;
    }
    if (typeof raw === "string") {
      const named = question.levels.indexOf(raw.trim());
      if (named >= 0) {
        answers[question.id] = named;
        continue;
      }
    }
    return undefined;
  }
  return answers;
}

export function buildJudgePrompt(state: string, questions: JudgeQuestion[]): string {
  const lines = questions.map((question) => {
    if (question.type === "bool") return `- ${question.id} (bool): ${question.ask}`;
    if (question.type === "choice") {
      return `- ${question.id} (choice): ${question.ask} Options: ${question.options.join(", ")}`;
    }
    return `- ${question.id} (score 0-${question.levels.length - 1}): ${question.ask} Levels: ${question.levels.join(", ")}`;
  });
  return [
    "You are a classifier. Do not call tools. Do not explain.",
    "Read STATE, then answer every question.",
    "",
    "STATE:",
    clip(state, JUDGE_STATE_CHARS),
    "",
    "QUESTIONS:",
    ...lines,
    "",
    `Reply with one JSON object whose keys are exactly: ${questions.map((q) => q.id).join(", ")}.`,
    "No markdown, no extra keys, no prose.",
  ].join("\n");
}

export function buildJudgeCliArgs(model: string, prompt: string, omp: boolean): string[] {
  const args = ["-p", "--no-session", "--no-skills", "--model", model];
  if (omp) args.push("--yolo");
  args.push(prompt);
  return args;
}

export async function judge(
  state: string,
  questions: JudgeQuestion[],
  opts: JudgeOpts = {},
): Promise<JudgeResult> {
  if (!questions.length) return { ok: false, error: "no questions" };
  const model = opts.model?.trim() || JUDGE_MODEL;
  const fallback = opts.fallbackModel?.trim() || JUDGE_FALLBACK_MODEL;
  const timeoutMs = opts.timeoutMs ?? JUDGE_TIMEOUT_MS;
  const cacheMs = opts.cacheMs ?? JUDGE_CACHE_MS;
  const now = opts.now ?? Date.now();
  const cwd = opts.cwd ?? process.cwd();
  const omp = opts.omp ?? isOmpHost();
  const prompt = buildJudgePrompt(state, questions);
  const key = `${model}\n${fallback}\n${prompt}`;
  const cached = cache.get(key);
  if (cached && cached.expires > now) return cached.result;

  const pending = inflight.get(key);
  if (pending) return pending;

  const work = (async (): Promise<JudgeResult> => {
    const complete = opts.complete ?? (omp ? completeWithHost : undefined);
    if (!complete) return { ok: false, error: "judge skipped: not omp and no complete()" };

    const models = fallback && fallback !== model ? [model, fallback] : [model];
    let lastError = "judge produced no answer";
    for (const candidate of models) {
      let reply: { text: string } | { error: string };
      try {
        reply = await complete({ prompt, model: candidate, timeoutMs, cwd });
      } catch (err) {
        lastError = err instanceof Error ? err.message : String(err);
        continue;
      }
      if ("error" in reply) {
        lastError = reply.error;
        if (candidate !== models.at(-1)) continue;
        return { ok: false, error: lastError };
      }
      const answers = parseJudgeAnswers(reply.text, questions);
      if (!answers) {
        lastError = "judge reply was not valid JSON for the questions";
        continue;
      }
      const result: Extract<JudgeResult, { ok: true }> = { ok: true, answers, model: candidate };
      if (cacheMs > 0) cache.set(key, { expires: now + cacheMs, result });
      return result;
    }
    return { ok: false, error: lastError };
  })();

  inflight.set(key, work);
  try {
    return await work;
  } finally {
    inflight.delete(key);
  }
}

export function handoffJudgeQuestions(role: IsolatedRole): JudgeQuestion[] | undefined {
  const options = [...expectedHandoffActions(role), "none"];
  if (options.length < 2) return undefined;
  return [
    {
      id: "action",
      type: "choice",
      ask: `Which handoff did the ${role.replaceAll("_", " ")} complete? Use none if the child did not finish the step.`,
      options,
    },
  ];
}

export function summarizeRunForJudge(role: IsolatedRole, run: RunState, childStdout = ""): string {
  const lines = [
    `role: ${role}`,
    `stage: ${run.stage}`,
    `task: ${clip(run.task, 400)}`,
    `expected: ${expectedHandoffActions(role).join(" | ") || "(none)"}`,
  ];
  pushField(lines, "spec", run.spec, 600);
  if (role === "plan_critic") pushField(lines, "planCritique", run.planCritique?.notes, 600);
  if (role === "design_critic") pushField(lines, "designCritique", run.designCritiqueNotes, 600);
  if (role === "planner_orchestrator" || role === "scout") {
    const items = run.scoutItems ?? [];
    lines.push(
      `scoutItems: ${items.length} (${items.filter((item) => item.status === "done").length} done)`,
    );
    pushField(lines, "scoutNotes", run.scoutNotes, 400);
  }
  if (role === "orchestrator") lines.push(`workItems: ${run.workItems?.length ?? 0}`);
  if (role === "database") pushField(lines, "databaseNotes", run.databaseNotes, 500);
  if (role === "backend") pushField(lines, "backendNotes", run.backendNotes, 500);
  if (role === "frontend") pushField(lines, "frontendNotes", run.frontendNotes, 500);
  if (role === "general") pushField(lines, "generalNotes", run.generalNotes, 500);
  if (role === "reviewer" || role === "tester" || role === "linter") {
    const findings = (run.reviewFindings ?? [])
      .map((finding) => `${finding.severity}:${finding.text}`)
      .join(" | ");
    pushField(lines, "reviewFindings", findings, 600);
  }
  if (role === "tester") {
    if (run.testFailed !== undefined) lines.push(`testFailed: ${run.testFailed}`);
    pushField(lines, "testResults", run.testResults, 600);
  }
  if (role === "linter") {
    if (run.lintErrors !== undefined) lines.push(`lintErrors: ${run.lintErrors}`);
    pushField(lines, "lintResults", run.lintResults, 600);
  }
  if (role === "demo") pushField(lines, "demoNotes", run.demoNotes, 400);
  if (role === "commit_message")
    pushField(lines, "commitMessageDraft", run.commitMessageDraft, 300);
  const output = clip(extractAssistantText(childStdout).trim() || childStdout.trim(), 1500);
  if (output) lines.push(`childOutput:\n${output}`);
  return lines.join("\n");
}

export async function inferHandoffFromJudge(opts: {
  role: IsolatedRole;
  run: RunState;
  childStdout?: string;
  complete?: JudgeComplete;
  omp?: boolean;
  cwd?: string;
}): Promise<HandoffAction | undefined> {
  const questions = handoffJudgeQuestions(opts.role);
  if (!questions) return undefined;
  const allowed = new Set<string>(expectedHandoffActions(opts.role));
  const result = await judge(
    summarizeRunForJudge(opts.role, opts.run, opts.childStdout ?? ""),
    questions,
    {
      complete: opts.complete,
      omp: opts.omp,
      cwd: opts.cwd,
    },
  );
  if (!result.ok) return undefined;
  const action = result.answers.action;
  if (typeof action !== "string" || action === "none" || !allowed.has(action)) return undefined;
  return action as HandoffAction;
}

export const SCOUT_SKIP_QUESTION: JudgeQuestion = {
  id: "skipScout",
  type: "bool",
  ask: "Does this task already name the files, paths, or endpoints to change, so repository recon is unnecessary? Answer true only when a developer could start editing without first exploring the tree.",
};

export function summarizeTaskForScoutSkip(run: Pick<RunState, "task" | "stack">): string {
  const stack = run.stack;
  return [
    `task: ${clip(run.task, 400)}`,
    `uiSurface: ${stack?.uiSurface ?? "unknown"}`,
    `frontend: ${stack?.frontend ?? "none"}`,
    `backend: ${(stack?.backends ?? []).join(", ") || "none"}`,
    `services: ${stack?.services?.map((service) => service.name).join(", ") || "none"}`,
  ].join("\n");
}

export async function inferScoutSkipFromJudge(opts: {
  run: Pick<RunState, "task" | "stack">;
  complete?: JudgeComplete;
  omp?: boolean;
  cwd?: string;
}): Promise<boolean | undefined> {
  const result = await judge(summarizeTaskForScoutSkip(opts.run), [SCOUT_SKIP_QUESTION], {
    complete: opts.complete,
    omp: opts.omp,
    cwd: opts.cwd,
  });
  if (!result.ok) return undefined;
  if (result.answers.skipScout === true) return true;
  if (result.answers.skipScout === false) return false;
  return undefined;
}

export const BASH_FAILURE_CLASSES = ["no_failure", "code_bug", "environment", "transient"] as const;
export type BashFailureClass = (typeof BASH_FAILURE_CLASSES)[number];

export const BASH_FAILURE_ADVICE: Record<BashFailureClass, string> = {
  no_failure: "",
  code_bug: "Fix the code under test.",
  environment:
    "Fix the environment (missing binary, port, or permissions); do not change product code.",
  transient: "Retry the same command unchanged (network or flake).",
};

export const BASH_FAILURE_QUESTION: JudgeQuestion = {
  id: "failureClass",
  type: "choice",
  ask: "What kind of failure is in this tester or linter bash output? Use no_failure when tests/lint succeeded. Use code_bug for product or test-code defects. Use environment for missing tools, ports, or permissions. Use transient for flakes and network hiccups.",
  options: [...BASH_FAILURE_CLASSES],
};

export function applyBashFailureClass(
  heuristic: boolean | undefined,
  klass: BashFailureClass | undefined,
): { failed: boolean | undefined; halt?: Exclude<BashFailureClass, "no_failure" | "code_bug"> } {
  if (klass === "environment" || klass === "transient") return { failed: heuristic, halt: klass };
  if (klass === "code_bug") return { failed: true };
  if (klass === "no_failure") return { failed: heuristic === true ? true : false };
  return { failed: heuristic };
}

export function summarizeBashForJudge(opts: {
  role: "tester" | "linter";
  stdout: string;
  heuristic?: boolean;
}): string {
  const heuristic =
    opts.heuristic === true ? "failed" : opts.heuristic === false ? "passed" : "unknown";
  const output = clip(extractAssistantText(opts.stdout).trim() || opts.stdout.trim(), 2000);
  return [
    `role: ${opts.role}`,
    `heuristicBash: ${heuristic}`,
    output ? `childOutput:\n${output}` : "childOutput: (empty)",
  ].join("\n");
}

export async function inferBashFailureFromJudge(opts: {
  role: "tester" | "linter";
  stdout: string;
  heuristic?: boolean;
  complete?: JudgeComplete;
  omp?: boolean;
  cwd?: string;
}): Promise<BashFailureClass | undefined> {
  const result = await judge(summarizeBashForJudge(opts), [BASH_FAILURE_QUESTION], {
    complete: opts.complete,
    omp: opts.omp,
    cwd: opts.cwd,
  });
  if (!result.ok) return undefined;
  const value = result.answers.failureClass;
  if (typeof value !== "string") return undefined;
  return (BASH_FAILURE_CLASSES as readonly string[]).includes(value)
    ? (value as BashFailureClass)
    : undefined;
}

export async function completeWithHost(input: {
  prompt: string;
  model: string;
  timeoutMs: number;
  cwd: string;
}): Promise<{ text: string } | { error: string }> {
  const omp = isOmpHost();
  const args = buildJudgeCliArgs(input.model, input.prompt, omp);
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), Math.max(1_000, input.timeoutMs));
  try {
    const spawned = spawnPiChild({
      args,
      cwd: input.cwd,
      env: process.env,
      signal: ac.signal,
    });
    const result = await spawned.done;
    if (ac.signal.aborted) return { error: `judge timed out after ${input.timeoutMs}ms` };
    if (result.code !== 0) {
      const detail = result.output.trim() || `exit ${result.code}`;
      return { error: clip(detail, 500) };
    }
    const text = result.stdout.trim() || result.output.trim();
    if (!text) return { error: "judge returned empty output" };
    return { text };
  } catch (err) {
    return { error: err instanceof Error ? err.message : String(err) };
  } finally {
    clearTimeout(timer);
  }
}

function parseObject(text: string): Record<string, unknown> | undefined {
  try {
    const parsed: unknown = JSON.parse(text);
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>;
    }
  } catch {
    /* not json */
  }
  return undefined;
}

function collectText(node: unknown): string {
  if (typeof node === "string") return node;
  if (!node || typeof node !== "object") return "";
  if (Array.isArray(node)) return node.map(collectText).join("");
  const record = node as Record<string, unknown>;
  const direct = record.text ?? record.delta ?? record.content;
  if (typeof direct === "string") return direct;
  if (Array.isArray(direct) || (direct && typeof direct === "object")) return collectText(direct);
  if (record.message && typeof record.message === "object") return collectText(record.message);
  return "";
}

function clip(value: string | undefined, max: number): string {
  const text = value?.replace(/\s+/g, " ").trim() ?? "";
  if (text.length <= max) return text;
  return `${text.slice(0, max - 1)}…`;
}

function pushField(lines: string[], name: string, value: string | undefined, max: number): void {
  const text = clip(value, max);
  if (text) lines.push(`${name}: ${text}`);
}
