---
description: Free advice on a plan, a film, or several films. Renders nothing and spends nothing.
argument-hint: <scene, jobId, or character>
---

Advise. Arguments: $ARGUMENTS

This file is `commands/advisor.md`. Grok registers a plugin command from the filename and lowercases the slash string, so the invocation you type is `/advisor`.

Spend nothing. Do not call `board_film`, `render_sequence`, `retry_shot`, `generate_still`, `generate_controlled_clip`, `extend_clip`, `assemble_film`, or `create_character`. Do not pass `confirm`. Do not invent a character, a wardrobe, a location, or a plot the arguments did not state.

If `suggest_coverage` is not in the tool list, say the plugin is not loaded and stop.

A job id starts with `seq_`. Read the arguments and take the first case that fits:

1. Two or more job ids. Call `check_cross_film` with those ids. Show each measured difference and each abstention. There is no series id. Do not pass `persist` unless the user asked to save the report.

2. One job id, and optionally a 1-based shot number after it. Call `suggest_coverage` with that `jobId`, then `review_continuity` with that `jobId`. If a shot number is present, also call `propose_repair` for that shot and show each option's price. A price on that list is not an approval. A film with no stored shot type abstains. Do not invent a shot type from the prompt.

3. One bare word, with no job id. Call `check_cross_film` with that word as `character`. If it finds fewer than two films, say the word is not a scene and not a character with films on disk. Do not plan a film to fill the gap, and do not create the character.

4. A scene: a location or an action, not a single bare word. Call `plan_storyboard` with that text. If the arguments end with a number, use it as the shot count. Then call `suggest_coverage` on the plan. Show the numbered shots and the notes. Do not reorder beats the user described. Do not board or render.

A note that would need a new or replaced shot names `plan_storyboard`, `render_sequence`, `board_film`, or `retry_shot`. That tool still returns its own price and waits for its own approval. Do not treat the note as a quote.
