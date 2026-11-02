---
description: Start a new theShow film. Opens the configuration card, then boards and renders it.
argument-hint: <what the film is about>
---

The user wants a new film. Arguments: $ARGUMENTS

1. Call `configure_film` with `scene` pre-filled from the arguments above if they describe the
   film, and no `prompt`. The user sees one card for scene, characters, style, shots, seconds per
   shot, resolution and price, shape, audio, never-show, and an optional reference image.
2. When the card comes back, read the answers. If it was cancelled or empty, stop and say so.
   Never invent an answer the user did not give.
3. Pass the scene, cast and reference image to `board_film` for a cost estimate only
   (no `confirm`). Show the estimate and wait for approval.
4. On approval, call `board_film` with `confirm: true`, then `render_sequence` with the returned
   shots. Render in the background and report the `jobId`.
5. Poll `check_sequence` until the film is finished, then report the path, duration and actual cost.

Never render without the user's approval of the estimate first.
