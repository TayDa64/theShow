# Phase 1 audit

Base: `main` at `50b9eb56d479837f07f6c5c95cebac42ed70cc90`.
Read before any Phase 1 feature code. This file is the grounded map of where evidence review, cost gates, and dependency-aware repair hook in, and of what this brief already has or contradicts.

Locked split, confirmed in the tree: StoryForge Studio (`src/`, `server.ts`) is a separate visual app. Production control is the MCP server (`mcp/server.ts`) plus job files under `~/.theshow/jobs` (`JOBS_DIR` in `mcp/media.ts`). Nothing in the render, claim, or resume path imports a Grok Bot, a routine, or an observer. A film reloads from disk in `loadJobsFromDisk` / `refreshJobsFromDisk` (`mcp/server.ts`).

## Module map

### `mcp/continuity.ts` — wardrobe layers, per-location props, events

- Layer, start state, and state-image types: `WardrobeLayer` / `CharacterWardrobe` at lines 41–74. Events: `WardrobeEvent` (76–87), `PropEvent` (117–125).
- Props are location-scoped. `resolveProp` (250–267) matches an id globally and a name only inside the shot's location. An unnamed prop event is ignored (`applyPropEvent`, 383–388).
- `replayContinuity` (600–651) replays events shot by shot into `ShotContinuity`: worn checklist, props in view, prompt wording, warnings. This is the ledger diff a review can measure without looking at pixels.
- The picture stays ground truth when the worn stack matches the reference (`wardrobePrompt`, 565–572). That rule lives in `mcp/cast.ts` and must not be re-litigated here.
- Post-render vision audit is a stub. `ContinuityAuditor.auditShot` throws `CONTINUITY_AUDIT_UNIMPLEMENTED` (707–719). The comment at 663–667 forbids wiring a vision or image API because the cost is unmeasured. Phase 1 does not call it.

### `mcp/contracts.ts` — per-shot contracts, pre-render gate, stubbed auditor

- `ShotContract` (56–65): requires, at most three steps, ensures, invariants, forbidden.
- `validateContracts` (522) and `validateContractsAgainstPlan` (563) are offline. They refuse step overflow, a garment worn and hanging, invented counts, and a start state that does not match the previous shot's end.
- `decideSpend` (667–673): `confirm: false` is always `"estimate"`. `"spend"` only when confirm is true and status is `"pass"` or `"override"`. `"unchecked"` and `"fail"` are `"refused"`.
- `gateRenderSequence` (675–747): no plan and no contracts is unchecked and blocked, unless `overrideValidation` (682–689). A failed contract stays blocked unless `overrideValidation` (723–734). Override changes the validation status. It does not set confirm.
- `runPreVideoGate` (750–752) is the same function, used by `board_film`.
- `createContinuityAuditor` (760–762) returns the throwing stub unless a test injects an implementation. No image or video API is called.

### `mcp/admission.ts` — post-generation checklist

- `TakeAdmissionSchema` (34–43) is caller-supplied: objects and rooms, body ratios, vocal vs timed end. No vision call (file comment, lines 7–8).
- `reviewTake` (55–137) turns those measurements into failures.
- `acceptRenderedTake` (148–157) deletes the file via `discardTake` (139–142) when the checklist fails, so a bad take cannot be pinned. A continuity review must not call this. Review is recommend-only.

### `mcp/storyboard.ts` and `board_film`

- `STILL_USD = 0.02` (35), one constant for the quote and the fallback recorded cost.
- `planBoardFrames` (152) plans N+1 stills for N shots: one shared boundary, plus an optional midpoint.
- `findExistingStill` (322) reuses a still already on disk. `boardFilm` (382–675) prices only missing frames (447–460) and, without `confirm` or when over `maxCostUsd`, returns `estimate-only` / `over-budget` and does not call `generateStill` (497–525).
- `maxCostUsd` is a hard ceiling checked before any still is bought. It is not a mid-render abort. Keep it.
- Handler: `mcp/server.ts` `board_film` at 3463. It runs `runPreVideoGate` (3593) and `decideSpend` (3649). `confirm` does not override a failed wardrobe check (3536–3543).

