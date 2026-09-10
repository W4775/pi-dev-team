import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { detectServices, mergeServices } from "./services.ts";
import type { Catalog, ProjectConfig, ServiceInfo, StackDetection, StackEntry, UiSurface } from "./types.ts";

export type DetectInput = {
  cwd: string;
  filesToChange?: string[];
  plannerHint?: string;
  envText?: string;
  config?: ProjectConfig;
};

function walkFiles(dir: string, maxFiles = 4000, prefix = ""): string[] {
  const out: string[] = [];
  let entries: string[] = [];
  try {
    entries = readdirSync(dir);
  } catch {
    return out;
  }
  for (const name of entries) {
    if (name === "node_modules" || name === ".git" || name === "dist" || name === "coverage") continue;
    const abs = join(dir, name);
    const rel = prefix ? `${prefix}/${name}` : name;
    let st;
    try {
      st = statSync(abs);
    } catch {
      continue;
    }
    if (st.isDirectory()) {
      if (out.length >= maxFiles) break;
      out.push(...walkFiles(abs, maxFiles - out.length, rel));
    } else {
      out.push(rel);
      if (out.length >= maxFiles) break;
    }
  }
  return out;
}

function readIfExists(path: string): string | undefined {
  try {
    return readFileSync(path, "utf8");
  } catch {
    return undefined;
  }
}

export function collectNpmDeps(packageJsonText: string): Set<string> {
  const deps = new Set<string>();
  try {
    const json = JSON.parse(packageJsonText) as Record<string, unknown>;
    for (const key of ["dependencies", "devDependencies", "peerDependencies", "optionalDependencies"]) {
      const block = json[key];
      if (block && typeof block === "object") {
        for (const name of Object.keys(block as Record<string, string>)) deps.add(name);
      }
    }
  } catch {
    /* ignore */
  }
  return deps;
}

function fileMatchesPattern(files: string[], pattern: string): boolean {
  if (pattern.startsWith("*.")) {
    const ext = pattern.slice(1);
    return files.some((f) => f.endsWith(ext) || f.toLowerCase().endsWith(ext.toLowerCase()));
  }
  return files.some((f) => f === pattern || f.endsWith(`/${pattern}`));
}

function anyCsprojContains(cwd: string, files: string[], needles: string[]): boolean {
  const csproj = files.filter((f) => f.endsWith(".csproj") || f.endsWith(".fsproj") || f.endsWith(".vbproj"));
  for (const f of csproj) {
    const text = readIfExists(join(cwd, f));
    if (!text) continue;
    if (needles.some((n) => text.includes(n))) return true;
  }
  return false;
}

function prismaIsPostgres(cwd: string, files: string[]): boolean {
  const prisma = files.filter((f) => f.endsWith("schema.prisma") || f.includes("/prisma/"));
  for (const f of prisma) {
    const text = readIfExists(join(cwd, f));
    if (text && /provider\s*=\s*"postgresql"/i.test(text)) return true;
  }
  return false;
}

