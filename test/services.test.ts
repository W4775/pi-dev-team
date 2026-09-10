import assert from "node:assert/strict";
import { test } from "node:test";
import {
  detectServices,
  mergeServices,
  serviceByName,
  serviceForPath,
  serviceQueueForLayer,
} from "../src/services.ts";

test("a polyglot tree yields one service per manifest", () => {
  const services = detectServices({
    files: ["services/api/go.mod", "services/api/main.go", "services/scoring/pyproject.toml", "services/scoring/app.py"],
  });
  assert.equal(services.length, 2);
  const api = serviceByName(services, "api");
  const scoring = serviceByName(services, "scoring");
  assert.equal(api?.languages.includes("go"), true);
  assert.equal(api?.layer, "backend");
  assert.deepEqual(api?.test, ["go test ./..."]);
  assert.equal(scoring?.languages.includes("python"), true);
  assert.deepEqual(scoring?.test, ["pytest"]);
});

test("a single-manifest repo is one service", () => {
  const services = detectServices({ files: ["go.mod", "main.go"] });
  assert.equal(services.length, 1);
  assert.equal(services[0]?.root, "");
  assert.deepEqual(serviceQueueForLayer(services, "backend"), []);
});

test("config merges over a detected service by name", () => {
  const detected = detectServices({ files: ["api/go.mod"] });
  const merged = mergeServices(detected, [
    { name: "api", test: ["go test ./... -count=1"], lint: ["golangci-lint run"] },
  ]);
  assert.equal(merged.length, 1);
  assert.deepEqual(merged[0]?.test, ["go test ./... -count=1"]);
  assert.equal(merged[0]?.source, "merged");
});

test("serviceForPath picks the deepest root", () => {
  const services = detectServices({
    files: ["go.mod", "services/worker/pyproject.toml"],
  });
  assert.equal(serviceForPath(services, "services/worker/job.py")?.name, "worker");
  assert.equal(serviceForPath(services, "main.go")?.root, "");
});

test("two backend services become a queue", () => {
  const services = detectServices({
    files: ["api/go.mod", "scoring/pyproject.toml"],
  });
  assert.deepEqual(serviceQueueForLayer(services, "backend").sort(), ["api", "scoring"]);
});
