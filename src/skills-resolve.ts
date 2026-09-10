import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import type { Catalog, ProjectConfig, ResolvedSkill, ServiceInfo, SkillSource, StackDetection } from "./types.ts";
import { stackIdsForLayer } from "./detect-stack.ts";

export type ResolveOptions = {
  cwd: string;
  agentDir: string;
  homedir?: string;
  config?: ProjectConfig;
  catalog: Catalog;
  detection: StackDetection;
  layer: "frontend" | "backend" | "database" | "tester" | "general";
  service?: ServiceInfo;
  fetchImpl?: (source: SkillSource, destDir: string) => boolean;
};

function skillNameFromDir(dir: string): string | undefined {
  const skill = join(dir, "SKILL.md");
  if (!existsSync(skill)) return undefined;
  const text = readFileSync(skill, "utf8");
  const m = text.match(/^---[\s\S]*?^name:\s*([^\s\n]+)/m);
  return m?.[1];
}

function walkSkillDirs(root: string, acc: string[] = [], depth = 0): string[] {
  if (depth > 6 || !existsSync(root)) return acc;
  if (existsSync(join(root, "SKILL.md"))) {
    acc.push(root);
    return acc;
  }
  let entries: string[] = [];
  try {
    entries = readdirSync(root);
  } catch {
    return acc;
  }
  for (const name of entries) {
    if (name === "node_modules" || name === ".git") continue;
    const abs = join(root, name);
    try {
      if (statSync(abs).isDirectory()) walkSkillDirs(abs, acc, depth + 1);
    } catch {
      /* ignore */
    }
  }
  return acc;
}

export function installedSkillDirs(cwd: string, home: string): string[] {
  const roots = [
    join(home, ".pi", "agent", "skills"),
    join(home, ".agents", "skills"),
    join(cwd, ".pi", "skills"),
    join(cwd, ".agents", "skills"),
  ];
  const dirs: string[] = [];
  for (const root of roots) dirs.push(...walkSkillDirs(root));
  return dirs;
}

export function findInstalledSkill(name: string, cwd: string, home: string): string | undefined {
  for (const dir of installedSkillDirs(cwd, home)) {
    if (skillNameFromDir(dir) === name) return dir;
  }
  return undefined;
}

export function cacheDirFor(agentDir: string, source: SkillSource): string {
  const [owner, repo] = source.repo.split("/");
  return join(agentDir, "devteam", "skill-cache", owner, repo, source.ref, source.path);
}

export function defaultFetchSkill(source: SkillSource, destDir: string): boolean {
  if (existsSync(join(destDir, "SKILL.md"))) return true;
  mkdirSync(destDir, { recursive: true });
  const parent = join(destDir, "..");
  mkdirSync(parent, { recursive: true });
  const tmp = `${destDir}.fetch`;
  try {
    rmSync(tmp, { recursive: true, force: true });
    const url = `https://github.com/${source.repo}.git`;
    const clone = spawnSync(
      "git",
      ["clone", "--depth", "1", "--filter=blob:none", "--sparse", "--branch", source.ref, url, tmp],
      { encoding: "utf8", timeout: 120_000 },
    );
    if (clone.status !== 0) {
      rmSync(tmp, { recursive: true, force: true });
      return false;
    }
    const sparse = spawnSync("git", ["sparse-checkout", "set", source.path], {
      cwd: tmp,
      encoding: "utf8",
      timeout: 60_000,
    });
    if (sparse.status !== 0) {
      rmSync(tmp, { recursive: true, force: true });
      return false;
    }
    const from = join(tmp, source.path);
    if (!existsSync(join(from, "SKILL.md"))) {
      rmSync(tmp, { recursive: true, force: true });
      return false;
    }
    mkdirSync(destDir, { recursive: true });
    copyDir(from, destDir);
    rmSync(tmp, { recursive: true, force: true });
    return existsSync(join(destDir, "SKILL.md"));
  } catch {
    rmSync(tmp, { recursive: true, force: true });
    return false;
  }
}

