import { spawn, type ChildProcess } from "node:child_process";
import { createProgressParser, type ProgressUpdate } from "./child-progress.ts";
import { assertNoNoExtensions, getPiInvocation } from "./spawn.ts";

export type ChildResult = {
  code: number;
  stderr: string;
  stdout: string;
  output: string;
};

export type SpawnedChild = {
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
  const proc = spawn(invocation.command, invocation.args, {
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

  const abort = () => {
    if (!proc.killed) proc.kill("SIGTERM");
    setTimeout(() => {
      if (!proc.killed) proc.kill("SIGKILL");
    }, 2000).unref();
  };

  if (opts.signal) {
    if (opts.signal.aborted) abort();
    else opts.signal.addEventListener("abort", abort, { once: true });
  }

  const done = new Promise<ChildResult>((resolve) => {
    const finish = (code: number, extra = "") => {
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
