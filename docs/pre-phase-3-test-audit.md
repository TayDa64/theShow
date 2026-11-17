# Pre-Phase 3 test audit

Base: `3dc941e104dd9da3991082724d1fbd06a6662566`. Line numbers below are that commit unless a later sentence says the line moved. N35 edits `mcp/server.ts` and `mcp/crossFilm.ts` in place; it does not insert lines, so the tool registration lines are unchanged.

This document was written before the new tests. The tests named here are the ones that hook into each fact.

## Studio

Confirmed. StoryForge Studio is the React 19 + Vite 6 + Tailwind 4 SPA in `src/` (`src/main.tsx`, `src/App.tsx`). Surfaces: `TimelineView`, `CharactersList` / `CharacterEditor`, `ScenesView`, `ExportView`, `CamerasView` (camera controls live in the timeline dock, not a popup), `AccountDashboard`, `AuthGate`.

`server.ts` serves it. Dev uses Vite middleware when `NODE_ENV !== 'production'` (`server.ts:2773-2778`). Production serves `dist/` and falls back to `index.html` (`server.ts:2779-2784`). `npm run dev` is `tsx server.ts`. `npm start` is `node dist/server.cjs` after `npm run build`.

There are no URL routes. One page at `/`. The primary view is the timeline (`timeline-shell`, `camera-dock`, `workspace-dock`, `prompt-dock` in `src/components/TimelineView.tsx`). Four popups, `App.tsx:114-153`: `characters` = Roster, `scenes` = Scenes, `export` = Pipeline, `account` = Account. Opened by `workspace-button-<id>`, `prompt-open-pipeline`, and `account-workspace-trigger`.

`MOBILE_WORKSPACE_ORDER` is `App.tsx:115`. Below the `lg` breakpoint a bottom `nav` renders those five entries (`App.tsx:571-586`). At 1280px that nav is hidden. At 375px it is visible. The new surface spec asserts both.

State keys match the brief: `sf_characters`, `sf_scenes`, `sf_camera`, `sf_exportSettings`, `sf_activePopupView`, `sf_updatedAt` (`App.tsx` around the state initializers, and `e2e/timeline-shell.spec.ts` seeds them). Signed-in project files go to `.storyforge/` in the working directory when not under Vitest (`src/lib/authStore.ts:143-148`). API routes run from `server.ts:161` through the sandbox save route at `server.ts:2759`, including `/api/auth/*`, `/api/generate-*`, `/api/extend-clip`, `/api/extract-frame`, `/api/assemble-film`, `/api/download-film/:filmId`, `/api/video-status`, `/api/load-sandbox-state`, `/api/save-sandbox-state`.

`index.html` title at this commit is `My Google AI Studio App`. This PR changes it to `StoryForge Studio`.

## Playwright before this PR

Confirmed. `@playwright/test` `^1.61.0` is a devDependency. `playwright.config.ts` matched `e2e/**/*.spec.ts` and `playwright/**/*.spec.ts`, chromium only, `workers: 1`, `retries: 2` in CI, webServer `npm run dev` on port 3100, `THESHOW_VIDEO_BACKEND ?? 'sandbox'` at the old line 37, and forwarded `GEMINI_API_KEY` when set (old line 41).

Specs: `e2e/timeline-shell.spec.ts` (3 UI tests, seeded `localStorage`), `playwright/lion-greeting-workflow.spec.ts` (sandbox two-clip render, assemble, MP4 download), `playwright/lion-greeting-live.spec.ts` (skipped unless `RUN_LIVE_VEO=1`). No axe package in `package.json` at this commit.

CI (`.github/workflows/ci.yml`) had `typecheck`, `lint`, `build` (with the `GEMINI_API_KEY` grep), `test` (refuses `XAI_API_KEY` / `GROK_API_KEY` / `GEMINI_API_KEY` and `~/.grok/auth.json`, sets `GROK_AUTH_FILE` and `THESHOW_FORBID_HOME_AUTH=1`), `bundle`, and `all-green`. No Playwright job.

