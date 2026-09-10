import assert from "node:assert/strict";
import { test } from "node:test";
import {
  applyServiceDefaults,
  nextWave,
  normalizeWorkItems,
  resolveParallel,
  retryableItems,
} from "../src/work.ts";
import type { ServiceInfo, WorkItem } from "../src/types.ts";

function item(partial: Partial<WorkItem> & Pick<WorkItem, "id" | "layer" | "title">): WorkItem {
  return {
    files: [],
    dependsOn: [],
    status: "pending",
    attempts: 0,
    ...partial,
  };
}

test("normalizeWorkItems fills ids, layers, and drops unknown dependsOn", () => {
  const items = normalizeWorkItems([
    { title: "POST /od", layer: "backend", files: "services/api/routes/**", dependsOn: ["missing"] },
    { id: "ui", layer: "frontend", files: ["src/app/**"] },
    { id: "ui", layer: "frontend", title: "duplicate id" },
  ]);
  assert.equal(items.length, 3);
  assert.equal(items[0]?.layer, "backend");
  assert.deepEqual(items[0]?.dependsOn, []);
  assert.ok(items[0]?.id);
  assert.equal(items[1]?.id, "ui");
  assert.equal(items[2]?.id, "ui-3");
});

test("nextWave runs one layer at a time in pipeline order", () => {
  const wave = nextWave([
    item({ id: "ui", layer: "frontend", title: "page", files: ["src/app/**"] }),
    item({ id: "db", layer: "database", title: "schema", files: ["prisma/**"] }),
    item({ id: "api", layer: "backend", title: "route", files: ["src/server/**"] }),
  ]);
  assert.deepEqual(
    wave.map((entry) => entry.id),
    ["db"],
  );
});

test("nextWave packs disjoint files in the same layer up to the parallel cap", () => {
  const wave = nextWave(
    [
      item({ id: "a", layer: "backend", title: "a", files: ["src/a/**"] }),
      item({ id: "b", layer: "backend", title: "b", files: ["src/b/**"] }),
      item({ id: "c", layer: "backend", title: "c", files: ["src/c/**"] }),
      item({ id: "d", layer: "backend", title: "d", files: ["src/d/**"] }),
    ],
    3,
  );
  assert.deepEqual(
    wave.map((entry) => entry.id),
    ["a", "b", "c"],
  );
});

test("nextWave will not run overlapping files together", () => {
  const wave = nextWave([
    item({ id: "a", layer: "backend", title: "a", files: ["src/api/**"] }),
    item({ id: "b", layer: "backend", title: "b", files: ["src/api/routes.ts"] }),
    item({ id: "c", layer: "backend", title: "c", files: ["src/other/**"] }),
  ]);
  assert.deepEqual(
    wave.map((entry) => entry.id),
    ["a", "c"],
  );
});

test("an item with no files runs alone", () => {
  const wave = nextWave([
    item({ id: "a", layer: "backend", title: "a" }),
    item({ id: "b", layer: "backend", title: "b", files: ["src/b/**"] }),
  ]);
  assert.deepEqual(
    wave.map((entry) => entry.id),
    ["a"],
  );
});

test("nextWave waits on dependsOn within a layer", () => {
  const items = [
    item({ id: "a", layer: "backend", title: "a", files: ["src/a/**"] }),
    item({ id: "b", layer: "backend", title: "b", files: ["src/b/**"], dependsOn: ["a"] }),
  ];
  assert.deepEqual(
    nextWave(items).map((entry) => entry.id),
    ["a"],
  );
  items[0]!.status = "done";
  assert.deepEqual(
    nextWave(items).map((entry) => entry.id),
    ["b"],
  );
});

test("nextWave does not skip a layer that still has unfinished items", () => {
  const wave = nextWave([
    item({ id: "a", layer: "database", title: "a", files: ["db/**"], dependsOn: ["missing-done"] }),
    item({ id: "ui", layer: "frontend", title: "ui", files: ["src/app/**"] }),
  ]);
  assert.deepEqual(wave, []);
});

test("nextWave returns nothing while any item is running", () => {
  const wave = nextWave([
    item({ id: "a", layer: "backend", title: "a", files: ["src/a/**"], status: "running" }),
    item({ id: "b", layer: "backend", title: "b", files: ["src/b/**"] }),
  ]);
  assert.deepEqual(wave, []);
});

test("applyServiceDefaults fills files from the named service", () => {
  const services: ServiceInfo[] = [
    {
      name: "api",
      root: "services/api",
      layer: "backend",
      languages: ["go"],
      paths: ["services/api/**"],
      skills: [],
      test: [],
      lint: [],
      source: "detected",
    },
  ];
  const items = applyServiceDefaults(
    [item({ id: "route", layer: "backend", title: "route", service: "api" })],
    services,
  );
  assert.deepEqual(items[0]?.files, ["services/api/**"]);
});

test("resolveParallel defaults to 3 and caps at 6", () => {
  assert.equal(resolveParallel(undefined), 3);
  assert.equal(resolveParallel(0), 3);
  assert.equal(resolveParallel(9), 6);
});

test("retryableItems stops after two attempts", () => {
  const items = [
    item({ id: "a", layer: "backend", title: "a", status: "failed", attempts: 1 }),
    item({ id: "b", layer: "backend", title: "b", status: "failed", attempts: 2 }),
  ];
  assert.deepEqual(
    retryableItems(items).map((entry) => entry.id),
    ["a"],
  );
});
