import type { ImplementorLayer, ServiceConfig, ServiceInfo } from "./types.ts";
import { MAX_SERVICES } from "./types.ts";

const SKIP_DIRS = new Set([
  "node_modules",
  "vendor",
  "third_party",
  "dist",
  "build",
  "out",
  "target",
  "bin",
  "obj",
  "coverage",
  ".git",
  ".venv",
  "venv",
  "site-packages",
  "__pycache__",
  ".next",
  ".nuxt",
  ".terraform",
  "testdata",
  "fixtures",
]);

const MAX_DEPTH = 4;

type ManifestRule = {
  match: (base: string) => boolean;
  language: string;
  test: string[];
  lint: string[];
};

const MANIFESTS: ManifestRule[] = [
  { match: (b) => b === "go.mod", language: "go", test: ["go test ./..."], lint: ["go vet ./..."] },
  {
    match: (b) => b === "pyproject.toml" || b === "requirements.txt" || b === "setup.py" || b === "Pipfile",
    language: "python",
    test: ["pytest"],
    lint: ["ruff check ."],
  },
  { match: (b) => b === "Cargo.toml", language: "rust", test: ["cargo test"], lint: ["cargo clippy"] },
  {
    match: (b) => b.endsWith(".csproj") || b.endsWith(".fsproj") || b.endsWith(".vbproj"),
    language: "dotnet",
    test: ["dotnet test"],
    lint: ["dotnet format --verify-no-changes"],
  },
  { match: (b) => b === "pom.xml", language: "java", test: ["mvn -q test"], lint: ["mvn -q verify"] },
  {
    match: (b) => b === "build.gradle" || b === "build.gradle.kts",
    language: "java",
    test: ["./gradlew test"],
    lint: ["./gradlew check"],
  },
  { match: (b) => b === "Gemfile", language: "ruby", test: ["bundle exec rspec"], lint: ["bundle exec rubocop"] },
  { match: (b) => b === "composer.json", language: "php", test: ["composer test"], lint: ["composer lint"] },
  { match: (b) => b === "mix.exs", language: "elixir", test: ["mix test"], lint: ["mix format --check-formatted"] },
  { match: (b) => b === "package.json", language: "node", test: ["npm test"], lint: ["npm run lint"] },
];

const FRONTEND_DEPS = [
  "react",
  "react-dom",
  "next",
  "vue",
  "nuxt",
  "@angular/core",
  "svelte",
  "@sveltejs/kit",
  "solid-js",
  "astro",
  "react-native",
  "expo",
];

const FRONTEND_DIR_NAMES = /^(web|www|ui|frontend|front-end|client|site|dashboard|admin|app)$/i;
const LANGUAGE_STACK_IDS: Record<string, string[]> = { dotnet: ["dotnet"] };

export type ServiceScanInput = {
  files: string[];
  readFile?: (relPath: string) => string | undefined;
};

function dirOf(relPath: string): string {
  const cut = relPath.lastIndexOf("/");
  return cut < 0 ? "" : relPath.slice(0, cut);
}

function baseOf(relPath: string): string {
  const cut = relPath.lastIndexOf("/");
  return cut < 0 ? relPath : relPath.slice(cut + 1);
}

function isSkipped(dir: string): boolean {
  if (!dir) return false;
  const parts = dir.split("/");
  if (parts.length > MAX_DEPTH) return true;
  return parts.some((part) => SKIP_DIRS.has(part) || part.startsWith("."));
}

function nodeIsFrontend(dir: string, readFile: (relPath: string) => string | undefined): boolean {
  const text = readFile(dir ? `${dir}/package.json` : "package.json");
  if (text) {
    try {
      const json = JSON.parse(text) as Record<string, unknown>;
      const deps = new Set<string>();
      for (const key of ["dependencies", "devDependencies", "peerDependencies"]) {
        const block = json[key];
        if (block && typeof block === "object") for (const name of Object.keys(block)) deps.add(name);
      }
      if (FRONTEND_DEPS.some((dep) => deps.has(dep))) return true;
      if (deps.size) return false;
    } catch {
      /* fall through */
    }
  }
  return FRONTEND_DIR_NAMES.test(baseOf(dir));
}

function dotnetIsFrontend(dir: string, files: string[], readFile: (relPath: string) => string | undefined): boolean {
  return files
    .filter((file) => dirOf(file) === dir && /\.(cs|fs|vb)proj$/.test(file))
    .some((file) => /Blazor|Components\.WebAssembly|Microsoft\.NET\.Sdk\.Razor/i.test(readFile(file) ?? ""));
}

