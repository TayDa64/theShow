// StoryForge Studio — LIVE Veo two-clip lion-greeting workflow (opt-in, consumes quota).
//
// ⚠️ This spec calls REAL Veo and will consume your daily video-generation quota
//    (2 generations for this two-clip greeting). It is intentionally OPT-IN.
//
// How to run it:
//   1. Export a Gemini API key that actually has Veo API access:
//        # bash / git-bash
//        export GEMINI_API_KEY="your-key"
//        export RUN_LIVE_VEO=1
//        npx playwright test lion-greeting-live
//
//   2. Optional: cap usage at the app layer so it can never exceed your intent:
//        export WORKSPACE_VIDEO_DAILY_LIMIT=2
//
// What it proves:
//   - Whether GEMINI_API_KEY has live Veo access. If it does, two real ~6s clips
//     (12s total) are generated, assembled, and downloaded as a real MP4.
//   - If the key LACKS Veo access (common with consumer Google AI Pro / free
//     AI Studio keys), the server falls back to sandbox and this test FAILS with a
//     clear, actionable message — definitively answering "is Veo API available?".
//
// Why this is a separate, gated spec (not a rewrite of the sandbox spec):
//   Making the default suite "always live" would burn quota or fail on every
//   `npx playwright test`. Gating behind RUN_LIVE_VEO keeps the default suite free
//   and deterministic while still providing a true live path on demand.

import { expect, test, type APIRequestContext } from '@playwright/test';

const BASE_URL = process.env.PLAYWRIGHT_BASE_URL ?? 'http://127.0.0.1:3100';
const RUN_LIVE = process.env.RUN_LIVE_VEO === '1' || process.env.RUN_LIVE_VEO === 'true';
const HAS_KEY = !!(process.env.GEMINI_API_KEY && process.env.GEMINI_API_KEY.trim());

// Two lions exchanging a greeting. Each beat is a 6s shot => 12s total.
const LION_GREETING = [
  {
    shotId: 'lion-greeting-shot-1',
    speaker: 'Tawny Lion',
    line: 'Good morning, friend. The savanna is warm today.',
    durationSeconds: 6 as const,
  },
  {
    shotId: 'lion-greeting-shot-2',
    speaker: 'Grey-Maned Lion',
    line: 'Good morning to you. May your hunt be swift and your pride be safe.',
    durationSeconds: 6 as const,
  },
];

const TOTAL_EXPECTED_SECONDS = LION_GREETING.reduce((sum, beat) => sum + beat.durationSeconds, 0);

async function registerLocalAccount(request: APIRequestContext) {
  const nonce = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const response = await request.post(`${BASE_URL}/api/auth/register`, {
    data: {
      name: `Lion Live ${nonce.slice(-6)}`,
      email: `lion-live-${nonce}@example.com`,
      password: 'Passw0rd!23',
    },
  });

  expect(response.status(), 'account registration should succeed').toBe(201);
  const body = await response.json();
  expect(body.csrfToken, 'registration should return a CSRF token').toBeTruthy();

  // With GEMINI_API_KEY set in the server env and no personal key linked, the account
  // should resolve to the live "workspace" provider.
  expect(
    body.provider?.mode,
    'expected workspace provider mode — is GEMINI_API_KEY set in the server env?',
  ).toBe('workspace');
  expect(body.provider?.liveVideoEnabled, 'workspace provider should enable live video').toBeTruthy();

  return { csrfToken: body.csrfToken as string };
}

async function pollLiveOperation(request: APIRequestContext, csrfToken: string, operationName: string) {
  // Live Veo can take a few minutes per clip; poll up to ~6 minutes.
  const maxAttempts = 180;
  const intervalMs = 2000;

  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    const response = await request.post(`${BASE_URL}/api/video-status`, {
      headers: { 'x-csrf-token': csrfToken },
      data: { operationName },
    });

    expect(response.ok(), 'video-status should respond OK').toBeTruthy();
    const body = await response.json();

    if (body.done) {
      expect(body.error, `live operation ${operationName} should not finish with an error`).toBeFalsy();
      return body;
    }

    // eslint-disable-next-line no-await-in-loop
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }

  throw new Error(`Live operation ${operationName} did not complete within the polling window.`);
}