This PR adds a second webServer (`npm run build && npm start` on port 3101, `NODE_ENV=production`) and a `studio-built` project. The sandbox pin is now the literal `SANDBOX_BACKEND = 'sandbox'`, not `?? 'sandbox'`. `GEMINI_API_KEY` is forwarded only when `RUN_LIVE_VEO` is set, and only to the dev server. The live spec stays ignored on `studio-built`.

One correction forced by the built server: `src/lib/authStore.ts:584` sets `secure: true` on the session cookie when `NODE_ENV === 'production'`. Playwright's API request context does not send that cookie to `http://127.0.0.1`. A fetch made inside the page does, because Chromium treats loopback as a secure context. `playwright/lion-greeting-workflow.spec.ts` and `playwright/sandbox-guard.spec.ts` therefore call the API from the page (`playwright/browser-api.ts`). The assertions are the original ones. The three timeline-shell tests are unchanged and run on both projects.

## HTTP bundle

Confirmed. `mcp/http-server.ts` serves only `/mcp` (`handleHttp` at line 246 returns JSON 404 for every other path). `THESHOW_HTTP_TOKEN` is required (`http-server.ts:37-44`). Default bind is `127.0.0.1:8787` (`http-server.ts:23-24`). DNS-rebinding protection is on (`enableDnsRebindingProtection: true` at line 226). No HTML and no browser UI.

## Existing MCP harnesses

Confirmed, and still true after this PR except for the new file.

- `tests/mcp-stdio-baseline.test.ts` and `tests/mcp-http-transport.test.ts` spawn `mcp/launch.mjs` in bundle and source mode and, against the bundle, check `initialize` / `tools/list` and the pinned schemas. They do not `tools/call` a film tool on the bundle.
- `tests/phase2-transport.test.ts` compares stdio and HTTP for `suggest_coverage` and `check_cross_film` from source (`THESHOW_MCP_FROM_SOURCE: "1"`).
- `tests/phase1-tools.test.ts` and `tests/phase2-tools.test.ts` use `InMemoryTransport`.
- `tests/phase2-recovery.test.ts` spawns `tests/mcp-multi-child.ts` via tsx. The pause hooks (`setBeforeAdvisoryProbe`, `setBeforeAdvisoryFramesProbe`, `setBeforeRenameProbe`) are installed by that child. The shipped bundle never installs them.

`tests/e2e-bundles.test.ts` is the new hook: `mcp/launch.mjs` in bundle mode, no `THESHOW_MCP_FROM_SOURCE`, no `NODE_ENV=test`, no `THESHOW_STUB_VIDEO`.

`extract_last_frame` and `assemble_film` call `probeDuration`, which runs `ffprobe` (`mcp/media.ts:89-102`). `@ffmpeg-installer/ffmpeg` ships ffmpeg and not ffprobe. `resolveTools` (`mcp/media.ts:60-80`) uses `/usr/bin/ffprobe` when `/usr/bin/ffmpeg` exists, and otherwise a sibling path that is not in the installer package. GitHub's `ubuntu-latest` image has neither binary, so the test job installs the `ffmpeg` apt package. That is a CI setup step, not a production change.

R1 review, test-only: the preload writes `guard-loaded` and a `<kind> <target>` line for every outbound attempt. The suite fails unless the marker is present and every target is an exact loopback host (`localhost`, `127.0.0.0/8`, or `::1`). An unreadable N35 job is a directory at the job path, so `readFile` throws `EISDIR` for root as well as for other users. `snapshotCharacter` is also trapped with a `data:` string that is a real relative path. Playwright fulfills the Google Fonts CSS inside the page and does not change `src/index.css`. The Account button's accessible name is `${firstName} account` when signed in.

## Tool surface

`registerTool` lines in `mcp/server.ts`, unchanged by N35:

