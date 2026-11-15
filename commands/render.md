---
description: Render a planned shot list from JSON, with frame-to-frame continuity.
argument-hint: <path to shots JSON>
---

Render a shot list. Arguments: $ARGUMENTS

Read the JSON file named in the arguments and pass its shots to `render_sequence`. Call once
without `confirm`. Show the contract: the exact prompt that will be sent, lint hits, the pinned
start frame, references, voice, duration, resolution, and the dollar quote. Render only after a
separate yes. If the contract has lint hits, stop and ask for an edit of that prompt. Report the
`jobId` immediately, because a film keeps rendering after the tool call returns.

If no path was given, ask which shot list to render, or offer to board one with /board first.
