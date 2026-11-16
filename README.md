# theShow

**Continuity-first AI film generation, as a Grok plugin.**

Most AI video tools give you a slot machine. You type a sentence, you get eight seconds, and the next eight seconds has a different face, a different coat, and a different street.

theShow treats a film as a sequence of planned shots. It collects the whole brief before spending anything, boards the film as stills so you can see it before you buy it, checks a per-shot contract before a paid render, pins the opening frame of each clip (and the closing frame when you ask), and assembles the result with FFmpeg.

On the desktop plugin, a signed-in Grok session is enough. `XAI_API_KEY` is optional there and is used first when it is set. The optional HTTP server bills the API key unless you opt in to that session file.

<!-- Hero: the proof film, four frames from one 24-second render. -->
![Four frames from a 24-second theShow film: the same man, the same tan sherpa coat, the same 17th-floor office and skyline, across four shots](docs/images/proof-film-frames.jpg)

The 8.4 MB master (`docs/media/tay-17th-floor-720p.mp4`, 1280×720, 24.17 s) is the file the measurements below were taken from. GitHub's file viewer will not play it: the blob page says it can't show a file that big. The clip here is that same film, re-encoded to 960×540 so the page can play it. It is not a new render.

<video src="docs/media/tay-17th-floor-preview.mp4" poster="docs/images/proof-film-frames.jpg" controls width="960"></video>

**[Watch the 24-second film](docs/media/tay-17th-floor-preview.mp4)**

---

## A real film, measured

