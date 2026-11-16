# Phase 2 audit

Base: `main` at `b8bcc7315d8438b8c5ba55988cab262a5cdcb90e`.
Read before any Phase 2 feature code. This file is the grounded map of where narrative suggestions and cross-film checks hook in, and of what the brief already has or contradicts.

Locked split, confirmed in the tree: StoryForge Studio (`src/`, root `server.ts`) does not read `~/.theshow`. Production control is `mcp/server.ts` plus files under `JOBS_DIR` (`mcp/media.ts`). Nothing in the render, claim, or resume path imports a Grok Bot, a routine, or an observer. Phase 2 does not change Studio.

## Module map

### Tool surface — `mcp/server.ts`

Fifteen tools, registered in this order. The line numbers match the brief.

| Tool | Register |
|---|---|
| `configure_film` | 741 |
| `create_character` | 920 |
| `plan_storyboard` | 1554 |
| `generate_controlled_clip` | 1887 |
| `extend_clip` | 2107 |
| `extract_last_frame` | 2313 |
| `generate_still` | 2355 |
| `assemble_film` | 2541 |
| `render_sequence` | 3641 |
| `board_film` | 4218 |
| `retry_shot` | 4551 |
| `list_films` | 4880 |
| `check_sequence` | 4941 |
| `review_continuity` | 5070 |
| `propose_repair` | 5160 |

`tests/mcp-stdio-baseline.test.ts` (24–38, 220) and `tests/mcp-http-transport.test.ts` (23–37, 287) compare the first 13 names with `slice`. The same tests then require the **entire** `tools/list` payload to equal `tests/fixtures/mcp-tool-input-schemas.json` (stdio line 227, HTTP line 288). That fixture is not the original 13. At this base it pins all **15** tools, including `review_continuity` (fixture line 2692) and `propose_repair` (fixture line 2831). The brief's "original 13" describes the slice, not the file.

Phase 2 keeps that fixture byte-identical. The equality assertion has to become a prefix check, with `suggest_coverage` and `check_cross_film` appended. Changing the fixture would violate the brief. Leaving the full equality in place would make an appended tool fail CI.

Names stay `suggest_coverage` and `check_cross_film`. No existing tool is a place for this: `review_continuity` ignores narrative suggestions on purpose (below), and `check_sequence` is a poll of one render.

### Story and shot metadata

- `BEAT_LADDER` (`mcp/server.ts` 448–497): six beats, `at`, `title`, `shotType`, `move`, `note`. Shot types are `wide`, `medium`, `tracking`, `close-up`, `wide`, `medium`.
- `planShots` (510–598). Caller beats replace the ladder (523–538) and are not reshaped toward it. The ladder path (550–597) picks the latest beat whose `at` is at or before the shot's position, and suffixes repeated titles. A six-shot ladder plan is therefore not the six titles in order: position 0.6 still sits on Rising Action because Complication is at 0.62. A structure check has to use that same rule.
- `resolveBeatShotType` (`mcp/beats.ts` 16–20) prefers `framing`, then `shotType`, then wide for shot 0 and medium after that. `durationFromLine` (26–30) is 2 words/second sung, 3 spoken, clamped to 4–15. `resolveBeatDuration` (32–39) prefers an explicit duration, then the line, then an even split, and clamps to 1–15.
- `plan_storyboard` beats (1576–1617) carry `title`, `action`, `note`, `locationId`, `framing` (`wide` / `medium` / `close` / `feet-close`), `shotType`, `durationSeconds` (1–15), `line` `{text, delivery}`, `steps`, `start` / `end`, `avoid`, `audio`. The description at 1618–1619 says caller beats override the ladder and must not be imposed on a story the user already described.
- Output (1724–1745): `scene`, `shotCount`, `totalDurationSeconds`, `shots`, `continuity`, optional `continuityWarnings`. The tool returns JSON and persists nothing.
- `applyShotContinuity` (1520–1527) copies `locationId` onto each planned shot from the ledger snapshot. It does **not** copy `line`. `continuity` on the output holds locations, props, events, and snapshots (1729–1737). It does not hold `spokenLines`. A suggestion tool that only received the plan JSON can see `shotType` and, when beats named rooms, `locationId`. It cannot see the spoken line unless the caller also passes `beats` or `shots`, or the film's ledger has `spokenLines`. Phase 2 does not change this output. Adding `line` or a ladder flag would change an existing tool's output.
- `render_sequence` accepts per-shot `shotType` and `locationId` (3668–3669). It does **not** accept `framing`. Adding `framing` would change the pinned input schema. `SequenceJob.shots` (2714–2745) stores `index`, `title`, `status`, `prompt`, `durationSeconds`, paths, `pinUsed`, `closingFrameAgreement`, and cost. **`shotType` and `framing` are not persisted.** The renderer max of 15 seconds is the schema (`.max(15)` at 3657 and 1586), not a separate constant.
- `locationId`, worn layers, props in view, `spokenLines`, `shotSteps`, and `tier1` live under `job.ledger` (2783–2798). `spokenLines` is `{shot, line}` with no delivery. The field name is the record that the line is spoken. `ShotContinuity` (`mcp/continuity.ts` 155–164) has `checklists` and `propsInView`. First-shot wardrobe is `ledger.shots[0].checklists[].worn[].id`.

