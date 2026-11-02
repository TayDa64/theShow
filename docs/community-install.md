# theShow: continuity-first video generation as a Grok plugin

Most AI video tools give you a slot machine. You type a sentence, you get eight seconds, and the next eight seconds has a different face, a different coat, and a different street.

theShow is a plugin for Grok Build that treats a film as a sequence of planned shots instead of one lucky prompt. You describe a scene; it collects the brief before spending anything, keeps characters consistent by feeding each clip the previous clip's final frame, and assembles the result with FFmpeg. It runs on your Grok subscription, so you do not need a separate API key.

This is how to install it and make your first film.

## Install

```bash
grok plugin install TayDa64/theShow --trust
```

That is the whole setup. The server ships pre-bundled, and the launcher starts that file. Startup does not run `npm install` or fetch dependencies.

Confirm it worked:

```bash
grok mcp doctor
```

You want `theshow` reported healthy with nine tools discovered: `configure_film`, `create_character`, `plan_storyboard`, `generate_controlled_clip`, `extend_clip`, `extract_last_frame`, `assemble_film`, `render_sequence`, and `check_sequence`. Run that check on the machine the session is using. If the session's tool list has no `plan_storyboard`, the plugin is not loaded there, and the skill tells the model to stop and say so.

An early build died during initialize for one of two reasons, both fixed in the launcher. Startup used to install dependencies, about 13 seconds of work, which overran the client's initialize window, or the client resolved the script from the home directory instead of the plugin folder. The launcher now runs the bundle and resolves paths from its own file. Update with:

```bash
grok plugin uninstall theshow && grok plugin install TayDa64/theShow --trust
```

## Your first film

Ask in plain language. You never call the tools yourself.

> Generate a two-shot, 16-second film about a lamplighter in the rain. Keep the same character in both shots.

Here is what happens behind that sentence.

**Brief.** `configure_film` runs first. It puts the whole brief on one interactive card: scene, characters, style, shot count, seconds per shot, aspect ratio, audio, hard constraints, and an optional reference image. The card returns those answers as JSON, plus a cost estimate marked `isEstimate: true`. It renders nothing and spends nothing. Only the scene is required. The other fields default to two shots, eight seconds each, 16:9, diegetic audio, and Photoreal cinematic. Shot count on the card runs from 1 to 8.

A blank stays blank. The form says anything you leave out is left out of the film, and the tool tells the caller never to invent a character detail you left empty. That invented detail is a second paid render. One card is one model turn; asking the same questions one at a time spends a turn on each of them before a frame exists. If the client cannot draw a form, the tool returns `elicitationSupported: false` and the same fields as text. Decline and cancel both come back as instructions not to render.

The MCP form has no file upload, so the reference field takes a path or an https URL. A chat attachment already resolves to a local path. Paste that.

**Character and storyboard.** `create_character` stores the subject by name in this server process, with any reference images. Later shots that name the character pick those images up. `plan_storyboard` turns the scene into numbered shots with framing, camera move, action, and continuity notes. A requested shot count is used, capped at 12, and a requested duration is split across those shots, capped at 180 seconds. The call does not render. Approve the board before anyone spends money.

**Sequence.** For more than one shot, use `render_sequence`. It renders the shots in order, chains each one from the previous shot's last frame, and assembles the film (`assemble` defaults to true). It is two steps. Without `confirm`, it returns an estimate with `willRender: false` and `isEstimate: true`, and it does not start a job. With `confirm: true`, it returns a `jobId` and runs the chain in the background. Poll that id with `check_sequence`, which is read-only and free. The running job says to poll every 20 to 30 seconds until `done` is true, and not to start a second render of the same shots.

The job exists because a multi-shot chain outlives the MCP client's 60-second request timeout. The first version awaited the chain inside the request. The clips landed on disk, the money was spent, and the caller got a timeout instead of a film. The chain stops on the first shot that fails, and it stops if a rendered shot's last frame cannot be extracted. The job names that shot and does not start the ones after it.

One call takes 1 to 12 shots, each 1 to 15 seconds. Twelve shots of 15 seconds is three minutes. Past that, pass the finished job's `lastFramePath` as `firstFrameUrl` on the next sequence, which pins the first new shot to the previous film's last frame. That call renders and bills only the shots you hand it. `spentUsd` is that job's spend. One file covering both jobs is a later `assemble_film` over the clip paths. Job ids live in the server process. After a restart `check_sequence` reports an unknown id and says jobs do not survive one. Clips already written to disk stay on disk.