### `mcp/server.ts` — the thirteen tools and every confirm path

Registered in this order. Names, required inputs, and defaults are the contract in `tests/fixtures/mcp-tool-input-schemas.json`, asserted exactly by `tests/mcp-stdio-baseline.test.ts` (220–228).

| Tool | Register | Paid? | Confirm path |
|---|---|---|---|
| `configure_film` | 714 | no | Returns a cost estimate. Renders nothing (722). |
| `create_character` | 893 | no | Writes a character record only. |
| `plan_storyboard` | 1095 | no | Builds the ledger and prompts. |
| `generate_controlled_clip` | 1428 | video | `decideSpend(confirm, gate)` at 1529. Estimate at 1562–1568. `pin` defaults to `"start"` (1461). |
| `extend_clip` | 1605 | video | No ledger, so confirm spends only with `overrideValidation` (1613–1614, 1629–1637). That override is the validation bypass, not a cost bypass: `confirm: false` still estimates. |
| `extract_last_frame` | 1765 | no | Local ffmpeg. |
| `generate_still` | 1807 | still $0.02 | `confirm !== true` returns the estimate (1875–1891) before `generateGrokStill`. |
| `assemble_film` | 1951 | no | Local ffmpeg. |
| `render_sequence` | 2920 | video | Rates at 2078–2082. Estimate return at 3224–3275. Spend only after confirm, contract gate (3200), and prompt lint (3278). `pin` defaults to `"start"` (3022). |
| `board_film` | 3463 | stills | Separate tool and separate `confirm` from `render_sequence`. |
| `retry_shot` | 3758 | one shot | Estimate at 3877–3918, including the seam caveat. Spend uses `decideSpend(true, repairGate)` (3936–3952) only after `confirm` was already required. Warnings for the downstream cut are pushed at 3998–4006. |
| `list_films` | 4059 | no | Reads disk. |
| `check_sequence` | 4115 | no | Reads one job. Polling cannot spend. |

`overrideValidation` appears on `generate_controlled_clip` (1490), `extend_clip` (1623), `render_sequence` (3001), `board_film` (3541), and `retry_shot` (3777). In every spend path it is an argument to `gateRenderSequence`, and `decideSpend` still requires `confirm`.

### `mcp/runtime.ts` — claims, locks, heartbeats, HTTP sessions

- Owner stamp: pid, token, host, `heartbeatAt` (15–20, 70–72). `jobShouldStop` (93–107) reaps only a dead owner or an expired lease.
- Job dir: `THESHOW_JOBS_DIR` or `JOBS_DIR` (41–43).
- Exclusive create: `publishExclusive` (180). Heartbeats: `startJobHeartbeat` (254). HTTP session cap: `maxSessions` (65).
- HTTP render memo (308–333) is transport-local and reports `costUsd: 0` on reuse. `retry_shot` bypasses it with `withoutHttpRenderMemo` (299). Stdio never memos.
- This module does not import the HTTP stack. New Phase 1 modules must stay the same way so the stdio bundle does not gain HTTP-only dependencies.

Job file format and reload live in `mcp/server.ts`:

- `SequenceJob` (2109–2206). Optional today: `owner`, `claim`, `revision`, `ledger`, `settings.pin`, `warnings`, `repairedFrom`, `resumedFrom`, `carriedOverUsd`.
- `persistJob` (2237–2258) writes `~/.theshow/jobs/<id>.json` through one in-process writer chain and a monotonic `revision`. A stale heartbeat cannot move a finished film back to `"running"`.
- `refreshJobsFromDisk` (2304–2327) is how the other process (stdio vs HTTP) sees the film. A running job owned by this process is not replaced by disk (2318).
- `claimFilm` / `releaseFilmClaim` (2491–2581) are the cross-process lock for resume and repair. A live owner or a live claim blocks the second writer.

