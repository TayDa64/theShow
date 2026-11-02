---
description: Board a film as stills before rendering. About two cents a frame.
argument-hint: <scene or shot list, or a jobId to re-board>
---

Board a film as stills. Arguments: $ARGUMENTS

If the arguments name a finished or unfinished job id, call `list_films` to find it and re-board
from its prompts. Otherwise treat the arguments as a scene and call `board_film` with no `confirm`
for the estimate first.

Show the estimate, and on approval call `board_film` with `confirm: true`. Reuse frames already on
disk. Report the frame paths and the board's actual cost. This renders no video.