function scriptsFromPackageJson(
  dir: string,
  readFile: (relPath: string) => string | undefined,
): { test?: string[]; lint?: string[] } {
  const text = readFile(dir ? `${dir}/package.json` : "package.json");
  if (!text) return {};
  try {
    const json = JSON.parse(text) as { scripts?: Record<string, string> };
    const scripts = json.scripts ?? {};
    const out: { test?: string[]; lint?: string[] } = {};
    if (scripts.test) out.test = ["npm test"];
    if (scripts.lint) out.lint = ["npm run lint"];
    return out;
  } catch {
    return {};
  }
}

function serviceName(dir: string, taken: Set<string>): string {
  const base = baseOf(dir) || "root";
  let name = base.replace(/[^\w.-]+/g, "-").toLowerCase() || "root";
  if (taken.has(name) && dir) {
    const parent = baseOf(dirOf(dir));
    if (parent) name = `${parent}-${name}`.toLowerCase();
  }
  let suffix = 2;
  let unique = name;
  while (taken.has(unique)) {
    unique = `${name}-${suffix}`;
    suffix += 1;
  }
  taken.add(unique);
  return unique;
}

function pathsForRoot(root: string): string[] {
  return root ? [`${root}/**`] : ["**"];
}

export function detectServices(input: ServiceScanInput): ServiceInfo[] {
  const readFile = input.readFile ?? (() => undefined);
  const byDir = new Map<string, Set<string>>();

  for (const file of input.files) {
    const dir = dirOf(file);
    if (isSkipped(dir)) continue;
    const base = baseOf(file);
    for (const rule of MANIFESTS) {
      if (!rule.match(base)) continue;
      const langs = byDir.get(dir) ?? new Set<string>();
      langs.add(rule.language);
      byDir.set(dir, langs);
    }
  }

  const dirs = [...byDir.keys()].sort((a, b) => {
    const depth = a.split("/").length - b.split("/").length;
    return a === "" ? -1 : b === "" ? 1 : depth !== 0 ? depth : a.localeCompare(b);
  });

  const taken = new Set<string>();
  const services: ServiceInfo[] = [];
  for (const dir of dirs.slice(0, MAX_SERVICES)) {
    const languages = [...(byDir.get(dir) ?? [])].sort();
    const primary = languages.find((lang) => lang !== "node") ?? languages[0] ?? "node";
    let layer: ImplementorLayer = "backend";
    if (primary === "node" && nodeIsFrontend(dir, readFile)) layer = "frontend";
    if (primary === "dotnet" && dotnetIsFrontend(dir, input.files, readFile)) layer = "frontend";
    const rules = MANIFESTS.filter((rule) => rule.language === primary);
    const scripts = primary === "node" ? scriptsFromPackageJson(dir, readFile) : {};
    services.push({
      name: serviceName(dir, taken),
      root: dir,
      layer,
      languages,
      paths: pathsForRoot(dir),
      skills: LANGUAGE_STACK_IDS[primary] ?? [],
      test: [...new Set(scripts.test ?? rules.flatMap((rule) => rule.test))],
      lint: [...new Set(scripts.lint ?? rules.flatMap((rule) => rule.lint))],
      source: "detected",
    });
  }
  return services;
}

