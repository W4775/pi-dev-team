import assert from "node:assert/strict";
import { test } from "node:test";
import { compileScoutNotes, nextScoutWave, normalizeScoutItems } from "../src/scout.ts";
import { MAX_SCOUTS } from "../src/types.ts";

test("normalizeScoutItems fills ids and caps the list", () => {
  const items = normalizeScoutItems([
    { title: "Existing UI", files: "src/app/**" },
    { id: "api", title: "API", paths: ["src/server/**"] },
  ]);
  assert.equal(items.length, 2);
  assert.ok(items[0]?.id);
  assert.deepEqual(items[0]?.files, ["src/app/**"]);
  assert.equal(items[1]?.id, "api");
  assert.deepEqual(items[1]?.files, ["src/server/**"]);
});

test("normalizeScoutItems drops overflow past MAX_SCOUTS", () => {
  const raw = Array.from({ length: MAX_SCOUTS + 3 }, (_, index) => ({ title: `s${index}` }));
  assert.equal(normalizeScoutItems(raw).length, MAX_SCOUTS);
});

test("nextScoutWave packs pending items and allows overlapping paths", () => {
  const wave = nextScoutWave(
    [
      { id: "a", title: "a", files: ["src/**"], status: "pending", attempts: 0 },
      { id: "b", title: "b", files: ["src/**"], status: "pending", attempts: 0 },
      { id: "c", title: "c", files: ["src/**"], status: "pending", attempts: 0 },
      { id: "d", title: "d", files: ["src/**"], status: "pending", attempts: 0 },
    ],
    3,
  );
  assert.deepEqual(
    wave.map((item) => item.id),
    ["a", "b", "c"],
  );
});

test("nextScoutWave waits while any scout is running", () => {
  const wave = nextScoutWave([
    { id: "a", title: "a", files: [], status: "running", attempts: 1 },
    { id: "b", title: "b", files: [], status: "pending", attempts: 0 },
  ]);
  assert.deepEqual(wave, []);
});

test("compileScoutNotes prefers stored notes, else item findings", () => {
  const items = [
    { id: "a", title: "UI", files: [], status: "done" as const, attempts: 1, findings: "settings live in src/app/settings" },
  ];
  assert.match(compileScoutNotes(items), /src\/app\/settings/);
  assert.equal(compileScoutNotes(items, "already written"), "already written");
});
