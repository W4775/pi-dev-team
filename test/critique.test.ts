import assert from "node:assert/strict";
import { test } from "node:test";
import { formatCritiqueForPlanner, parseCritiqueItems } from "../src/critique.ts";
import { formatAskAnswers, OTHER_OPTION, withOtherOption } from "../src/ask-ui.ts";

test("parseCritiqueItems reads a JSON array of suggestions", () => {
  const items = parseCritiqueItems(
    JSON.stringify([
      { id: "c1", title: "Empty state", text: "Specify the empty settings page." },
      { id: "c2", text: "Name the API error payload." },
    ]),
  );
  assert.equal(items.length, 2);
  assert.equal(items[0]?.id, "c1");
  assert.equal(items[0]?.title, "Empty state");
  assert.match(items[1]?.title ?? "", /Name the API error payload/);
});

test("parseCritiqueItems falls back to markdown bullets", () => {
  const items = parseCritiqueItems(`- Missing empty state for settings
- Name the 409 conflict payload`);
  assert.equal(items.length, 2);
  assert.match(items[0]?.text ?? "", /empty state/i);
});

test("parseCritiqueItems treats a blob as one item", () => {
  const items = parseCritiqueItems("The spec never says what happens on save failure.");
  assert.equal(items.length, 1);
  assert.match(items[0]?.text ?? "", /save failure/);
});

test("formatCritiqueForPlanner splits accepted and rejected", () => {
  const text = formatCritiqueForPlanner([
    { id: "c1", title: "Empty state", text: "Add it.", decision: "accept" },
    { id: "c2", title: "Rewrite stack", text: "Use Rails.", decision: "reject" },
  ]);
  assert.match(text, /Accepted/);
  assert.match(text, /Empty state/);
  assert.match(text, /Rejected/);
  assert.match(text, /Rewrite stack/);
});

test("withOtherOption appends a custom-answer entry once", () => {
  assert.deepEqual(withOtherOption(["Accept", "Reject"]), ["Accept", "Reject", OTHER_OPTION]);
  assert.equal(withOtherOption(["A", OTHER_OPTION]).filter((item) => item === OTHER_OPTION).length, 1);
});

test("formatAskAnswers prefers custom text", () => {
  assert.equal(
    formatAskAnswers([{ id: "q1", question: "Who?", selected: [OTHER_OPTION], custom: "Admins only" }]),
    "Admins only",
  );
});
