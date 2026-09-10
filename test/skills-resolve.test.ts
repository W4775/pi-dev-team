import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { loadCatalog } from "../src/catalog.ts";
import { resolveSkillsForLayer } from "../src/skills-resolve.ts";
import type { SkillSource, StackDetection } from "../src/types.ts";

const catalog = loadCatalog();

const detection: StackDetection = {
  frontend: "vue",
  backend: undefined,
  backends: [],
  database: [],
  tester: ["vue-testing"],
  extra: ["vue-pinia", "vue-router"],
  uiSurface: "web",
  matchedIds: ["vue", "vue-pinia", "vue-router", "vue-testing"],
  services: [],
};

test("override ids win over detection", () => {
  const cwd = mkdtempSync(join(tmpdir(), "devteam-resolve-"));
  const agentDir = mkdtempSync(join(tmpdir(), "devteam-agent-"));
  const resolved = resolveSkillsForLayer({
    cwd,
    agentDir,
    catalog,
    detection,
    layer: "frontend",
    config: { skills: { frontend: [] } },
    fetchImpl: () => {
      throw new Error("should not fetch when override is empty");
    },
  });
  assert.equal(
    resolved.filter((s) => s.catalogId).length,
    0,
  );
});

test("installed skill is preferred over fetch", () => {
  const home = mkdtempSync(join(tmpdir(), "devteam-home-"));
  const cwd = mkdtempSync(join(tmpdir(), "devteam-cwd-"));
  const agentDir = mkdtempSync(join(tmpdir(), "devteam-agent-"));
  const installed = join(home, ".pi", "agent", "skills", "vue-best-practices");
  mkdirSync(installed, { recursive: true });
  writeFileSync(join(installed, "SKILL.md"), "---\nname: vue-best-practices\n---\n");

  const resolved = resolveSkillsForLayer({
    cwd,
    agentDir,
    homedir: home,
    catalog,
    detection: { ...detection, extra: [] },
    layer: "frontend",
    fetchImpl: () => {
      throw new Error("must not fetch when installed");
    },
  });
  const vue = resolved.find((s) => s.name === "vue-best-practices");
  assert.equal(vue?.source, "installed");
  assert.equal(vue?.dir, installed);
});

test("cache miss soft-fails and continues", () => {
  const cwd = mkdtempSync(join(tmpdir(), "devteam-cwd-"));
  const agentDir = mkdtempSync(join(tmpdir(), "devteam-agent-"));
  const resolved = resolveSkillsForLayer({
    cwd,
    agentDir,
    catalog,
    detection: { ...detection, extra: [] },
    layer: "frontend",
    fetchImpl: (_source: SkillSource) => false,
  });
  const vue = resolved.find((s) => s.name === "vue-best-practices");
  assert.equal(vue?.source, "unresolved");
  assert.match(vue?.error ?? "", /Could not resolve/);
});

test("skill cap records overflow as unresolved", () => {
  const cwd = mkdtempSync(join(tmpdir(), "devteam-cwd-"));
  const agentDir = mkdtempSync(join(tmpdir(), "devteam-agent-"));
  let n = 0;
  const resolved = resolveSkillsForLayer({
    cwd,
    agentDir,
    catalog: { ...catalog, maxSkillsPerChild: 2 },
    detection,
    layer: "frontend",
    fetchImpl: (source, dest) => {
      mkdirSync(dest, { recursive: true });
      writeFileSync(join(dest, "SKILL.md"), `---\nname: ${source.name}\n---\n`);
      n += 1;
      return true;
    },
  });
  const loaded = resolved.filter((s) => s.source === "cache");
  const overflow = resolved.filter((s) => s.error?.includes("Capped"));
  assert.equal(loaded.length, 2);
  assert.ok(overflow.length >= 1);
  assert.ok(n >= 3);
});

test("absolute extra paths are appended", () => {
  const cwd = mkdtempSync(join(tmpdir(), "devteam-cwd-"));
  const agentDir = mkdtempSync(join(tmpdir(), "devteam-agent-"));
  const extra = mkdtempSync(join(tmpdir(), "custom-skill-"));
  writeFileSync(join(extra, "SKILL.md"), "---\nname: my-custom\n---\n");
  const resolved = resolveSkillsForLayer({
    cwd,
    agentDir,
    catalog,
    detection: { ...detection, extra: [], frontend: undefined, matchedIds: [] },
    layer: "frontend",
    config: { skills: { frontend: [], extra: [extra] } },
    fetchImpl: () => false,
  });
  assert.ok(resolved.some((s) => s.name === "my-custom" && s.source === "override"));
});
