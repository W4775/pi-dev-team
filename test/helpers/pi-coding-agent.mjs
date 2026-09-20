import { join } from "node:path";

export function getAgentDir() {
  return process.env.DEVTEAM_E2E_AGENT_DIR || join(process.env.HOME ?? "/tmp", ".omp", "agent");
}

export function isToolCallEventType(name, event) {
  return event?.toolName === name;
}

export function withFileMutationQueue(_path, fn) {
  return fn();
}
