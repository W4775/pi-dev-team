import { existsSync, readdirSync } from "node:fs";
import { basename, join } from "node:path";
import { loadRun, readCurrentJobId, runPaths } from "./state.ts";
import type { RunState } from "./types.ts";

export type JobSummary = {
  index: number;
  jobId: string;
  file: string;
  task: string;
  stage: string;
  pauseReason?: string;
  updatedAt: string;
  cwd?: string;
  current: boolean;
};

export function newJobId(taken: Iterable<string> = []): string {
  const used = new Set(taken);
  for (let i = 0; i < 24; i++) {
    const id = `${Date.now().toString(36).slice(-3)}${Math.random().toString(36).slice(2, 5)}`;
    if (!used.has(id)) return id;
  }
  return `job${Date.now().toString(36)}`;
}

export function listJobs(agentDir: string, currentJobId?: string): JobSummary[] {
  const dir = join(agentDir, "devteam", "runs");
  if (!existsSync(dir)) return [];
  const pointer = currentJobId ?? readCurrentJobId(agentDir);
  const summaries: Omit<JobSummary, "index">[] = [];
  for (const name of readdirSync(dir)) {
    if (!name.endsWith(".json")) continue;
    const file = join(dir, name);
    const run = loadRun(file);
    if (!run) continue;
    if (run.stage === "idle" && !run.task) continue;
    const jobId = run.jobId || basename(name, ".json");
    summaries.push({
      jobId,
      file,
      task: run.task || "(untitled)",
      stage: run.stage,
      pauseReason: run.pauseReason,
      updatedAt: run.updatedAt || run.createdAt,
      cwd: run.cwd,
      current: pointer === jobId,
    });
  }
  summaries.sort((a, b) => (b.updatedAt || "").localeCompare(a.updatedAt || ""));
  return summaries.slice(0, 50).map((item, index) => ({ ...item, index: index + 1 }));
}

export function resolveJobRef(jobs: JobSummary[], ref: string): JobSummary | undefined {
  const raw = ref.trim().replace(/^#/, "");
  if (!raw) return undefined;
  if (/^\d+$/.test(raw)) {
    const n = Number(raw);
    return jobs.find((job) => job.index === n);
  }
  const exact = jobs.find((job) => job.jobId === raw);
  if (exact) return exact;
  const prefix = jobs.filter((job) => job.jobId.startsWith(raw));
  if (prefix.length === 1) return prefix[0];
  return undefined;
}

export function renderJobList(jobs: JobSummary[]): string {
  if (jobs.length === 0) {
    return [
      "No saved /devteam jobs yet.",
      "Start one with /devteam <task>. Jobs are kept when you start another task.",
    ].join("\n");
  }
  const lines = [
    `# Devteam jobs (${jobs.length})`,
    ``,
    `Resume with /devteam continue <n> or /devteam continue <id>`,
    ``,
  ];
  for (const job of jobs) {
    const mark = job.current ? "*" : " ";
    const when = formatWhen(job.updatedAt);
    const pause = job.pauseReason ? ` / ${job.pauseReason}` : "";
    lines.push(`${mark}${job.index}. ${job.jobId}  ${job.stage}${pause}`);
    lines.push(`    ${truncate(job.task, 80)}  ${when}`);
    if (job.cwd) lines.push(`    ${job.cwd}`);
  }
  lines.push(``, `* = current job`);
  return lines.join("\n");
}

export function loadJob(agentDir: string, jobId: string): RunState | undefined {
  return loadRun(runPaths(agentDir, jobId).json);
}

function truncate(text: string, max: number): string {
  const t = text.replace(/\s+/g, " ").trim();
  return t.length <= max ? t : `${t.slice(0, max - 1)}…`;
}

function formatWhen(iso: string): string {
  if (!iso) return "";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toISOString().replace("T", " ").slice(0, 16);
}
