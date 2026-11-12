<div align="center">

# pi-dev-team

**One command. Full team. `/devteam` plans, builds, tests, and demos.**

Plans with scouts · Builds the slice · Tests + lints · Optional live demo

[![Pi](https://img.shields.io/badge/Powered_by-Pi-7c3aed?style=flat-square)](https://pi.dev)
[![Oh My Pi](https://img.shields.io/badge/Compatible-OMP-0a0a0a?style=flat-square)](https://github.com/coder/oh-my-pi)
[![Node](https://img.shields.io/badge/Node-%3E%3D22-339933?style=flat-square&logo=nodedotjs&logoColor=white)](https://nodejs.org)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg?style=flat-square)](./LICENSE)

[Quick Start](#-quick-start) · [How it Works](#-how-it-works) · [Commands](#-commands) · [Config](#-config) · [Stack Skills](#-stack-skills)

</div>

---

## ⚡ Quick Start

```bash
# Pi
pi install https://github.com/W4775/pi-dev-team
# OMP
omp plugin install github:W4775/pi-dev-team
```

Then in any Pi/OMP session:

```text
/devteam Add a settings page for profile and notifications
```

Answer the planner's questions, review its suggestions, and let specialists implement and check the work.

> Jobs persist between sessions. Use `/devteam list` to find a previous job.

---

## 🧠 How it Works

| Step | What happens |
|------|--------------|
| **Research** | Scouts explore the project when needed. |
| **Plan** | A planner asks questions and writes a spec; a critic checks it for gaps. |
| **Design** | Optionally review a mockup for a web interface. |
| **Build** | Specialists implement the work, running independent tasks in parallel when possible. |
| **Review and test** | A reviewer checks the changes, then the team runs tests and linting. Issues can trigger fixes and another check. |
| **Demo** | Optionally watch a Playwright demo and request changes. |
| **Finish** | A commit message is drafted for you. The plugin never commits automatically. |

---

## 🎮 Commands

| Command | Does |
|---------|------|
| `/devteam <task>` | Start a new job |
| `/devteam continue` | Resume this step, or proceed past a parked cap |
| `/devteam retry [id …]` | Reopen failed work items on this job and return to implement. Omit ids to retry every failed item |
| `/devteam list` | Show saved jobs |
| `/devteam continue 2` | Jump to job #2 at its saved stage |
| `/devteam skip` | Skip this step. During implement, remaining items go to review |
| `/devteam stop` | Abort the current child / step |
| `/devteam status` | Show notebook paths |
| `/devteam mockup` | Open the HTML mockup |
| `/devteam clear` | Clear current job state and its job artifact directory |

At mockup or demo opt-in, answer **yes** or **no** in chat, or skip. `/devteam continue` resumes the current stage; `/devteam retry` reopens failed work.

Before clearing, back up needed artifacts: `/devteam clear` removes the job's artifact directory, including mockups, demo scripts, and screenshots.

<details>
<summary>Troubleshooting and recovery</summary>

- Review, test, lint, and design-critic caps park the job; continue or skip to proceed. Failed scouts retry automatically up to their cap, then park. Use `/devteam continue` to retry or `/devteam skip` to proceed without scouting.
- Plan critique requires an interactive decision. Without a picker, resume with UI or skip to keep the existing spec.
- On Windows, stopping a child terminates only the direct child; descendants may need manual cleanup.
- If a crash leaves a state `.lock` directory behind, stop all devteam processes before removing it. Lock timeouts fail closed to protect run state.
- If a run remains busy after a crash, stop all parent and child processes for that job. Back up its canonical run JSON (shown by `/devteam status`, not the workflow-state alias), remove `pipelineOwner`, set `pipelineLocked` to `false`, and use `/devteam continue <job-id>` to requeue interrupted items. Never clear ownership while any job process is alive.

See [Where is workflow state?](WHERE-IS-WORKFLOW-STATE.md) for job files and artifacts.

</details>

---

## 🎬 Demo

The demo needs a configured serve command, project-local Playwright, and an installed browser. It is best-effort: missing prerequisites or a failed demo are recorded as notes. On Linux without a display, `xvfb-run` can provide a virtual display, but it is not visible on your screen.


## ⚙️ Config

Create `.pi/devteam.json` (or `.omp/devteam.json` on OMP) — trusted projects only:

```json
{
  "skills": { "frontend": ["angular"], "backend": ["dotnet"], "database": ["postgres"] },
  "paths": { "frontend": ["src/app/**"] },
  "services": [{ "name": "api", "root": "services/api", "layer": "backend", "test": ["go test ./..."] }],
  "parallel": 3,
  "maxToolCalls": 200,
  "models": { "scout": "@smol", "reviewer": "@slow" }
}
```

- `skills` — stack skills for each kind of work; see `catalog/stacks.json` for available IDs.
- `services` — override detected services and their commands.
- `models` — choose a model for each role. Pi uses the session model.
- `parallel` — maximum number of independent specialists running at once (default 3, maximum 6).
- `maxToolCalls`, `childIdle`, `repeatToolAbort` — adjust agent limits.


---

## 🧩 Stack Skills

The plugin includes development workflow skills and can use stack-specific skills for React, Vue, Angular, .NET, Postgres, and more. Stack skills are fetched when needed.

---

## 🔒 Permissions

| Role | Can |
|------|-----|
| Planner / critics / reviewer | Read project files; do not edit application code |
| Designer | Read files and create mockups; do not edit application code |
| Implementors | Edit project files; restricted from secrets, commits, destructive Git operations, and package installs |
| Demo | Run the configured app and Playwright; write demo artifacts |

Optional per-layer `paths` globs further restrict writes.

These checks are guardrails, not a security sandbox: shell commands and project scripts can perform actions beyond the tool-level restrictions. Run only trusted projects and agents with appropriate OS permissions.

Use only trusted projects. On hosts without a working trust API, including OMP, the extension assumes the project is trusted and may launch children with `--yolo`.


---

<details>
<summary>Installation and development details</summary>

Install a local checkout with `omp plugin install /abs/path/to/pi-dev-team`, or load it in Pi with `pi -e ./src/index.ts`. Upgrade OMP with `omp plugin uninstall pi-dev-team` followed by the install command above.

To verify a checkout, run `npm test`, `npm run lint`, and `npm run fmt:check`. Development tooling requires Node `^22.18.0 || ^24.11.0 || >=26.0.0`; the extension supports Node 22+.

</details>

---

<div align="center">

MIT for pi-dev-team · See `NOTICE` for skill licenses (Matt Pocock MIT, Anthropic Apache-2.0)

*PRs welcome — keep it thin, keep it tested.*

</div>