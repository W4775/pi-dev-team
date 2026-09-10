import assert from "node:assert/strict";
import { test } from "node:test";
import {
  adaptArgsForUnknownFlags,
  buildChildCliArgs,
  childProcessEnv,
  getPiInvocation,
  hostBinaryName,
  isOmpHost,
  mapToolsForHost,
  parseUnknownFlags,
  rememberRejectedFlags,
  resetRejectedFlags,
  stripFlags,
  toolsForRole,
} from "../src/spawn.ts";
import { formatChildFailure } from "../src/child-process.ts";
import { loadDevteamConfig } from "../src/config.ts";
import { onAgentIdle, projectTrusted, sessionIdFromContext } from "../src/host-compat.ts";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { matchGlob } from "../src/glob.ts";

test("child CLI never disables extensions and still isolates skills", () => {
  const args = buildChildCliArgs({
    extensionPath: "/pkg/src/index.ts",
    rolePromptFile: "/tmp/frontend.prompt.md",
    role: "frontend",
    statePath: "/tmp/run.json",
    skillDirs: ["/skills/implement", "/cache/angular-developer"],
    tools: toolsForRole("frontend"),
    trusted: true,
    prompt: "do the work",
    omp: false,
  });
  assert.equal(args.includes("--no-extensions"), false);
  assert.ok(args.includes("--no-skills"));
  assert.ok(args.includes("-e"));
  assert.equal(args[args.indexOf("-e") + 1], "/pkg/src/index.ts");
  assert.ok(args.includes("--skill"));
  assert.ok(args.includes("--devteam-role"));
  assert.ok(args.includes("frontend"));
  assert.ok(args.includes("--devteam-state"));
  assert.ok(args.includes("-a"));
  assert.ok(args.includes("--tools"));
  assert.ok(args.at(-1)?.includes("do the work"));
});

test("Oh My Pi child argv omits unknown --devteam flags and uses env instead", () => {
  const opts = {
    extensionPath: "/pkg/src/index.ts",
    rolePromptFile: "/tmp/plan_critic.prompt.md",
    role: "plan_critic" as const,
    statePath: "/tmp/run.json",
    skillDirs: ["/skills/to-spec"],
    tools: toolsForRole("plan_critic"),
    prompt: "review the spec",
  };
  const args = buildChildCliArgs({ ...opts, omp: true, trusted: true });
  assert.equal(args.includes("--devteam-role"), false);
  assert.equal(args.includes("--devteam-state"), false);
  assert.equal(args.includes("--skill"), false);
  assert.equal(args.includes("-a"), false);
  assert.ok(args.includes("--no-skills"));
  assert.ok(args.includes("-e"));
  assert.equal(args[args.indexOf("-e") + 1], "/pkg/src/index.ts");
  assert.ok(args.includes("--yolo"));
  const tools = args[args.indexOf("--tools") + 1] ?? "";
  assert.match(tools, /glob/);
  assert.equal(tools.includes("ls"), false);
  assert.equal(tools.includes("find"), false);
  const env = childProcessEnv("plan_critic", "/tmp/run.json", {});
  assert.equal(env.DEVTEAM_ROLE, "plan_critic");
  assert.equal(env.DEVTEAM_STATE, "/tmp/run.json");
});

test("isOmpHost detects Oh My Pi env", () => {
  assert.equal(isOmpHost({}, ["node", "test.js"], "/usr/bin/node"), false);
  assert.equal(isOmpHost({ OH_MY_PI: "1" }), true);
  assert.equal(isOmpHost({ PI_CODING_AGENT_PACKAGE: "@oh-my-pi/pi-coding-agent" }), true);
  assert.equal(hostBinaryName({ OH_MY_PI: "1" }), "omp");
  assert.equal(hostBinaryName({}), "pi");
});

test("isOmpHost detects Oh My Pi from argv, exec path and OMP_ vars", () => {
  assert.equal(isOmpHost({ OMP_CONFIG_DIR: "C:/Users/me/.omp" }, [], ""), true);
  assert.equal(isOmpHost({}, ["node", "C:\\Users\\me\\.omp\\bin\\omp.js"], "node"), true);
  assert.equal(isOmpHost({}, [], "/usr/local/bin/omp"), true);
  assert.equal(isOmpHost({}, ["node", "/usr/local/lib/pi/cli.js"], "node"), false);
  assert.equal(isOmpHost({ DEVTEAM_HOST: "pi" }, [], "/usr/local/bin/omp"), false);
  assert.equal(isOmpHost({ DEVTEAM_HOST: "omp" }, [], "/usr/local/bin/pi"), true);
});

