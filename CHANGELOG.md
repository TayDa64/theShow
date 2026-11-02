# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added
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