There is no spend-approval record and no review record on `SequenceJob` today. `spentUsd` and per-shot `costUsd` are the only money fields, and they are actuals from `costUsdFromUsage` (`mcp/grokVideo.ts` 103–106), not estimates.

### Pricing — `mcp/grokVideo.ts`, `mcp/storyboard.ts`, `mcp/server.ts`

- Video, measured and hardcoded: `RESOLUTION_RATES` at `mcp/server.ts` 2078–2082. 480p $0.08/s, 720p $0.14/s, 1080p $0.25/s. Unknown labels fall back to 720p. The configure form prints the same rates (668–670).
- Stills: `STILL_USD` 0.02 (`mcp/storyboard.ts` 35). `generate_still` quotes that constant (1882–1886).
- Reported cost is ticks / 1e10 (`USD_TICKS_PER_DOLLAR`, `mcp/grokVideo.ts` 101–106). A missing usage block does not invent a price.

### `mcp/promptLint.ts`, `mcp/cast.ts`, `mcp/media.ts`

- `lintSentPrompt` (67–82) rejects forbidden nouns and negation before any paid call. Render and retry both refuse on hits (`mcp/server.ts` 3278, 3922). Phase 1 does not weaken this.
- `castForPicture` (`mcp/cast.ts` 60–70) drops garment words when a reference picture is present. Review classifies identity against the reference; it does not put garment adjectives back into prompts.
- `extractLastFrame` (`mcp/media.ts` 142–180) and `closingFrameAgreement` (195–227) are local ffmpeg measurements. `CLOSING_FRAME_MATCH_THRESHOLD` is 0.6 (230). These are the deterministic seam measurements a review can cite. They are not a vision API.
- `assembleClips` (280) is local. A fade of 0 is a hard cut, which is also what `retry_shot` already warns the downstream join becomes.

### `skills/theshow/` and `commands/`

- `skills/theshow/SKILL.md` tells the model the workflow: `configure_film`, then `board_film` (estimate, then `confirm`), then `render_sequence` (its own confirm), then `check_sequence`, with `retry_shot` for one bad shot. Line 12 calls the thirteen tools the whole plugin. Slash commands in `commands/` (`theshow.md`, `film.md`, `board.md`, `render.md`, `retry.md`, `check.md`, `scene.md`, `continue.md`, `character.md`, `films.md`) are the same workflow started partway in. None of them observe a bot.
- Behavior text changes only where Phase 1 adds a free review or a repair proposal. The thirteen-tool count has to stay accurate after that addition.

### Studio surfaces (`src/`)

Studio continuity is not the MCP ledger.

- `src/types.ts` 155, 186, 213, 230: `continuitySource`, `continuityNotes`, `continuityGroupId` on studio shots.
- `src/utils/storyforge.ts` keeps those notes and a continuity buffer for timing (about 715–720). It does not read `~/.theshow/jobs`.
- `src/components/ExportView.tsx` shows a studio `costUsd` and retry seed modes (`retry-same` / `retry-new`). Those seeds are not `retry_shot` and do not share job claims.

Phase 1 does not add a second orchestration path in the studio. Cost, review, and repair state stay on the MCP job. No studio screen currently shows the ledger, the contract gate, or `retry_shot` warnings.

## Tests that already cover this ground

- Ledger replay and prop scope: `tests/mcp-continuity.test.ts`.
- Contract gate, override, unchecked plan: `tests/mcp-contracts.test.ts`, `tests/contracts-invariants.property.test.ts`. `render_sequence` refusal text: `tests/mcp-sequence.test.ts` (around 389).
- Admission failures delete the take: `tests/admission.test.ts`.
- Board estimate, `maxCostUsd`, disk reuse: `tests/mcp-board.test.ts`.
- Confirm stops before any generator fetch: `tests/mcp-server.handlers.test.ts`.
- Claims, heartbeat, revision: `tests/mcp-review-fixes.test.ts`. Two processes and HTTP: `tests/mcp-multi-process.test.ts`, `tests/mcp-dual-runtime.test.ts`, `tests/mcp-http-transport.test.ts`.
- Exact thirteen-tool list and input schemas: `tests/mcp-stdio-baseline.test.ts` plus `tests/fixtures/mcp-tool-input-schemas.json`.

