---
description: Re-render one bad shot of a finished film and splice it back in.
argument-hint: <jobId> <shot number> [new prompt]
---

Repair one shot. Arguments: $ARGUMENTS

The first argument is the job id and the second is the 1-based shot number. Anything after that is
a replacement prompt; omit it to re-render the same prompt.

Call `retry_shot` without `confirm` for the price of that one render. Show it, and on approval call
it again with `confirm: true`. Then report the new film path, the cost, and any warnings: the shots
after the repaired one were built from the old frame, so that join becomes a cut.