test.describe('LIVE: Lion greeting two-clip workflow (consumes Veo quota)', () => {
  // 15 minutes: two serial live renders + assembly + download.
  test.setTimeout(15 * 60_000);

  test('generates two real Veo clips (~12s total) and assembles a downloadable film', async ({ request }) => {
    test.skip(
      !RUN_LIVE,
      'Opt-in only: set RUN_LIVE_VEO=1 (and GEMINI_API_KEY with Veo access) to run. Consumes 2 daily generations.',
    );
    expect(
      HAS_KEY,
      'GEMINI_API_KEY must be set in the server environment for the live Veo path.',
    ).toBeTruthy();

    const { csrfToken } = await registerLocalAccount(request);

    const scene = {
      id: 'lion-greeting-scene',
      title: 'Two Lions Greet at Dawn',
      description: 'Two lions meet on the open savanna and exchange a warm greeting.',
      lighting: 'sunset-warm',
      dialogues: LION_GREETING.map((beat, index) => ({
        id: `lion-dialogue-${index + 1}`,
        characterId: `lion-${index + 1}`,
        text: beat.line,
        sentiment: 'playful',
      })),
    };

    const characters = [
      { id: 'lion-1', name: 'Tawny Lion', role: 'Pride Greeter' },
      { id: 'lion-2', name: 'Grey-Maned Lion', role: 'Elder Lion' },
    ];

    const camera = { aspectRatio: '16:9', shotType: 'medium-shot', focalLength: 50, tiltAngle: 'eye-level' };

    const clips: Array<{
      shotId: string;
      title: string;
      order: number;
      operationName: string;
      durationSeconds: number;
    }> = [];

    for (let index = 0; index < LION_GREETING.length; index += 1) {
      const beat = LION_GREETING[index];

      const shot = {
        id: beat.shotId,
        shotNumber: index + 1,
        title: `${beat.speaker} greeting`,
        shotType: 'medium-shot',
        durationSeconds: beat.durationSeconds,
        composition: 'Two lions framed together on the savanna at golden hour.',
        action: `${beat.speaker} greets the other lion warmly.`,
        dialogueLineIds: [`lion-dialogue-${index + 1}`],
        dialogueExcerpt: beat.line,
        continuityNotes: 'Maintain savanna setting, golden-hour light, and both lions in frame.',
        seedStrategy: 'auto',
        transitionInMode: index === 0 ? 'none' : 'previous-shot',
      };

      const renderResponse = await request.post(`${BASE_URL}/api/generate-shot-video`, {
        headers: { 'x-csrf-token': csrfToken },
        data: { characters, scene, shot, camera },
      });

      expect(renderResponse.ok(), `shot ${index + 1} render request should succeed`).toBeTruthy();
      const renderBody = await renderResponse.json();

      // The whole point of the live spec: assert REAL Veo was used, not the sandbox fallback.
      if (renderBody.isFallback) {
        throw new Error(
          `Live Veo was NOT used for shot ${index + 1}: the server fell back to sandbox ` +
            `(providerMode=${renderBody.providerMode}). This means GEMINI_API_KEY does not have Veo API access. ` +
            `Veo over the Gemini API requires API-tier access with billing — a Google account login or ` +
            `consumer Google AI Pro subscription does not grant it.`,
        );
      }

      expect(renderBody.providerMode, `shot ${index + 1} should run on the live workspace provider`).toBe('workspace');
      expect(renderBody.operationName, `shot ${index + 1} should return an operation name`).toBeTruthy();
      expect([4, 6, 8]).toContain(renderBody.durationSeconds);
      expect(renderBody.durationSeconds).toBe(beat.durationSeconds);

      await pollLiveOperation(request, csrfToken, renderBody.operationName);

      clips.push({
        shotId: beat.shotId,
        title: shot.title,
        order: index + 1,
        operationName: renderBody.operationName,
        durationSeconds: renderBody.durationSeconds,
      });
    }

    expect(clips).toHaveLength(2);
    const totalSeconds = clips.reduce((sum, clip) => sum + clip.durationSeconds, 0);
    expect(totalSeconds).toBe(TOTAL_EXPECTED_SECONDS);
    expect(totalSeconds).toBe(12);

    const assembleResponse = await request.post(`${BASE_URL}/api/assemble-film`, {
      headers: { 'x-csrf-token': csrfToken },
      data: { title: 'Two Lions Greet at Dawn (Live)', clips, aspectRatio: '16:9' },
    });

    expect(assembleResponse.ok(), 'assemble-film should succeed').toBeTruthy();
    const assembleBody = await assembleResponse.json();
    expect(assembleBody.status).toBe('completed');
    expect(assembleBody.clipCount).toBe(2);
    expect(assembleBody.downloadUrl, 'assembly should return a download URL').toMatch(/^\/api\/download-film\//);

    const downloadResponse = await request.get(`${BASE_URL}${assembleBody.downloadUrl}`, {
      headers: { 'x-csrf-token': csrfToken },
    });

    expect(downloadResponse.ok(), 'film download should succeed').toBeTruthy();
    expect(downloadResponse.headers()['content-type']).toContain('video/mp4');

    const filmBuffer = await downloadResponse.body();
    expect(filmBuffer.byteLength).toBeGreaterThan(10_000);
    expect(filmBuffer.subarray(0, 64).includes(Buffer.from('ftyp'))).toBeTruthy();
  });
});
