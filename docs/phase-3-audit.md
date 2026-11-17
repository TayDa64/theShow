# Phase 3 audit

Base: `main` at `f2257136b9ac60ec05fe21894527f50defa5f69f`.
Read before any Phase 3 feature code. Line numbers below were checked against that tree. Where the brief and the code disagree, this file follows the code's safety behavior and says so.

Locked split, confirmed in the tree: StoryForge Studio (`src/`, root `server.ts`) does not read `~/.theshow`. Production control is `mcp/server.ts` plus files under `JOBS_DIR` (`mcp/media.ts` 31–32, captured when that module is first imported). Nothing in the render, claim, heartbeat, or resume path imports a Grok Bot, a routine, a Page, or an observer. A missing event log cannot affect production today because no event log exists.

PR shape: one pull request. The writer, the feed, the MCP tool, the Studio endpoint, and the Pipeline section are one log format and one read model. Splitting the panel off (3a/3b) would ship the bridge without the Studio reader the brief is named for. The audit does not find a second writer or a safety conflict that forces that split.

## Job shape

`SequenceJob` is `mcp/server.ts` 2717–2838.

| Fact | Where | Confirmed |
|---|---|---|
| `state` | 2721 | `"running" \| "completed" \| "stopped" \| "failed"` |
| `owner` / `claim: JobOwner` | 2723–2725 | `JobOwner` is `mcp/runtime.ts` 15–20 (`pid`, `token`, `host`, `heartbeatAt`) |
| `revision` | 2727 | optional number; increases on every queued write |
| `shots[].status`, `shots[].costUsd` | 2735, 2737 | status is a string; cost is optional |
| `continuityReview` | 2822 | `ContinuityReview` |
| `spendLedger` | 2824 | `PersistedSpend` |
| `dependencies` | 2826 | `DependencyGraph` |
| `repairProposal` | 2828 | `RepairProposal` |

Authoritative times are only `startedAt` (2719) and `finishedAt` (2720). Confirmed absent:

- `ContinuityReview` (`mcp/continuityReview.ts` 75–83) has `version`, `findings`, optional `repairProposal`, and the three `false` flags. No timestamp.
- `RepairProposal` (`mcp/repairPlan.ts` 75–83) has `version`, `badShot`, `resolution`, `options`, and the three `false` flags. No timestamp. Each `RepairOption` (65–73) has `requiresApproval: true`.
- `SpendEntry` (`mcp/costGate.ts` 64–75) has `kind`, `usd`, and optional `estimated` / `derived` / `uncertain` / `reason`. No timestamp.

`PersistedSpend.appliedNoteIds` (`mcp/costGate.ts` 84) is the replay set. It is not a time.

## Single writer

`persistJob` (`mcp/server.ts` 2869–2897):

- Calls `applyQueuedNotes` only when `thisProcessOwns` (2871–2874).
- Takes the next `revision` (2875–2877) before the snapshot (`structuredClone` at 2878).
- Per-job chain `jobWriteChain` (2852, 2879–2894). A stale revision returns without writing (2881).
- `atomicWriteFile` of `<jobId>.json` (2883). `atomicWriteFile` (`mcp/runtime.ts` 237–244) writes `<path>.<pid>.<hostKey>.<uuid>.tmp` and `rename`s it. `hostKey` is sha256 of the hostname (166–168).
- `.claim` mirror (2884–2885): the claim JSON is written, or the claim file is unlinked when the snapshot has no claim.
- Journal note files are unlinked after that rename (2886–2887), and only the paths `applyQueuedNotes` returned.

`applyQueuedNotes` (1395–1409) merges valid notes and **deletes torn notes immediately** (1397), before the job rename. Valid note files are returned and deleted only after the rename. Phase 3 does not change that owner path. The new feed must not call it. Issue #13 N33 (do not delete torn or id-less notes) applies to the feed and to readers, not as a rewrite of this owner merge.

`persistJob` awaits the job-file chain (2896). The event append has to be queued after that chain resolves and must not be part of the promise `persistJob` returns. `trackWrite` (2895; `runtime.ts` 335–342) is how shutdown drains writes. `flushJobWrites` is 340–342. `installShutdown` is 350–359.

## Transitions that will append

