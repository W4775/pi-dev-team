import assert from "node:assert/strict";
import { test } from "node:test";
import { withFileMutationQueue } from "../src/file-queue.ts";

test("withFileMutationQueue serializes same-path work", async () => {
  const order: number[] = [];
  await Promise.all([
    withFileMutationQueue("/tmp/devteam-q", async () => {
      order.push(1);
      await new Promise((r) => setTimeout(r, 20));
      order.push(2);
    }),
    withFileMutationQueue("/tmp/devteam-q", async () => {
      order.push(3);
    }),
  ]);
  assert.deepEqual(order, [1, 2, 3]);
});

test("withFileMutationQueue allows different paths concurrently", async () => {
  let concurrent = 0;
  let max = 0;
  await Promise.all([
    withFileMutationQueue("/tmp/devteam-a", async () => {
      concurrent += 1;
      max = Math.max(max, concurrent);
      await new Promise((r) => setTimeout(r, 15));
      concurrent -= 1;
    }),
    withFileMutationQueue("/tmp/devteam-b", async () => {
      concurrent += 1;
      max = Math.max(max, concurrent);
      await new Promise((r) => setTimeout(r, 15));
      concurrent -= 1;
    }),
  ]);
  assert.equal(max, 2);
});
