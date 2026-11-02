---
description: Create or update a character, with reference photos for face continuity.
argument-hint: <name> [description] [reference image path]
---

Create or update a character. Arguments: $ARGUMENTS

The first word is the character name. Anything after it is the description, and a trailing path is
a reference image. Call `create_character` with the name, description and reference images.
If the name already exists, report that the character was updated rather than created.

Then confirm the reference photo is on disk and tell the user the character is ready to name in
`board_film`'s `characters` or `generate_controlled_clip`'s `characters`.
