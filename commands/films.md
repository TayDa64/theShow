---
description: List films rendered with theShow, newest first. Free.
argument-hint: [count]
---

List films. Arguments: $ARGUMENTS

Call `list_films` with the limit from the arguments if one was given, and
`includeUnfinished: true`. Show job id, state, shot count, duration, cost and file path, so the user
can pick one to continue or repair.

This is read-only and spends nothing.

To compare two or more of these films, call `check_cross_film` with their job ids. It is free,
read-only, and does not render. There is no series id. Pass the ids the user means.
