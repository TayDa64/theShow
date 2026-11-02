---
name: theshow
description: Controlled continuity-first video generation using theShow (StoryForge) pipeline. Plan characters and storyboards, generate sequential clips with reference images and first-frame continuity, then assemble with FFmpeg. Use when the user wants multi-shot films, consistent characters, or precise cinematic control beyond single-prompt video gen.
when-to-use: controlled video, storyboard, continuity, multi-shot film, character consistency, theShow, StoryForge, Grok Imagine with refs
---

# theShow Controlled Video Generation

You are driving the theShow continuity-first video pipeline. Prefer sequential multi-shot
generation with explicit continuity over single long clips.

**The six tools are the whole point of this plugin.** Do not substitute `imagine_*` calls, image
generation plus FFmpeg by hand, or any other route. If a tool appears unavailable, run
`grok mcp doctor` and report what it says rather than improvising a replacement pipeline.

If a user asks for theShow and your tool list has no `plan_storyboard`, stop and say the plugin
isn't loaded in this session — do not quietly build the film another way and present it as theShow.

## Step 0 — Configure before you generate. Never skip this.

**This is the single most important rule.** Generating before configuration is how you get a film
full of invented detail that the user never asked for and cannot correct without paying twice.

Ask the user for the following, grouped into one short round of questions, and show their answers
back as a config block for confirmation. Offer defaults so they can just say "yes, go".

1. **Scene** — one or two sentences. Location, time of day, weather, mood.
2. **Characters** — name, age range, build, wardrobe, distinguishing features. Anything that must
   stay identical across shots.
3. **Style** — photoreal / cinematic / animated / period / documentary, plus a colour or lighting
   direction.
4. **Shot count and duration** — how many shots, total length. Each shot is one paid render.
5. **Aspect ratio** — `16:9`, `9:16`, or `1:1`.
6. **Audio** — dialogue, diegetic sound only, or silent.
7. **Hard constraints** — what must never appear: no on-screen text, no subtitles, no logos, no
   extra people, no modern objects in a period piece.

Then render the confirmed block back to them like this before spending anything:

```
Scene:        <one line>
Characters:   <name — look, wardrobe>
Style:        <look and colour>
Shots:        2 × 8s = 16s, 16:9
Audio:        <dialogue | diegetic | silent>
Never show:   <constraints>
Estimated:    ~$1.28 (2 renders · 8s ≈ $0.64 each)
```

Only after they approve, proceed. If the user gave enough detail up front to fill every field, show
the block and ask for a single yes instead of re-asking everything.

**Never invent a character detail the user did not give.** If it matters to continuity, it goes in
the config block. If they don't care, say so explicitly instead of filling the gap silently.

## Core Workflow

1. **Characters**
   Call `create_character` with `name`, `role`, `description`, and `referenceImageUrls` if the user
   supplied portraits. Store the returned character ID.

2. **Storyboard**
   Call `plan_storyboard` with `sceneDescription`, `characters` (the names from step 1),
   `targetDurationSeconds`, and `shotCount`. It returns numbered shots with `shotType`,
   `cameraMove`, `action`, `continuityNotes`, `focusCharacter`, and `characterContext`.

   Show the storyboard to the user and get approval. This call is free and instant; a render is not.

3. **Sequential clips**
   For each shot, in order:
   - Compose the prompt from the shot's `action`, `cameraMove`, `shotType`, the confirmed style,
     and the character's stored description. Keep it specific and physical: what moves, where the
     camera is, what the light does.
   - Call `generate_controlled_clip` with the parameters listed below.
   - Report the returned `costUsd` to the user before starting the next shot.

4. **Assembly**
   Call `assemble_film` with `clips` as an array of **objects**, not strings:
   `[{ "url": "<clip path>", "title": "<shot title>" }]`, plus optional `fadeDuration` (default 0.5).

## Exact parameter names

These were wrong in earlier versions of this skill and caused silent failures. Use these:

| Purpose | Parameter | Notes |
|---|---|---|
| Reference portraits | `referenceImageUrls` | array of https URL, data URI, or local path |
| Continuity frame | `firstFrameUrl` | **image only**; a video here returns `invalid_image` |
| Length | `durationSeconds` | 1–15, default 8 |
| Shape | `aspectRatio` | `16:9`, `9:16`, `1:1` |
| Model | `model` | default `grok-imagine-video-1.5` |
| Assembly clips | `clips[].url` | objects with `url`, `title`, `trimStart`, `trimEnd` |

There is no `reference_images`, no `first_frame`, no `generate_shot_prompt`, and no `seed`
parameter. Do not call them.

## Continuity chain

1. `plan_storyboard` → shots with framing and continuity notes.
2. `generate_controlled_clip` for shot 1.
3. `extract_last_frame` on shot 1's `videoUrl` → returns `framePath` and a `dataUri`.
4. `generate_controlled_clip` for shot 2 with `firstFrameUrl` set to that `framePath`.
   The first frame is pinned, so wardrobe, lighting, and framing carry across the cut.
5. Repeat 3–4 for each further shot.
6. `assemble_film` with the ordered clip objects.

Prefer 8-second shots: long enough to read, short enough to chain reliably.

## Reducing hallucination

Unwanted invention comes from vague prompts and missing constraints, not from the tool being weak.

- Put the character's physical description in **every** prompt, not just the first. The model does
  not reliably remember across calls.
- Prefer one action per shot. Two beats in one prompt is where extra props and background figures
  appear.
- State the negative constraints literally in the prompt: "no on-screen text, no subtitles, no
  additional people."
- Keep the camera instruction concrete: "low wide angle, slow push in" beats "cinematic".
- If a shot drifts, re-render it with the previous shot's extracted frame as `firstFrameUrl`
  rather than accepting it. Tell the user it's a second charge before doing so.

## Authentication

`generate_controlled_clip` resolves a credential in this order:

1. **`XAI_API_KEY`** if genuinely set — bills to xAI API credits at `https://api.x.ai`.
2. **Grok CLI session** in `~/.grok/auth.json` — bills to the user's **Grok subscription**. This is
   the normal path; no API key needed. Sign in once with `grok login`.

Treat an unresolved `${XAI_API_KEY}` placeholder as absent: the CLI substitutes placeholders
literally, so a truthiness check sends `${XAI_API_KEY}` as a bearer token and gets
`400 Incorrect API key`.

If the token has expired, say so and tell the user to run `grok login`. Do not fall back to a
different backend, and never present a mock render as a real one.

### `extend_clip` is API-key only

The subscription proxy answers `POST /v1/videos/extensions` with HTTP 405. On a subscription,
continue a shot with `generate_controlled_clip` plus `firstFrameUrl` instead. Report this plainly
rather than retrying.

## Reporting cost

Every render returns `costUsd`. Real measured figures: 3s ≈ $0.24, 4s ≈ $0.32, 6s ≈ $0.49,
8s ≈ $0.64 — about 8 cents per second.

- Quote the **actual** returned figure, never an estimate stated as fact.
- Before the first render, give the estimate from the config block and say it is an estimate.
- After each render, report what it actually cost.
- Never invent a price. If a number isn't available, say it isn't available.

## Error Handling

- Never invent completed video URLs. Wait for a real URL or file path.
- On failure, report the tool's actual error. Do not silently switch backends or produce a
  placeholder and call it done.
- Rate limits exist on generation endpoints. Space out calls.
- If a shot comes back wrong, say what's wrong and what a re-render would cost before doing it.
