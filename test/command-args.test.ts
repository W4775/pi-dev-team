import assert from "node:assert/strict";
import { test } from "node:test";
import { parseDevteamArgs } from "../src/command-args.ts";

test("parseDevteamArgs reads continue from string, array, or full slash line", () => {
  assert.deepEqual(parseDevteamArgs("continue"), { trimmed: "continue", sub: "continue", rest: "" });
  assert.deepEqual(parseDevteamArgs("/devteam continue"), { trimmed: "continue", sub: "continue", rest: "" });
  assert.deepEqual(parseDevteamArgs("devteam continue"), { trimmed: "continue", sub: "continue", rest: "" });
  assert.deepEqual(parseDevteamArgs(["continue"]), { trimmed: "continue", sub: "continue", rest: "" });
  assert.equal(parseDevteamArgs({ text: "continue" }).sub, "continue");
  assert.deepEqual(parseDevteamArgs("continue list"), { trimmed: "continue list", sub: "continue", rest: "list" });
  assert.deepEqual(parseDevteamArgs("continue 2"), { trimmed: "continue 2", sub: "continue", rest: "2" });
  assert.equal(parseDevteamArgs("").sub, "");
  assert.equal(parseDevteamArgs("Add a settings page").trimmed, "Add a settings page");
});
