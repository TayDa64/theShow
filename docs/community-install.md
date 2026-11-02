# theShow: continuity-first video generation as a Grok plugin

Most AI video tools give you a slot machine. You type a sentence, you get eight seconds, and the next eight seconds has a different face, a different coat, and a different street.

theShow is a plugin for Grok Build that treats a film as a sequence of planned shots instead of one lucky prompt. You describe a scene; it plans a storyboard, keeps your characters consistent across shots by feeding each clip the previous clip's final frame, and assembles the result with FFmpeg. It runs on your Grok subscription, so you do not need a separate API key.

This is how to install it and make your first film.

## Install

```bash
grok plugin install TayDa64/theShow --trust
```

That is the whole setup. The plugin ships a pre-bundled server, so there is no `npm install` step, no network fetch at startup, and nothing to configure before you start.

Confirm it worked:

```bash
grok mcp doctor
```

You want to see `theshow` reported healthy with seven tools discovered. If it reports a failure, the details line names the missing piece.

### Run it on your own machine, not in a cloud sandbox

This one costs people an afternoon if they hit it blind. Plugins install per machine, into `~/.grok/installed-plugins/` on the computer where you ran the command. A Grok Build session started from a web share link runs in a throwaway cloud sandbox with its own empty workspace, and it cannot see your installed plugins.

The symptom is subtle: you give it a perfect prompt, it produces video anyway, and nothing about the output mentions the plugin. It quietly fell back to the built-in image and video tools plus hand-written FFmpeg, which is the exact manual slog this plugin removes.

If a session seems to ignore theShow, check whether it actually called the tools. Run `grok mcp doctor` where the session is running. Six healthy tools means you are in the right place.

If you installed an early version and the doctor reports `handshake failed (connection closed: initialize response)`, one of two things was wrong: an early release installed dependencies during startup and overran the client's initialize window, or the manifest used a relative path that resolved from your home directory instead of the plugin folder. Both are fixed. Update with:

```bash
grok plugin uninstall theshow && grok plugin install TayDa64/theShow --trust
```

## Your first film

Ask in plain language. You never call the tools yourself.

> Generate a two-shot, 16-second film about a lamplighter in the rain. Keep the same character in both shots.

Here is what happens behind that sentence.

**Character.** `create_character` stores your subject by name with any reference images you supply. This is the anchor everything else refers to, so a named character with a portrait produces far more stable results than describing a person in prose each time.

**Storyboard.** `plan_storyboard` breaks the scene into numbered shots with framing notes and continuity cues. Ask for more shots and you get more shots; the count and the total duration are honored rather than ignored.

**Clips.** `generate_controlled_clip` renders each shot in order. For every shot after the first, `extract_last_frame` pulls the final frame from the previous clip and passes it forward, so the next shot begins exactly where the last one ended.

**Assembly.** `assemble_film` cross-fades the ordered clips into a single file.

## What it costs

Every clip is a real charge against your subscription. In measured runs, an eight-second Grok Imagine clip came to roughly $0.64. A three-shot film is therefore around $2 before assembly, and a ten-shot film around $6.40.

Plan the storyboard before you generate, not after. Re-rendering a shot because the framing was wrong in the plan is the expensive mistake.

Each render reports its exact cost in the tool result as `costUsd`, converted from the API's `usage.cost_in_usd_ticks`. Read it from there to audit a project rather than estimating. (The StoryForge web app additionally writes a sidecar JSON beside each clip, but that is the app's own bookkeeping and is not part of the MCP tools — do not go looking for a sidecar file after a plain plugin run.)

## Authentication

The plugin picks a backend in this order:

1. `XAI_API_KEY` if it is set, billed as xAI API credits.
2. Your Grok subscription session, picked up from `~/.grok/auth.json` after you run `grok login`. No API key needed.
3. Veo through `GEMINI_API_KEY`, where configured.

Most people will land on option two, and that is the point: if you already pay for Grok, you already have the video budget.

One limitation to know about. The subscription proxy rejects clip extensions, so `extend_clip` works only with an API key. On a subscription, continuity comes from the first-frame handoff described above, which in practice produces cleaner cuts anyway.

## Two ways to run it

The plugin is the fast path, and it lives inside Grok Build where you are already talking.

The full StoryForge Studio interface is the other. Clone the repository, run `npm install` and `npm run dev`, open `http://localhost:3000`, and create a local account on first visit. You get a visual storyboard, per-shot generation controls, and a project view. The banner at the top tells you which backend is live; if it does not say the Grok subscription is active, your credentials are not being picked up and nothing will render.

## Known edges

- `firstFrameUrl` must be an image. Handing it a video returns an invalid-image error.
- The bundled FFmpeg build is old and lacks cross-fade filters. Install a system FFmpeg and the plugin will prefer it.
- Unset environment variables referenced in the MCP config can arrive as literal `${VAR}` strings, which some servers mistake for a real token. theShow rejects that shape explicitly, but it is worth knowing if you write your own server.

## Where this goes next

The plugin is at 0.1.0 and the pipeline is working end to end. The open items are a marketplace catalog entry with a pinned SHA, slash commands for the common recipes, and publishing this write-up so the install path is discoverable.

If you build something with it, the interesting problems left are all continuity problems: how to hold a location, a light source, or a prop across a cut. That is where the tool earns its keep.
