import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { loadCatalog } from "../src/catalog.ts";
import { collectNpmDeps, detectStack, entryMatches, stackIdsForLayer } from "../src/detect-stack.ts";

const catalog = loadCatalog();

function project(files: Record<string, string>): string {
  const root = mkdtempSync(join(tmpdir(), "devteam-stack-"));
  for (const [rel, body] of Object.entries(files)) {
    const abs = join(root, rel);
    mkdirSync(dirname(abs), { recursive: true });
    writeFileSync(abs, body);
  }
  return root;
}

test("catalog contains curated first-party stacks only", () => {
  const ids = catalog.stacks.map((s) => s.id);
  for (const id of [
    "react-native",
    "angular",
    "next",
    "vue",
    "react",
    "blazor",
    "dotnet",
    "postgres",
    "efcore",
  ]) {
    assert.ok(ids.includes(id), `missing ${id}`);
  }
  assert.equal(
    ids.some((id) => id.includes("django") || id.includes("fastapi") || id.includes("rails")),
    false,
  );
});

test("react-native wins over react", () => {
  const cwd = project({
    "package.json": JSON.stringify({
      dependencies: { react: "19.0.0", "react-native": "0.76.0" },
    }),
  });
  const detection = detectStack(catalog, { cwd });
  assert.equal(detection.frontend, "react-native");
  assert.equal(detection.uiSurface, "native");
});

test("next matches before generic react and still uses react practices", () => {
  const cwd = project({
    "package.json": JSON.stringify({ dependencies: { next: "15.0.0", react: "19.0.0" } }),
  });
  const detection = detectStack(catalog, { cwd });
  assert.equal(detection.frontend, "next");
  assert.equal(detection.uiSurface, "web");
  const nextSkills = catalog.stacks.find((s) => s.id === "next")?.skills.map((s) => s.path);
  assert.ok(nextSkills?.some((p) => p.includes("react-best-practices")));
});

test("angular.json matches angular", () => {
  const cwd = project({
    "package.json": JSON.stringify({ dependencies: { "@angular/core": "19.0.0" } }),
    "angular.json": "{}",
  });
  const detection = detectStack(catalog, { cwd });
  assert.equal(detection.frontend, "angular");
});

test("vue pinia is additive and requires vue", () => {
  const cwd = project({
    "package.json": JSON.stringify({ dependencies: { vue: "3.5.0", pinia: "2.2.0" } }),
  });
  const detection = detectStack(catalog, { cwd });
  assert.equal(detection.frontend, "vue");
  assert.ok(detection.extra.includes("vue-pinia"));
  const ids = stackIdsForLayer(detection, "frontend");
  assert.ok(ids.includes("vue"));
  assert.ok(ids.includes("vue-pinia"));
});

test("postgres from DATABASE_URL and prisma", () => {
  const cwd = project({
    "package.json": JSON.stringify({ dependencies: { pg: "8.0.0" } }),
    ".env.example": "DATABASE_URL=postgresql://localhost/app\n",
    "prisma/schema.prisma": `datasource db { provider = "postgresql" url = env("DATABASE_URL") }\n`,
  });
  const detection = detectStack(catalog, { cwd });
  assert.ok(detection.database.includes("postgres"));
});

test("dotnet web sdk matches backend webapi skill only", () => {
  const cwd = project({
    "App.csproj": `<Project Sdk="Microsoft.NET.Sdk.Web"><ItemGroup><PackageReference Include="Microsoft.AspNetCore" /></ItemGroup></Project>\n`,
  });
  const detection = detectStack(catalog, { cwd });
  assert.equal(detection.backend, "dotnet");
  const skill = catalog.stacks.find((s) => s.id === "dotnet")?.skills[0];
  assert.equal(skill?.path, "plugins/dotnet-aspnetcore/skills/dotnet-webapi");
});

test("efcore is a database skill", () => {
  const cwd = project({
    "Data.csproj": `<Project Sdk="Microsoft.NET.Sdk"><PackageReference Include="Microsoft.EntityFrameworkCore" /></Project>\n`,
  });
  const detection = detectStack(catalog, { cwd });
  assert.ok(detection.database.includes("efcore"));
});

test("stackIdsForLayer tolerates missing extra/database arrays", () => {
  const ids = stackIdsForLayer({ frontend: "react" } as ReturnType<typeof detectStack>, "frontend");
  assert.deepEqual(ids, ["react"]);
  const db = stackIdsForLayer({ frontend: "react" } as ReturnType<typeof detectStack>, "database");
  assert.deepEqual(db, []);
});

test("collectNpmDeps reads dependency blocks", () => {
  const deps = collectNpmDeps(
    JSON.stringify({ dependencies: { vue: "1" }, devDependencies: { vitest: "1" } }),
  );
  assert.ok(deps.has("vue"));
  assert.ok(deps.has("vitest"));
});

test("entryMatches is true when any configured matcher hits", () => {
  const entry = catalog.stacks.find((s) => s.id === "react")!;
  assert.equal(
    entryMatches(entry, {
      deps: new Set(["react"]),
      files: ["package.json"],
      cwd: "/tmp",
      envText: "",
    }),
    true,
  );
});
