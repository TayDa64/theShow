---
description: Plan a storyboard for one scene. Free, renders nothing.
argument-hint: <scene description> [shots]
---

Plan a storyboard. Arguments: $ARGUMENTS

Call `plan_storyboard` with the scene text from the arguments. If the arguments end with a number,
use that as the shot count. Return the numbered shots with their prompts and durations so the user
can edit them before anything costs money.

This spends nothing. Do not continue to `board_film` or `render_sequence` unless the user asks.
