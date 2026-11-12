# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added
- Admission control on still and clip submission. A prompt lint rejects forbidden nouns and negation before any paid call. A negative list is stored for that lint and for the post-generation checklist, and is not sent: Grok Imagine has no negative_prompt field. A Gaussian-feathered portrait cutout is written beside a character portrait and the original file is left untouched. A failed checklist (an object that changes rooms or appears from nowhere, a squashed torso, a widened body, shortened legs, or a vocal that runs past its pre-timed end) deletes the take so it cannot pin the next shot. `imageOrder: "plate-first"` puts the room first when placing a person into a set. The default remains portrait-first.
- Per-shot state-file contracts derived from the continuity ledger: requires, atomic steps,
  ensures, invariants, and forbidden items. A validator rejects more than three steps, a
  garment that is both worn and hanging, duplicate garment counts, footwear counts that are
  not a pair, and a shot whose start does not match the previous shot's end. `render_sequence`
  refuses to start when validation fails unless `overrideValidation` is set. Boarding can
  plan an optional middle keyframe per shot. A sample Tay coat-and-shoes montage shows the
  split plan passing and the old single-shot hang failing. The vision auditor stays a stub.
- Wardrobe layers on a character record, named clothing events (remove, put on, adjust), and a
  per-location prop ledger. `plan_storyboard` and `board_film` replay those events into each shot's
  checklist so prompts describe what is worn and the props that belong in that room. A removed
  garment is staged as a prop rather than deleted. The ledger is stored on a `render_sequence` job.
  A post-render vision audit is defined but not implemented; its cost has not been measured.
- `lastFrameUrl` on clip generation and per shot in `render_sequence`. With `firstFrameUrl` as well a
  shot is bookended: the model has to arrive at a chosen frame, so a cut between two shots lands on
  identical pixels instead of two near-misses. Measured on real renders, a bookended shot landed its
  opening frame at 0.998 correlation against the supplied image and its closing frame at 0.87.
- `generate_still`: one Grok Imagine image for about $0.02, returned as a URL, a local path and the
  exact cost billed.
- `board_film`: stills-first boarding. Generates one still per shot boundary (N shots, N+1 stills),
  reports the cost before spending, honours an optional `maxCostUsd` ceiling, reuses stills already
  on disk, and returns shots ready to paste into `render_sequence`.
- Tests for all of the above, including the body-size budgeting that keeps a bookend inside the
  proxy's request limit.

### Changed
- Studio `POST /api/generate-shot-video` on Grok sends an affirmative motion prompt. Veo still uses `buildShotPrompt` and `negativePrompt`. The old don'ts are stored as the Grok negative and stay off the request. Studio Grok calls send `resolution`, using 720p when the caller left it unset and keeping an explicit 480p. A pinned start frame stays in `image`. A separate person portrait may be sent as a feathered cutout in `reference_images`. Optional `voiceId` is sent as `reference_audios`, and an explicit track duration sizes that clip. Shots without a voice keep their duration. Last-frame chaining stays the film path for a subscription session and for an API key. The 405 on `POST /v1/videos/extensions` was the subscription proxy, not the API spec.
- An `auth.x.ai` session refreshes at `https://auth.x.ai/oauth2/token`. `GROK_OAUTH_TOKEN_URL` still overrides that. Refresh stays opt-in via `THESHOW_REFRESH_GROK_SESSION`.
- Board and hero still prompts say what the frame holds. The picture-preservation rule stays; the sent text no longer uses negation.
- Stored wardrobe `closure` is read from `character.json` and applied. The previous release dropped it, so an existing character that already stored `open`, `slip-on`, or `none` now skips an `unbuttons` step and is checked against that closure. A layer with no `closure` is unchanged.
- A bookend budgets its two frames together (75 KB each, ~200 KB of base64 for the pair) instead of
  hitting the request body limit at ~590 KB. A single inlined image keeps the original 220 KB budget,
  so phone photos behave exactly as before.
- `render_sequence` prefers a shot's own `firstFrameUrl` over chaining from the previous shot, so a
  boarded frame is not quietly replaced by a near-miss. With no per-shot frames, behaviour is
  unchanged.
- `extend_clip` remains API-key only; the subscription proxy does not expose extensions.

## [1.1.0] - 2026-06-02

### Added
- World-class film pipeline server helpers for storage validation, Veo chaining, Gemini prompt direction, and FFmpeg-based film assembly.
- New API routes for generating shot prompts, extending clips, extracting bridge frames, assembling films, and downloading rendered MP4 exports.
- Vitest coverage for rate limiting, FFmpeg assembly, Veo chaining, storage validation, and film assembly routes.
- Dedicated server TypeScript config, ESLint configuration, and CI workflow jobs for typecheck, lint, build, and focused test suites.

### Changed
- Renamed the package to `the-show` and added dedicated `lint`, `typecheck`, and `test` scripts.
- Tightened upload validation to PNG, JPEG, and WEBP files with UUID filenames and date-partitioned storage.
- Updated ExportView to support cancellation-aware polling, stop-on-failure sequencing, server-side frame extraction, and full-film assembly/download actions.
- Updated App cloud sync to merge by timestamp, persist `sf_updatedAt`, and show reactive sync status badges.

### Fixed
- Ensured continuity bridge frames are passed through the `first_frame` extension parameter instead of `reference_images[0]`.
- Removed LiveLink-only export affordances and file-format dropdowns in favor of server-backed video export flow.
