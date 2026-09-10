# Where is `workflow_state`?

It is **not** in this plugin folder. This directory is the installed package (extensions, skills, catalog). Run notebooks are written next to the Pi / Oh My Pi **agent** data, so they survive plugin reinstalls and never pollute the plugin cache.

## Look here

Oh My Pi:

```text
~/.omp/agent/devteam/workflow_state.json
~/.omp/agent/devteam/workflow_state.md
```

Pi:

```text
~/.pi/agent/devteam/workflow_state.json
~/.pi/agent/devteam/workflow_state.md
```

Per-job copies (kept when you start a new task):

```text
~/.omp/agent/devteam/runs/<job-id>.json
~/.omp/agent/devteam/current
```

`/devteam list` and `/devteam continue list` show these jobs. `/devteam continue 1` resumes the newest. `/devteam clear` deletes only the **current** job.

Those files appear after you start a run with `/devteam <task>`. `/devteam status` prints the absolute paths.

Mockups live beside the job file:

```text
~/.omp/agent/devteam/runs/<session-id>/mockup/index.html
```
