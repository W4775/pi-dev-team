import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import {
  DEFAULT_KNOWLEDGE_REL,
  isKnowledgePath,
  knowledgeConfig,
  knowledgePromptBlock,
  prepareKnowledgeBundle,
  specConceptRel,
} from "../src/knowledge.ts";

test("knowledgeConfig defaults to enabled bootstrap under .pi/knowledge", () => {
  const cfg = knowledgeConfig(undefined);
  assert.equal(cfg.enabled, true);
  assert.equal(cfg.bootstrap, true);
  assert.equal(cfg.rel, DEFAULT_KNOWLEDGE_REL);
});

test("knowledgeConfig respects disabled flag", () => {
  const cfg = knowledgeConfig({ knowledge: { enabled: false } });
  assert.equal(cfg.enabled, false);
});

test("prepareKnowledgeBundle creates starter files on trusted projects", () => {
  const cwd = mkdtempSync(join(tmpdir(), "devteam-knowledge-"));
  const bundle = prepareKnowledgeBundle(cwd, undefined, true);
  assert.ok(bundle);
  assert.equal(bundle?.rel, DEFAULT_KNOWLEDGE_REL);
  assert.equal(existsSync(join(bundle!.abs, "index.md")), true);
  assert.equal(existsSync(join(bundle!.abs, "concepts", "repo", "overview.md")), true);
  assert.equal(existsSync(join(cwd, "AGENTS.md")), true);
  assert.match(readFileSync(join(cwd, "AGENTS.md"), "utf8"), /\.pi\/knowledge/);
});

test("isKnowledgePath matches files under the bundle root", () => {
  const cwd = "/repo";
  const rel = ".pi/knowledge";
  assert.equal(isKnowledgePath("/repo/.pi/knowledge/concepts/repo/x.md", cwd, rel), true);
  assert.equal(isKnowledgePath("/repo/src/app.ts", cwd, rel), false);
});

test("specConceptRel slugifies job ids", () => {
  assert.equal(specConceptRel("abc123"), "concepts/specs/abc123.md");
  assert.equal(specConceptRel("weird id!"), "concepts/specs/weird-id.md");
});

test("knowledgePromptBlock is empty without a bundle path", () => {
  assert.equal(knowledgePromptBlock({}), "");
});

test("knowledgePromptBlock names the spec concept path", () => {
  const text = knowledgePromptBlock({ knowledgePath: ".pi/knowledge", jobId: "job1" });
  assert.match(text, /concepts\/specs\/job1\.md/);
  assert.match(text, /project-knowledge/);
});
