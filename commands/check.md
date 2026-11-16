---
description: Check a render's progress, or list recent films if no job is named.
argument-hint: [jobId]
---

Check progress. Arguments: $ARGUMENTS

If the arguments contain a job id, call `check_sequence` for it and report progress, the film path
and the actual cost so far. If the job is finished, report duration and whether it returned warnings.

With no job id, call `list_films` and show the most recent films with their state, shot count,
duration and cost.

`review_continuity` reads the cuts and does not spend. Use it when the user asks whether wardrobe,
props, pose, light, or identity held across a cut. Repeat only findings that carry evidence or an
abstention. Do not re-render from that review.