| Tool | Line |
|---|---|
| `configure_film` | 759 |
| `create_character` | 938 |
| `plan_storyboard` | 1572 |
| `generate_controlled_clip` | 1905 |
| `extend_clip` | 2125 |
| `extract_last_frame` | 2331 |
| `generate_still` | 2373 |
| `assemble_film` | 2559 |
| `render_sequence` | 3673 |
| `board_film` | 4251 |
| `retry_shot` | 4584 |
| `list_films` | 4914 |
| `check_sequence` | 4975 |
| `review_continuity` | 5104 |
| `propose_repair` | 5194 |
| `suggest_coverage` | 5422 |
| `check_cross_film` | 5586 |

Order is that table. `tests/fixtures/mcp-tool-input-schemas.json` pins the first 15 input schemas and is not modified.

## Advisory output contract

`refusal` (`mcp/server.ts:1092`) JSON-stringifies the payload into `content[0].text`. It does not add fields.

`suggest_coverage` returns `suggestCoverage()` (`mcp/coverageSuggestions.ts:73-82` and the handler at `mcp/server.ts:5514`). Fields: `version`, `executed: false`, `willRender: false`, `willSpend: false`, `mutatedPaths: []` (the type is the empty tuple), `source`, `suggestions`, and `error` on the early refusals. No `costQuote`, `confirm`, or `approved*`. Suggestions carry `wouldSpend: false`. A `jobId` is read with `readPersistedJob` and not written.

`check_cross_film` returns `checkCrossFilm()` (`mcp/crossFilm.ts:125-135`). Fields: `version`, `executed: false`, `willRender: false`, `willSpend: false`, `mutatedPaths` (empty unless `persist`), `findings`, `films`, `persisted`, optional `error`. `persist: true` adds `reportId`, `reportPath`, `persisted: true`, and `mutatedPaths: [reportPath]` (`mcp/server.ts:5699-5709`). No `costQuote` / `confirm` / `approved*`. Missing files (ENOENT) abstain with `artifactPaths: []` (`mcp/crossFilm.ts:617-623`).

N35: a file that is present but unreadable, invalid JSON, or schema-invalid used to abstain with `artifactPaths: []` (`mcp/crossFilm.ts:624-629` at the base). The abstention now passes `entry.path` into that array. ENOENT is unchanged. No other output field changes. The input schema is unchanged.

`review_continuity` success path spreads `reviewContinuity()` (`mcp/continuityReview.ts:75-82`), which includes `executed/willRender/willSpend: false` and `mutatedPaths: []`, plus `persisted`, `source`, and `reproducible` (`mcp/server.ts:5181-5186`). The empty-input refusal (`mcp/server.ts:5153-5158`) and the unknown-job refusal (`mcp/server.ts:5134-5136`) do **not** include `mutatedPaths`. That matches the brief's measurement on an empty home: the refusal has no `mutatedPaths`. The success contract does. This PR does not add a field to make them match. Calls in the bundle test that pass shots hit the success contract. Calls without shots are not given a fake `mutatedPaths`.

`propose_repair` success path spreads `proposeRepair()` (`mcp/repairPlan.ts:75-83`): `version`, `badShot`, `resolution`, `options`, `executed/willRender/willSpend: false`. No `mutatedPaths`. The handler adds `advisory: true` and `persisted` (`mcp/server.ts:5311-5317`). `costQuote` is attached only to the `retry-alone` option when `jobId` is set (`mcp/server.ts:5272-5291`). `confirm` is accepted and ignored (`mcp/server.ts:5221-5223`); it is not echoed. Passing `jobId` also writes `dependencies` and `repairProposal` onto the job (`mcp/server.ts:5295-5307`). The read-only bundle calls omit `jobId` so that write does not happen. The brief's "files unchanged after each advisory call" matches the no-`jobId` contract. A call with `jobId` is a documented annotation write, not a silent mutation, and the bundle test does not use it for the hash check.

