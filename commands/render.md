---
description: Render a planned shot list from JSON, with frame-to-frame continuity.
argument-hint: <path to shots JSON>
---

Render a shot list. Arguments: $ARGUMENTS

Read the JSON file named in the arguments and pass its shots to `render_sequence`. Call once
without `confirm` for the estimate, show it, and render only after the user approves. Report the
`jobId` immediately, because a film keeps rendering after the tool call returns.

If no path was given, ask which shot list to render, or offer to board one with /board first.
