---
description: Start a new theShow film. Same recipe as /theshow — configure, board, contract, then render.
argument-hint: <what the film is about>
---

The user wants a new film. Arguments: $ARGUMENTS

Follow the same recipe as `/theshow`. This is not a second pipeline.

1. Call `configure_film` with `scene` pre-filled from the arguments above if they describe the film, and no `prompt`. The command loads these instructions. It does not open the form by itself. You then call `configure_film`.
2. When the card comes back, show the sent continuity, the stored negative, any lint hits, and the quote for the selected resolution and seconds. If it was cancelled or empty, stop. Never invent an answer the user did not give.
3. Pass the scene, cast and reference image to `board_film` for a cost estimate only (no `confirm`). Show the still prompts, their lint hits, and the estimate, and wait.
4. On approval, call `board_film` with `confirm: true`.
5. Call `render_sequence` without `confirm`. Show the exact prompt that will be sent, lint hits, the pinned start frame, references, voice, duration, resolution, and the dollar quote.
6. Call `render_sequence` with `confirm: true` only after a separate yes. Never render without that confirm. Poll `check_sequence` until the film is finished, then report the path, duration and actual cost.

If the contract has lint hits, stop. The next take is an edit of that prompt.