function normalizeRoot(root: string | undefined): string {
  return (root ?? "").replaceAll("\\", "/").replace(/^\.\//, "").replace(/\/+$/, "");
}

function asList(value: unknown): string[] {
  if (Array.isArray(value)) return value.map((item) => String(item ?? "").trim()).filter(Boolean);
  if (typeof value === "string" && value.trim()) return [value.trim()];
  return [];
}

export function mergeServices(detected: ServiceInfo[], configured: ServiceConfig[] | undefined): ServiceInfo[] {
  if (!configured?.length) return detected;
  const out = detected.map((service) => ({ ...service }));
  const taken = new Set(out.map((service) => service.name.toLowerCase()));

  for (const entry of configured) {
    const name = String(entry?.name ?? "").trim();
    if (!name) continue;
    const root = normalizeRoot(entry.root);
    const existing =
      out.find((service) => service.name.toLowerCase() === name.toLowerCase()) ??
      (entry.root !== undefined ? out.find((service) => service.root === root) : undefined);

    if (existing) {
      existing.name = name;
      if (entry.root !== undefined) existing.root = root;
      if (entry.layer) existing.layer = entry.layer;
      if (asList(entry.languages).length) existing.languages = asList(entry.languages);
      if (asList(entry.paths).length) existing.paths = asList(entry.paths);
      else if (entry.root !== undefined) existing.paths = pathsForRoot(root);
      if (asList(entry.skills).length) existing.skills = asList(entry.skills);
      if (asList(entry.test).length) existing.test = asList(entry.test);
      if (asList(entry.lint).length) existing.lint = asList(entry.lint);
      existing.source = "merged";
      continue;
    }

    if (taken.has(name.toLowerCase())) continue;
    taken.add(name.toLowerCase());
    out.push({
      name,
      root,
      layer: entry.layer ?? "backend",
      languages: asList(entry.languages),
      paths: asList(entry.paths).length ? asList(entry.paths) : pathsForRoot(root),
      skills: asList(entry.skills),
      test: asList(entry.test),
      lint: asList(entry.lint),
      source: "config",
    });
  }
  return out.slice(0, MAX_SERVICES);
}

export function normalizeServices(raw: unknown): ServiceInfo[] {
  if (!Array.isArray(raw)) return [];
  const out: ServiceInfo[] = [];
  for (const entry of raw) {
    if (!entry || typeof entry !== "object") continue;
    const node = entry as Record<string, unknown>;
    const name = String(node.name ?? "").trim();
    if (!name) continue;
    const root = normalizeRoot(typeof node.root === "string" ? node.root : "");
    const layer = node.layer;
    out.push({
      name,
      root,
      layer:
        layer === "database" || layer === "backend" || layer === "frontend" || layer === "general"
          ? layer
          : "backend",
      languages: asList(node.languages),
      paths: asList(node.paths).length ? asList(node.paths) : pathsForRoot(root),
      skills: asList(node.skills),
      test: asList(node.test),
      lint: asList(node.lint),
      source: node.source === "config" || node.source === "merged" ? node.source : "detected",
    });
  }
  return out.slice(0, MAX_SERVICES);
}

export function isMultiService(services: ServiceInfo[] | undefined): boolean {
  return (services?.length ?? 0) > 1;
}

export function serviceByName(
  services: ServiceInfo[] | undefined,
  name: string | undefined,
): ServiceInfo | undefined {
  if (!name) return undefined;
  const key = name.trim().toLowerCase();
  if (!key) return undefined;
  return (services ?? []).find((service) => service.name.toLowerCase() === key);
}

export function servicesForLayer(
  services: ServiceInfo[] | undefined,
  layer: ImplementorLayer | undefined,
): ServiceInfo[] {
  if (!layer) return services ?? [];
  return (services ?? []).filter((service) => service.layer === layer);
}

/** Names to run for a layer. One service is treated as the whole layer. */
export function serviceQueueForLayer(
  services: ServiceInfo[] | undefined,
  layer: ImplementorLayer | undefined,
): string[] {
  const names = servicesForLayer(services, layer).map((service) => service.name);
  return names.length > 1 ? names : [];
}

export function servicesForFiles(
  services: ServiceInfo[] | undefined,
  files: string[],
  layer: ImplementorLayer,
): string[] {
  const hits = new Set<string>();
  for (const file of files) {
    const service = serviceForPath(services, file);
    if (service?.layer === layer) hits.add(service.name);
  }
  return hits.size ? [...hits] : serviceQueueForLayer(services, layer);
}

export function serviceForPath(services: ServiceInfo[] | undefined, filePath: string): ServiceInfo | undefined {
  const rel = filePath.replaceAll("\\", "/").replace(/^\.\//, "");
  let best: ServiceInfo | undefined;
  for (const service of services ?? []) {
    if (!service.root) {
      if (!best) best = service;
      continue;
    }
    if (rel === service.root || rel.startsWith(`${service.root}/`)) {
      if (!best?.root || service.root.length > best.root.length) best = service;
    }
  }
  return best;
}

export function serviceCommands(services: ServiceInfo[] | undefined, kind: "test" | "lint"): string[] {
  const out: string[] = [];
  for (const service of services ?? []) {
    for (const command of service[kind]) {
      if (!out.includes(command)) out.push(command);
    }
  }
  return out;
}

export function renderServices(services: ServiceInfo[] | undefined): string {
  const all = services ?? [];
  if (!all.length) return "";
  return all
    .map((service) => {
      const root = service.root ? `${service.root}/` : "./";
      const langs = service.languages.length ? service.languages.join("+") : "unknown";
      const test = service.test.length ? ` · test: ${service.test.join(" && ")}` : "";
      const lint = service.lint.length ? ` · lint: ${service.lint.join(" && ")}` : "";
      return `- **${service.name}** (${service.layer}, ${langs}) — ${root}${test}${lint}`;
    })
    .join("\n");
}
