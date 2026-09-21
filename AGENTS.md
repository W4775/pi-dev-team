# Agents

This repository is the **pi-dev-team** Pi/OMP extension: a `/devteam` workflow that scouts, plans, implements layer-by-layer, and runs QA.

- **Package manager:** npm (Node ≥ 22)
- **Verify changes:** `npm test` · `npm run lint` · `npm run fmt:check`

Keep this file small. Use the links below instead of duplicating rules here ([progressive disclosure](https://www.aihero.dev/a-complete-guide-to-agents-md)).

## Where to look

| Topic | Location |
|-------|----------|
| OKF knowledge bundles (consumer repos) | [KNOWLEDGE.md](./KNOWLEDGE.md) |
| OKF authoring (`sources`, `generated`, concept types) | [skills/project-knowledge/SKILL.md](./skills/project-knowledge/SKILL.md) |
| Run notebooks (`workflow_state`, job JSON) | [WHERE-IS-WORKFLOW-STATE.md](./WHERE-IS-WORKFLOW-STATE.md) — **not** in this plugin folder |
| User-facing overview | [README.md](./README.md) |
| Extension source | `src/` |
| Tests | `test/` (`node --test`, no Pi install required) |
| Role prompts | `roles/` |
| Bundled workflow skills | `skills/` |
| Stack skill catalog | `catalog/stacks.json` |

## Conventions for this package

- Workflow orchestration is TypeScript in `src/`; prefer extending existing patterns over new abstractions.
- Run state and specs for **active** `/devteam` jobs live in the user's agent directory (`devteam_state`), not in git.
- OKF **durable** knowledge (repo facts, mirrored feature specs) is for **consumer projects** under `.pi/knowledge/` — see KNOWLEDGE.md and `templates/AGENTS.md` for the bootstrap shape.
- Do not commit secrets, `.env` files, or generated run artifacts into this repo.