function composeHasPostgres(cwd: string, files: string[]): boolean {
  const compose = files.filter((f) => /docker-compose|compose\.ya?ml$/i.test(f));
  for (const f of compose) {
    const text = readIfExists(join(cwd, f));
    if (text && /image:\s*['"]?postgres/i.test(text)) return true;
  }
  return false;
}

export function nativeUiFromFiles(files: string[], deps: Set<string>): boolean {
  if (deps.has("react-native") || deps.has("expo")) return true;
  return files.some((f) => /\.(swift|kt|kts|m|mm)$/i.test(f));
}

export function entryMatches(
  entry: StackEntry,
  ctx: {
    deps: Set<string>;
    files: string[];
    cwd: string;
    envText: string;
    plannerHint?: string;
  },
): boolean {
  const m = entry.match;
  const checks: boolean[] = [];
  if (m.deps?.length) checks.push(m.deps.some((d) => ctx.deps.has(d)));
  if (m.files?.length) checks.push(m.files.some((p) => fileMatchesPattern(ctx.files, p)));
  if (m.csprojContains?.length) checks.push(anyCsprojContains(ctx.cwd, ctx.files, m.csprojContains));
  if (m.prismaProvider === "postgresql") checks.push(prismaIsPostgres(ctx.cwd, ctx.files));
  if (m.envContains?.length) checks.push(m.envContains.some((s) => ctx.envText.toLowerCase().includes(s.toLowerCase())));
  if (m.composeImages?.length) {
    checks.push(m.composeImages.includes("postgres") && composeHasPostgres(ctx.cwd, ctx.files));
  }
  if (m.missingFiles?.length) {
    const missing = m.missingFiles.every((p) => !fileMatchesPattern(ctx.files, p));
    if (m.plannerHint) {
      checks.push(missing && ctx.plannerHint === m.plannerHint);
    } else {
      checks.push(missing);
    }
  }
  if (m.plannerHint && !m.missingFiles?.length) checks.push(ctx.plannerHint === m.plannerHint);
  if (checks.length === 0) return false;
  return checks.some(Boolean);
}

export function detectStack(catalog: Catalog, input: DetectInput): StackDetection {
  const files = existsSync(input.cwd) ? walkFiles(input.cwd) : [];
  const scoped = input.filesToChange?.length
    ? [...new Set([...files, ...input.filesToChange])]
    : files;

  const pkg = readIfExists(join(input.cwd, "package.json")) ?? "";
  const deps = collectNpmDeps(pkg);
  const envText =
    input.envText ??
    [readIfExists(join(input.cwd, ".env.example")), readIfExists(join(input.cwd, ".env"))].filter(Boolean).join("\n");

  const ctx = {
    deps,
    files: scoped,
    cwd: input.cwd,
    envText,
    plannerHint: input.plannerHint,
  };

  const matched: StackEntry[] = [];
  for (const entry of catalog.stacks) {
    if (entry.requires && !matched.some((m) => m.id === entry.requires)) continue;
    if (entryMatches(entry, ctx)) matched.push(entry);
  }

  let frontend: string | undefined;
  let uiSurface: UiSurface = "none";
  for (const entry of matched) {
    if (entry.layer !== "frontend" || entry.additive) continue;
    frontend = entry.id;
    uiSurface = entry.uiSurface ?? "web";
    break;
  }

  const backends = matched.filter((e) => e.layer === "backend" && !e.additive).map((e) => e.id);
  const backend = backends[0];

  const database = matched.filter((e) => e.layer === "database").map((e) => e.id);
  const tester = matched.filter((e) => e.layer === "tester").map((e) => e.id);
  const extra = matched.filter((e) => e.additive && e.layer === "frontend").map((e) => e.id);

  if (deps.has("react-native") || deps.has("expo")) uiSurface = "native";
  if (!frontend && nativeUiFromFiles(scoped, deps) && !deps.has("react")) {
    if (scoped.some((f) => /\.(swift|kt|kts)$/i.test(f))) uiSurface = "native";
  }
  if (frontend && uiSurface === "none") uiSurface = "web";

  const services = mergeServices(
    detectServices({
      files: scoped,
      readFile: (rel) => readIfExists(join(input.cwd, rel)),
    }),
    input.config?.services,
  );

  return {
    frontend,
    backend,
    backends,
    database,
    tester,
    extra,
    uiSurface,
    matchedIds: matched.map((m) => m.id),
    services,
  };
}

export function stackIdsForLayer(
  detection: StackDetection,
  layer: "frontend" | "backend" | "database" | "tester" | "general",
  service?: ServiceInfo,
): string[] {
  const extra = detection.extra ?? [];
  const database = detection.database ?? [];
  const tester = detection.tester ?? [];
  const backends = detection.backends ?? (detection.backend ? [detection.backend] : []);
  if (service?.skills?.length) return [...new Set(service.skills)];
  if (layer === "frontend") {
    return [detection.frontend, ...extra.filter((id) => id !== detection.frontend)].filter(
      (x): x is string => Boolean(x),
    );
  }
  if (layer === "backend") return [...new Set(backends)];
  if (layer === "database") return database;
  if (layer === "tester") return tester;
  const all = [detection.frontend, ...backends, ...database, ...tester, ...extra].filter(
    (x): x is string => Boolean(x),
  );
  return [...new Set(all)];
}
