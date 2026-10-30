# theShow as a Grok Plugin

This directory contains the scaffolding to turn theShow (StoryForge) into a Grok Build plugin and MCP server for controlled video generation.

## Structure

- `plugin.json` – Grok Build plugin manifest
- `.mcp.json` – MCP server declaration
- `skills/theshow/SKILL.md` – Detailed workflow instructions for Grok
- `mcp/server.ts` – MCP server skeleton exposing the core tools

## How to Use

### Local Grok Build Plugin

1. Copy this folder into `~/.grok/plugins/theshow` or into a project `.grok/plugins/theshow`.
2. Or point a marketplace source at this repo path.
3. In Grok Build TUI: `/plugins` → enable theshow.
4. Ask Grok to “generate a controlled multi-shot film with theShow” — the skill will guide it.

### Remote MCP (Grok API / Connectors)

1. Deploy the MCP server (HTTP Streamable recommended for remote).
2. In grok.com/connectors → New Connector → Custom → paste the public MCP URL.
3. Or pass `mcp(server_url=...)` in the xAI SDK tools array.

### Integration Notes

- The MCP tools are currently stubs. Wire them to the existing Express routes in `server.ts` or directly to the Google GenAI / xAI video APIs.
- Prefer Grok Imagine Video 1.5 for native support of up to 14 reference images, first/last frames, keyframes, and extension.
- Keep the Veo path as a fallback for existing projects.

## Next Steps

1. Replace stub implementations with real calls.
2. Add authentication (API key or session) to the MCP server.
3. Submit a catalog entry to https://github.com/xai-org/plugin-marketplace (remote source + SHA pin).
4. Add slash commands under `commands/` if desired.

See the main theShow README for running the full UI.
