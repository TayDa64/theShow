---
name: theshow
description: Controlled continuity-first video generation using theShow (StoryForge) pipeline. Plan characters and storyboards, generate sequential clips with reference images and first-frame continuity, then assemble with FFmpeg. Use when the user wants multi-shot films, consistent characters, or precise cinematic control beyond single-prompt video gen.
when-to-use: controlled video, storyboard, continuity, multi-shot film, character consistency, theShow, StoryForge, Grok Imagine with refs
---

# theShow Controlled Video Generation

You are driving the theShow continuity-first video pipeline. Prefer sequential multi-shot
generation with explicit continuity over single long clips.

**These nine tools are the whole point of this plugin.** Do not substitute `imagine_*` calls, image
generation plus FFmpeg by hand, or any other route. If a tool appears unavailable, run
`grok mcp doctor` and report what it says rather than improvising a replacement pipeline.

If a user asks for theShow and your tool list has no `plan_storyboard`, stop and say the plugin
isn't loaded in this session — do not quietly build the film another way and present it as theShow.

## Step 0 — Configure before you generate. Never skip this.

**This is the single most important rule.** Generating before configuration is how you get a film
full of invented detail that the user never asked for and cannot correct without paying twice.

**Call `configure_film` first.** It presents every field below as one interactive form card and
returns the answers as JSON with a cost estimate. One card costs one turn; asking the same questions
conversationally costs a turn each, and turns cost real money on top of the renders. Use the form
unless the user has already answered everything in chat.

If `configure_film` comes back with `elicitationSupported: false`, the client cannot draw a form.
Then ask for the same fields in a single message, not one at a time, and show the config block:
- `action: "decline"` or `"cancel"` means the user dismissed it. Do not render. Ask what to change.
- Reuse `config` verbatim. Every blank the user left blank stays blank — see the rule below.

The fields, whether they arrive by form or by message:

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
8. **Reference images** — ask directly: "Do you have a photo of the character, or a still of the
   location, I should match?" A real reference beats any amount of description and is the single
   biggest drop in unwanted invention. Ask once, take no for an answer.

The form's reference field takes a **path or URL, not a file** — the MCP protocol has no file
upload. So when the user wants to supply an image, have them attach it in chat, or give you a public
https link.

**On a phone, this is the normal path, not a workaround.** Tell them plainly: attach the photo to
the chat, and its path can be used as-is. Do not ask them to download it, open a desktop, or host it
somewhere. A chat attachment already arrives as a readable local path, so iPhone and Android photos
work directly.

Phone photos need no preparation — HEIC and HEIF are transcoded automatically, and anything too
large is stepped down until it fits the request limit. A 12-megapixel photo comes through around
190 KB. Never tell the user to resize or convert their photo first.

Then render the confirmed block back to them like this before spending anything:

```
Scene:        <one line>
Characters:   <name — look, wardrobe>
Style:        <look and colour>
Shots:        2 × 8s = 16s, 16:9
Audio:        <dialogue | diegetic | silent>
Never show:   <constraints>
Estimated:    ~$2.24 (2 renders · 8s at 720p ≈ $1.12 each)
```

Only after they approve, proceed. If the user gave enough detail up front to fill every field, show
the block and ask for a single yes instead of re-asking everything.

**Never invent a character detail the user did not give.** If it matters to continuity, it goes in
the config block. If they don't care, say so explicitly instead of filling the gap silently.

## Reference images

The pipeline accepts three forms in `referenceImageUrls` and `firstFrameUrl`, and all three work:

- a **local file path** such as `/workspace/theshow/f1.png`, including a chat attachment or a frame
  from `extract_last_frame`
- a **public https URL**
- a **data URI** (`data:image/png;base64,...`)

Local files are read and inlined automatically, and anything over about 220 KB is re-encoded to a
smaller JPEG first, so a full-size phone photo is fine — do not downscale or convert by hand.

**Register the portrait once, then reference it by name.** Call `create_character` with
`referenceImageUrls`, and from then on pass `characters: ["Ada"]` to `generate_controlled_clip`.
The tool merges that character's images into every render, so the face stays consistent across
shots without you copying paths around. Passing an unknown name is reported back in
`unknownCharacters` rather than failing silently — check that field.

Put reference images on **every** shot, not just the first. The model does not carry memory between
calls, so a shot without the reference will drift even if the previous shot had it.

## Core Workflow

