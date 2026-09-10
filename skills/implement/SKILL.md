---
name: implement
description: "Implement a piece of work based on a spec or set of tickets."
disable-model-invocation: true
---
> Adapted for **pi-dev-team**: persist work in `devteam_state` (never write specs, tickets, or workflow files into the user repo). Do not require `/setup-matt-pocock-skills` or an issue tracker. Do not git-commit. Read `CONTEXT.md` / ADRs if they already exist.


Implement the work described by the user in the spec or tickets.

Use /tdd where possible, at pre-agreed seams.

Run typechecking regularly, single test files regularly, and the full test suite once at the end.

Once done, update `devteam_state` with implementation notes. Do not nested-review. Do not commit.
