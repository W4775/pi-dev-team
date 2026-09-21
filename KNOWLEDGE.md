# Project knowledge (OKF)

`/devteam` can maintain an **Open Knowledge Format (OKF)** bundle in your repository for facts and specs that should survive across runs. Workflow orchestration (`workflow_state.json`, stage, handoffs) stays in the Pi agent directory — only durable knowledge is written here.

## Location

Default bundle root:

```text
.pi/knowledge/
  index.md
  log.md
  concepts/
    repo/           # scouts: sourced facts about the codebase
    specs/<job>.md  # planner: OKF mirror of each run's spec
```

On bootstrap, pi-dev-team also creates a minimal root **`AGENTS.md`** (if missing) that points agents at this bundle — keep it small per [progressive disclosure](https://www.aihero.dev/a-complete-guide-to-agents-md). Template: `templates/AGENTS.md` in the plugin package.


## Configure

In `.pi/devteam.json` (or `.omp/devteam.json`):

```json
{
  "knowledge": {
    "path": ".pi/knowledge",
    "bootstrap": true,
    "enabled": true
  }
}
```

| Field | Default | Meaning |
|-------|---------|---------|
| `enabled` | `true` | Turn off OKF reads/writes entirely |
| `path` | `.pi/knowledge` | Bundle root (relative to repo) |
| `bootstrap` | `true` | Create `index.md`, `log.md`, and starter concepts when missing |

Set `enabled: false` if you do not want agents writing into the repo.

## Who writes what

| Role | Bundle access |
|------|----------------|
| Scout | Read + write `concepts/repo/` |
| Planner | Read + write concepts; mirror spec to `concepts/specs/<job-id>.md` |
| Implementors / critics | Read only |
| `devteam_state` | Always the live run notebook (agent dir) |

## Spec of record

- **Building this run:** `devteam_state.spec` (via `devteam_state` tool)
- **Git history / review:** `concepts/specs/<job-id>.md` (`type: Feature Spec`)

The planner should keep them aligned when handing off `plan_ready`.

## Format

See [skills/project-knowledge/SKILL.md](./skills/project-knowledge/SKILL.md) and the [OKF v0.2 spec](https://github.com/GoogleCloudPlatform/knowledge-catalog/blob/main/okf/SPEC.md).

Minimum conformant concept:

```yaml
---
type: Repository Fact
title: Example
---
```

Recommended: `generated`, `sources` with footnote-linked claims, `status`, and `stale_after` on facts that go out of date quickly.