That film was made end to end through the installed plugin: one form, one board, one chained render, with both ends of each shot pinned. It is the evidence behind the measurements in this section. The current default pin is `start`; see [How continuity actually works](#how-continuity-actually-works).

| | |
|---|---|
| Job | `seq_mvzhmxbj_ahcsd9` |
| Shots | 4 × 6 seconds, 720p (1280×720), 24 fps, hard cuts |
| Result | 24.17 seconds, 580 frames, 8.4 MB |
| Cost | **$3.44** actual ($0.86 a shot) against a $3.36 quote |
| Warnings | none |

What was checked, on the rendered pixels rather than on the prompt:

- **Every shot landed on its pinned closing frame.** Correlation to the supplied last frame: 0.999, 0.999, 0.988, 0.980.
- **Every cut met on the shared frame.** Correlation across the three cuts: 0.9980, 0.9956, 0.9699 — at or above the within-shot controls for the same footage (0.9863, 0.8881). That film pinned both ends, so two shots met on the same file.
- **The face held.** SFace identity against the reference portrait, sampled every half second across 47 detected faces: mean 0.519. Every score below 0.36 was inspected and is a pose, not a different person — a profile, a face leaving frame, a man turned away.
- **The wardrobe held.** Tan coat presence mean 0.684; navy, the garment the old prompt wrongly named, mean 0.008 (max 0.069).
- **The room held.** The left-window patch stayed put within shots that keep the same framing, and the board's frames agreed with each other at 0.843 mean structural correlation.

The numbers, the method and the raw measurements are in [`docs/proof.md`](docs/proof.md).

---

## Install

### Grok plugin

```bash
grok plugin install TayDa64/theShow --trust
```

The server ships pre-bundled, so startup runs no `npm install` and needs no network. `.mcp.json` runs `node mcp/launch.mjs` and does not set `THESHOW_TRANSPORT`, so the desktop launch is stdio and opens no port.

Confirm the wiring:

```bash
grok mcp doctor
```

You want `theshow` reported healthy with **fifteen tools** discovered. Run that on the machine the session is actually using. Plugins install per machine, and a Grok web sandbox is not your machine.

If the session's tool list has no `plan_storyboard`, the plugin is not loaded there. theShow's skill tells the model to stop and say so rather than quietly build a film some other way.

To update:

```bash
grok plugin uninstall theshow && grok plugin install TayDa64/theShow --trust
```

### Desktop stdio from a checkout

From a source checkout, the same launcher starts stdio when `THESHOW_TRANSPORT` is unset:

```bash
node mcp/launch.mjs
```

Set `THESHOW_MCP_FROM_SOURCE=1` to run `mcp/stdio-main.ts` through `tsx` instead of `mcp/server.bundle.mjs`. That needs `node_modules`.

### Streamable HTTP

A second process can expose the same fifteen tools over Streamable HTTP. Tool names, input schemas, and handlers are the ones the desktop server uses. The process refuses to start without a bearer token, and the default bind is loopback.

```bash
THESHOW_TRANSPORT=http \
THESHOW_HTTP_TOKEN="$(openssl rand -hex 32)" \
THESHOW_HTTP_HOST=127.0.0.1 \
THESHOW_HTTP_PORT=8787 \
node mcp/launch.mjs
```

| Variable | Required | Default | What it does |
|---|---|---|---|
| `THESHOW_TRANSPORT` | no | `stdio` | `stdio` or `http`. Unset is stdio. |
| `THESHOW_HTTP_TOKEN` | yes, in http mode | none | Bearer token. The process exits if this is missing or blank when transport is `http`. |
| `THESHOW_HTTP_HOST` | no | `127.0.0.1` | Bind address. Anything other than loopback is refused unless `THESHOW_HTTP_EXPOSE=1`. |
| `THESHOW_HTTP_PORT` | no | `8787` | Bind port. `0` asks the OS for a free port. |
| `THESHOW_HTTP_EXPOSE` | no | off | Set to `1` before binding a non-loopback host. Put TLS in front of that listener. |
| `THESHOW_HTTP_ALLOW_GROK_SESSION` | no | off | HTTP bills `XAI_API_KEY`. Set to `1` to use `~/.grok/auth.json`, which spends the Grok subscription of the account in that file. |
| `THESHOW_HTTP_ALLOWED_HOSTS` | no | the bound host, `127.0.0.1`, and `localhost`, with the port | Extra `Host` values accepted when DNS-rebinding protection is on. |
| `THESHOW_HTTP_ALLOWED_ORIGINS` | no | `http://127.0.0.1:<port>` and `http://localhost:<port>` | `Origin` values a browser may send. Any other `Origin` is rejected. |
| `THESHOW_HTTP_SESSION_TTL_MS` | no | `1800000` | Idle session lifetime. |
| `THESHOW_HTTP_MAX_SESSIONS` | no | `32` | Cap. The oldest idle session is closed to make room. |
| `THESHOW_JOB_LEASE_MS` | no | `30000` | How long a running film may go without a heartbeat before another process may mark it stopped. |
| `THESHOW_JOB_HEARTBEAT_MS` | no | `10000` | How often the process that owns a render rewrites that heartbeat. |

The endpoint is `http://127.0.0.1:8787/mcp`. Every request needs `Authorization: Bearer <token>`. A missing or wrong token is rejected before any tool runs. `initialize` returns an `Mcp-Session-Id` header; send that header, and `MCP-Protocol-Version`, on later requests. `DELETE` the same URL with those headers closes the session. A dropped connection does not cancel a film. The process that started the render keeps a heartbeat on the job file under `~/.theshow/jobs`. Another process, stdio or HTTP, can see that film and will not mark it stopped while the heartbeat is fresh and the owner process is alive. A heartbeat dated more than five seconds in the future is ignored when the owner is on this machine. An owner on a different machine is allowed a minute of clock skew before a future stamp is treated the same way.

HTTP tool results leave out the `auth` field, so a remote client does not receive the operator email from `~/.grok/auth.json`. Desktop stdio still tries the API key first, then the subscription session.

`configure_film` returns the form fields as `needsInput` when the HTTP client has no GET stream to receive elicitation. A client that does open the stream gets the form, and on HTTP a missing answer comes back after `THESHOW_ELICIT_TIMEOUT_MS` (default 10 seconds). Desktop stdio waits for the form with no timeout.

The desktop bundle is `mcp/server.bundle.mjs` (`mcp/stdio-main.ts`). HTTP is `mcp/server-http.bundle.mjs` (`mcp/http-server.ts`). `node mcp/launch.mjs` picks from `THESHOW_TRANSPORT`. Importing `mcp/server.ts` does not listen and does not start stdio.

The server answers POSTs with JSON. The client still has to send both accepted types:

```bash
curl -sS -D - http://127.0.0.1:8787/mcp \
  -H "Authorization: Bearer $THESHOW_HTTP_TOKEN" \
  -H "Content-Type: application/json" \
  -H "Accept: application/json, text/event-stream" \
  -d '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-11-25","capabilities":{},"clientInfo":{"name":"curl","version":"0"}}}'
```

To reach it from Grok Chat, keep this process on `127.0.0.1` and put TLS in front of it. This process does not terminate TLS and does not serve rendered media over HTTPS. Point the connector at the public `https` URL of `/mcp`, and send the bearer token in a header. Do not put the token in the URL.

```json
{
  "mcpServers": {
    "theshow": {
      "url": "https://your-host.example/mcp",
      "headers": {
        "Authorization": "Bearer YOUR_TOKEN"
      }
    }
  }
}
```

---

## Your first film

Ask in plain language. You never call the tools yourself.

> Use theShow to make a four-shot film of a man in a 17th-floor office at dusk, studying a holographic model of a skyline. Keep his face and his coat the same in every shot.

`configure_film` puts the whole brief on one interactive card: scene, characters, style, shot count, seconds per shot, resolution and its price, aspect ratio, audio, what must never appear, a music or voiceover path, and an optional reference image. The card returns your answers as JSON plus a cost estimate, and renders nothing.

![The theShow configuration card inside Grok, showing the scene, characters, style, shots, seconds per shot, resolution and price, shape, audio and never-show fields, with accept and decline at the bottom](docs/images/config-card.png)

One card is one model turn. Asking the same questions one at a time spends a turn on each before a frame exists.

Two rules the tool holds to:

- **A blank stays blank.** Anything you leave empty is left out of the film, and the model is told never to invent a character detail you did not give.
- **Decline means no.** A declined or cancelled card comes back as an instruction not to render.

The reference field takes a **path or an https URL**, because MCP has no file upload. A photo attached in chat already arrives as a readable local path. HEIC and HEIF are transcoded automatically and oversized images are stepped down until they fit.

### Slash commands

Ten commands ship with the plugin. `/theshow` is the primary start. `/film` follows the same recipe.

| Command | What it does |
|---|---|
| `/theshow <idea>` | Primary start. The model calls `configure_film`, then the board, then the render contract |
| `/film <idea>` | The same recipe as `/theshow` |
| `/scene <scene> [shots]` | Plans a storyboard only. Free, renders nothing |
| `/character <name> [look] [photo]` | Creates or updates a character with reference photos |
| `/board <scene or jobId>` | Boards a film as stills, about two cents a frame |
| `/render <shots.json>` | Renders a planned shot list |
| `/check [jobId]` | Progress and real cost on a render, or your recent films |
| `/retry <jobId> <shot> [prompt]` | Re-renders one bad shot and splices it back |
| `/films [count]` | Lists films on disk. Free |
| `/continue <jobId> <what next>` | Continues an existing film with more shots |

A command that spends money still prices the work and waits for a yes. The command files are in [`commands/`](commands/theshow.md).

---

## The film workflow

1. **Configure.** `configure_film` collects the brief and a cost estimate. It spends nothing.
2. **Plan.** `plan_storyboard` turns the scene into numbered shots. Omit `promptStyle`, or pass `legacy`, for the paragraph prompt. `sections-v2` is opt-in: it writes a sectioned prompt and does not append the ledger paragraph. Planning is free.
3. **Board stills.** `board_film` generates one still per shot boundary. Call it without `confirm` for the estimate. Pass `confirm` only after a yes. Frames already on disk are reused and cost nothing.
4. **Render gates and the contract.** Before a paid video call, the server builds one contract per shot from the continuity ledger: the state at the start, the steps in between, the state at the end, invariants, and things that must not appear. Validation refuses more than three steps, a garment that is both worn and hanging, a count that invents a second coat or a third shoe, and a shot whose start does not match the previous shot's end. `confirm` does not unblock a failed board or a failed render. `overrideValidation: true` is the explicit bypass. A prompt lint also rejects forbidden nouns and negation before any paid call, because the image API has no negative-prompt field. `extend_clip` has no ledger, so `confirm` spends on an extension only when `overrideValidation` is set.
5. **Render.** `render_sequence` prices the shot list without `confirm` and spends only after `confirm`. It returns a `jobId`. Poll `check_sequence`. A long sequence keeps running, so do not call `render_sequence` again to check on it.
6. **Assemble.** `render_sequence` can assemble the finished shots. `assemble_film` joins an ordered list of clips with FFmpeg. Joins are hard cuts by default. A music bed shorter than the film is refused. It is not looped.
7. **Retry.** `retry_shot` re-renders one shot of a finished film and splices it back. The other shots stay as they were. The seam after the repaired shot is a cut, and the tool says so in `warnings`. `propose_repair` lists cheaper and wider options first and does not render them.
8. **Review.** `review_continuity` classifies each cut as measured, visually flagged, or unverified. It does not render or delete anything.

---

## The tools

| Tool | Costs | What it does |
|---|---|---|
| `configure_film` | free | Collects the whole brief on one card, with a cost estimate |
| `create_character` | free | Stores a named character with reference photos on disk |
| `plan_storyboard` | free | Turns a scene into numbered shots, with wardrobe checklists and a per-room prop ledger |
| `generate_controlled_clip` | per shot, after `confirm` | One clip. `pin` defaults to `start`. An end-frame pin has to be asked for |
| `extend_clip` | per call, API key only | Continues an existing take. `confirm` spends only with `overrideValidation` |
| `extract_last_frame` | free | Pulls the last frame out of a clip as a PNG |
| `generate_still` | $0.02, after `confirm` | One image |
| `assemble_film` | free | Joins ordered clips into one film with FFmpeg |
| `render_sequence` | per shot, after `confirm` | Renders a shot list with continuity, then can assemble it |
| `board_film` | $0.02 a still, after `confirm` | Boards a film as stills, one per shot boundary |
| `retry_shot` | one shot, after `confirm` | Re-renders a single bad shot and splices it back in |
| `list_films` | free | Films on disk, including earlier sessions |
| `check_sequence` | free | Progress and real cost on a `render_sequence` job |
| `review_continuity` | free | Evidence review of each cut. It does not render or spend |
| `propose_repair` | free | Repair options with a price, what they fix, and what stays broken. It does not render |

---

## How continuity actually works

**The board shares a picture at each cut.** N shots produce N+1 stills. The boundary between two shots is one picture. `render_sequence` sends that closing frame only when `pin` is `"both"`. The default pin is `start`, so the cut is not pixel-pinned unless you ask. A start pin holds the opening frame. The proof film above used both ends, which is why its cuts met on one file.

**A location can be the base image.** When the cast includes a character whose role is `Location`, its photo becomes the base that frames are edited from. Measured skyline agreement across a five-frame board: **0.72** by that route, against 0.57 editing from the location alone, 0.36 chaining, and 0.25 when a portrait rode along as a second reference.

**The cast line describes the photo.** `mcp/cast.ts` drops garment words from the cast line when a picture is present, so the prompt does not invent a second coat on top of the one in the photo. A measured board whose cast line said "navy blazer" while the portrait showed a tan sherpa coat produced a different jacket in three of five frames. Once the line stopped arguing with the photo, the same board held the coat in all five.

### The continuity ledger

`mcp/continuity.ts` stores wardrobe as an ordered checklist of layers, including footwear: what is against the skin, what sits on top, and how much of each the reference photo shows. Named events (remove, put on, adjust) replay into that checklist for later shots. A removed coat becomes a prop at its destination.

Props are scoped to a location id. The living-room hanger and the study hanger stay different objects even when they share a name. An unnamed prop stays where it is. Only an event that names a prop by id can move or remove it. The ledger is stored on the film job in `~/.theshow/jobs`, so a resumed film keeps the same rooms and objects.

`mcp/contracts.ts` turns that ledger into the per-shot contract the render gate checks. Validation is offline. The vision auditor in that module is a stub: it refuses to run, because a vision pass costs money and that cost has not been measured. `mcp/admission.ts` is the post-generation checklist. It does not call a vision API. The caller supplies the measurements, and a failed take is deleted so it cannot be pinned or chained.

**A film survives the session.** Every job is written to `~/.theshow/jobs` as it renders and reloaded at startup, with the footage in `~/.theshow/media`. Characters live in `~/.theshow/characters`. `list_films` is how you find a film to continue or repair.

---

## Cost

Every render is a real charge, and **resolution sets the price**. The rates in code are:

| Resolution | Per second |
|---|---|
| `480p` | $0.08 |
| `720p` | $0.14 |
| `1080p` | $0.25 |

Measured on real eight-second renders, those rates produced:

| Resolution | Output | 8-second shot | Four 8-second shots |
|---|---|---|---|
| `480p` | 848×480 | $0.64 | $2.56 |
| `720p` | 1280×720 | $1.12 | $4.48 |
| `1080p` | 1920×1088 | $2.00 | $8.00 |

What is free, and what is not:

| | |
|---|---|
| Free | `configure_film`, `create_character`, `plan_storyboard`, `extract_last_frame`, `assemble_film`, `list_films`, `check_sequence`, `review_continuity`, `propose_repair`, and any still or clip the tool reports as already on disk |
| $0.02 | one still from `generate_still` or `board_film`, after `confirm` |
| Per second | video from `render_sequence`, `generate_controlled_clip`, `retry_shot`, and `extend_clip`, after the gate and `confirm` |
| Unbilled | an estimate (`confirm` omitted), a declined card, a contract the gate refuses, and a render the provider does not bill |

- **The default resolution is 720p.** An estimate that omits the resolution is a 720p estimate.
- **One shot runs to 15 seconds.** A film is a chain of shots.
- **Every render returns its actual `costUsd`.** Quote that, not the estimate. Failed renders are not billed.
- **A still already on disk is free.** Re-running `board_film` after a partial board reuses those frames. A hero built from a portrait and a room is bought again on each confirmed board, and a new hero buys the shot frames again.
- **A board confirm does not authorize video, and a video confirm does not authorize a board.** Optional `approvedKind`, `approvedUsd`, and `approvedFingerprint` bind a yes to that quote. If the resolution, duration, shot count, or pin changes, the old yes is refused. Omitting those fields keeps the previous confirm behavior.
- **`budgetUsd` warns.** Spent money plus the pending estimate is compared with that threshold. Crossing it does not spend and does not stop a render that already started. `overrideValidation` still does not stand in for `confirm`. `maxCostUsd` on a board is unchanged: over that ceiling, the board spends nothing.

---

## Authentication

`render_sequence`, `generate_controlled_clip`, `board_film` and the rest resolve a credential in this order on desktop stdio:

1. **`XAI_API_KEY`**, if set — billed as xAI API credits at `https://api.x.ai`.
2. **Grok subscription session** — read from `~/.grok/auth.json` after `grok login`.

HTTP uses `XAI_API_KEY` and does not read `~/.grok/auth.json` unless `THESHOW_HTTP_ALLOW_GROK_SESSION=1`.

An unset MCP environment variable can arrive as a literal `${XAI_API_KEY}` string. theShow treats that shape as absent. An expired token reports a reason that names `grok login`.

`extend_clip` needs the API key. The subscription proxy answers `POST /v1/videos/extensions` with **HTTP 405**. On a subscription, continue a shot with `generate_controlled_clip` and `firstFrameUrl` instead.

---

## Network, files and credentials

| What | Where |
|---|---|
| Video and image generation | `https://cli-chat-proxy.grok.com` on a Grok subscription, `https://api.x.ai` with `XAI_API_KEY` |
| Subscription credential | Reads `~/.grok/auth.json`, written by `grok login`. Read-only |
| Your films | Writes `~/.theshow/jobs` and `~/.theshow/media` |
| Your cast | Writes `~/.theshow/characters`, with your reference photos copied in |
| FFmpeg | Runs the local `ffmpeg` and `ffprobe` on your `PATH` |
| Remote MCP | Only when `THESHOW_TRANSPORT=http`. Listens on `127.0.0.1:8787` unless host and port are set |

Reference photos you attach are uploaded to the generation endpoint as part of the request that uses them.

The MCP server ships as two committed esbuild bundles, `mcp/server.bundle.mjs` and `mcp/server-http.bundle.mjs`, because an install must never run `npm install`. They are not minified and there is no postinstall step. `npm run build:mcp` regenerates both from `mcp/stdio-main.ts` and `mcp/http-server.ts`.

---

## Limits

- **`pin` defaults to `start`.** Pass `pin: "both"` when the cut must land on the boarded closing still.
- **`firstFrameUrl` must be an image.** A clip there returns `invalid_image`.
- **`first_frame` is ignored by the underlying API.** theShow sends `image` on the wire. `last_frame` works.
- **A shot is at most 15 seconds.** For longer, chain shots or resume a job.
- **A music bed shorter than the film is refused.** It is not looped to cover the runtime.
- **Rate limits exist** on the generation endpoints. theShow reports the real error.
- **`retry_shot` cannot repair the seam after the repair.** Shots after the new one were built from the original shot's last frame. The tool says so in `warnings`.
- **A film caught mid-render when the server stopped** returns as `state: "stopped"`. Shots already finished stay on disk.
- **There is no colour garment check.** A colour check was built and removed: it learned the coat from a hero frame cropped at the chest and abstained on a real board. What holds the wardrobe is the cast line, the layer checklist, and your eyes on a board that costs pennies.
- **Post-render vision audit is not wired.** The interface exists. It does not call an image or video API. The cost of that pass has not been measured.

---

## StoryForge Studio

The repository also contains **StoryForge Studio**, the web workspace: a timeline, a character roster, a scene library, and a pipeline panel. These shots are the local app on the built-in sample cast (Kaelen Thorne and Lyra), in local draft mode, with no account and no provider key on screen.

```bash
npm install
npm run dev          # http://localhost:3000
```

![StoryForge Studio timeline in local draft mode, with an empty preview player and no beats in the cut](docs/images/studio-timeline.jpg)

![The roster popup, showing the sample characters Kaelen Thorne and Lyra with empty portraits](docs/images/studio-roster.jpg)

![The scenes popup, with Act I Handshake Protocol and an empty storyboard](docs/images/studio-scenes.jpg)

![The pipeline popup, asking for an account before live video routes and offering a sandbox preview](docs/images/studio-pipeline.jpg)

The workspace loads in local draft mode with no account. **Live video routes require a signed-in local account.** Optional Studio environment (`GEMINI_API_KEY` for the Veo path, `SESSION_SECRET`, `STORYFORGE_ENCRYPTION_KEY`, and the `GOOGLE_OIDC_*` set) is documented in [`.env.example`](.env.example). The MCP server does not need those. StoryForge keeps app login separate from provider credentials. A personal Gemini key connected in the Account dashboard is stored server-side and encrypted at rest.

The Studio prefers Grok when a credential resolves and falls back to Gemini Veo when it does not.

---

## Developing

Node 22. CI uses that version.

```bash
npm run typecheck    # app, Express server, and mcp/tsconfig
npm run lint
npm test             # Vitest, with coverage
npm run build        # Vite app plus dist/server.cjs
npm run build:mcp    # mcp/server.bundle.mjs and mcp/server-http.bundle.mjs
```

`npm test` is the suite CI runs. It does not call xAI. `npm run test:e2e` is Playwright. `npm run test:e2e:live` sets `RUN_LIVE_VEO=1` and is a paid path. CI does not run it.

`THESHOW_STUB_VIDEO` is a Vitest-only seam. The shipped bundles ignore it unless `VITEST=true` or `NODE_ENV=test`, so setting it on a desktop or HTTP server does not skip the session check and does not fake a paid call. Under Vitest it stubs clip, still, board, and extend, and the extend stub returns before the provider credential check. `THESHOW_STUB_VIDEO=completed` returns a completed clip with no reported cost, which is how the per-shot quote fallback is tested.

After changing anything under `mcp/`, run `npm run build:mcp` and commit both bundles. CI's bundle job rebuilds them and fails if `git diff` is not empty.

CI (`.github/workflows/ci.yml`) runs on pull requests and on pushes to `main`:

| Job | What it runs |
|---|---|
| `typecheck` | `npm run typecheck` |
| `lint` | `npm run lint` |
| `build` | `npm run build`, then checks `dist/assets` for `GEMINI_API_KEY` |
| `test` | `npm test`, with paid keys refused and `GROK_AUTH_FILE` pointed at a missing file |
| `bundle` | `npm run build:mcp`, then `git diff --exit-code` on both bundles |
| `all-green` | waits for the five jobs above |

```
mcp/            the MCP server
  server.ts       tool handlers and createTheShowServer
  stdio-main.ts   desktop entry
  http-server.ts  Streamable HTTP entry
  launch.mjs      picks stdio or http from THESHOW_TRANSPORT
  continuity.ts   wardrobe layers and the per-location prop ledger
  contracts.ts    per-shot contracts and the pre-render gate
  admission.ts    post-generation checklist (no vision API)
  promptLint.ts   forbidden nouns and negation, before a paid call
  storyboard.ts   board planning and stills
  cast.ts         cast line against the reference photo
  grokVideo.ts    video and image client
  characters.ts   on-disk character store
  runtime.ts      claims, locks, HTTP session limits
skills/theshow/ the workflow the model follows
commands/       the ten slash commands
docs/           proof measurements, the film, and screenshots
src/            StoryForge Studio (React)
server.ts       Studio dev server
tests/          Vitest
```

---

## License

MIT. See [LICENSE](LICENSE).

Built by [@TayDa64](https://github.com/TayDa64).
