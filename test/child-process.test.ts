import assert from "node:assert/strict";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { spawnPiChild } from "../src/child-process.ts";

test(
  "abort escalates for SIGTERM-resistant child and descendants",
  { skip: process.platform === "win32", timeout: 10000 },
  async () => {
    const script = `
    const { spawn } = require('node:child_process');
    process.on('SIGTERM', () => console.log('parent-term'));
    const child = spawn(process.execPath, ['-e', "process.on('SIGTERM', () => console.log('child-term')); console.log('child-ready'); setInterval(() => {}, 1000)"], { stdio: ['ignore', 'inherit', 'inherit'] });
    console.log('parent-ready');
    setInterval(() => {}, 1000);
  `;
    const child = spawnPiChild({
      args: ["-e", script],
      cwd: process.cwd(),
      env: { ...process.env, PI_SUBPROCESS_CMD: process.execPath },
    });
    let output = "";
    let completed = false;
    try {
      const ready = Promise.withResolvers<void>();
      const timer = setTimeout(() => ready.reject(new Error("child did not become ready")), 5000);
      child.process.stdout!.on("data", (chunk: string) => {
        output += chunk;
        if (output.includes("parent-ready") && output.includes("child-ready")) ready.resolve();
      });
      child.process.once("error", ready.reject);
      try {
        await ready.promise;
      } finally {
        clearTimeout(timer);
      }
      child.abort();
      child.abort();
      // Real clock required: escalation must signal real OS processes.
      const deadline = Promise.withResolvers<never>();
      const deadlineTimer = setTimeout(
        () => deadline.reject(new Error("abort did not terminate process group")),
        5000,
      );
      const result = await Promise.race([child.done, deadline.promise]).finally(() =>
        clearTimeout(deadlineTimer),
      );
      completed = true;
      assert.equal(result.code, 1);
      assert.equal(child.process.signalCode, "SIGKILL");
      assert.match(result.stdout, /parent-term/);
      assert.match(result.stdout, /child-term/);
    } finally {
      if (!completed && child.process.pid) {
        try {
          process.kill(-child.process.pid, "SIGKILL");
        } catch {
          /* already exited */
        }
      }
    }
  },
);

test(
  "abort kills redirected descendant after invoked child exits on SIGTERM",
  { skip: process.platform === "win32", timeout: 10000 },
  async () => {
    const dir = mkdtempSync(join(tmpdir(), "child-abort-"));
    const marker = join(dir, "survived");
    const script = `
      const { spawn } = require('node:child_process');
      const descendant = spawn(process.execPath, ['-e', ${JSON.stringify(`
        process.on('SIGTERM', () => {});
        process.send('ready');
        setTimeout(() => require('node:fs').writeFileSync(process.argv[1], 'alive'), 3500);
      `)}, ${JSON.stringify(marker)}], { stdio: ['ignore', 'ignore', 'ignore', 'ipc'] });
      descendant.on('message', () => {
        descendant.disconnect();
        console.log('descendant-ready');
      });
      setInterval(() => {}, 1000);
    `;
    const child = spawnPiChild({
      args: ["-e", script],
      cwd: process.cwd(),
      env: { ...process.env, PI_SUBPROCESS_CMD: process.execPath },
    });
    try {
      const ready = Promise.withResolvers<void>();
      const timer = setTimeout(
        () => ready.reject(new Error("descendant did not become ready")),
        5000,
      );
      let output = "";
      child.process.stdout!.on("data", (chunk: string) => {
        output += chunk;
        if (output.includes("descendant-ready")) ready.resolve();
      });
      child.process.once("error", ready.reject);
      try {
        await ready.promise;
      } finally {
        clearTimeout(timer);
      }
      child.abort();
      const result = await child.done;
      assert.equal(result.code, 1);
      assert.equal(child.process.signalCode, "SIGKILL");
      // The marker is written by a real OS process after the grace period.
      const delay = Promise.withResolvers<void>();
      setTimeout(delay.resolve, 2000);
      await delay.promise;
      assert.equal(existsSync(marker), false);
    } finally {
      child.abort();
      rmSync(dir, { recursive: true, force: true });
    }
  },
);

test("preserves normal exit status and streams", async () => {
  const child = spawnPiChild({
    args: ["-e", "console.log('out'); console.error('err'); process.exitCode = 7"],
    cwd: process.cwd(),
    env: { ...process.env, PI_SUBPROCESS_CMD: process.execPath },
  });
  const result = await child.done;
  assert.equal(result.code, 7);
  assert.match(result.stdout, /out/);
  assert.match(result.stderr, /err/);
});

test("reports missing executable", async () => {
  const child = spawnPiChild({
    args: [],
    cwd: process.cwd(),
    env: { ...process.env, PI_SUBPROCESS_CMD: "/no/such/pi-executable" },
  });
  const result = await child.done;
  assert.equal(result.code, 1);
  assert.match(result.stderr, /ENOENT/);
});

test("abort before supervisor startup terminates child", { timeout: 10000 }, async () => {
  const controller = new AbortController();
  controller.abort();
  const child = spawnPiChild({
    args: ["-e", "setInterval(() => {}, 1000)"],
    cwd: process.cwd(),
    env: { ...process.env, PI_SUBPROCESS_CMD: process.execPath },
    signal: controller.signal,
  });
  assert.equal((await child.done).code, 1);
});
