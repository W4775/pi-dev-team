import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { test } from "node:test";
import { bundledSkillDir, WORKFLOW_SKILLS } from "../src/catalog.ts";
import { rolePromptPath } from "../src/roles.ts";
import type { RoleName } from "../src/types.ts";

test("vendored workflow skills exist on disk", () => {
  for (const name of WORKFLOW_SKILLS) {
    assert.equal(existsSync(`${bundledSkillDir(name)}/SKILL.md`), true, name);
  }
});

test("every role has a prompt file", () => {
  const roles: RoleName[] = [
    "planner",
    "plan_critic",
    "designer",
    "design_critic",
    "database",
    "backend",
    "frontend",
    "general",
    "reviewer",
    "tester",
    "linter",
    "orchestrator",
    "planner_orchestrator",
    "scout",
    "commit_message",
  ];
  for (const role of roles) {
    assert.equal(existsSync(rolePromptPath(role)), true, role);
  }
});
