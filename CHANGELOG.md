# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

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