1. **Characters**
   Call `create_character` with `name`, `role`, `description`, and `referenceImageUrls` if the user
   supplied portraits or a look you both settled on. Store the returned character ID. Ask for a
   reference photo here if you have not already — it is worth one question.

2. **Storyboard**
   Call `plan_storyboard` with `sceneDescription`, `characters` (the names from step 1),
   `targetDurationSeconds`, and `shotCount`. It returns numbered shots with `shotType`,
   `cameraMove`, `action`, `continuityNotes`, `focusCharacter`, and `characterContext`.

   Show the storyboard to the user and get approval. This call is free and instant; a render is not.

3. **Sequential clips — use `render_sequence`**

   **Prefer `render_sequence` for anything longer than one shot.** It renders every shot in order,
   chains each one from the previous shot's final frame automatically, and assembles the film. That
   is the whole reason the plugin can make a real film instead of a pile of clips.

   ```
   render_sequence({
     shots: [{ prompt, durationSeconds, title }, ...],   // 1 to 12
     characters: ["Ada"],                                 // reference images auto-applied
     firstFrameUrl: "<optional anchor for shot one>",
     aspectRatio: "16:9",
     assemble: true,
   })
   ```

   Two-step, always:

   - Call it **without** `confirm`. It renders nothing and returns `estimate.totalUsd`. Show that
     figure, get a yes, and only then call again with `confirm: true`.
   - The second call returns a `jobId` and `state: "running"` straight away. A sequence takes
     minutes, well past the client's own request timeout, so **poll `check_sequence` with the jobId
     every 20 to 30 seconds** until `done` is true. Do not re-call `render_sequence` while one is
     running; that renders the whole film twice and bills twice.

   When it finishes you get `filmPath`, `fileUrl`, `spentUsd`, `filmDurationSeconds`, and
   `lastFramePath`. Report the real `spentUsd` next to the estimate you gave.

   **For a film longer than 12 shots, or longer than 15 seconds per shot, chain sequences.** Pass
   the previous run's `lastFramePath` as `firstFrameUrl` to the next run. Continuity holds across the
   join: measured against the first frame, a five-shot chain stayed at about 0.86 correlation, and
   the drift does not compound as the chain grows. Report each sequence's cost separately.

   If the user wants manual control over one shot at a time, `generate_controlled_clip` still works:
   compose the prompt from `action`, `cameraMove`, `shotType`, the confirmed style, and the stored
   character description, then thread `firstFrameUrl` from `extract_last_frame` yourself. Report
   `costUsd` before starting the next shot.

4. **Assembly**
   `render_sequence` assembles automatically when `assemble` is true. Call `assemble_film` yourself
   only when stitching existing clips, with `clips` as an array of **objects**, not strings:
   `[{ "url": "<clip path>", "title": "<shot title>" }]`, plus optional `fadeDuration` (default 0.5).

   **What assembly does and does not do.** It normalizes mismatched resolutions and cross-fades on
   the join, so clips that came back at slightly different sizes still cut cleanly. It cannot invent
   motion that was not rendered: a slow cross-fade hides a jump in framing, but nothing makes two
   unconnected shots look continuous. Continuity comes from the frame chain, not from the fade.

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

Every render returns `costUsd`. **Price depends on resolution**, measured on real 8-second renders:

| Resolution | Output size | Per second | 8-second shot |
|---|---|---|---|
| `480p` | 848×480 | $0.08 | $0.64 |
| `720p` | 1280×720 | $0.14 | $1.12 |
| `1080p` | 1920×1088 | $0.25 | $2.00 |

The default is `720p`. Leaving resolution unset does **not** mean 480p pricing — the API returns a
soft 848×480 image for it, so the old "eight cents a second" figure was the cheapest, worst-looking
setting and quoting it made every estimate a third too low. Always name the resolution alongside a
price, and never quote a per-second rate without it.

- Quote the **actual** returned figure, never an estimate stated as fact.
- Before the first render, give the estimate from the config block and say it is an estimate.
  `configure_film` returns `estimate.totalUsd` already labelled `isEstimate: true`.
- After each render, report what it actually cost.
- Never invent a price. If a number isn't available, say it isn't available.

## Error Handling

- Never invent completed video URLs. Wait for a real URL or file path.
- On failure, report the tool's actual error. Do not silently switch backends or produce a
  placeholder and call it done.
- Rate limits exist on generation endpoints. Space out calls.
- If a shot comes back wrong, say what's wrong and what a re-render would cost before doing it.