test("getPiInvocation matches Oh My Pi nested launch", () => {
  const args = ["--mode", "json", "-p"];
  assert.deepEqual(getPiInvocation(args, { PI_SUBPROCESS_CMD: "/opt/omp" }, { platform: "linux" }), {
    command: "/opt/omp",
    args,
    shell: false,
  });
  assert.deepEqual(
    getPiInvocation(args, { OH_MY_PI: "1" }, { argv: ["node"], execPath: "C:/nodejs/node.exe", platform: "win32" }),
    { command: "omp.cmd", args, shell: true },
  );
  assert.deepEqual(
    getPiInvocation(
      args,
      { OH_MY_PI: "1" },
      { argv: ["bun", "/$bunfs/root/omp.js"], execPath: "B:/BUN/root/omp-windows-x64", platform: "win32" },
    ),
    { command: "B:/BUN/root/omp-windows-x64", args, shell: false },
  );
});

test("parseUnknownFlags reads the flag names out of a host rejection", () => {
  assert.deepEqual(parseUnknownFlags("Error: unknown flags: -a, --skill, --skill\nRun `omp --help`"), [
    "-a",
    "--skill",
  ]);
  assert.deepEqual(parseUnknownFlags("error: unrecognized option '--thinking'"), ["--thinking"]);
  assert.deepEqual(parseUnknownFlags("plan critic rejected the spec"), []);
});

test("stripFlags drops rejected flags with their values but keeps the prompt", () => {
  const args = ["--mode", "json", "-a", "--skill", "/skills/to-spec", "--tools", "read", "review --skill now"];
  assert.deepEqual(stripFlags(args, ["-a", "--skill"]), [
    "--mode",
    "json",
    "--tools",
    "read",
    "review --skill now",
  ]);
});

test("adaptArgsForUnknownFlags swaps Pi's -a for Oh My Pi's --yolo", () => {
  const args = ["--mode", "json", "-a", "--skill", "/skills/to-spec", "do the work"];
  assert.deepEqual(adaptArgsForUnknownFlags(args, ["-a", "--skill"]), [
    "--mode",
    "json",
    "--yolo",
    "do the work",
  ]);
});

test("buildChildCliArgs reuses flags the host already rejected", () => {
  const opts = {
    extensionPath: "/pkg/src/index.ts",
    rolePromptFile: "/tmp/planner_orchestrator.prompt.md",
    role: "planner_orchestrator" as const,
    statePath: "/tmp/run.json",
    skillDirs: ["/skills/to-spec"],
    tools: toolsForRole("planner_orchestrator"),
    trusted: true,
    prompt: "plan scouts",
    omp: false,
  };
  try {
    rememberRejectedFlags(["-a", "--skill"]);
    const args = buildChildCliArgs(opts);
    assert.equal(args.includes("-a"), false);
    assert.equal(args.includes("--skill"), false);
    assert.equal(args.includes("/skills/to-spec"), false);
    assert.ok(args.includes("--yolo"));
    assert.ok(args.includes("-e"));
    assert.equal(args.at(-1), "plan scouts");
  } finally {
    resetRejectedFlags();
  }
  assert.ok(buildChildCliArgs(opts).includes("-a"));
});

test("mapToolsForHost replaces Pi find/ls with Oh My Pi glob", () => {
  assert.deepEqual(mapToolsForHost(["read", "grep", "find", "ls", "bash"], true), ["read", "grep", "glob", "bash"]);
  assert.deepEqual(mapToolsForHost(["read", "grep", "find", "ls", "bash"], false), [
    "read",
    "grep",
    "find",
    "ls",
    "bash",
  ]);
});

test("Oh My Pi child argv still passes --thinking", () => {
  const args = buildChildCliArgs({
    extensionPath: "/pkg/src/index.ts",
    rolePromptFile: "/tmp/scout.prompt.md",
    role: "scout",
    statePath: "/tmp/run.json",
    skillDirs: [],
    tools: toolsForRole("scout"),
    thinking: "low",
    trusted: true,
    prompt: "scout",
    omp: true,
  });
  assert.equal(args[args.indexOf("--thinking") + 1], "low");
});

test("formatChildFailure includes argv when streams are empty", () => {
  const msg = formatChildFailure("plan_critic", { code: 1, stderr: "", stdout: "", output: "" }, [
    "--mode",
    "json",
    "-p",
  ]);
  assert.match(msg, /plan_critic/);
  assert.match(msg, /empty stdout/);
  assert.match(msg, /--mode json/);
});

