import { homedir } from "node:os";
import { existsSync } from "node:fs";
import { join } from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import * as codingAgent from "@earendil-works/pi-coding-agent";
import { withFileMutationQueue as localWithFileMutationQueue } from "./file-queue.ts";

export type { ExtensionAPI, ExtensionContext };

type Host = {
  getAgentDir?: () => string;
  isToolCallEventType?: (name: string, event: { toolName?: string }) => boolean;
  withFileMutationQueue?: typeof localWithFileMutationQueue;
};

const host = codingAgent as Host;

export function getAgentDir(): string {
  if (typeof host.getAgentDir === "function") return host.getAgentDir();
  const home = homedir();
  const omp = join(home, ".omp", "agent");
  if (existsSync(omp)) return omp;
  return join(home, ".pi", "agent");
}

export function isToolCallEventType(name: string, event: { toolName?: string }): boolean {
  if (typeof host.isToolCallEventType === "function") {
    return host.isToolCallEventType(name, event);
  }
  return event.toolName === name;
}

export const withFileMutationQueue: typeof localWithFileMutationQueue =
  typeof host.withFileMutationQueue === "function" ? host.withFileMutationQueue : localWithFileMutationQueue;

export const PROJECT_CONFIG_DIRS = [".omp", ".pi"] as const;
