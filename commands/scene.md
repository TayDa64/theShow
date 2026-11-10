---
description: Plan a storyboard for one scene. Free, renders nothing.
argument-hint: <scene description> [shots]
---

Plan a storyboard. Arguments: $ARGUMENTS

Call `plan_storyboard` with the scene text from the arguments. If the arguments end with a number,
use that as the shot count. If the user named clothing changes or props in particular rooms, pass
those as `wardrobeEvents`, `locations`, `props` and `propEvents` (each prop scoped to a location
id). Return the numbered shots with their prompts, durations and continuity checklists so the user
can edit them before anything costs money.

This spends nothing. Do not continue to `board_film` or `render_sequence` unless the user asks.