test("formatChildFailure does not dump thinking token JSON as the error", () => {
  const jsonl = [
    `{"type":"session","version":3,"id":"s1"}`,
    `{"type":"message_update","assistantMessageEvent":{"type":"thinking_delta","contentIndex":0,"delta":"see"}}`,
    `{"type":"message_update","assistantMessageEvent":{"type":"thinking_delta","contentIndex":0,"delta":" I"}}`,
  ].join("\n");
  const msg = formatChildFailure(
    "planner_orchestrator",
    { code: 1, stderr: "", stdout: jsonl, output: jsonl },
    ["--mode", "json"],
  );
  assert.equal(msg.includes("thinking_delta"), false);
  assert.equal(msg.includes('"delta":"see"'), false);
  assert.match(msg, /planner_orchestrator/);
  assert.match(msg, /exited 1/);
});

test("plan critic tools do not include edit/write", () => {
  const tools = toolsForRole("plan_critic");
  assert.equal(tools.includes("edit"), false);
  assert.equal(tools.includes("write"), false);
  assert.ok(tools.includes("devteam_handoff"));
});

test("orchestrator tools are read-only plus state/handoff", () => {
  const tools = toolsForRole("orchestrator");
  assert.equal(tools.includes("edit"), false);
  assert.equal(tools.includes("write"), false);
  assert.ok(tools.includes("devteam_state"));
  assert.ok(tools.includes("devteam_handoff"));
});

test("planner orchestrator and scout tools are read-only", () => {
  for (const role of ["planner_orchestrator", "scout"] as const) {
    const tools = toolsForRole(role);
    assert.equal(tools.includes("edit"), false, role);
    assert.equal(tools.includes("write"), false, role);
  }
  assert.equal(toolsForRole("scout").includes("bash"), false);
  assert.ok(toolsForRole("planner_orchestrator").includes("bash"));
});

test("childProcessEnv carries service and task id", () => {
  const env = childProcessEnv("backend", "/tmp/run.json", {}, { serviceName: "api", taskId: "route" });
  assert.equal(env.DEVTEAM_SERVICE, "api");
  assert.equal(env.DEVTEAM_TASK, "route");
});

test("implementor tools include edit and write", () => {
  const tools = toolsForRole("database");
  assert.ok(tools.includes("edit"));
  assert.ok(tools.includes("write"));
});

test("loadDevteamConfig requires trust", () => {
  const cwd = mkdtempSync(join(tmpdir(), "devteam-cfg-"));
  mkdirSync(join(cwd, ".pi"));
  writeFileSync(join(cwd, ".pi", "devteam.json"), JSON.stringify({ skills: { frontend: ["vue"] } }));
  assert.equal(loadDevteamConfig(cwd, false), null);
  assert.deepEqual(loadDevteamConfig(cwd, true)?.skills?.frontend, ["vue"]);
});

test("loadDevteamConfig prefers .omp then .pi", () => {
  const cwd = mkdtempSync(join(tmpdir(), "devteam-cfg-omp-"));
  mkdirSync(join(cwd, ".omp"));
  writeFileSync(join(cwd, ".omp", "devteam.json"), JSON.stringify({ skills: { frontend: ["angular"] } }));
  assert.deepEqual(loadDevteamConfig(cwd, true, [".omp", ".pi"])?.skills?.frontend, ["angular"]);
});

test("loadDevteamConfig returns null without a cwd", () => {
  assert.equal(loadDevteamConfig(undefined, true), null);
});

test("projectTrusted is true when the host has no isProjectTrusted", () => {
  assert.equal(projectTrusted({}), true);
  assert.equal(projectTrusted({ isProjectTrusted: () => false }), false);
  assert.equal(projectTrusted({ isProjectTrusted: () => true }), true);
});

test("sessionIdFromContext survives a missing sessionManager", () => {
  assert.equal(sessionIdFromContext({}), "session");
  assert.equal(sessionIdFromContext({ sessionManager: { getSessionId: () => "abc" } }), "abc");
});

test("onAgentIdle listens for Oh My Pi agent_end and Pi agent_settled", () => {
  const names: string[] = [];
  onAgentIdle(
    {
      on(event: string) {
        names.push(event);
      },
    },
    () => {},
  );
  assert.deepEqual(names, ["agent_end", "agent_settled"]);
});

test("glob matcher supports ** and *", () => {
  assert.equal(matchGlob("src/app/**", "src/app/page.tsx"), true);
  assert.equal(matchGlob("**/.env", "config/.env"), true);
  assert.equal(matchGlob("*.pem", "key.pem"), true);
  assert.equal(matchGlob("src/app/**", "server/api.ts"), false);
});
