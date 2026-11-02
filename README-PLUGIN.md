# theShow as a Grok Plugin

This directory turns theShow (StoryForge) into a Grok Build plugin and MCP server for controlled, continuity-first video generation.

## Structure

- `plugin.json` — Grok Build plugin manifest
- `.mcp.json` — MCP server declaration
- `mcp/launch.mjs` — launcher (runs the pre-bundled server)
- `mcp/server.bundle.mjs` — the server, bundled so startup needs no install
- `skills/theshow/SKILL.md` — workflow instructions the model follows
- `mcp/server.ts` — MCP server exposing the core tools

## Install

The fastest path pulls straight from GitHub:

```bash
grok plugin install TayDa64/theShow --trust
```

Pin a release by appending a tag, for example `TayDa64/theShow@v0.1.0`. To install from a local checkout instead, pass the folder path in place of the GitHub shorthand.

The server ships pre-bundled, so there is no `npm install` step and startup needs no network. Confirm the wiring with:

```bash
grok mcp doctor
```

You should see `theshow` healthy with nine tools discovered.

## Use

Ask for a film in plain language:

> Generate a two-shot, 16-second film about a lamplighter in the rain. Keep the same character in both shots.

The bundled skill sequences the tools for you:

| Tool | Role |
|---|---|
| `configure_film` | Collects the whole brief as one interactive form card, with a cost estimate |
| `render_sequence` | Renders a whole shot sequence with automatic frame-to-frame continuity, then assembles it |
| `check_sequence` | Reports progress and real cost on a running sequence (free) |
| `create_character` | Stores a named character with reference images |
| `plan_storyboard` | Turns a scene into numbered shots |
| `generate_controlled_clip` | Renders one shot, optionally seeded by the previous clip's last frame |
| `extract_last_frame` | Produces the bridge frame for the next shot |
| `extend_clip` | Continues an existing take (API-key backends only) |
| `assemble_film` | Cross-fades the ordered clips into one film with FFmpeg |

## Authentication

`generate_controlled_clip` resolves a backend in this order:

1. **`XAI_API_KEY`** if set — billed as xAI API credits.
2. **Grok subscription session** — read from `~/.grok/auth.json` after `grok login`. No API key required.
3. **Veo** via `GEMINI_API_KEY`, where configured.

Subscription sessions cannot use `extend_clip`; the proxy rejects extensions. Continuity is carried instead by passing each shot the previous clip's extracted last frame as `firstFrameUrl`, which must be an image.

## Remote MCP (Grok API / Connectors)

1. Deploy the MCP server, using HTTP Streamable for remote access.
2. In grok.com/connectors, choose New Connector, then Custom, and paste the public MCP URL.
3. Alternatively pass `mcp(server_url=...)` in the xAI SDK tools array.

## Integration Notes

- The MCP tools are live. `generate_controlled_clip` renders real video through the xAI API or a Grok subscription session, and `assemble_film` stitches clips with FFmpeg cross-fades.
- Grok Imagine Video 1.5 supports up to 14 reference images plus first/last frames, keyframes, and extension.
- Keep the Veo path as a fallback for existing projects.

## Cost

Every clip is a real charge, and resolution sets the price. Measured on eight-second renders: $0.64 at 480p, $1.12 at 720p, $2.00 at 1080p. The default is 720p, so a three-shot film runs about $3.40 before assembly. Every render returns its exact `costUsd` in the tool result, which is the number to trust.

## Next Steps

1. Submit a catalog entry to https://github.com/xai-org/plugin-marketplace, using a remote source with a SHA pin.
2. Add slash commands under `commands/` for common recipes.
3. Publish a public write-up covering install, a first film, and cost expectations.

See the main theShow README for running the full StoryForge UI.
