<div align="center">
<img width="1200" height="475" alt="GHBanner" src="https://ai.google.dev/static/site-assets/images/share-ais-513315318.png" />
</div>

# Run and deploy your AI Studio app

This contains everything you need to run your app locally.

View your app in AI Studio: https://ai.studio/apps/43fefd0e-4d16-4be5-b3fc-939d925757a1

## Run Locally

**Prerequisites:**  Node.js


1. Install dependencies:
   `npm install`
2. Set the `GEMINI_API_KEY` in [.env.local](.env.local) to your Gemini API key
3. Optional but recommended for secure account/provider storage:
   - `SESSION_SECRET` — used for hardened local session handling
   - `STORYFORGE_ENCRYPTION_KEY` — used to encrypt any user-linked Gemini API keys at rest
4. Run the app:
   `npm run dev`

## Account dashboard and secure login

The app now includes an **Account** dashboard for secure sign-in, session management, and Gemini provider isolation.

- You can keep working in **local draft mode** without signing in.
- Sign-in is required for **cloud sync** and the authenticated AI/video API routes.
- StoryForge keeps **app login** separate from **Gemini provider credentials**.
- If you connect a personal Gemini API key in the Account dashboard, it is stored **server-side only** and encrypted at rest.

### Provider modes

- **Personal** — your account uses its own linked Gemini API key and quota.
- **Workspace** — the app uses the server's shared `GEMINI_API_KEY`.
- **Sandbox** — no live Gemini API key is active, so supported routes fall back to local/mock behavior.

### Cloud sync behavior

- Anonymous users save to browser localStorage only.
- Authenticated users load/save a **user-scoped** project state on the server.
- Legacy `sandbox-state.json` data is treated as a fallback source for first authenticated load.

## What changed in this implementation

This project now supports a continuity-first workflow for building short or long-form video sequences with Google GenAI:

- **Character roster reference uploads**
   - Each character can keep using the existing **AI-generated portrait from description** path.
   - Characters can now also upload **reference images** into a continuity library.
   - The active portrait can come from either an uploaded reference or an AI-generated image.

- **Scene background reference uploads**
   - Each scene now has its own **background reference library**.
   - This is intended to help preserve atmosphere, set dressing, and recurring location continuity.

- **Storyboard shot planning**
   - Scenes can now be expanded into **multiple storyboard beats/shots** instead of being treated as one flattened clip.
   - Each shot stores title, framing, action, dialogue excerpt, duration, and continuity notes.

- **Two export modes**
   - **Quick Preview** keeps the original one-scene / one-clip preview path for fast iteration.
   - **Storyboard Mode** renders **one Veo clip per storyboard shot** so longer dialogue is not compressed into a single short preview.

## Google model usage

- **Gemini** is used for text-generation tasks such as character/dialogue/storyboard planning.
- **Veo 3.1 Lite** is still used for the existing quick preview flow.
- **Veo 3.1 Generate Preview** is used for storyboard shot rendering when continuity references matter.

## Important Veo storyboard constraints

The current implementation is aligned to the practical constraints we verified for the installed Google SDK and Veo preview workflow:

- Reference-image shot rendering should assume **up to 3 total reference images per shot**.
- Reference-image mode should assume **8-second shots**.
- Raster image formats such as **PNG / JPEG / WEBP** are the safest continuity references for Veo.
- Storyboard rendering is intentionally **sequential** because Veo returns **one video per request**.

## Upload storage behavior

- Uploaded continuity images are stored locally in the repo's `uploads/` directory.
- That directory is now git-ignored for local development.
- Local sandbox state is also ignored via `sandbox-state.json`.

## Quota and fallback behavior

- If Veo quota or billing is not available, the app can fall back to sandbox/mock behavior for preview flows.
- Storyboard planning also includes a local fallback path when `GEMINI_API_KEY` is unavailable.

## Suggested workflow

1. Create or edit characters in the roster.
2. Optionally upload character reference images for continuity.
3. Create scenes and add dialogue.
4. Optionally upload scene background references and atmosphere notes.
5. Generate or refine storyboard shots in the scene editor.
6. Use **Quick Preview** for a fast concept check.
7. Use **Storyboard Mode** when you want the scene rendered as separate beats/clips for better continuity and longer dialogue coverage.
