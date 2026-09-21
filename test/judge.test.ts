import assert from "node:assert/strict";
import { test } from "node:test";
import {
  buildJudgeCliArgs,
  buildJudgePrompt,
  clearJudgeCache,
  extractJsonObject,
  applyBashFailureClass,
  inferBashFailureFromJudge,
  inferHandoffFromJudge,
  inferScoutSkipFromJudge,
  judge,
  parseJudgeAnswers,
} from "../src/judge.ts";
import { emptyRun } from "../src/state.ts";

const questions = [
  {
    id: "action",
    type: "choice" as const,
    ask: "Which handoff?",
    options: ["qa_pass", "qa_fail", "none"],
  },
];

test("parseJudgeAnswers reads JSON, fences, and event streams", () => {
  assert.deepEqual(parseJudgeAnswers('{"action":"qa_pass"}', questions), { action: "qa_pass" });
  assert.deepEqual(parseJudgeAnswers('```json\n{"action":"qa_fail"}\n```', questions), {
    action: "qa_fail",
  });
  assert.deepEqual(
    parseJudgeAnswers('{"type":"text","text":"{\\"action\\":\\"none\\"}"}', questions),
    { action: "none" },
  );
  assert.equal(parseJudgeAnswers('{"action":"commit_drafted"}', questions), undefined);
  assert.deepEqual(extractJsonObject('noise {"action":"qa_pass"} trailing'), {
    action: "qa_pass",
  });
});

test("judge fail-opens, caches, and retries @smol", async () => {
  clearJudgeCache();
  const missing = await judge("state", questions, { omp: false });
  assert.equal(missing.ok, false);

  const calls: string[] = [];
  const first = await judge("reviewer finished with notes", questions, {
    cacheMs: 60_000,
    now: 1,
    complete: async ({ model }) => {
      calls.push(model);
      if (model === "@tiny") return { error: "unknown model @tiny" };
      return { text: '{"action":"qa_pass"}' };
    },
  });
  assert.equal(first.ok, true);
  if (first.ok) assert.equal(first.model, "@smol");
  assert.deepEqual(calls, ["@tiny", "@smol"]);

  const cached = await judge("reviewer finished with notes", questions, {
    cacheMs: 60_000,
    now: 2,
    complete: async () => {
      throw new Error("should not rerun");
    },
  });
  assert.equal(cached.ok, true);
  if (cached.ok) assert.equal(cached.answers.action, "qa_pass");

  const invalid = await judge("other", questions, {
    complete: async () => ({ text: "not json" }),
  });
  assert.equal(invalid.ok, false);
});

test("inferHandoffFromJudge accepts only the role's actions", async () => {
  clearJudgeCache();
  const run = emptyRun("s", "ship settings");
  const pass = await inferHandoffFromJudge({
    role: "reviewer",
    run,
    complete: async () => ({ text: '{"action":"qa_pass"}' }),
  });
  assert.equal(pass, "qa_pass");

  clearJudgeCache();
  const none = await inferHandoffFromJudge({
    role: "reviewer",
    run,
    complete: async () => ({ text: '{"action":"none"}' }),
  });
  assert.equal(none, undefined);

  clearJudgeCache();
  const wrong = await inferHandoffFromJudge({
    role: "reviewer",
    run,
    complete: async () => ({ text: '{"action":"plan_ready"}' }),
  });
  assert.equal(wrong, undefined);
});

test("judge argv uses @tiny without loading this extension", () => {
  const args = buildJudgeCliArgs("@tiny", '{"action":"qa_pass"}', true);
  assert.deepEqual(args.slice(0, 6), [
    "-p",
    "--no-session",
    "--no-skills",
    "--model",
    "@tiny",
    "--yolo",
  ]);
  assert.equal(args.includes("-e"), false);
  assert.equal(args.includes("--mode"), false);
  const prompt = buildJudgePrompt("role: reviewer", questions);
  assert.match(prompt, /Do not call tools/);
  assert.match(prompt, /action \(choice\)/);
});

test("inferScoutSkipFromJudge skips only on true", async () => {
  clearJudgeCache();
  const run = emptyRun("s", "Add a settings page for profile");
  const skip = await inferScoutSkipFromJudge({
    run,
    complete: async () => ({ text: '{"skipScout":true}' }),
  });
  assert.equal(skip, true);

  clearJudgeCache();
  const keep = await inferScoutSkipFromJudge({
    run,
    complete: async () => ({ text: '{"skipScout":false}' }),
  });
  assert.equal(keep, false);

  clearJudgeCache();
  const failed = await inferScoutSkipFromJudge({
    run,
    complete: async () => ({ error: "timeout" }),
  });
  assert.equal(failed, undefined);
});

test("applyBashFailureClass maps classes without flipping a real exit failure", () => {
  assert.deepEqual(applyBashFailureClass(undefined, "code_bug"), { failed: true });
  assert.deepEqual(applyBashFailureClass(undefined, "no_failure"), { failed: false });
  assert.deepEqual(applyBashFailureClass(true, "no_failure"), { failed: true });
  assert.equal(applyBashFailureClass(true, "environment").halt, "environment");
  assert.equal(applyBashFailureClass(undefined, "transient").halt, "transient");
  assert.deepEqual(applyBashFailureClass(false, undefined), { failed: false });
});

test("inferBashFailureFromJudge accepts only known classes", async () => {
  clearJudgeCache();
  const klass = await inferBashFailureFromJudge({
    role: "tester",
    stdout: "error TS2322",
    complete: async () => ({ text: '{"failureClass":"code_bug"}' }),
  });
  assert.equal(klass, "code_bug");

  clearJudgeCache();
  const env = await inferBashFailureFromJudge({
    role: "linter",
    stdout: "sh: eslint: command not found",
    complete: async () => ({ text: '{"failureClass":"environment"}' }),
  });
  assert.equal(env, "environment");

  clearJudgeCache();
  const bad = await inferBashFailureFromJudge({
    role: "tester",
    stdout: "ok",
    complete: async () => ({ text: '{"failureClass":"explode"}' }),
  });
  assert.equal(bad, undefined);
});