There is one append site: inside `persistJob`, after the job rename and the `.claim` mirror succeed. `deriveJobEvents` decides which rows that snapshot adds. Call sites that change the snapshot:

| Transition | Where the snapshot changes | Persist |
|---|---|---|
| Create `running` (`render_sequence`) | 4103–4106 | `void persistJob` 4187 |
| Create `running` (`retry_shot`) | 4822–4826 | `void persistJob` 4863. The brief listed only the render_sequence create. This path is the same shape and the same writer. |
| Shot spend | `noteReportedSpend` 3560–3565, shot pushed 3567 | not its own persist; the next persist includes it |
| Shot progress | `completed` / `lastFramePath` 3626–3627 | `void persistJob` 3628 |
| `stopped` (render failed) | 3570–3572 | 3573 |
| `stopped` (no frame) | 3602–3604 | 3605 |
| `stopped` (admission) | 3613–3619 | 3620 |
| `completed` | 3657–3663 | 3664 |
| `failed` | 3666–3668 | 3669 |
| Reaper `stopped` | `reapIfOwnerGone` 2899–2909 | `await persistJob` 2910. **Not an append.** See below. |
| Claim commit | `commitClaimFromDisk` 3137–3143 | `await persistJob` 3143, via `claimFilm` 3158–3220 |
| Annotation (review, repair, budget on a proposal) | `saveJobAnnotation` 3259–3294 | `await persistJob` 3294, then `releaseFilmClaim` 3297 |
| `review_continuity` | writes `continuityReview` at 5175–5176 through `saveJobAnnotation` | same |
| `propose_repair` | writes `dependencies`, `repairProposal`, and optional `thresholdUsd` at 5296–5306 through `saveJobAnnotation` | same |
| Claim release | `releaseFilmClaim` 3301–3316 clears `claim` | `await persistJob` 3316. Wait for this process's pending appends **before** this call, up to 2 s. |

`mergeFromDisk` (2930–2940) is memory-only. It does not write and does not append.

## Heartbeat and reaper append nothing

`startOwnedJobHeartbeat` (2636–2648) rewrites every owned running job and every owned claim every `heartbeatMs()` (default 10 s, `runtime.ts` 50–53; floor 200). The lease is 30 s (`leaseMs` 45–48). Each beat sets `heartbeatAt` and calls `persistJob`, which bumps `revision`.

Phase 3 keeps a per-job sha256 of the canonical snapshot with `owner.heartbeatAt`, `claim.heartbeatAt`, and `revision` removed. An unchanged hash skips the event step: no log read, no append. Independently, event ids exclude those fields, so an unskipped heartbeat still yields no new id.

`jobShouldStop` (`runtime.ts` 93–107) is pure. It does not write.

`reapIfOwnerGone` (2899–2911) is not the owner. `thisProcessOwns` (1411–1416) is true only when `owner.token` and `owner.pid` match this process, or `claim.token` and `claim.pid` match. The reaper's `persistJob` therefore appends nothing. `job.stopped` for a reaped film appears on read, reconciled, with the same id `deriveJobEvents` would have used. `refreshJobsFromDisk` (2943–2966) calls the reaper at 2959 when it adopts the disk snapshot.

## Claims

- `claimPath` 2854: `<jobId>.claim` beside the job file.
- `claimFilm` 3158–3220, exclusive via `publishExclusive` (`runtime.ts` 270–302) and turn files (3012–3113).
- `commitClaimFromDisk` 3137 persists the claim.
- `saveJobAnnotation` 3259–3317 claims, patches, persists, releases.
- `releaseFilmClaim` 3301 clears the claim and persists. The hand-off wait goes at the start of this function.
- Resume claims at 4080–4096. `retry_shot` claims the original film at 4803 and releases it when the new job finishes (4884–4885).

## Spend journal