**One shot at a time.** `generate_controlled_clip`, `extract_last_frame`, and `assemble_film` still work shot by shot. Render, pull the last frame as a PNG (`framePath`, plus a data URI unless you turn that off), pass that image as `firstFrameUrl` on the next shot, and assemble the ordered clips yourself.

**Assembly.** With an FFmpeg that has `xfade`, joins are cross-fades. `render_sequence` defaults `fadeDuration` to 0.25 seconds. `assemble_film` defaults it to 0.5 seconds. The bundled binary has no `xfade`, and a system binary that has the filter is preferred. Without the filter, assembly is a stream-copy concat: a hard cut. With the filter present, the duration you pass is the duration `xfade` gets, and 0 stays on that cross-fade path as a zero-length transition.

## What it costs

Every clip is a real charge, and the rate is the resolution you name. Measured on real eight-second renders: 480p (848×480) is $0.64, or $0.08 a second; 720p (1280×720) is $1.12, or $0.14 a second; 1080p (1920×1088) is $2.00, or $0.25 a second. Both render tools default to 720p, so an eight-second shot is $1.12, a three-shot film is $3.36 before assembly, and ten shots are $11.20.

Omitting `resolution` on the API request lets the API pick a soft 848×480 frame. That measured default is the soft picture, and it is what the old flat eight-cents-a-second line was quoting. A tool call that leaves the argument off is filled in as 720p and billed at $0.14 a second. Name the resolution beside any price. The configure card has no resolution field, so its estimate uses the 720p rate and labels it `isEstimate: true`.

`plan_storyboard` and an unconfirmed `render_sequence` spend nothing. Re-rendering a shot because the board was wrong is the expensive mistake.

Each finished render reports `costUsd`, converted from `usage.cost_in_usd_ticks` at 10^10 ticks per dollar. Audit from that field. The StoryForge web app writes a JSON sidecar beside its own downloaded clips; a plugin run leaves the figure on the tool result.

## Authentication

The plugin resolves a credential in this order:

1. `XAI_API_KEY`, when it is set and is not a literal `${XAI_API_KEY}` placeholder. Billed as xAI API credits at `https://api.x.ai`.
2. The Grok subscription session in `~/.grok/auth.json`, after `grok login`. No API key. Calls go to the CLI inference proxy and bill the subscription.

Most people land on the second, which is the point. The auth file is re-read on every call. An expired token comes back with a reason that names `grok login`.

`extend_clip` needs the API key. The subscription proxy answers `POST /v1/videos/extensions` with HTTP 405. On a subscription, the continuation is `generate_controlled_clip` with `firstFrameUrl` set to the previous clip's last frame.

## Two ways to run it

The plugin is the fast path. It lives inside Grok Build, where you are already talking.

StoryForge Studio is the other. Clone the repository, run `npm install` and `npm run dev`, and open `http://localhost:3000`. The workspace loads in local draft mode with no account. Live video routes require a signed-in local account. The header line is the account's provider mode, or local draft mode when you are signed out. The export panel names the video backend. When a Grok credential resolved it reads "Grok Imagine Video active — billed to" the subscription or the API key. Otherwise it names the Gemini provider or sandbox preview. The Studio server prefers Grok when a credential resolves, and uses Gemini Veo, through `GEMINI_API_KEY` or a key on the account, when it does not.

## Known edges

- `firstFrameUrl` must be an image. The video API rejects a clip with `invalid_image`.
- The pinned `@ffmpeg-installer` binary has no `xfade` filter. A system FFmpeg on the path is preferred. Assembly still succeeds, as a hard-cut concat, on the old binary.
- An unset MCP environment variable can arrive as a literal `${VAR}` string. theShow treats that shape as absent, so it is not sent as a bearer token.

## Where this goes next

The plugin is at 0.1.0, and a film can go from the card to a polled job to a file. This document is the write-up, so publishing the install path is the page you are reading.

Still open, and absent from the tree: a marketplace catalog entry pinned to a SHA, and slash commands under `commands/`.

If you build something with it, the interesting problems left are continuity problems: how to hold a location, a light source, or a prop across a cut. That is where the tool earns its keep.
