---
name: theshow
description: Controlled continuity-first video generation using theShow (StoryForge) pipeline. Plan characters and storyboards, generate sequential clips with reference images and first-frame continuity, then assemble with FFmpeg. Use when the user wants multi-shot films, consistent characters, or precise cinematic control beyond single-prompt video gen.
when-to-use: controlled video, storyboard, continuity, multi-shot film, character consistency, theShow, StoryForge, Grok Imagine with refs
---

# theShow Controlled Video Generation

You are driving the theShow continuity-first video pipeline. Prefer sequential multi-shot
generation with explicit continuity over single long clips.

**These thirteen tools are the whole point of this plugin.** Do not substitute `imagine_*` calls, image
generation plus FFmpeg by hand, or any other route. If a tool appears unavailable, run
`grok mcp doctor` and report what it says rather than improvising a replacement pipeline.

If a user asks for theShow and your tool list has no `plan_storyboard`, stop and say the plugin
isn't loaded in this session — do not quietly build the film another way and present it as theShow.

In a new chat, if the user says "theShow" or "the show" and wants a film, start this same workflow
at `configure_film`. Do not substitute `imagine_*` or any other pipeline. If the plugin's tools are
not loaded, say so and stop.

`/theshow` is the primary start. The command file is `commands/theshow.md`. Grok registers plugin
commands from the filename and lowercases the slash string, so the invocation you type is
`/theshow`. The skill named `theshow` also appears as `/theshow`, and the qualified form when those
names collide is `/theshow:theshow`. theShow is the name to look for. A slash command loads these
instructions. It does not open the form by itself. You then call `configure_film`. `/film` follows
this same recipe. It is not a second pipeline.

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
Constraints:  stored off the prompt
Estimated:    <count> × <seconds>s at $<rate>/s for <resolution> = $<total>
```

Only after they approve, proceed. If the user gave enough detail up front to fill every field, show
the block and ask for a single yes instead of re-asking everything.

### Step 0.5 — Board the film as stills before rendering it

Between the approved config and the first paid render there is a much cheaper checkpoint:
**`board_film`**. It generates one still per shot boundary, so the user sees the film as pictures
before any video is bought.

A still is **$0.02**. A second of 720p video is $0.14. A three-shot film boards as four stills for
eight cents and renders for roughly $3.36, so the board is about 2% of the cost and catches the
things that are expensive to fix later: wrong wardrobe, wrong light, a face that is not the user's
character, a location that reads nothing like what they described.

- N shots produce **N+1 stills**, not 2N. The boundary between two shots is one picture used as both
  the first shot's last frame and the second's first frame, which is what makes the cut exact.
- It is **two-step**, like every other spending tool: call without `confirm` for the estimate, show
  it, then call again with `confirm: true`.
- Pass `maxCostUsd` when you want a hard ceiling. Over it, the tool spends **nothing** and reports
  the figure.
- A re-run is free for anything already on disk, so an interrupted board resumes instead of
  re-buying. Stills are named from their own prompt for exactly this reason.
- It returns `shots`, already carrying `firstFrameUrl` and `lastFrameUrl`. Paste that straight into
  `render_sequence`.

Offer the board. Do not force it: a user who just wants one 8-second clip should not be walked
through a storyboard. But for anything over about three shots, the arithmetic is worth saying out
loud once, plainly, and letting them choose.

**Never invent a character detail the user did not give.** If it matters to continuity, it goes in
the config block. If they don't care, say so explicitly instead of filling the gap silently.

## Slash commands

The plugin ships ten commands, and each one is this same workflow started partway in. When a user
types one, honour what it names and skip the step they already took. None of them skips the
estimate. `/theshow` is the primary start. `/film` follows that same recipe.

| Command | What it does |
|---|---|
| `/theshow <idea>` | Primary start. configure_film, then the board, then the render contract, then render |
| `/film <idea>` | The same recipe as `/theshow` |
| `/scene <scene> [shots]` | Plans a storyboard only. Free, renders nothing |
| `/character <name> [look] [photo]` | Creates or updates a character with reference photos |
| `/board <scene or jobId>` | Boards a film as stills, about two cents a frame |
| `/render <shots.json>` | Renders a planned shot list |
| `/check [jobId]` | Progress and real cost on a render, or recent films |
| `/retry <jobId> <shot> [prompt]` | Re-renders one bad shot and splices it back |
| `/films [count]` | Lists films on disk. Free |
| `/continue <jobId> <what next>` | Continues an existing film with more shots |

None of them skips the estimate. A command that spends money still calls its tool without `confirm`,
shows the contract that applies to it, and waits. `/board` shows the still prompts, their lint hits,
and the $0.02 quote. `/render` and `/continue` show the composed prompt, lint hits, the pinned start
frame, references, voice, duration, resolution, and the quote. `/retry` shows that one shot's sent
prompt, its lint hits, its price, and the warning that the next join becomes a cut. A lint hit
means the next take is an edit of that prompt. Do not spend it automatically.

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

   When a character wears more than one layer, store them as `wardrobe.layers` (id, item, order from
   inner to outer, and `inReference`: visible, partial, or hidden) plus `wardrobe.startState.worn`.
   Put identity — face, hair, skin — in `appearance`, not in the same sentence as the coat. A later
   state that has its own photo, such as the coat off, goes in `wardrobe.stateImages`. Older files
   that only have `description` still work.

2. **Storyboard**
   Call `plan_storyboard` with `sceneDescription`, `characters` (the names from step 1),
   `targetDurationSeconds`, and `shotCount`. It returns numbered shots with `shotType`,
   `cameraMove`, `action`, `continuityNotes`, `focusCharacter`, and `characterContext`.

   If clothing or objects will move, pass `wardrobeEvents`, `props`, `locations`, and `propEvents`
   (or put `locationId` and those events on each beat). Each prop has its own `locationId`, so two
   hangers in two rooms stay two hangers. The tool replays the events into a checklist and folds
   that wording into each shot's `action`. A removed garment becomes a prop at its destination
   rather than disappearing. If the layer that becomes outermost was only partial or hidden in the
   reference photo, and no state photo exists, the shot carries a warning that the model will have
   to guess its appearance.

   Show the storyboard to the user and get approval. This call is free and instant; a render is not.

3. **Board it — `board_film`**

   Optional but strongly preferred past three shots. Pass the storyboard's shots (its `action` field
   is accepted directly), plus `cast`, `look` set to `configure_film`'s `continuityBlock`, and
   `characters`.

   ```
   board_film({
     shots: [{ prompt, title, durationSeconds }, ...],  // or plan_storyboard's shots as-is
     cast: "one man, grey beard, dark flat cap, black double-breasted coat, brass-tipped pole",
     look: "<configure_film's continuityBlock>",
     characters: ["Ada"],
     aspectRatio: "16:9",
     maxCostUsd: 0.50,      // optional hard ceiling
     confirm: false,        // estimate first, always
   })
   ```

   **Always pass `cast`, and always look at the stills before approving.** This is the one step where
   a bad board is cheap to catch and expensive to miss.

   `cast` must match the reference photo, not describe what you would like to see. Write down what the
   photo actually shows — outer layer included. A measured board whose cast line said "navy blazer"
   while the portrait showed a tan sherpa coat produced a different jacket in three of five frames;
   the prompt was arguing with the picture. Once the line described the coat that is in the photo, the
   same board held it in all five.

   **A reference photo outranks the prompt.** The board sends a base picture on the edit route, where
   the picture is the subject rather than a hint: the prompt's job is to change the pose and the action
   and to leave the rest alone. A shot that genuinely wants different clothing has to say so by name
   ("he has taken the coat off"); otherwise the board keeps what the photo shows. Do not pad the cast
   with details the photo contradicts.

   **Do not list a garment you cannot see — until a named change makes it the outer layer.** A
   second outer layer buried under the first is the one detail that reliably leaks: a measured cast
   line ended "…under a tan sherpa-collar jacket with a dark navy blazer beneath it", the coat
   survived, and the model spent a whole shot promoting the blazer and turning the coat into a
   sleeveless vest around thirteen seconds in. While the photo still matches the worn stack, describe
   the layer that is actually visible and stop there. After a named change, use the checklist: name
   what is worn now, and treat the removed garment as a prop in the room.

   **Look at the stills yourself; nothing measures the garment for you.** A colour check was built
   and removed. It learned the coat's colour from the hero frame's arms, the hero is cropped at the
   chest, so it had no sleeves to learn from and quietly abstained on all five frames of a real
   board. Detecting a face to anchor the measurement works, but needs OpenCV and model files, and
   this plugin ships neither. What actually holds the wardrobe is `mcp/cast.ts` refusing to let the
   prompt name a garment the picture contradicts, the layer checklist after a named change, plus
   your own eyes on a board that costs pennies against a render that costs dollars.

   There is a stub for a post-render audit that would compare sampled frames to the prop ledger.
   It is not implemented and must not be called: it would need a vision pass, and the cost of that
   pass per shot has not been measured.

   `cast` is a physical description, not a name — a name means nothing to the image model.

   Show the stills and the cost. On approval, call again with `confirm: true`. The returned `shots`
   have both frames filled in and consecutive shots share a boundary frame.

   **Pass `characters`, including a Location.** When the cast includes a character whose role is
   Location, its first photo becomes the base every frame is edited from, and the board spends one
   extra still (two cents) building a hero frame of the cast inside that location first. That hero
   frame is what holds both a real face and a recognisable room: measured skyline agreement across a
   five-frame board was 0.72 by that route, against 0.57 editing from the location alone, 0.36
   chaining, and 0.25 when a portrait rode along as a second reference. Without a Location the board
   falls back to chaining.

   **Pin default is start.** Closing frames are not sent unless `pin` is `both`. A start-only pin
   keeps the opening picture in `image`. The prompt the user reads for that shot is the motion
   prompt, without the room. Pinning both ends is opt-in. Measured on real renders, a shot sent with
   a first and last frame landed its opening frame at **0.998** against the supplied image and its
   closing frame at **0.87** (lower only because the last rendered frame carries motion blur). That
   measurement is what `pin: "both"` does. It is not the default.

4. **Sequential clips — use `render_sequence`**

   **Prefer `render_sequence` for anything longer than one shot.** It renders every shot in order,
   chains each one from the previous shot's final frame automatically, and assembles the film. That
   is the whole reason the plugin can make a real film instead of a pile of clips.

   ```
   render_sequence({
     shots: [{ prompt, durationSeconds, title, firstFrameUrl, lastFrameUrl }, ...], // 1 to 12
     characters: ["Ada"],                                 // reference images auto-applied
     continuity: "<configure_film's continuityBlock>",    // prepended to every shot
     firstFrameUrl: "<optional anchor for shot one>",
     aspectRatio: "16:9",
     assemble: true,
   })
   ```

   **A shot may carry its own `firstFrameUrl` and `lastFrameUrl`.** That is how a boarded film
   renders: paste `board_film`'s `shots` in unchanged. An explicit frame beats chaining, because the
   frame on the board is the one the user actually approved; chaining over it would quietly swap in a
   near-miss. With no per-shot frames anywhere the behaviour is exactly as before — every shot chains
   from the previous shot's extracted last frame.

   **Pass `continuity`.** `configure_film` returns a `continuityBlock` built from the confirmed
   config: style, cast, audio, and the never-show constraints, phrased as one sentence. It is
   prepended to every shot prompt inside `render_sequence`, so set, wardrobe and light survive the
   whole film without you repeating them in twelve prompts and without the model forgetting one.
   The per-shot `prompt` then only has to say what happens and how it is framed.

   Two-step, always:

   - Call it **without** `confirm`. It renders nothing and returns `estimate.totalUsd`. Show that
     figure, get a yes, and only then call again with `confirm: true`.
   - The second call returns a `jobId` and `state: "running"` straight away. A sequence takes
     minutes, well past the client's own request timeout, so **poll `check_sequence` with the jobId
     every 20 to 30 seconds** until `done` is true. Do not re-call `render_sequence` while one is
     running; that renders the whole film twice and bills twice.

   When it finishes you get `filmPath`, `fileUrl`, `spentUsd`, `filmDurationSeconds`, and
   `lastFramePath`. Report the real `spentUsd` next to the estimate you gave.

   **For a film longer than 12 shots, continue the same job.** Call `render_sequence` again with
   `resumeFromJobId` set to the finished job's id and **only the new shots**. The earlier shots are
   reused rather than re-rendered (they cost nothing more), the first new shot chains from that
   film's last frame, and the assembly covers the whole film, not just the new tail. The result
   splits `spentUsd` (this run) from `filmTotalUsd` (the film so far), so report both.

   ```
   render_sequence({ resumeFromJobId: "seq_...", shots: [ ...new shots only... ], confirm: true })
   ```

   Films survive a restart: every job is written to disk as it renders, into `~/.theshow/jobs`, and
   reloaded at startup along with the footage in `~/.theshow/media`. So a film can be continued,
   repaired or re-assembled days later. `list_films` shows what exists, with each film's job id, shot
   count, cost and file.

   A film that was mid-render when the server stopped comes back as `state: "stopped"` with an error
   saying so. Every shot it had already finished is still there and still paid for; assemble them, or
   continue from the last one.

   Continuity holds across the join: measured against the first frame, a five-shot chain stayed at
   about 0.86 correlation and the drift does not compound as the chain grows. Nothing here caps the
   length of a film except patience and budget; a 12-shot run at 8 seconds is 96 seconds, and two
   continued runs already pass three minutes.

   If the user wants manual control over one shot at a time, `generate_controlled_clip` still works:
   compose the prompt from `action`, `cameraMove`, `shotType`, the confirmed style, and the stored
   character description, then thread `firstFrameUrl` from `extract_last_frame` yourself. Report
   `costUsd` before starting the next shot.

5. **Assembly**
   `render_sequence` assembles automatically when `assemble` is true. Call `assemble_film` yourself
   only when stitching existing clips, with `clips` as an array of **objects**, not strings:
   `[{ "url": "<clip path>", "title": "<shot title>" }]`, plus optional `fadeDuration` (default 0.5).

   **Joins default to hard cuts, and the real answer is to plan cuts, not to hide them.**

   Both join styles were reviewed frame by frame on three chained clips of the same scene, assembled
   both ways from identical footage. A cross-fade ghosts: the incoming and outgoing cobblestones do
   not align, so they double-expose and sharpness dips for the whole length of the fade. A hard cut
   keeps every texture sharp but "pops" where the texture drift is visible. The reviewer called
   neither acceptable and named the real cause: the generations drift in fine texture, so any join
   between near-identical framings shows it.

   So:
   - **Change the framing between shots.** A cut from a wide to a close-up, or a new angle, reads as
     an edit and the drift is invisible. A cut between two shots of the same subject from the same
     angle, in the same camera move, reads as a jump cut no matter how you join it. This is a
     planning rule, not an assembly setting, and it is why the storyboard varies `shotType` and
     `cameraMove` per shot. Do not write two consecutive prompts that only differ in texture.
   - **Leave `fadeDuration` at `0`** when the shot changes framing. Sharp, and the edit reads.
   - **Use a short dissolve (`0.15` to `0.3`) only** when two consecutive shots genuinely continue one
     camera move with the same framing, where a cut would pop. Accept that the fade will soften the
     image briefly; that trade is usually better than a visible jump, and it is the user's call.

   **What assembly does and does not do.** It normalises mismatched sizes, frame rates and audio, so
   clips that came back at different dimensions still join cleanly. It cannot invent motion that was
   not rendered, and it cannot remove drift that the generations introduced. Continuity comes from
   the frame chain; the join only decides how the seam is presented.

   **Music and narration.** `render_sequence` and `assemble_film` both take `audioTrackUrl`, which
   mixes a music bed or voiceover under the whole film. A track shorter than the film is refused.
   A long enough track is trimmed to the film and faded out at the end. It is mixed *under* the
   clips' own audio rather than replacing it.

   - Ask for the track and have the user attach it in chat, exactly like a reference photo; the
     attachment path goes in as-is. A public https link works too.
   - `audioTrackVolume` defaults to `0.25`, which sits under dialogue. Raise it for a music-led
     piece, lower it under a quiet scene.
   - Clips already carry their own ambient audio. Check with the user before drowning it: for a
     dialogue shot the bed should usually be much lower or absent.

   The film's length always wins. A long bed does not stretch the picture.

## Coming back to a film

Films are files, not session state. `list_films({ includeUnfinished: true })` is free and lists every
film with its job id, state, shot count, duration, cost and file path.

Use it whenever a user refers to a previous film ("the lamplighter one", "what I made yesterday")
instead of asking them for an id they will not have. Then continue it with `resumeFromJobId` or
repair a shot with `retry_shot`. Never re-render a film you can find on disk.

## Fixing one bad shot

A film is not all-or-nothing. When one shot comes back wrong, do not re-render the film.

`retry_shot({ jobId, shotIndex })` re-renders exactly that shot and splices it back in. Every other
shot is reused at no cost, and the film is re-assembled with its original resolution, joins and
audio. It is two-step like everything else: call without `confirm` for the price of the one render,
show it, then call again with `confirm: true`.

```
retry_shot({ jobId: "seq_...", shotIndex: 3 })                  // same prompt, a better roll
retry_shot({ jobId: "seq_...", shotIndex: 3, prompt: "<new>" }) // the prompt was wrong
```

**Tell the user the caveat, every time, in your own words.** The shots after a repaired one were
chained from the *original* shot's last frame, so that next join becomes a cut rather than a
continuation. The tool reports this in `warnings`; repeat it rather than burying it. If the user
cares about that seam, repair the following shots too.

The tool also reports `filmSpentIncludingReplacedUsd` beside `filmTotalUsd`. The difference is money
already spent and thrown away, which is worth saying out loud once, plainly, without apologising for
it repeatedly.

Re-render a shot when: the action did not happen, a face drifted off the reference, an unwanted
object or extra person appeared, or the framing ignores the storyboard. Do not re-render for taste;
say what is wrong and what another roll would cost, and let the user decide.

## Exact parameter names

These were wrong in earlier versions of this skill and caused silent failures. Use these:

| Purpose | Parameter | Notes |
|---|---|---|
| Reference portraits | `referenceImageUrls` | array of https URL, data URI, or local path |
| Continuity frame | `firstFrameUrl` | **image only**; a video here returns `invalid_image` |
| Bookend closing frame | `lastFrameUrl` | pins the last rendered frame; with `firstFrameUrl` the shot is bookended |
| Board a film | `board_film` | `shots`, `cast`, `look`, `characters`, `maxCostUsd`; $0.02 a still, reusable |
| One still | `generate_still` | `prompt`, `aspectRatio`, `referenceImageUrls`, `characters`; $0.02 |
| Length | `durationSeconds` | 1–15, default 8. **15s is the real ceiling per shot** (measured: a 15s render billed $1.20 at 480p) |
| Shape | `aspectRatio` | `16:9`, `9:16`, `1:1` |
| Model | `model` | default `grok-imagine-video-1.5` |
| Assembly clips | `clips[].url` | objects with `url`, `title`, `trimStart`, `trimEnd` |
| Join style | `fadeDuration` | `0` = hard cut (default). `0.15`–`0.3` only for a continued camera move |
| Continue a film | `resumeFromJobId` | a finished `render_sequence` job id; pass only the new shots |
| Music / narration | `audioTrackUrl` | mixed under the film; `audioTrackVolume` defaults to 0.25 |
| Repair one shot | `retry_shot` | `jobId` + `shotIndex`; every other shot reused free |
| Find an old film | `list_films` | free; returns job ids, costs and paths from earlier sessions |

There is no `reference_images`, no `first_frame`, no `generate_shot_prompt`, and no `seed`
parameter. Do not call them. `first_frame` deserves a note: it is silently **ignored** by the API.
A shot sent with it landed at 0.14 correlation against the supplied image, the same as an unpinned
render, which means it fails without ever saying so. The first frame is `image` on the wire, which is
what `firstFrameUrl` sends for you. The last frame is `last_frame`, which works.

## Continuity chain

**Boarded (preferred for anything past three shots):**

1. `plan_storyboard` → shots with framing and continuity notes.
2. `board_film` → one still per shot boundary. Approve the pictures.
3. `render_sequence` with the returned `shots`, which already carry both frames.

Every cut is between two uses of the same file, so the seams are exact by construction rather than
by hope.

**Manual, one clip at a time:**

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

**A still is $0.02**, measured, and it is the cheapest thing here by an order of magnitude. Board
first when the look matters: four stills for a three-shot film is eight cents against roughly $3.36
of 720p footage.

**A single shot runs to 15 seconds.** Verified: a 15-second render came back at 15 seconds and billed
$1.20 at 480p. The old 16-second ceiling was never the model's limit, it was how the calls were being
made. Nothing caps a film except patience and budget — 12 shots at 8 seconds is 96 seconds, and two
continued runs pass three minutes.

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