function copyDir(src: string, dest: string) {
  mkdirSync(dest, { recursive: true });
  for (const name of readdirSync(src)) {
    const from = join(src, name);
    const to = join(dest, name);
    const st = statSync(from);
    if (st.isDirectory()) copyDir(from, to);
    else writeFileSync(to, readFileSync(from));
  }
}

function sourcesForIds(catalog: Catalog, ids: string[]): { catalogId: string; source: SkillSource }[] {
  const out: { catalogId: string; source: SkillSource }[] = [];
  for (const id of ids) {
    const entry = catalog.stacks.find((s) => s.id === id);
    if (!entry) continue;
    for (const skill of entry.skills) out.push({ catalogId: id, source: skill });
  }
  return out;
}

function overrideIds(config: ProjectConfig | undefined, layer: ResolveOptions["layer"]): string[] | undefined {
  if (!config?.skills) return undefined;
  if (layer === "frontend") return config.skills.frontend;
  if (layer === "backend") return config.skills.backend;
  if (layer === "database") return config.skills.database;
  return undefined;
}

export function resolveSkillsForLayer(opts: ResolveOptions): ResolvedSkill[] {
  const home = opts.homedir ?? homedir();
  const fetchImpl = opts.fetchImpl ?? defaultFetchSkill;
  const max = opts.catalog.maxSkillsPerChild ?? 3;

  const overrides = opts.service?.skills?.length ? undefined : overrideIds(opts.config, opts.layer);
  const ids =
    overrides !== undefined
      ? overrides
      : stackIdsForLayer(opts.detection, opts.layer, opts.service);

  const extra = opts.config?.skills?.extra ?? [];
  const pairs = sourcesForIds(opts.catalog, ids);

  const resolved: ResolvedSkill[] = [];
  const seen = new Set<string>();

  const resolveOne = (catalogId: string | undefined, source: SkillSource | { name: string; abs: string }) => {
    if ("abs" in source) {
      if (seen.has(source.abs)) return;
      seen.add(source.abs);
      resolved.push({
        name: source.name,
        dir: source.abs,
        source: "override",
        catalogId,
      });
      return;
    }
    const key = `${source.repo}@${source.ref}:${source.path}`;
    if (seen.has(key)) return;
    seen.add(key);

    const installed = findInstalledSkill(source.name, opts.cwd, home);
    if (installed) {
      resolved.push({ name: source.name, dir: installed, source: "installed", catalogId });
      return;
    }
    const cache = cacheDirFor(opts.agentDir, source);
    if (existsSync(join(cache, "SKILL.md"))) {
      resolved.push({ name: source.name, dir: cache, source: "cache", catalogId });
      return;
    }
    const ok = fetchImpl(source, cache);
    if (ok) {
      resolved.push({ name: source.name, dir: cache, source: "cache", catalogId });
      return;
    }
    resolved.push({
      name: source.name,
      dir: "",
      source: "unresolved",
      catalogId,
      error: `Could not resolve ${source.name} from ${source.repo}`,
    });
  };

  for (const pair of pairs) resolveOne(pair.catalogId, pair.source);

  for (const extraPath of extra) {
    if (extraPath.startsWith("/") && existsSync(join(extraPath, "SKILL.md"))) {
      const name = skillNameFromDir(extraPath) ?? extraPath.split("/").pop() ?? "custom";
      resolveOne(undefined, { name, abs: extraPath });
    } else {
      const entry = opts.catalog.stacks.find((s) => s.id === extraPath);
      if (entry) {
        for (const skill of entry.skills) resolveOne(entry.id, skill);
      }
    }
  }

  const loaded = resolved.filter((r) => r.source !== "unresolved");
  const unresolved = resolved.filter((r) => r.source === "unresolved");
  const capped = loaded.slice(0, max);
  const overflow = loaded.slice(max);
  return [
    ...capped,
    ...overflow.map((r) => ({
      ...r,
      source: "unresolved" as const,
      error: `Capped at ${max} stack skills; read ${r.name} from cache if needed (${r.dir})`,
    })),
    ...unresolved,
  ];
}