No test classifies a finding as Measured, Visually flagged, or Unverified. No test separates a board approval from a video approval. No test invalidates a confirm when the quote changes. No test warns on a cumulative budget. No test builds a shot-dependency graph.

## Where Phase 1 hooks

### A. Evidence review (recommend only)

New pure module, called by a new free tool `review_continuity`. Justified against an optional field on `check_sequence`: a field on a poll tool would change that tool's input schema and would mix a writer with a reader. A new tool keeps all thirteen names, defaults, and current outputs intact. The stdio baseline must grow only by that tool (and by `propose_repair` below).

The review reads, it does not render:

- Wardrobe and props at each cut from `replayContinuity` output already stored on `job.ledger.shots`, or replayed from `job.ledger`.
- Pose at the seam from frame paths on the shot (`framePath`, `lastFramePath`, the next shot's start). Measurement reuses the local method in `closingFrameAgreement` when both files exist, or an injected comparer in tests. No xAI call.
- Admission numbers already on a shot, when a caller recorded them. Those are measurements in the same sense as `mcp/admission.ts`.
- Identity against a reference path. With the vision auditor still a stub, a missing embedding is Unverified, not a guess. Byte-identical frame and reference can be Measured. Different files without an embedding are not scored as a face match.
- Lighting and time of day are Unverified unless a local luminance delta was actually computed. Frames alone are not a lighting opinion.

Classes are exactly `measured`, `visually-flagged`, and `unverified`. Every finding has evidence (method, value, artifact paths) or an abstention reason. Style notes and narrative suggestions are dropped. `plan.tier1` / tier 2 in `mcp/weighted.ts` stay on the pre-render gate; the review does not restyle them into opinions.

Results persist as optional `continuityReview: { version: 1, ... }` on the job. Old jobs omit it and still list, resume, check, retry, and assemble. The write goes through `persistJob` after `refreshJobsFromDisk`, and takes `claimFilm` when the film is idle so two processes cannot clobber a revision. A live render owner is not aborted to save a review. The other process sees the field on the next refresh once it is on the job file.

The review may attach repair options from section C. It does not call `retry_shot`, delete media, or reorder shots.

The vision auditor stays the stub. Any future paid vision path would have to be off by default and go through the cost gate. This phase does not add that path.

### B. Explicit cost gates

New pure module, used by the existing paid handlers. It does not replace `decideSpend`.

Already true, and kept:

- Board and video are different tools with different `confirm` flags. `board_film`'s confirm is not read by `render_sequence`.
- `overrideValidation` does not satisfy `confirm` (`decideSpend` checks confirm first).
- `maxCostUsd` refuses a board before spend. That is a caller ceiling, not a silent mid-flight abort. Do not remove it and do not treat it as the cumulative budget.

Not true yet:

- Nothing records that a yes was for one estimate. `confirm: true` spends the estimate computed on that call (`render_sequence` 3224 vs the spend path after 3278; `retry_shot` 3877 vs 3921). Changing resolution between two calls is a new call with a new estimate, and the boolean does not know the old one.
- Nothing sums spent plus pending against a film threshold. `spentUsd` is actuals only.

Hook, additive only:

- Optional input on each paid tool: `approvedUsd`, `approvedKind` (`board` | `video` | `still` | `extend` | `retry`), `approvedFingerprint`. Omitted means today's behavior, so existing callers and tests keep working.
- When those fields are present, the kind must be the kind of this call (a board quote cannot pass a video call) and the usd plus fingerprint must match the estimate computed now. A changed resolution, shot count, duration, or pin changes the fingerprint and the old yes is refused. `overrideValidation: true` does not skip that check.
- Optional `budgetUsd` stored on the job. Warning when `spentUsd` (actuals already on the job) plus the pending estimate crosses it. The warning is returned beside the estimate or the started job. It never sets `confirm`, never flips `decideSpend` to spend, and is not consulted inside `runSequenceJob` after a render has started.
- Spend and quotes persist as optional `spendLedger: { version: 1 }` on the same job file, updated under the same claim and revision rules, so a restarted process and the other transport see the same actuals and the same warning.

### C. Dependency-aware repair

Built from fields the job already stores after a real run, not from a plan the model wishes:

- `settings.pin` (`start` or `both`).
- Each shot's `framePath` (extracted last frame, the next shot's start when the chain ran).
- `lastFrameUrl` / `lastFramePath` when a board frame was pinned.
- `repairedFrom`, `resumedFrom`, and an extension only when a shot record says it was extended. `extend_clip` today does not write a sequence job; a dependency edge is recorded when the caller or a later job field names the source clip. Absent source means no invented edge.

