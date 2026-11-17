# Production feed

The job file under `THESHOW_JOBS_DIR` (default `~/.theshow/jobs`) stays authoritative. Phase 3 adds a best-effort history beside it. Studio, `production_feed`, and any other observer only read that history. Grok Bot pages and routines are optional readers. Nothing in production depends on them. A render, review, repair, claim, heartbeat, and reap all finish with no Bot and no Studio running.

## Log

Location: `JOBS_DIR/.events/<jobId>.jsonl`.

`jobId` must match `^[A-Za-z0-9_-]{1,128}$`, and the resolved path must stay inside `JOBS_DIR/.events/`. Any other id is skipped once and not thrown. The writer does not use `filmsById`.

One JSON object per line, newline terminated:

```json
{"v":1,"id":"ev_…","seq":1,"jobId":"seq_…","type":"job.started","revision":1,"recordedAt":1700000000000,"data":{}}
```

`recordedAt` is the writer's clock at append time. `revision` is the job revision of the snapshot and is not part of the id. `data` is a short summary. It has no prompts, tokens, pids, hostnames, or absolute paths. A line over 16 KiB is stored with `data: {"truncated": true}`.

`id` is `ev_` plus the first 32 hex chars of `sha256(jobId NUL type NUL discriminator)`. Discriminators are the shot index and status, the spend-entry index and its canonical JSON, the sorted merged note ids, a canonical hash of the review or proposal, or the terminal state alone. Ids do not include revision, recordedAt, heartbeatAt, owner, or claim. `deriveJobEvents` is the only function that defines those ids, for both the writer and reconciliation.

`seq` is 1 plus the highest valid seq in the file, read inside the owning process's per-job chain. It is not an in-memory counter. Each line is one `appendFile` (`O_APPEND`) call. `O_APPEND` line atomicity is assumed only on local filesystems, the same scope as the existing `link()` fallbacks.

## Who appends

Only `thisProcessOwns`: the running owner token and pid match, or the claim token and pid match. Heartbeats rewrite `heartbeatAt` and `revision` and append nothing. The reaper is not the owner, so it appends nothing. A reaped `job.stopped` shows up on read, reconciled, with the same id.

Before a claim is released, and after a terminal job write, the owner waits up to 2 seconds for its own appends and then continues. `persistJob` does not wait for the append. Shutdown drains it through `trackWrite`.

A failed append is logged once per job per process on stderr:

```text
theShow: event log append failed for <jobId>: <code>
```

The job file is already written. The tool result does not change. The next owned write that is not a heartbeat diffs ids again.

## Crash, cap, and exclusion

A crash before the append leaves the log behind the job file. Reconciliation fills the gap. A crash mid-line can leave a torn tail. The next append, if the file does not end in a newline, prefixes a newline and does not truncate. Readers skip the torn line and count `tornLines`. Nobody rewrites or deletes the log.

Cap: 2,000 events or 1 MiB, whichever comes first. The writer then appends one `log.capped` and stops. Later transitions are reconciled from the job file. An orphan log with no job file is ignored and not deleted. There is no rotation.

The log is outside every existing sweep and reaper, and those functions are unchanged:

- `sweepOrphanTemps` only unlinks top-level `*.tmp` in the directory it is given.
- `atomicWriteFile` sweeps only the job file's directory.
- `sweepStaleReviewFrames` only matches `.review-frames-*`.
- `refreshJobsFromDisk` and `reapIfOwnerGone` only read names ending in `.json`.
- `filmsMatchingCharacter` skips dotfiles.

## Read

`readProductionFeed` merges the log with `deriveJobEvents(job)`. A derived id missing from the log is `source: "reconciled"`, with no `recordedAt`, and `at` only from `startedAt` or `finishedAt`. Logged rows stay `source: "log"`. Queued spend notes are `source: "journal"` and `type: "spend.queued"`. Torn or id-less notes are abstentions and are not deleted. The summary (state, progress, spend, budget, review counts, repair option ids and costs, film basename, liveness) comes from the job file. Liveness uses `jobShouldStop` and does not reap.

The cursor is opaque base64url of `{v: 1, jobs: {jobId: {seq, reconciledDigest}}}`. A later read returns log events with a higher seq and reconciled or journal ids not yet delivered. A garbage or foreign cursor is a fresh read. Consumers dedupe by `id`. Duplicate seq values are reported as `seqCollisions` and are not an error.

## Studio and the tool

`GET /api/production/feed` and `HEAD` are loopback only: the peer is `127.0.0.1`, `::1`, or `::ffff:127.0.0.1`, and `Host` is `127.0.0.1`, `localhost`, or `[::1]`, with any port. Anything else is 404. `THESHOW_STUDIO_FEED=0` is 404. The response is `Cache-Control: no-store`, rate limited, with no CORS headers. Studio's bind stays `0.0.0.0`. The pipeline panel polls this route while it is open and the page is visible. It has no action buttons.

`production_feed` is tool 18, after `check_cross_film`. It is free, read-only, renders nothing, spends nothing, writes nothing, and is never required for production. It declares `outputSchema` and returns `structuredContent` plus the same JSON as text. A refused job id is `isError: true`. It does not call `refreshJobsFromDisk`.

`check_sequence` and `list_films` gain `structuredContent` equal to `JSON.parse` of their existing text. They do not gain `outputSchema`.
