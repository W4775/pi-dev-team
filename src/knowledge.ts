import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { packageRoot } from "./catalog.ts";
import type { ProjectConfig } from "./types.ts";

export const DEFAULT_KNOWLEDGE_REL = ".pi/knowledge";

export type KnowledgeBundle = {
  /** Path relative to the repository root, e.g. `.pi/knowledge`. */
  rel: string;
  abs: string;
  bootstrapped: boolean;
};

function normalizeRelPath(filePath: string, cwd: string): string {
  const abs = resolve(cwd, filePath);
  const rel = relative(cwd, abs).replaceAll("\\", "/");
  return rel.startsWith("..") ? filePath.replaceAll("\\", "/") : rel;
}

export function knowledgeConfig(config?: ProjectConfig): {
  enabled: boolean;
  bootstrap: boolean;
  rel: string;
} {
  const raw = config?.knowledge;
  if (raw?.enabled === false) {
    return { enabled: false, bootstrap: false, rel: DEFAULT_KNOWLEDGE_REL };
  }
  const rel = raw?.path?.trim() || DEFAULT_KNOWLEDGE_REL;
  const bootstrap = raw?.bootstrap !== false;
  return { enabled: true, bootstrap, rel };
}

export function knowledgeBundleAbs(cwd: string, rel: string): string {
  return resolve(cwd, rel);
}

export function isKnowledgePath(filePath: string, cwd: string, knowledgeRel: string): boolean {
  const bundleAbs = knowledgeBundleAbs(cwd, knowledgeRel);
  const targetAbs = resolve(cwd, filePath);
  const bundleWithSep = bundleAbs.endsWith("/") ? bundleAbs : `${bundleAbs}/`;
  return targetAbs === bundleAbs || targetAbs.startsWith(bundleWithSep);
}

export function isReservedKnowledgeFile(relPath: string): boolean {
  const base = relPath.split("/").pop() ?? "";
  return base === "index.md" || base === "log.md";
}

const INDEX_TEMPLATE = `---
okf_version: "0.2"
---

# Project knowledge

Agent-maintained facts about this repository. Scouts and planners may update concepts here; workflow orchestration stays in \`devteam_state\`.

Root \`AGENTS.md\` points here — keep that file small; put durable detail in concepts.

## Concepts

* [Repository overview](concepts/repo/overview.md) - stack, layout, and conventions
* [Specs](concepts/specs/) - OKF feature specs written during \`/devteam\` runs

## Conventions

- One concept per \`.md\` file with YAML frontmatter (\`type\` is required).
- Cite repo paths in \`sources\` and footnotes — do not rely on positional lists.
- \`devteam_state.spec\` is the build contract for the active run; mirror it under \`concepts/specs/<job-id>.md\` for git history.
`;

const LOG_TEMPLATE = `# Knowledge update log

## ${new Date().toISOString().slice(0, 10)}

* **Initialization**: Created the pi-dev-team knowledge bundle.
`;

const OVERVIEW_TEMPLATE = `---
type: Repository Fact
title: Repository overview
description: High-level map of this codebase for /devteam scouts and implementors.
status: draft
generated:
  by: pi-dev-team/bootstrap
  at: ${new Date().toISOString()}
---

# Overview

Describe the stack, top-level directories, and where features live. Scouts should enrich this file with sourced facts from the tree.

# Services

List named services, languages, and entrypoints when the repo is polyglot.

# Conventions

Testing, linting, routing, and naming patterns agents must follow.
`;

function writeIfMissing(path: string, content: string): boolean {
  if (existsSync(path)) return false;
  mkdirSync(join(path, ".."), { recursive: true });
  writeFileSync(path, content, "utf8");
  return true;
}

function agentsMdTemplate(): string {
  const path = join(packageRoot(), "templates", "AGENTS.md");
  if (existsSync(path)) return readFileSync(path, "utf8");
  return `# Agents\n\nSee .pi/knowledge/index.md for OKF project knowledge.\n`;
}


/** Ensure the bundle exists; returns the relative bundle path when enabled. */
export function prepareKnowledgeBundle(
  cwd: string,
  config: ProjectConfig | undefined,
  trusted: boolean,
): KnowledgeBundle | undefined {
  const { enabled, bootstrap, rel } = knowledgeConfig(config);
  if (!enabled || !trusted || !cwd) return undefined;

  const abs = knowledgeBundleAbs(cwd, rel);
  let bootstrapped = false;
  if (bootstrap) {
    bootstrapped =
      writeIfMissing(join(cwd, "AGENTS.md"), agentsMdTemplate()) |
      writeIfMissing(join(abs, "index.md"), INDEX_TEMPLATE) |
      writeIfMissing(join(abs, "log.md"), LOG_TEMPLATE) |
      writeIfMissing(join(abs, "concepts", "repo", "overview.md"), OVERVIEW_TEMPLATE);
    mkdirSync(join(abs, "concepts", "specs"), { recursive: true });
  }

  if (!existsSync(abs)) return undefined;
  return { rel, abs, bootstrapped };
}

export function readKnowledgeIndex(cwd: string, rel: string, limit = 4000): string | undefined {
  const indexPath = join(knowledgeBundleAbs(cwd, rel), "index.md");
  if (!existsSync(indexPath)) return undefined;
  try {
    const text = readFileSync(indexPath, "utf8").trim();
    return text.length > limit ? `${text.slice(0, limit)}\n…` : text;
  } catch {
    return undefined;
  }
}

export function specConceptRel(jobId: string): string {
  const safe = jobId.replace(/[^\w.-]+/g, "-").replace(/^-+|-+$/g, "") || "run";
  return join("concepts", "specs", `${safe}.md`).replaceAll("\\", "/");
}

export function knowledgePromptBlock(run: {
  knowledgePath?: string;
  jobId?: string;
  task?: string;
}): string {
  if (!run.knowledgePath) return "";
  const specRel = specConceptRel(run.jobId ?? "run");
  return [
    `Project knowledge bundle: \`${run.knowledgePath}/\` (OKF-style markdown with YAML frontmatter).`,
    `Read root AGENTS.md and \`${run.knowledgePath}/index.md\` before scouting or planning.`,
    `Scouts: write durable repo facts under \`${run.knowledgePath}/concepts/repo/\` with \`sources\` + \`generated\`.`,
    `Planner: when the spec is ready, mirror it to \`${run.knowledgePath}/${specRel}\` (\`type: Feature Spec\`) and keep \`devteam_state.spec\` as the run contract.`,
    `Follow the \`project-knowledge\` skill for frontmatter and footnote rules.`,
  ].join("\n");
}

export function knowledgePathsForGate(
  cwd: string,
  knowledgeRel: string | undefined,
): string[] | undefined {
  if (!knowledgeRel) return undefined;
  return [knowledgeRel, `${knowledgeRel}/**`];
}

export function relPathUnderKnowledge(
  filePath: string,
  cwd: string,
  knowledgeRel: string,
): string | undefined {
  if (!isKnowledgePath(filePath, cwd, knowledgeRel)) return undefined;
  return normalizeRelPath(filePath, cwd);
}