## Read-only proof and the dead owner

`loadJobsFromDisk` (`mcp/server.ts:2968-2971`) calls `reapIfOwnerGone` (`mcp/server.ts:2899-2910`). A `running` job whose owner is on this host and whose pid is dead is rewritten to `stopped` before any tool runs (`jobShouldStop`, `mcp/runtime.ts:93-107`). A foreign host with a fresh lease is not reaped, even if the pid number is dead (`mcp/runtime.ts:105` checks the pid only for this host).

The bundle test therefore seeds both:

- `seq_e2e_running_local`: same host, dead pid. After the process is ready the file is `stopped` and the error says the server stopped while the film was rendering. Advisory calls do not change it again.
- `seq_e2e_running_remote`: host `remote-host-not-this-box`, dead pid, lease held open with `THESHOW_JOB_LEASE_MS=600000` in the test process only. The file bytes stay equal to the seed across the advisory calls.

Hashes and mtimes are compared on `jobs/`, `characters/`, `media/`, and `consistency/` after each advisory call. `persist: true` may add exactly one `cxf_*.json` under `consistency/`. Anything else fails the test.

## Parity normalization

Stdio and HTTP are compared after replacing only:

- the temp `HOME` prefix
- `frame-<12 hex>` and `film-<12 hex>` (those names include `Date.now()` in `mcp/media.ts:178` and `:387-390`)
- `cxf_<uuid>` report ids
- `char_<time>_<hash>` ids from `create_character` (`mcp/characters.ts` id assignment)
- ISO timestamps whose year is 2026 or later (`create_character` `createdAt` / `updatedAt`). Fixture timestamps are 2024 and are not replaced.
- numbers greater than `1_750_000_000_000` (a reaped `finishedAt`, if a payload echoes one)
- `configure_film.message`, dropped only when `elicitationSupported` is present

`configure_film` without a form (`mcp/server.ts:787-802`) says the client cannot show a form on stdio, and that HTTP has no server-to-client stream when `requestScope().kind === 'http'` and SSE is not connected. That wording is transport-specific. The test asserts each sentence and then drops `message` before the deep compare.

`extend_clip` with `confirm: true` and `overrideValidation: true` is refused before `fetch`. Stdio hits `refuseIfSessionWillNotLast` (`mcp/server.ts:1527-1535`) and the error is the "No credential found" reason. HTTP refuses the subscription session and names `XAI_API_KEY` (`mcp/grok-auth.ts` around 226-239). Neither body contains `https://api.x.ai` or a `requestId`. The test asserts both wordings, then replaces them with `<CREDENTIAL_REFUSAL>` for the compare. There is no provider base-URL override (`API_BASE_URL` is the constant `https://api.x.ai` in `mcp/grok-auth.ts:22`). The proof that nothing was called is `tests/provider-net-guard.mjs`, loaded with `NODE_OPTIONS=--import` on the bundle process. It records `fetch`, `http.request`, `https.request`, and `net.Socket.connect`, and throws on a non-loopback target. The guard log must not contain `api.x.ai` or `provider network blocked`.

## No-paid-call switches

Confirmed. `paidStubEnabled` (`mcp/grokVideo.ts:380-384`) honors `THESHOW_STUB_VIDEO` only when `VITEST === "true"` or `NODE_ENV === "test"`. This PR does not widen it. The bundle processes do not set either variable.

`resolveVideoBackend` (`src/lib/grokClipStore.ts:211-228`): an explicit `THESHOW_VIDEO_BACKEND` wins; a Vitest/`NODE_ENV=test` run never bills; otherwise a resolvable Grok credential selects Grok. The Playwright server is not a Vitest run. Its protection is the sandbox pin plus `GROK_AUTH_FILE=/nonexistent/theshow-test-auth.json` and `THESHOW_FORBID_HOME_AUTH=1` (`mcp/grok-auth.ts:98-107`). Unpinned, with no credential and no Gemini key, `POST /api/generate-shot-video` returns 503 `no-video-backend` (`server.ts:1633-1641`) instead of a mock clip. `playwright/sandbox-guard.spec.ts` fails in that case. The CI `e2e` job also fails if `RUN_LIVE_VEO` is set.