- Directory `.spend-journal/<jobId>/` (1272–1274), under `JOBS_DIR`.
- `enqueueSpendNote` (1372–1381): `.<name>.<pid>.tmp` then rename to `<ms16>-<uuid>.json`. The note has an `id`. Unchanged by Phase 3. Not copied into the event log. Readers surface it as `spend.queued`.
- `listJournal` (1285–1313) and `readQueuedFilmSpend` (1316–1331) are read-only. They move into `mcp/productionFeed.ts` with the same behavior and are imported back. Torn and id-less notes stay on disk when the feed reads them (#13 N33). The owner merge still deletes torn notes; that is existing behavior, not a new feed path.
- `noteReportedSpend` (1191–1220) appends `spendLedger.entries`.
- `rememberAppliedNote` (1358–1370) appends `appliedNoteIds`.

`spend.merged` lists at most 50 note ids and otherwise a count (#13 N32). The id is the hash of the full sorted id list, so the cap is on the payload, not on identity.

## Existing pure readers

- `filmsMatchingCharacter` (5518–5543) skips dotfiles (5527) and non-`.json`. It does not reap.
- `filmsById` (5545–5585) joins `JOBS_DIR/<id>.json` with the raw id at **5557**. That is #13 N37. Phase 3 does not change it. Every new `jobId` and log path is confined (`^[A-Za-z0-9_-]{1,128}$` plus `path.resolve` stays inside `JOBS_DIR/.events/`). `sequenceJobId` (3319–3321) produces `seq_<base36>_<base36>`, which matches. Do not reuse `filmsById`.
- Both use `jobSchema` (`mcp/crossFilm.ts` 49).
- `list_films` (4914, handler calls `refreshJobsFromDisk` at 4929) and `check_sequence` (4975, handler at 4986) are not pure.

## Tools and transports

17 `registerTool` calls, in this order:

| # | Tool | Line |
|---|---|---|
| 1 | `configure_film` | 759 |
| 2 | `create_character` | 938 |
| 3 | `plan_storyboard` | 1572 |
| 4 | `generate_controlled_clip` | 1905 |
| 5 | `extend_clip` | 2125 |
| 6 | `extract_last_frame` | 2331 |
| 7 | `generate_still` | 2373 |
| 8 | `assemble_film` | 2559 |
| 9 | `render_sequence` | 3673 |
| 10 | `board_film` | 4251 |
| 11 | `retry_shot` | 4584 |
| 12 | `list_films` | 4914 |
| 13 | `check_sequence` | 4975 |
| 14 | `review_continuity` | 5104 |
| 15 | `propose_repair` | 5194 |
| 16 | `suggest_coverage` | 5422 |
| 17 | `check_cross_film` | 5586 |

`createTheShowServer` is 155–159. The record-and-replay hook around `registerTool` is 147–152. The brief's "150–159" covers both.

`refusal` (1092–1094) returns `{ content: [{ type: "text", text }] }` and does not set `isError`. No tool sets `structuredContent`, `outputSchema`, or `annotations`. SDK 1.32.2 validates `outputSchema` only when `isError` is not set (`server/mcp.js` `validateToolOutput`: a non-error result with `outputSchema` and no `structuredContent` throws). Existing tools keep text-only results. `structuredContent` without `outputSchema` is added only on `check_sequence` and `list_films`, and it is `JSON.parse` of the existing text.

Order assertions:

- `tests/e2e-bundles.test.ts` `TOOL_ORDER` at 47; equality at 736 (the brief's 735 is the `listTools` call).
- `tests/mcp-stdio-baseline.test.ts` `TOOL_NAMES` at 24 (first 13); full name list at 228–232.
- `tests/mcp-http-transport.test.ts` `TOOL_NAMES` at 23; slice at 287; full name list at 294–298.

The pinned fixture `tests/fixtures/mcp-tool-input-schemas.json` is the 15 tools through `propose_repair`. It stays byte-identical. `production_feed` is appended after `check_cross_film`.

Transports:

- stdio: `startStdioServer` 2650–2671. Loads jobs, connects `StdioServerTransport`, starts the heartbeat, drains on shutdown.
- HTTP: `mcp/http-server.ts`. Token required (36–45). Loopback bind unless `THESHOW_HTTP_EXPOSE` (47–69). Host and Origin allowlists (145–165, 223–228). Only `/mcp` (245–251). JSON responses (225). Own `loadJobsFromDisk` and heartbeat (170–172). Phase 3 does not change `/mcp`.

`isLoopbackHost` (`runtime.ts` 137–139) is `127.0.0.1`, `localhost`, or `::1` with no brackets and no `::ffff:` prefix. The Studio feed guard must accept a peer of `127.0.0.1`, `::1`, and `::ffff:127.0.0.1`, and a Host of `127.0.0.1`, `localhost`, and `[::1]`, with any port (#13 N42). It will not change `isLoopbackHost`, because the HTTP bind check uses that function.

## Studio

Root `server.ts`:

- `PORT` 88.
- `attachAuthToRequest` 100.
- Limiters 133–159 (generation, file, auth).
- Routes 161–2771. The feed route registers with these, before `setupServer`.
- `setupServer` 2772–2785: Vite middleware, or `dist` plus SPA fallback.
- **Listens on `0.0.0.0`** (2787). The bind stays.

Cookie `storyforge_session` (`src/lib/authStore.ts` 149, set at 581–589): `httpOnly`, `sameSite: 'lax'`, `secure` when `NODE_ENV === 'production'`. `requireAuth` 1439. `requireCsrf` 1449 (GET/HEAD are exempt inside that function). The feed is GET/HEAD, no auth, so a guest Studio can read it. `THESHOW_STUDIO_FEED=0` makes the route 404.

`authFetch` is `src/context/AuthContext.tsx` 120–142. Workspace state is `localStorage` (`src/App.tsx` 162–300, keys `sf_activePopupView` and `sf_updatedAt`). The feed must not write those keys or project state.

The Pipeline popup is `ExportView` ("Pipeline Exports", `src/components/ExportView.tsx` 1409), opened from `prompt-open-pipeline` (`src/components/TimelineView.tsx` 613). There is no `aria-live` region under `src/`.

## Sweeps, reaper, and why `.events/` is outside them

Checked. Phase 3 does not change these functions.

| Function | What it touches | Why `.events/` is safe |
|---|---|---|
| `sweepOrphanTemps` (`runtime.ts` 175–204) | Top-level names in the directory it is given that end in `.tmp` | It does not recurse. The log is `JOBS_DIR/.events/<jobId>.jsonl` and uses no temp file. |
| `atomicWriteFile` (`runtime.ts` 237–239) | Sweeps `dirname(path)` of the file it writes | Job files live in `JOBS_DIR`, so the sweep is `JOBS_DIR`, not `.events`. |
| `sweepStaleReviewFrames` (`runtime.ts` 206–235) | Top-level names starting `.review-frames-` | `.events` does not match. |
| `refreshJobsFromDisk` (`server.ts` 2950–2951) | Names ending `.json` | `.events` is a directory and does not end in `.json`. `reapIfOwnerGone` runs only on those parsed jobs. |
| `filmsMatchingCharacter` (`server.ts` 5527) | Skips dotfiles and non-`.json` | Skips `.events`. |
| `loadJobsFromDisk` (2968–2971) | The two sweeps on `JOBS_DIR`, then `refreshJobsFromDisk` | Same exclusions. |

`thisProcessOwns` is 1411–1416. `releaseFilmClaim` is 3301. Grep of `unlink`, `rm`, and `writeFile` under `mcp/*.ts` shows no deletion of a `<jobId>.json` job file. Unlinks are claim files, journal notes, temp files, tombs, and review-frame directories.

The log uses no temp name, so `sweepOrphanTemps` has nothing to delete even if it were pointed at `.events`. Phase 3 does not point it there.

## Event catalogue

`deriveJobEvents(job)` is the only id source for the writer and for reconciliation. `id = "ev_" + sha256(jobId NUL type NUL discriminator)` first 32 hex chars. The id does not include `revision`, `recordedAt`, `heartbeatAt`, owner, or claim.

| Type | When | Discriminator | `data` (redacted) |
|---|---|---|---|
| `job.started` | every valid job | `started` | `{ shotCount }` |
| `shot.completed` | `shots[i].status === "completed"` | shot index + `completed` | `{ index, status }` |
| `shot.failed` | `shots[i].status === "failed"` | shot index + `failed` | `{ index, status }` |
| `job.completed` | `state === "completed"` | `completed` | `{ state }` |
| `job.stopped` | `state === "stopped"` | `stopped` | `{ state }` |
| `job.failed` | `state === "failed"` | `failed` | `{ state }` |
| `review.recorded` | `continuityReview` present | canonical hash of the review | finding counts only |
| `repair.proposed` | `repairProposal` present | canonical hash of the proposal | option `id`, `costUsd`, `requiresApproval: true` |
| `budget.set` | `spendLedger.thresholdUsd` is a number | canonical threshold | `{ thresholdUsd }` |
| `spend.recorded` | each `spendLedger.entries[i]` | entry index + canonical entry JSON | `{ index, kind, usd }` plus the boolean flags. `reason` is not copied (it is provider text). |
| `spend.merged` | `appliedNoteIds` non-empty | sorted note ids | up to 50 ids, otherwise `{ count }` |
| `log.capped` | writer only, at the cap | `capped` | `{ events, bytes }` |

`log.capped` is not derived from the job file. `spend.queued` is not derived and is not written to the log. The feed builds it from the journal at read time.

Source fields: `state`, `shotCount`, `shots[].index`, `shots[].status`, `continuityReview`, `repairProposal.options`, `spendLedger.thresholdUsd`, `spendLedger.entries`, `spendLedger.appliedNoteIds`, `startedAt`, `finishedAt`. Prompts, tokens, pids, hostnames, and absolute paths are not source fields for `data`.

Reconciled rows (derived id missing from the log) use `source: "reconciled"`, no `recordedAt`, and `at` only from `startedAt` (`job.started`) or `finishedAt` (the terminal row). Logged rows keep `source: "log"` and their `recordedAt`.

## Feed path must not reach writers

The feed module does not exist yet. This is the set it, `readProductionFeed`, `production_feed`, and `GET /api/production/feed` must not call:

`persistJob`, `atomicWriteFile`, `publishExclusive`, `unlink`, `rm`, `writeFile`, `appendFile`, `rename`, `truncate`, `refreshJobsFromDisk`, `loadJobsFromDisk`, `reapIfOwnerGone`, `claimFilm`, `saveJobAnnotation`, `releaseFilmClaim`, `applyQueuedNotes`, `enqueueSpendNote`, `noteReportedSpend`, `sweepOrphanTemps`, `sweepStaleReviewFrames`, `scheduleJobEvents` / the event writer.

Allowed reads: `readdir`, `readFile`, `JSON.parse`, zod, `jobShouldStop`, `assessBudget`, `deriveJobEvents`, `listJournal`, `readQueuedFilmSpend`.

A source grep of `mcp/productionFeed.ts` and of the Studio route will be recorded in this section after those files exist. The behavioral proof is the purity test: 50 reads leave every file's sha256, mtime, and listing unchanged.

## Tests and CI

- `playwright.config.ts` `studioEnv` (10–33) sets `PORT`, `DISABLE_HMR`, `THESHOW_VIDEO_BACKEND=sandbox`, `GROK_AUTH_FILE`, and `THESHOW_FORBID_HOME_AUTH`. It does **not** set `HOME`, `THESHOW_JOBS_DIR`, `THESHOW_OUTPUT_DIR`, or `THESHOW_CHARACTERS_DIR`. Pinning those is mandatory before the Studio server can see a jobs directory.
- `playwright/hermetic.ts` 9 is the loopback host set for the browser, not for the server.
- `tests/env-first.ts` 13–22 sets temp `THESHOW_*_DIR` before `mcp/media.ts` is imported. In-process Vitest does not write `~/.theshow`.
- CI job `e2e` (`.github/workflows/ci.yml` 81–117) is Playwright only, and it is the required check. `tests/e2e-bundles.test.ts` runs inside `npm test` (the `test` job). `all-green` needs typecheck, lint, build, test, bundle, and e2e.

## Axe

Before this change the new surface does not exist, so it has no violation count.

Existing gate: `e2e/studio-baseline.spec.ts` 44–46 asserts `result.violations` is `[]` for WCAG 2.2 AA tags (`wcag2a`, `wcag2aa`, `wcag21a`, `wcag21aa`, `wcag22aa`) at 1280 and 375, on the dev server and the built server. The Pipeline popup is one of those surfaces (97–102). After the section lands, that gate still has to be zero, including the new section. The measured after counts will be added here once Playwright has been run.

## What Phase 3 must not make worse

- Heartbeat and the reaper keep their timing and their writes. They gain no log append.
- Torn journal notes are still deleted by the owner merge. The feed adds a reader that does not delete them. That is not a new deletion.
- `filmsById` stays unconfined (#13 N37). New paths do not copy that join.
- `isLoopbackHost` stays as it is. The feed guard is a separate function.
