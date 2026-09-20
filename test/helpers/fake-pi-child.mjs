#!/usr/bin/env node
import { readFileSync, writeFileSync } from "node:fs";

const role = process.env.DEVTEAM_ROLE ?? "";
const statePath = process.env.DEVTEAM_STATE;
const taskId = process.env.DEVTEAM_TASK;

if (!statePath) {
  process.stderr.write("fake-pi-child: DEVTEAM_STATE is required\n");
  process.exit(1);
}

const run = JSON.parse(readFileSync(statePath, "utf8"));

if (role === "planner_orchestrator") {
  run.scoutItems = [
    {
      id: "s1",
      title: "Map the repo",
      details: "Find files related to the task",
      files: ["src"],
      status: "pending",
      attempts: 0,
    },
  ];
  run.pendingHandoff = { action: "scout_planned", summary: "one scout" };
  writeFileSync(statePath, `${JSON.stringify(run, null, 2)}\n`);
} else if (role === "scout") {
  process.stdout.write(
    `${JSON.stringify({ type: "message", text: `scout ${taskId ?? "s1"} found src/index.ts` })}\n`,
  );
} else if (role === "plan_critic") {
  run.planCritique = {
    notes: "- Keep the settings page on the existing router.",
    replacedScope: false,
    items: [
      {
        id: "c1",
        title: "Reuse the existing router",
        text: "Do not introduce a second routing library.",
      },
    ],
  };
  run.pendingHandoff = { action: "critic_approve", summary: "one suggestion" };
  writeFileSync(statePath, `${JSON.stringify(run, null, 2)}\n`);
}

process.exit(0);
