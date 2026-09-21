---
name: project-knowledge
description: Read and write OKF-style project knowledge under .pi/knowledge — provenance, trust, and durable specs for /devteam scouts and planners.
---
> **pi-dev-team**: Workflow state (`devteam_state`, `workflow_state.json`) stays in the agent directory. This skill covers the **git-tracked knowledge bundle** in the user repository only.

# Project knowledge (OKF-lite)

Use the bundle at `.pi/knowledge/` (or `knowledge.path` in `.pi/devteam.json`) for facts and specs that should survive across `/devteam` runs. A root **`AGENTS.md`** (bootstrapped on first `/devteam` run) should link here — do not duplicate OKF content in `AGENTS.md`. Format follows [Open Knowledge Format v0.2](https://github.com/GoogleCloudPlatform/knowledge-catalog/blob/main/okf/SPEC.md) with a small pi-dev-team profile.

## Layout

```text
.pi/knowledge/
  index.md                 # optional directory map (may declare okf_version)
  log.md                   # optional human/agent changelog
  concepts/
    repo/                  # durable repository facts (scouts maintain)
    specs/<job-id>.md      # per-run Feature Spec (planner mirrors devteam_state.spec)
```

## Required frontmatter

Every concept file MUST start with YAML frontmatter and a non-empty `type`:

```yaml
---
type: Repository Fact
title: Short display name
description: One-line summary
status: draft          # draft | stable | deprecated (omit ⇒ stable)
generated:
  by: pi-dev-team/scout
  at: 2026-09-21T00:00:00Z
sources:
  - id: users-route
    resource: src/app/users/page.tsx
    title: Users page
---
```

### Types used in pi-dev-team

| type | Who writes | Purpose |
|------|------------|---------|
| `Repository Fact` | Scout | What exists in the tree (paths, types, patterns, gaps) |
| `API Contract` | Scout, planner | Endpoint, payload, status codes, errors |
| `Schema` | Scout, planner | Tables, columns, migrations |
| `Pattern` | Scout | Auth, routing, testing, or layering conventions |
| `Feature Spec` | Planner | The active task spec (mirror of `devteam_state.spec`) |

Optional trust fields (recommended on `Feature Spec` and contracts):

```yaml
verified:
  - by: human:alice
    at: 2026-09-21T01:00:00Z
stale_after: 2026-12-21T00:00:00Z
```

## Provenance rules

1. Every non-obvious claim MUST link to a `sources[].id` via a footnote:

```markdown
Settings live under `/settings` with no API yet.[^settings-route]

[^settings-route]: src/app/settings/page.tsx
```

2. `sources[].resource` is a repo-relative path or URL — never invent paths.
3. Prefer updating an existing concept over creating duplicates; link between concepts with bundle-relative paths (`/concepts/repo/auth.md`).
4. Append a dated bullet to `log.md` when you add or materially change a concept.

## Role-specific workflow

### Scouts

1. Read `index.md` and relevant `concepts/repo/*` before scouting.
2. After investigation, upsert concepts under `concepts/repo/` (one topic per file).
3. Put a short rollup in `devteam_handoff` summary; durable detail lives in the bundle.
4. Do not write implementor work items or feature specs.

### Planner

1. Read scout notes **and** linked knowledge concepts; treat sourced facts as ground truth.
2. Grill the user until the spec is complete; store the working spec in `devteam_state` (`section: spec`).
3. When calling `plan_ready`, also write `concepts/specs/<job-id>.md`:

```yaml
---
type: Feature Spec
title: <task title>
description: <one line>
status: draft
generated:
  by: pi-dev-team/planner
  at: <ISO-8601>
sources:
  - id: scout-notes
    resource: devteam_state/scoutNotes
---
```

Body: same sections as the `to-spec` template (Problem, Solution, User Stories, Implementation Decisions, Testing, Out of Scope).

4. If the user confirms a contract during grilling, update or add an `API Contract` / `Schema` concept with `verified` when they explicitly approve.

### Implementors, critics, reviewers

- Read-only in the bundle. Use `devteam_state.spec` as the execution contract.
- If the spec and a `Feature Spec` concept disagree, `devteam_state.spec` wins for this run; file a `[note]` in review findings.

## Do not

- Store secrets, tokens, or `.env` values in concepts.
- Write workflow JSON, tickets, or `workflow_state` files into the user repo.
- Replace `devteam_state` orchestration fields with OKF files.
