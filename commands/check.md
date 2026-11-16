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

`suggest_coverage` is free. Use it when the user asks whether the plan, or a finished film, is
missing a wide shot, repeating one framing, or running long. It does not render. A film with no
stored shot type abstains. Do not invent a shot type from the prompt.

`check_cross_film` is free and read-only. Use it when the user asks whether two or more films still
match. Pass their job ids. It does not render and it does not approve a repair.
