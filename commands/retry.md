---
description: Re-render one bad shot of a finished film and splice it back in.
argument-hint: <jobId> <shot number> [new prompt]
---

Repair one shot. Arguments: $ARGUMENTS

The first argument is the job id and the second is the 1-based shot number. Anything after that is
a replacement prompt; omit it to re-render the same prompt.

Call `propose_repair` first. It is free and does not render. Show the options, each with its price,
what it fixes, and what stays broken. If the user wants the single-shot retry, call `retry_shot`
without `confirm`. Show the contract for that one shot: the prompt that will be sent, the lint hits,
and the price for the selected seconds at the film's resolution. Also show the warning that the next
join becomes a cut. On approval call it again with `confirm: true` and the estimate's `costQuote` echoed
as `approvedKind`, `approvedUsd`, and `approvedFingerprint`. Do not spend the retry
automatically. A bare confirm spends and returns `unboundApproval`; do not leave the
quote off. A board approval does not authorize this render. If the prompt fails the check, the
next take is an edit of that prompt. Then report the new film path, the cost, and any warnings.
