# theShow as a Grok Plugin

This turns theShow (StoryForge) into a Grok Build plugin and MCP server for controlled, continuity-first video generation. The [main README](README.md) has the proof film and the full story; this file is the component map.

## Structure

| Path | What it is |
|---|---|
| `.grok-plugin/plugin.json` | Grok Build plugin manifest — the path the marketplace index reads |
| `.mcp.json` | MCP server declaration |
| `mcp/launch.mjs` | Launcher. Runs the pre-bundled server from its own directory |
| `mcp/server.bundle.mjs` | The server, bundled so startup installs nothing |
| `mcp/server.ts` | Tool definitions — edit here, then rebuild the bundle |
| `skills/theshow/SKILL.md` | The workflow the model follows |
| `commands/*.md` | The ten slash commands. `/theshow` is the primary start |

## Install

```bash
grok plugin install TayDa64/theShow --trust
```

Pin a release by appending a tag, for example `TayDa64/theShow@v0.1.0`. To install from a local checkout, pass the folder path instead of the GitHub shorthand.

The server ships pre-bundled, so there is no `npm install` step and startup needs no network. Confirm the wiring:

```bash
grok mcp doctor
```

You should see `theshow` healthy with **thirteen tools** discovered.

Startup used to fail during initialize for two reasons, both now fixed. It ran `npm install` inside the handshake, about thirteen seconds of work that overran the client's initialize window; and Grok resolves a relative path in `.mcp.json` from the user's home directory rather than the plugin folder, so the entry point is `${GROK_PLUGIN_ROOT}/mcp/launch.mjs`. Updating an existing install needs an uninstall first:

```bash
grok plugin uninstall theshow && grok plugin install TayDa64/theShow --trust
```

## Use

Ask for a film in plain language:

> Generate a two-shot, 16-second film about a lamplighter in the rain. Keep the same character in both shots.

Or start from a command. `/theshow` is the primary start. The file is `commands/theshow.md`. Grok lowercases the slash string, so you type `/theshow`. The qualified form is `/theshow:theshow`. A slash command loads instructions. The model then calls `configure_film`. It does not open the form by itself. `/film` follows the same recipe.

| Command | What it does |
|---|---|
| `/theshow <idea>` | Primary start. configure_film, board, contract, then render |
| `/film <idea>` | The same recipe as `/theshow` |
| `/scene <scene> [shots]` | Storyboard only. Free |
| `/character <name> [look] [photo]` | Create or update a character |
| `/board <scene or jobId>` | Board as stills, $0.02 a frame |
| `/render <shots.json>` | Render a planned shot list |
| `/check [jobId]` | Progress and cost, or recent films |
| `/retry <jobId> <shot> [prompt]` | Repair one shot |
| `/films [count]` | List films on disk. Free |
| `/continue <jobId> <what next>` | Continue an existing film |

## The thirteen tools

| Tool | Costs | Role |
|---|---|---|
| `configure_film` | free | The whole brief on one interactive form, with a cost estimate |
| `create_character` | free | Stores a named character on disk, with its reference photos copied into its own folder |
| `plan_storyboard` | free | Turns a scene into numbered shots |
| `board_film` | $0.02 a still | Boards a film as stills, one per shot boundary, so every cut lands on identical pixels |
| `generate_still` | $0.02 | One image, for a frame you want on its own |
| `render_sequence` | per shot | Renders a whole shot list with automatic frame-to-frame continuity, then assembles it |
| `check_sequence` | free | Progress and real cost on a running sequence |
| `retry_shot` | one shot | Re-renders one bad shot and splices it back, reusing every other shot free |
| `list_films` | free | Films on disk with job ids, costs and paths, including earlier sessions |
| `generate_controlled_clip` | per shot | One clip, optionally bookended by a first and a last frame |
| `extract_last_frame` | free | Pulls the bridge frame out of a rendered clip |
| `assemble_film` | free | Joins ordered clips with FFmpeg, hard cuts by default |
| `extend_clip` | per call | Continues an existing take. API-key backends only |

## Continuity, in one paragraph

A boarded film produces N+1 stills for N shots, so the boundary between two shots is one picture used as both the first shot's last frame and the second's first frame. Every cut is between two uses of the same file. When the cast includes a character whose role is `Location`, that photo becomes the base each frame is edited from, and the board spends one extra still building a hero frame of the cast inside the room first — measured skyline agreement 0.72 that way against 0.57 editing from the location alone. The `cast` line describes the reference photo rather than arguing with it; `mcp/cast.ts` rewrites a garment the picture contradicts. A colour-based garment check was built and removed: it learned the coat from the hero's arms, the hero is cropped at the chest, and it abstained on every frame of a real board. Better to say so than to imply a safeguard that does not fire.

## Authentication

Tools resolve a credential in this order:

1. **`XAI_API_KEY`** if set and not a literal `${XAI_API_KEY}` placeholder — billed as xAI API credits.
2. **Grok subscription session** — read from `~/.grok/auth.json` after `grok login`. No API key required.

Subscription sessions cannot use `extend_clip`; the proxy answers `POST /v1/videos/extensions` with HTTP 405. Continuity is carried instead by passing each shot the previous clip's extracted last frame as `firstFrameUrl`, which must be an image.

## Remote MCP (Grok API / Connectors)

1. Deploy the MCP server, using HTTP Streamable for remote access.
2. In grok.com/connectors, choose New Connector, then Custom, and paste the public MCP URL.
3. Alternatively pass `mcp(server_url=...)` in the xAI SDK tools array.

## Cost

Every clip is a real charge, and resolution sets the price. Measured on eight-second renders:

| Resolution | Output | Per second | 8-second shot |
|---|---|---|---|
| `480p` | 848×480 | $0.08 | $0.64 |
| `720p` | 1280×720 | $0.14 | $1.12 |
| `1080p` | 1920×1088 | $0.25 | $2.00 |

A still is $0.02. The default is 720p, so a four-shot six-second film runs about $3.44. Every render returns its exact `costUsd` in the tool result, which is the number to trust.

## Developing

```bash
npm run build:mcp    # mcp/server.ts → mcp/server.bundle.mjs
npm test             # 174 tests across 15 files
```

The bundle is committed on purpose. After changing anything under `mcp/`, rebuild and commit it, or the plugin keeps running the old code.

## Where this goes next

Still open: a public write-up beyond these docs.

## License

MIT. See [LICENSE](LICENSE).

See the [main README](README.md) for the proof film, the network and file access list, and running the full StoryForge Studio UI.
