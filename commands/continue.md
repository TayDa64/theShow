---
description: Continue an earlier theShow film with more shots, keeping its cast and look.
argument-hint: <jobId> <what happens next>
---

Continue a film. Arguments: $ARGUMENTS

The first argument is the job id to continue; the rest describes what happens next in the story.
Call `list_films` to confirm the job exists, then `render_sequence` with `resumeFromJobId` set to it
and new shots for the next beats. Call once without `confirm` and show the contract for the new
shots: the exact prompt, lint hits, the pinned start frame, references, voice, duration, resolution,
and the dollar quote. Render only after a separate yes. Report the new jobId.

Say plainly that this appends to the same film rather than starting a new one.
