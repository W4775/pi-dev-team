import { spawn, type ChildProcess } from "node:child_process";
import { createProgressParser, type ProgressUpdate } from "./child-progress.ts";
import { assertNoNoExtensions, getPiInvocation } from "./spawn.ts";

export type ChildResult = {
  code: number;
  stderr: string;
  stdout: string;
  output: string;
};

// POSIX group leader remains alive until the parent acknowledges completion or
// escalation kills the group. Only the leader signals its own group, so a
// recycled PID can never cause an unrelated process to be signalled.
const supervisor = `
const { spawn } = require("node:child_process");
let aborted = false;
let result;
process.on("SIGTERM", () => {});
process.on("message", (message) => {
  if (message === "abort" && !aborted) {
    aborted = true;
    process.kill(-process.pid, "SIGTERM");
    setTimeout(() => process.kill(-process.pid, "SIGKILL"), 2000);
  } else if (message === "finish" && !aborted && result) {
    if (result.signal) {
      process.removeAllListeners(result.signal);
      process.kill(process.pid, result.signal);
    } else {
      process.exit(result.code);
    }
  }
});
process.on("disconnect", () => {
  if (!aborted) {
    aborted = true;
    process.kill(-process.pid, "SIGTERM");
    setTimeout(() => process.kill(-process.pid, "SIGKILL"), 2000);
  }
});
const [command, ...args] = JSON.parse(process.argv[1]);
const child = spawn(command, args, { stdio: ["ignore", "inherit", "inherit"] });
let spawnError = false;
child.on("error", (error) => {
  spawnError = true;
  process.stderr.write("\\n" + error.message);
});
child.on("close", (code, signal) => {
  result = { code: spawnError ? 1 : code ?? 1, signal };
  if (process.connected) process.send("finished");
});
`;

export type SpawnedChild = {
  /** On POSIX this is the process-group supervisor, not the invoked child. */
  process: ChildProcess;
  done: Promise<ChildResult>;
  abort: () => void;
};

function looksLikeJsonEventStream(text: string): boolean {
  const line = text.split(/\r?\n/).find((entry) => entry.trim());
  if (!line?.startsWith("{")) return false;
  return /"type"\s*:/.test(line);
}

export function formatChildFailure(role: string, result: ChildResult, args: string[]): string {
  const stderr = result.stderr.trim();
  if (stderr && !looksLikeJsonEventStream(stderr)) return stderr.slice(0, 500);

  const body = result.output.trim();
  if (!body) {
    const preview = args.slice(0, 20).join(" ");
    return `child ${role} exited ${result.code} with empty stdout/stderr. argv: ${preview}`;
  }
  if (looksLikeJsonEventStream(body)) {
    return `child ${role} exited ${result.code}.`;
  }
  return body.slice(0, 4000);
}

export function spawnPiChild(opts: {
  args: string[];
  cwd: string;
  env?: NodeJS.ProcessEnv;
  signal?: AbortSignal;
  onProgress?: (update: ProgressUpdate) => void;
  /** Called on every stdout chunk so idle clocks still tick while tokens stream. */
  onOutput?: () => void;
}): SpawnedChild {
  assertNoNoExtensions(opts.args);
  const invocation = getPiInvocation(opts.args, opts.env ?? process.env);
  const supervised = process.platform !== "win32";
  // Packed hosts are not necessarily JavaScript runtimes; Node is the
  // supported runtime and is used to run the small supervisor in that case.
  const runtime = /(?:^|[/\\])(?:node|bun)(?:\.exe)?$/i.test(process.execPath)
    ? process.execPath
    : "node";
  const proc = supervised
    ? spawn(runtime, ["-e", supervisor, JSON.stringify([invocation.command, ...invocation.args])], {
        cwd: opts.cwd,
        env: opts.env ?? process.env,
        detached: true,
        stdio: ["ignore", "pipe", "pipe", "ipc"],
      })
    : spawn(invocation.command, invocation.args, {
        cwd: opts.cwd,
        env: opts.env ?? process.env,
        shell: invocation.shell,
        stdio: ["ignore", "pipe", "pipe"],
      });

  let stderr = "";
  let stdout = "";
  proc.stderr?.setEncoding("utf8");
  proc.stderr?.on("data", (chunk: string) => {
    stderr += chunk;
  });
  const progress = createProgressParser();
  const report = (updates: ProgressUpdate[]) => {
    if (!opts.onProgress) return;
    for (const update of updates) {
      try {
        opts.onProgress(update);
      } catch {
        /* progress must never break the run */
      }
    }
  };
  proc.stdout?.setEncoding("utf8");
  proc.stdout?.on("data", (chunk: string) => {
    stdout += chunk;
    try {
      opts.onOutput?.();
    } catch {
      /* ignore */
    }
    report(progress.push(chunk));
  });

  let killTimer: NodeJS.Timeout | undefined;
  let finished = false;
  let aborting = false;
  let childFinished = false;
  if (supervised) {
    proc.on("message", (message) => {
      if (message !== "finished" || aborting) return;
      childFinished = true;
      if (proc.connected) proc.send("finish", () => {});
    });
  }
  const abort = () => {
    if (finished || aborting || childFinished) return;
    aborting = true;
    if (supervised) {
      if (proc.connected) proc.send("abort", () => {});
    } else {
      // Windows has no POSIX process groups: only the direct child is killed.
      proc.kill("SIGTERM");
      killTimer = setTimeout(() => proc.kill("SIGKILL"), 2000);
      killTimer.unref();
    }
  };

  if (opts.signal) {
    if (opts.signal.aborted) abort();
    else opts.signal.addEventListener("abort", abort, { once: true });
  }

  const done = new Promise<ChildResult>((resolve) => {
    const finish = (code: number, extra = "") => {
      if (finished) return;
      finished = true;
      clearTimeout(killTimer);
      opts.signal?.removeEventListener("abort", abort);
      report(progress.flush());
      const err = extra ? `${stderr}\n${extra}` : stderr;
      const output = [err, stdout].filter((part) => part.trim().length > 0).join("\n");
      resolve({ code, stderr: err, stdout, output });
    };
    proc.on("error", (err) => {
      finish(1, err.message);
    });
    proc.on("close", (code) => {
      finish(code ?? 1);
    });
  });

  return { process: proc, done, abort };
}
