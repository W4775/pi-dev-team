---
name: grilling
description: Grill the user relentlessly about a plan, decision, or idea. Use when the user wants to stress-test their thinking, or uses any 'grill' trigger phrases.
---
> Adapted for **pi-dev-team**: persist work in `devteam_state` (never write specs, tickets, or workflow files into the user repo). Do not require `/setup-matt-pocock-skills` or an issue tracker. Do not git-commit. Read `CONTEXT.md` / ADRs if they already exist.


Interview the user relentlessly until you reach a shared understanding. Map this as a **design tree**: every decision branches into the decisions that hang off it.

Work the tree in **rounds**. The **frontier** is every decision whose prerequisites are already settled: the questions you can ask _now_ without guessing at answers you haven't heard yet. Ask the whole frontier in one round.

Present each round with the **`ask` tool** if the host has it, otherwise **`devteam_ask`**. Each question gets 2–5 short option labels (put tradeoffs in the question body, not in the label). Mark `recommended` with the 0-based index of your preferred option. **Do not add an Other option** — the UI always adds "Other (type your own)" so the user can type a custom answer. Never ask them to type `q1:1`.

Then wait for the tool result before the next round.

Each round the user answers reshapes the tree: settled decisions push the frontier outward and unblock questions that depended on them. Recompute the frontier and ask the next round. A question whose answer depends on another question still open in this round belongs to a _later_ round, not this one.

Finding _facts_ is your job, never the user's. When a frontier question needs a fact from the environment (filesystem, tools, etc.), dispatch a sub-agent to find it; don't ask the user for anything you could look up yourself. Don't block on it: a running exploration is an unsettled prerequisite, so only the questions downstream of it wait for the sub-agent to report; ask the rest of the frontier now. The _decisions_ are the user's: put each to them and wait.

The session is done when the frontier is empty: every branch of the design tree visited, nothing left silently assumed. Do not act on it until the user confirms you have reached a shared understanding.
