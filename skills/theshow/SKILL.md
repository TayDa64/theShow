---
name: theshow
description: Controlled continuity-first video generation using theShow (StoryForge) pipeline. Plan characters and storyboards, generate sequential clips with reference images, first-frame continuity, and extension, then assemble with FFmpeg. Use when the user wants multi-shot films, consistent characters, or precise cinematic control beyond single-prompt video gen.
when-to-use: controlled video, storyboard, continuity, multi-shot film, character consistency, theShow, StoryForge, Veo chaining, Grok Imagine with refs
---

# theShow Controlled Video Generation

You are driving the theShow continuity-first video pipeline. Prefer sequential multi-shot generation with explicit continuity over single long clips.

## Core Workflow

1. **Characters**  
   Call `create_character` (or update) with name, role, description, and optional reference image URLs. Store character IDs and active reference URLs.

2. **Storyboard Planning**  
   Call `plan_storyboard` with scene description, character list, target duration, and desired shot count. Receive structured shots with titles, actions, dialogue excerpts, framing, and continuity notes.

3. **Sequential Clip Generation**  
   For each shot, in order:
   - Build a detailed cinematic prompt (use `generate_shot_prompt` if available, or craft one that references characters as `<IMAGE_n>`).
   - Call `generate_controlled_clip` with:
     - prompt
     - reference_images (character portraits + scene background)
     - first_frame (last frame of previous clip, or extracted bridge frame)
     - duration (prefer 8s for Veo-style, or up to 15s for Grok Imagine)
     - model (prefer `grok-imagine-video-1.5` when available for native refs/first-frame; fallback to Veo)
   - Poll status until complete. Download or retain video URL / operation ID.
   - Optionally call `extract_last_frame` to get a clean bridge image for the next shot.

4. **Extension / Bridging**  
   Use `extend_clip` when continuing the same continuous take (video_to_extend + prompt). Use first_frame for hard scene cuts that must match exactly.

5. **Assembly**  
   Once all clips are ready, call `assemble_film` with the ordered list of clip URLs or operation IDs, trim points, and desired transitions (default 0.5s cross-fade). Return the final film download URL.

## Continuity Rules

- Always pass previous clip’s last frame as `first_frame` for the next shot when visual continuity is required.
- Reference images do **not** lock the first frame; use `first_frame` / `image` parameter for that.
- Tag references in prompts: first reference is `<IMAGE_0>`, second `<IMAGE_1>`, etc.
- Prefer 8-second shots for maximum control and chaining reliability.
- For Grok Imagine Video 1.5: up to 14 reference images + first/last/keyframes + extend.
- For classic Veo path: up to 3 refs, sequential video_to_extend.

## Authentication (read before generating anything)

`generate_controlled_clip` authenticates in this order:

1. **`XAI_API_KEY`** if set — calls go to `https://api.x.ai` and bill to xAI API credits.
2. **Grok CLI session** in `~/.grok/auth.json` — calls go to the CLI inference proxy and bill to the
   user's **Grok subscription**. No API key is needed. Sign in with `grok login --device-code`.
   The token is re-read from disk on every call, so a refresh in the CLI is picked up automatically.

Every result reports `auth` and `billedTo`, so you always know which path paid.

Treat an unresolved `${XAI_API_KEY}` placeholder as absent: the Grok CLI substitutes placeholders
literally when the variable is unset, so a naive truthiness check sends `${XAI_API_KEY}` as a bearer
token and the API answers `400 Incorrect API key`.

### `extend_clip` is API-key only

The subscription proxy answers `POST /v1/videos/extensions` with HTTP 405, so `extend_clip` reports
that plainly instead of failing obscurely. To continue a shot on the subscription path, use
`generate_controlled_clip` with `firstFrameUrl` set to the frame from `extract_last_frame`.

## Continuity chain

The reliable pattern for a multi-shot film:

1. `plan_storyboard` — returns shots with `shotType`, `cameraMove`, `continuityNotes`, a
   `focusCharacter`, and `characterContext` when the character was created first.
2. `generate_controlled_clip` for shot 1.
3. `extract_last_frame` on shot 1's `videoUrl` — returns a local `framePath` and a `dataUri`.
4. `generate_controlled_clip` for shot 2 with `firstFrameUrl` set to that `framePath` or `dataUri`.
   The first frame is pinned, so wardrobe, lighting, and framing carry across the cut.
5. Repeat 3-4 for each further shot.
6. `assemble_film` with the ordered clip URLs; it cross-fades with real FFmpeg.

`firstFrameUrl` and `referenceImageUrls` accept a public https URL, a data URI, or a local path.
Local paths are inlined as data URIs, so the chain works without any upload step. A **video** URL is
not valid as `firstFrameUrl`; run `extract_last_frame` first.

## Error Handling

- If generation fails or hits quota, fall back to sandbox/mock mode if the tool supports it, or ask the user for a different model / shorter duration.
- Never invent completed video URLs. Always poll or wait for the tool to return a real URL or file.
- Rate limits exist on generation endpoints (typically 10/min). Space out calls.

## Advanced

- Seed locking: pass `seed` or `seedStrategy: "lock"` when the tool supports it for reproducible results.
- Timeline manifest: after generation, request a timeline summary for editing decisions.
- Hybrid: use Gemini (via theShow) for planning and Grok Imagine for the actual pixels when the user prefers native Grok video.

When the user pastes a theShow project URL or says “use theShow”, load this skill and follow the workflow above.