### Cross-film data

`SequenceJob` (2699–2807):

- `settings` (2754–2768): `aspectRatio`, `resolution`, `model`, `fadeDuration`, `continuity`, `characters` (names only), audio fields, `clipAudio`, `pin`, `voiceId`, `assemble`. **`promptStyle` is not here.** It is `ledger.promptStyle` (2791). A settings check that wants prompt style has to read the ledger and say so.
- `resumedFrom` (2747), `repairedFrom` (2774), `ledger`, `continuityReview` (2800), `spendLedger` (2802), `dependencies`, `repairProposal` (2806).
- No series id, no project id, no character version, no reference hash.

Characters: `CharacterRecord` (`mcp/characters.ts` 37–58) is overwritten in place. `updatedAt` changes; nothing stores the previous record. Readers: `loadCharacter` 612, `loadCharacterSync` 628, `loadAllCharacters` 653, `listCharacters` 676. `charactersRoot()` (33–35) reads `THESHOW_CHARACTERS_DIR` per call. A job does not record which reference image it used.

`spentUsd` is on the job (2713). Queued money is only in the spend journal, read by `readQueuedFilmSpend` (1298–1313).

### Read paths and their side effects

- `refreshJobsFromDisk` (2912–2935) is not a pure read. For a disk job it adopts, it calls `reapIfOwnerGone` (2868–2879), which rewrites a `running` job whose owner is gone (`jobShouldStop`) and `persistJob`s it. It also loads every top-level `*.json` whose parsed body has an `id` (2918–2925). A cross-film report with an `id` field in `JOBS_DIR` would become a film.
- `readPersistedJob` (3207–3216) reads one `${jobId}.json` and returns it only when `job.id === jobId`. It does not reap, claim, or merge the journal.
- `JOBS_DIR` (`mcp/media.ts` 31–32) is captured when the module is first imported. A process that sets `THESHOW_JOBS_DIR` before startup, which is how the server is launched, sees that directory. Vitest's `tests/setup.ts` imports the auth store first, and that import chain loads `mcp/media.ts` before the setup file can assign the env. `tests/env-first.ts` runs before that import so in-process tests do not write `~/.theshow`. Production path resolution is unchanged.
- `readQueuedFilmSpend` (1298–1313) lists the journal and skips ids in `appliedNoteIds` (1304). It does not delete or merge. `listJournal` (1267) classifies unreadable and id-less notes as torn but the queued reader ignores that list. Phase 2 must not change `isSpendNote` or that torn handling (issue #13 N33).
- `saveJobAnnotation` (3228–3268) refreshes, claims, re-reads, patches, and `persistJob`s (2838). `persistJob` calls `applyQueuedNotes` (1377) when this process owns the job, which appends to `spendLedger.appliedNoteIds`. An advisory tool that saved through this path would change a film and its journal. Phase 2 does not (issue #13 N32 stays as it is: no pruning).
- `list_films` (4895) and `check_sequence` (4952) both call `refreshJobsFromDisk`, so they can reap. The new tools must not call them and must not call `refreshJobsFromDisk`.

### Phase 1 building blocks

- `mcp/continuityReview.ts`: `reviewContinuity` 411. Classes at 19. Topics at 22 are boundary topics only (`wardrobe`, `props`, `pose`, `lighting`, `identity`). `styleNotes` and `narrativeSuggestions` are dropped at 417–418. The tool schema says the same at 5088–5089. Phase 2 leaves that function and that schema alone. Narrative suggestions are a new tool, not a field this review starts honoring.
- Findings already require evidence or an abstention (`measured` / `flagged` / `unverified` helpers, 111–152). `mutatedPaths` is always `[]` (75–83) even when the handler later persists the review onto the job and reports `persisted` separately (5138–5152). Phase 2 uses that same envelope.
- `mcp/repairPlan.ts`: graph 94, `proposeRepair` 183. Repair quotes are the repair tool's job. Suggestions must not emit `costQuote`.
- `mcp/costGate.ts`: `quoteFingerprint` 104, `videoQuote` 108, `assessBudget` 232, `gatePaidAction` 266, `PersistedSpend` 77. `quoteGate` (`mcp/server.ts` 1102–1122) passes `budgetUsd: args.budgetUsd ?? queued?.pendingThresholdUsd` (1121). Callers such as `generate_controlled_clip` (2011) also pre-fill `budgetUsd` from `spendLedger.thresholdUsd` when the caller sent one. The queued-note arm inside `quoteGate` is what still fires when the caller omits `budgetUsd` **and** the ledger has no `thresholdUsd`. That is mutant M44. Phase 2 does not edit `quoteGate`.
- `reviewShotsFromJob` (5002). Temp frames: `.review-frames-${pid}-${hostKey()}-` at 5104, removed in `finally` (5154–5156). `sweepStaleReviewFrames` (`mcp/runtime.ts` 206–235) deletes a young directory only when the name matches that prefix, the host hash is this machine, and the pid is dead. An old directory (15 minutes) is removed regardless. `filesIdentical` (4992–5000) is sha256 of the two files. `closingFrameAgreement` (`mcp/media.ts` 224–256) is a 32×32 grayscale correlation of a clip tail against a still. `extractFirstFrame` (146–169) is local ffmpeg. Neither is a face match. There is no vision call.

### What the model is told today

`skills/theshow/SKILL.md` says the fifteen tools are the whole plugin (line 12). It documents `review_continuity` and `propose_repair` (394–397, 445–446, 532–534) as free and non-rendering. It tells the model not to invent a finding the review abstained on. `commands/check.md` points `review_continuity` at cut questions. `commands/retry.md` says to call `propose_repair` before spending. No command mentions coverage suggestions or comparing two films. Nothing tells the model to run a bot.

## What the brief already has, and what the code contradicts

Already implemented, so Phase 2 does not rebuild it:

- Evidence classes and the "no evidence, no finding" shape, on continuity review only.
- A free advisory repair quote that does not render (`propose_repair`). Suggestions must not grow a second quote.
- Read-only spend readout (`readQueuedFilmSpend`), including the applied-id filter.
- Byte-identity of two files (`filesIdentical`) and a labeled 32×32 grayscale correlation (`closingFrameAgreement`).
- Review-frame directories and a sweep that already matches the pid/host/age rule.
- `plan_storyboard` as a free planner that does not persist.

Contradictions and gaps. Safety behavior in the code wins:

1. **The schema fixture is 15 tools, and the baseline asserts the whole list.** The brief says the fixture pins the original 13 and stays byte-identical. Both are honored by keeping the file and narrowing the assertion to a prefix plus appended tools. See the tool-surface section.
2. **`promptStyle` is on the ledger, not on `settings`.** The cross-film settings check reads `ledger.promptStyle` and names that path in the evidence. It does not copy the field onto `settings`.
3. **`framing` is not an input to `render_sequence`.** New jobs may store the caller's `shotType` when `render_sequence` was given one. They do not gain a `framing` input. `suggest_coverage` still reads `framing` when a plan, a beat, or a job file already has it. Missing shot type on a film abstains with "shot type not recorded on this film". Prompt text is not a shot type.
4. **`plan_storyboard` does not record that the ladder was used, and it does not echo `line`.** Structure suggestions run only when the caller passes `usedBuiltInLadder: true` and did not pass `beats`. Caller beats are never given a ladder order. Line-length suggestions need a `line` on the call or `ledger.spokenLines` on the job. Spoken ledger lines are spoken because that is the field; a caller line with no delivery abstains instead of assuming a pace.
5. **`refreshJobsFromDisk` rewrites dead running jobs.** `check_cross_film` and `suggest_coverage` read with `readdir` and `readPersistedJob` only. They do not call `refreshJobsFromDisk`, `saveJobAnnotation`, `persistJob`, or `claimFilm`.
6. **There is no series id.** Selection is an explicit `jobIds` list of 2–20, or a character name matched against `settings.characters`. No series id is created.
7. **A character has no history, and a job has no reference snapshot.** "Character changed after this film" is the timestamp comparison only. What changed is unverified. Reference-file identity is unverified on every film that has no snapshot. This PR may store `{name, updatedAt, sha256 of each local reference}` on **new** render jobs only. Legacy jobs are not rewritten.
8. **`mutatedPaths` stays `[]`.** Opt-in `persist: true` writes one report under `THESHOW_CONSISTENCY_DIR` (default `~/.theshow/consistency/<reportId>.json`) via `atomicWriteFile`. The report's own id is `reportId`, not `id`. The directory is refused when it is `JOBS_DIR` or inside it. `persisted` and `reportPath` say where it went, the same way review reports `persisted` while `mutatedPaths` stays empty.
9. **Issue #13.** N30 and N31 are test-only and are in this PR. N28 (refusal wording in the paid clip handlers), N32 (applied note ids), and N33 (id-less journal notes) are not touched.

## Where Phase 2 hooks

- New pure module `mcp/coverageSuggestions.ts`. Each rule is a pure function with a stable id and version. `suggest_coverage` is registered after `propose_repair`. A `jobId` is loaded with `readPersistedJob` only.
- New pure module `mcp/crossFilm.ts`. `check_cross_film` is registered after `suggest_coverage`. Journal totals come from `readQueuedFilmSpend`. Character records come from `loadCharacter`. First frames use `extractFirstFrame` inside a `.review-frames-<pid>-<hostKey>-` directory that `finally` removes. Byte identity uses the existing sha256 compare. A differing pair can be scored with a new still-to-still 32×32 grayscale helper next to `closingFrameAgreement`, labeled as that method and never as a face match.
- `render_sequence`, when it actually creates a job, may add optional `shotType` on new shot entries and optional `characterSnapshots` on the new job. Estimate responses and legacy files stay as they are. Paid gates are not edited.
- Docs that state the tool count or the review/list workflow (`README.md`, `skills/theshow/SKILL.md`, `commands/`, and the install pages that repeat the count) gain the two free tools and nothing else.

Rules kept, because the fields exist on a caller plan or on a ledger once the gaps above are respected:

| Id | Kind | Needs |
|---|---|---|
| `coverage.wide-before-first-close` | coverage | `shotType` or `framing`, and `locationId` |
| `coverage.consecutive-same-shot` | coverage | `shotType` or `framing` |
| `coverage.reestablish-on-location-change` | coverage | both of the above |
| `coverage.line-shorter-than-speech` | coverage | `line.text`, delivery or a spoken ledger line, `durationSeconds` |
| `coverage.line-without-person-coverage` | coverage | `line` and a shot type |
| `structure.ladder-order` | structure | explicit `usedBuiltInLadder`, and no caller beats |
| `pacing.total-duration` | pacing | `targetDurationSeconds` and every duration |
| `pacing.shot-exceeds-renderer-max` | pacing | `durationSeconds` greater than 15 |

No example rule is dropped. Each one abstains, instead of guessing, when its field is missing. Style opinions and model-written suggestions stay out.

## Review round 1

Checked against the code after the first draft:

- An empty reference snapshot is not an identity match. Zero stored hashes abstain with "no local reference hashed".
- Shot labels are judged only after the table in `mcp/coverageSuggestions.ts`. Unknown labels and the camera moves `tracking`, `dolly`, and `pan` abstain. `medium close-up` and `MCU` are close. `extreme wide` and `EWS` are wide.
- A job file that exists but fails validation is "present but could not be parsed", with the schema reason. "Job file not on disk" stays the missing-file case.
- A settings field that is unset on any film in the set is unverified, not a measured difference against the films that recorded it.
- A character omitted from a film's first-shot checklist is unverified, not an empty worn list.
- `persist: true` lists the report path in `mutatedPaths`. The default remains an empty list.
