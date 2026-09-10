import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { gateBash, gateWrite } from "../src/permissions.ts";

test("non-implementors cannot write the repo", () => {
  for (const role of ["planner", "designer", "plan_critic", "design_critic", "orchestrator", "planner_orchestrator", "scout", "reviewer", "tester", "linter", "commit_message"] as const) {
    const gate = gateWrite(role, "/repo/src/app.ts", "/repo", undefined);
    assert.equal(gate.block, true);
  }
});

test("assignedPaths restrict a subagent to its work item", () => {
  const allowed = gateWrite("backend", "/repo/src/api/route.ts", "/repo", undefined, undefined, ["src/api/**"]);
  const blocked = gateWrite("backend", "/repo/src/other/x.ts", "/repo", undefined, undefined, ["src/api/**"]);
  assert.equal(allowed.block, false);
  assert.equal(blocked.block, true);
});

test("orchestrator bash is read-only", () => {
  assert.equal(gateBash("orchestrator", "git status", undefined).block, false);
  assert.equal(gateBash("orchestrator", "npm test", undefined).block, true);
});

test("implementors can write ordinary source", () => {
  const gate = gateWrite("frontend", "/repo/src/app.tsx", "/repo", undefined);
  assert.equal(gate.block, false);
});

test("secrets files are denied", () => {
  assert.equal(gateWrite("backend", "/repo/.env", "/repo", undefined).block, true);
  assert.equal(gateWrite("backend", "/repo/config/.env.local", "/repo", undefined).block, true);
  assert.equal(gateWrite("database", "/repo/id_rsa", "/repo", undefined).block, true);
});

test("layer path globs restrict implementors when configured", () => {
  const config = { paths: { frontend: ["src/app/**", "src/components/**"] } };
  assert.equal(gateWrite("frontend", "/repo/src/app/page.tsx", "/repo", config).block, false);
  assert.equal(gateWrite("frontend", "/repo/server/api.ts", "/repo", config).block, true);
});

test("commit-message bash is git-read only", () => {
  assert.equal(gateBash("commit_message", "git diff HEAD", undefined).block, false);
  assert.equal(gateBash("commit_message", "git commit -am wip", undefined).block, true);
  assert.equal(gateBash("commit_message", "npm test", undefined).block, true);
});

test("planner bash is read-only inspection", () => {
  assert.equal(gateBash("planner", "git status", undefined).block, false);
  assert.equal(gateBash("planner", "ls src", undefined).block, false);
  assert.equal(gateBash("planner", "npm test", undefined).block, true);
});

test("tester may run test runners", () => {
  assert.equal(gateBash("tester", "npm test", undefined).block, false);
  assert.equal(gateBash("tester", "pnpm test --filter api", undefined).block, false);
  assert.equal(gateBash("tester", "git commit -m x", undefined).block, true);
});

test("linter may run lint commands", () => {
  assert.equal(gateBash("linter", "npm run lint", undefined).block, false);
  assert.equal(gateBash("linter", "ruff check .", undefined).block, false);
  assert.equal(gateBash("linter", "rm -rf dist", undefined).block, true);
});

test("implementors cannot git commit", () => {
  assert.equal(gateBash("backend", "git commit -m x", undefined).block, true);
  assert.equal(gateBash("backend", "npm test", undefined).block, false);
});

test("a service-scoped backend cannot write another service's files", () => {
  const api = {
    name: "api",
    root: "services/api",
    layer: "backend" as const,
    languages: ["go"],
    paths: ["services/api/**"],
    skills: [],
    test: ["go test ./..."],
    lint: ["go vet ./..."],
    source: "detected" as const,
  };
  assert.equal(gateWrite("backend", "/repo/services/api/main.go", "/repo", undefined, api).block, false);
  const blocked = gateWrite("backend", "/repo/services/scoring/app.py", "/repo", undefined, api);
  assert.equal(blocked.block, true);
  assert.match(blocked.block ? blocked.reason : "", /api service/);
});

test("tester may run a service's own test command", () => {
  const services = [
    {
      name: "scoring",
      root: "services/scoring",
      layer: "backend" as const,
      languages: ["python"],
      paths: ["services/scoring/**"],
      skills: [],
      test: ["pytest"],
      lint: ["ruff check ."],
      source: "detected" as const,
    },
  ];
  assert.equal(gateBash("tester", "pytest", undefined, services).block, false);
});

test("trusted glob config is not required when paths omitted", () => {
  const dir = mkdtempSync(join(tmpdir(), "devteam-perm-"));
  mkdirSync(join(dir, "src"));
  writeFileSync(join(dir, "src", "a.ts"), "export {}\n");
  assert.equal(gateWrite("general", join(dir, "src", "a.ts"), dir, undefined).block, false);
});
