# Agents

<!-- One sentence: what this project is and who it serves. -->

This project uses **[pi-dev-team](https://github.com/W4775/pi-dev-team)** `/devteam` for scout → plan → build → prove workflows.

## Commands

<!-- Only non-obvious commands (package manager, build, test). Delete this section if npm defaults are enough. -->

## Project knowledge (OKF)

Durable facts and specs live in the OKF bundle. Read the index before inferring structure from the tree.

| Resource | Path |
|----------|------|
| Bundle index | [.pi/knowledge/index.md](.pi/knowledge/index.md) |
| Repository facts (scouts maintain) | `.pi/knowledge/concepts/repo/` |
| Feature specs (planner mirrors each run) | `.pi/knowledge/concepts/specs/` |
| Update log | [.pi/knowledge/log.md](.pi/knowledge/log.md) |

**Active run contract:** `devteam_state.spec` (Pi agent directory via the `devteam_state` tool) wins for the current job. OKF `Feature Spec` concepts are the git-reviewed mirror.

**Format:** YAML frontmatter with required `type`; cite repo paths in `sources` and footnotes. Full rules: pi-dev-team `project-knowledge` skill during `/devteam` runs, or [OKF v0.2](https://github.com/GoogleCloudPlatform/knowledge-catalog/blob/main/okf/SPEC.md).

Configure the bundle in `.pi/devteam.json` (`knowledge.path`, `knowledge.enabled`, `knowledge.bootstrap`). See [KNOWLEDGE.md](https://github.com/W4775/pi-dev-team/blob/main/KNOWLEDGE.md) in the plugin repo.

## Progressive disclosure

Do not grow this file with style guides or path maps — those belong in OKF concepts or nested docs. In monorepos, add package-level `AGENTS.md` files only for conventions that differ from the root.