## Accessibility, measured in this PR before the token change

Chromium, 1280×800, `prefers-reduced-motion: reduce`, default sample cast (no `localStorage` seed), signed out, tags `wcag2a, wcag2aa, wcag21a, wcag21aa, wcag22aa`, after the shell was visible. The only violated rule was `color-contrast`. Every failing foreground was `#71717b` (Tailwind's default `zinc-500`). Node counts:

| Surface | color-contrast nodes |
|---|---|
| Timeline | 27 |
| Roster | 4 |
| Scenes | 13 |
| Pipeline | 7 |
| Account, signed out | 11 |

The worst computed pair was `#71717b` on `#18181b` (zinc-900) at 3.67:1. On `#09090b` (zinc-950) the same foreground was 4.12:1. All of the nodes were small text, so the bar is 4.5:1. Popup scans include the page behind the popup, so the header's "Local draft mode" line is inside the popup counts. These counts match the brief.

`src/index.css` now sets `--color-zinc-500: #8a8a94` in `@theme`. That is 5.18:1 on `#18181b` and 5.82:1 on `#09090b`. No other token moved. After the change, the same scan on desktop and at 375×800, signed out on all five surfaces and signed in on Account, reports **zero** violations.

One mobile-only failure showed up only because this PR scans 375px, which the original measurement did not. The Account trigger's label is `hidden sm:inline` (`App.tsx`), so at 375px the button had an icon and no accessible name (`button-name`, WCAG 2.1 A, inside the required tag set). `aria-label` repeats the same word the visible label uses. Layout, copy, and click behavior are unchanged. After that, mobile is also zero violations.

axe still lists `color-contrast` under `incomplete` on these pages (it could not score every node). Incomplete is not a violation. The gate asserts `violations` is empty.

## Where the new tests hook

| Fact | Test |
|---|---|
| Built bundles, both transports, all 17 tools, advisory hashes, parity, no provider call | `tests/e2e-bundles.test.ts` |
| Kill mid-call, restart, same result, sweeps only | same file, one test per transport |
| N34 / P39 URL skip | `tests/n34-snapshot-url.test.ts` |
| N35 path on unreadable and invalid JSON, ENOENT stays `[]` | `tests/n35-abstention-path.test.ts`, and again on both bundles in `tests/e2e-bundles.test.ts` |
| N36 recovery ceiling | `tests/phase2-recovery.test.ts` (assertions unchanged; signal ceiling 180s, test ceiling 300s) |
| Every Studio surface, both viewports, both servers, axe | `e2e/studio-baseline.spec.ts` |
| Sandbox pin | `playwright/sandbox-guard.spec.ts` |
| Existing timeline and lion workflow | unchanged assertions; lion calls run in the page so the built server's Secure cookie is sent |

## Already implemented, or not done on purpose

- The four advisory tools, their free flags, and `persist` writing one report already exist. This PR tests the built bundles; it does not add tools.
- `paidStubEnabled` already ignores `THESHOW_STUB_VIDEO` outside Vitest. Not widened.
- The live Veo spec already skips unless `RUN_LIVE_VEO=1`. CI now fails the job if that variable is set. The spec is not run.
- Firefox, WebKit, and visual-diff gates are out of scope and not added.
- Issue #13 items N28, N32, and N33 are untouched.
- `review_continuity`'s empty refusal has no `mutatedPaths`. Not "fixed"; the success path already has the field, and the test asserts the path it actually calls.
- Same-host dead-pid jobs are reaped at startup. The advisory hash window starts after that reap. A foreign-host dead pid is the job that stays `running` and byte-identical, which is what `jobShouldStop` already does.
