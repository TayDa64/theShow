---
description: theShow — start a film. The model calls configure_film; this command does not open the form by itself.
argument-hint: <the film idea>
---

theShow. Arguments: $ARGUMENTS

This file is `commands/theshow.md`. Grok registers a plugin command from the filename and lowercases the slash string, so the invocation you type is `/theshow`. The skill named `theshow` also appears as `/theshow`, and the qualified form when those names collide is `/theshow:theshow`. theShow is the name to look for. A slash command loads these instructions. It does not open the form by itself. You then call `configure_film`.

If `plan_storyboard` is not in the tool list, say the plugin is not loaded and stop. Do not substitute `imagine_*` or any other pipeline.

1. Call `configure_film`. Pre-fill `scene` from the arguments when they describe the film. Do not pass `prompt`. The user sees one card. A cancelled or empty card stops the film. Never invent an answer the user did not give.
2. Show the returned contract: the sent continuity text, the stored negative (constraints and no music stay off the prompt), any lint hits, the resolution, the seconds, and the quote. The quote uses the selected rate and the selected seconds.
3. Call `board_film` with no `confirm`. Show the still prompts, their lint hits, and the $0.02 quote. A still prompt names the room, because the still has to generate it. Stills are bought only after a yes.
4. On that yes, call `board_film` with `confirm: true`.
5. Call `render_sequence` with no `confirm`. Show the contract that applies to the video: the exact prompt that will be sent, lint hits, the pinned start frame, references, voice, duration, resolution, and the dollar quote. A pinned start frame is the motion prompt, without the room.
6. Call `render_sequence` with `confirm: true` only after a separate yes. Never render without that confirm. If the contract has lint hits, stop and ask for an edit of that prompt. Do not spend a retry.

`/film` follows this same recipe. It is not a second pipeline.
