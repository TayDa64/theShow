---
description: Continue an earlier theShow film with more shots, keeping its cast and look.
argument-hint: <jobId> <what happens next>
---

Continue a film. Arguments: $ARGUMENTS

The first argument is the job id to continue; the rest describes what happens next in the story.
Call `list_films` to confirm the job exists, then `render_sequence` with `resumeFromJobId` set to it
and new shots for the next beats. Estimate first, render after approval, and report the new jobId.

Say plainly that this appends to the same film rather than starting a new one.
