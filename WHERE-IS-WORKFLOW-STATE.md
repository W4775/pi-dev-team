# Where is `workflow_state`?

Run state lives in the Pi / Oh My Pi agent data directory, not the installed plugin folder. It survives plugin reinstalls and stays out of the plugin cache.

## Look here

For Oh My Pi, the directory is `~/.omp/agent/devteam/`; for Pi, use `~/.pi/agent/devteam/` instead. Paths below are relative to that directory:

```text
runs/<job-id>.json                 Canonical state for each job
workflow_state.json                 Shared JSON alias of the last saved run
workflow_state.md                   Shared readable rendering of the last saved run
current.<session-id>                Current job ID for this session
runs/<job-id>/demo/                 Demo scripts and screenshots
runs/<job-id>/mockup/index.html    Mockup written by the mockup tool
```

IDs in paths are sanitized. The aliases are shared across sessions and change when any run is saved; use the per-job JSON for a specific run. `/devteam status` prints the canonical path and alias path for the current run. The mockup command's fallback path uses `<session-id>` instead of `<job-id>` when no mockup path is stored.

`/devteam list` and `/devteam continue list` show up to 50 jobs ordered by most recently updated, not creation time; `/devteam continue 1` selects the first. `/devteam clear` refuses to clear an active or locked run. Otherwise it removes the current job's state and job-keyed artifact directory, then writes an empty idle state for that job; other job state is retained. The idle state is omitted from the job list.
