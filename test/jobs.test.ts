import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { emptyRun, saveRun } from "../src/state.ts";
import { listJobs, newJobId, renderJobList, resolveJobRef } from "../src/jobs.ts";

test("listJobs returns newest first and resolveJobRef accepts index or id", () => {
  const agentDir = mkdtempSync(join(tmpdir(), "devteam-jobs-"));
  const older = emptyRun("s1", "Auth cookies", "oldjob");
  older.stage = "done";
  older.updatedAt = "2026-01-01T00:00:00.000Z";
  const newer = emptyRun("s2", "Settings page", "newjob");
  newer.stage = "build_it_pause";
  newer.updatedAt = "2026-09-09T12:00:00.000Z";
  saveRun(join(agentDir, "devteam", "runs", "oldjob.json"), older, agentDir);
  saveRun(join(agentDir, "devteam", "runs", "newjob.json"), newer, agentDir);

  const jobs = listJobs(agentDir, "newjob");
  assert.equal(jobs.length, 2);
  assert.equal(jobs[0]?.jobId, "newjob");
  assert.equal(jobs[0]?.current, true);
  assert.equal(jobs[1]?.jobId, "oldjob");
  assert.equal(resolveJobRef(jobs, "1")?.jobId, "newjob");
  assert.equal(resolveJobRef(jobs, "#2")?.jobId, "oldjob");
  assert.equal(resolveJobRef(jobs, "old")?.jobId, "oldjob");
  assert.match(renderJobList(jobs), /continue <n>/);
});

test("starting a second job does not remove the first from the list", () => {
  const agentDir = mkdtempSync(join(tmpdir(), "devteam-jobs2-"));
  const first = emptyRun("s", "First task", "aaa111");
  first.stage = "planner";
  saveRun(join(agentDir, "devteam", "runs", "aaa111.json"), first, agentDir);
  const second = emptyRun("s", "Second task", "bbb222");
  second.stage = "planner";
  saveRun(join(agentDir, "devteam", "runs", "bbb222.json"), second, agentDir);
  const jobs = listJobs(agentDir);
  assert.equal(jobs.length, 2);
  assert.ok(jobs.some((j) => j.jobId === "aaa111"));
  assert.ok(jobs.some((j) => j.jobId === "bbb222"));
});

test("newJobId is unique against taken ids", () => {
  const taken = new Set([newJobId(), newJobId()]);
  const next = newJobId(taken);
  assert.equal(taken.has(next), false);
});