Optional `dependencies: { version: 1, edges }` on the job.

`propose_repair` is a second free tool. It returns least-cost options for one bad shot:

- Retry that shot only and accept the hard cut `retry_shot` already warns about.
- Retry that shot and the downstream shots whose start was seeded by it.
- Re-board the shared boundary still ($0.02) and re-render the shots that used it.
- Accept with a note. Cost 0. Renders nothing.

Each option carries cost (same rate table), what it fixes, and what stays broken. The tool persists `repairProposal: { version: 1 }` and does not call a generator. Running a strategy still goes through `retry_shot` or `render_sequence` and their confirm gates. Existing `retry_shot` with no strategy id keeps today's one-shot render and today's seam warnings.

## Already implemented, or contradicted by the code

Follow the code where it is stricter than the brief.

1. **Separate board and video confirms already exist** as two tools. Phase 1 records the kind on the quote so a yes cannot be replayed across kinds. It does not merge the tools.
2. **`overrideValidation` already cannot spend by itself.** `decideSpend` returns `"estimate"` when confirm is false. Extend-clip's extra override requirement is the unchecked-ledger rule, not a cost waiver. Keep both.
3. **`maxCostUsd` already blocks an over-ceiling board before spend.** The brief's cumulative budget "never silently blocks" applies to the new threshold warning. It does not remove `maxCostUsd`, and it must not abort `runSequenceJob` after frames are paid for.
4. **The vision auditor is an intentional stub** (`mcp/continuity.ts` 707–719, `mcp/contracts.ts` 754–762). The brief allows a gated paid vision path. The code refuses to run one because the cost is unmeasured. Phase 1 leaves the stub unwired. No paid vision path is added.
5. **`retry_shot` already preserves downstream shots and warns that the next join is a cut** (`mcp/server.ts` 3743–3756, 3904–3913, 3998–4006). Repair options build on that. They do not change the no-strategy path.
6. **Prices in this brief match the code:** 480p $0.08/s, 720p $0.14/s, 1080p $0.25/s, still $0.02.
7. **Jobs already survive restart with no Bot.** `persistJob` plus `refreshJobsFromDisk` is the recovery path. New fields are optional on that same object. A process crash mid-review must leave either the previous job or a fully written revision, using the existing atomic write (`atomicWriteFile` in `mcp/runtime.ts` 154–159).
8. **Admission deletes failed takes.** Review must not, even when it agrees a take is bad.
9. **A bare `confirm: true` currently approves the estimate of that call.** Requiring a previously stored quote on every confirm would break the workflow and the handler tests. The invalidation rule is enforced when the caller passes the quote they approved. Omitting it stays backward compatible.
10. **Studio continuity notes are a different system.** Phase 1 does not sync them and does not require the studio server to be up.
11. **Tool-list baseline is exact.** Adding free tools or optional properties changes `tools/list`. The thirteen existing tools keep their names, required fields, and defaults (`pin: "start"`, `confirm: false`). The baseline fixture is updated only for the addition, and a test checks the old required keys and defaults still match.

## Out of scope

Narrative or style suggestions (Phase 2). Marketplace pins. Paid renders, paid stills, and paid vision calls in tests or during development. Changing ledger semantics, prompt lint, contract rules, or the configure → plan → board → gate → render → assemble → retry order.
