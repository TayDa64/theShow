---
description: Check a render's progress, or list recent films if no job is named.
argument-hint: [jobId]
---

Check progress. Arguments: $ARGUMENTS

If the arguments contain a job id, call `check_sequence` for it and report progress, the film path
and the actual cost so far. If the job is finished, report duration and whether it returned warnings.

With no job id, call `list_films` and show the most recent films with their state, shot count,
duration and cost.
