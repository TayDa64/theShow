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

## Error Handling

- If generation fails or hits quota, fall back to sandbox/mock mode if the tool supports it, or ask the user for a different model / shorter duration.
- Never invent completed video URLs. Always poll or wait for the tool to return a real URL or file.
- Rate limits exist on generation endpoints (typically 10/min). Space out calls.

## Advanced

- Seed locking: pass `seed` or `seedStrategy: "lock"` when the tool supports it for reproducible results.
- Timeline manifest: after generation, request a timeline summary for editing decisions.
- Hybrid: use Gemini (via theShow) for planning and Grok Imagine for the actual pixels when the user prefers native Grok video.

When the user pastes a theShow project URL or says “use theShow”, load this skill and follow the workflow above.