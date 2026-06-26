// StoryForge Studio — two-clip lion-greeting workflow (sandbox/mock, zero Veo quota).
//
// What this validates end-to-end against the real server pipeline:
//   1. A local StoryForge account can authenticate (no Google sign-in, no Gemini key).
//   2. Two storyboard shots — a greeting exchange between two lions — each render a
//      real local MP4 via the sandbox/mock pipeline.
//   3. Per-shot duration is derived from the dialogue beat and stays within the app's
//      allowed shot durations (4 / 6 / 8s). Two 6s clips => ~12s total.
//   4. The two clips assemble into a single downloadable film.
//   5. The downloaded artifact is a real MP4 (has an `ftyp` box) of non-trivial size.
//
// This test intentionally stays in SANDBOX mode:
//   - It never links a Gemini API key.
//   - It never calls live Veo.
//   - It consumes ZERO daily video-generation quota.
//
// It drives the API directly (Playwright `request`) because the film pipeline is a
// server-orchestrated flow; this is more reliable than UI seed/anchor timing and is
// the same surface the UI ultimately calls.

import { expect, test, type APIRequestContext } from '@playwright/test';

const BASE_URL = process.env.PLAYWRIGHT_BASE_URL ?? 'http://127.0.0.1:3100';

// Two lions exchanging a greeting. Each beat maps to a 6s shot => 12s total.
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
      name: `Lion Workflow ${nonce.slice(-6)}`,
      email: `lion-workflow-${nonce}@example.com`,
      password: 'Passw0rd!23',
    },
  });

  expect(response.status(), 'account registration should succeed').toBe(201);
  const body = await response.json();
  expect(body.csrfToken, 'registration should return a CSRF token').toBeTruthy();
  return { csrfToken: body.csrfToken as string };
}

async function pollOperation(request: APIRequestContext, csrfToken: string, operationName: string) {
  // Mock operations complete in ~6s of simulated render time; poll generously.
  const maxAttempts = 40;
  const intervalMs = 1000;

  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    const response = await request.post(`${BASE_URL}/api/video-status`, {
      headers: { 'x-csrf-token': csrfToken },
      data: { operationName },
    });

    expect(response.ok(), 'video-status should respond OK').toBeTruthy();
    const body = await response.json();

    if (body.done) {
      expect(body.error, `operation ${operationName} should not finish with an error`).toBeFalsy();
      return body;
    }

    // eslint-disable-next-line no-await-in-loop
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }

  throw new Error(`Operation ${operationName} did not complete within the polling window.`);
}

test.describe('Lion greeting two-clip workflow (sandbox)', () => {
  test.setTimeout(180_000);

  test('renders two dialogue-driven clips (~12s total) and assembles a downloadable film', async ({ request }) => {
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

    // Render each greeting beat as its own sandbox clip, with duration driven by the beat.
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
        data: { characters, scene, shot, camera, resolvedSeed: 1234 + index },
      });

      expect(renderResponse.ok(), `shot ${index + 1} render request should succeed`).toBeTruthy();
      const renderBody = await renderResponse.json();

      // Sandbox/mock path must be active (no Gemini key linked) — this is the safe, zero-quota path.
      expect(renderBody.isFallback, `shot ${index + 1} should use the sandbox fallback path`).toBeTruthy();
      expect(renderBody.providerMode, `shot ${index + 1} should run in sandbox provider mode`).toBe('sandbox');
      expect(renderBody.operationName, `shot ${index + 1} should return an operation name`).toBeTruthy();

      // Duration is dialogue-beat driven and must remain within the app's allowed shot durations.
      expect([4, 6, 8]).toContain(renderBody.durationSeconds);
      expect(renderBody.durationSeconds).toBe(beat.durationSeconds);

      await pollOperation(request, csrfToken, renderBody.operationName);

      clips.push({
        shotId: beat.shotId,
        title: shot.title,
        order: index + 1,
        operationName: renderBody.operationName,
        durationSeconds: renderBody.durationSeconds,
      });
    }

    // Two clips, ~12s total.
    expect(clips).toHaveLength(2);
    const totalSeconds = clips.reduce((sum, clip) => sum + clip.durationSeconds, 0);
    expect(totalSeconds).toBe(TOTAL_EXPECTED_SECONDS);
    expect(totalSeconds).toBe(12);

    // Assemble the two clips into a single film.
    const assembleResponse = await request.post(`${BASE_URL}/api/assemble-film`, {
      headers: { 'x-csrf-token': csrfToken },
      data: { title: 'Two Lions Greet at Dawn', clips, aspectRatio: '16:9' },
    });

    expect(assembleResponse.ok(), 'assemble-film should succeed').toBeTruthy();
    const assembleBody = await assembleResponse.json();
    expect(assembleBody.status).toBe('completed');
    expect(assembleBody.clipCount).toBe(2);
    expect(assembleBody.downloadUrl, 'assembly should return a download URL').toMatch(/^\/api\/download-film\//);

    // Download the assembled film and verify it is a real MP4.
    const downloadResponse = await request.get(`${BASE_URL}${assembleBody.downloadUrl}`, {
      headers: { 'x-csrf-token': csrfToken },
    });

    expect(downloadResponse.ok(), 'film download should succeed').toBeTruthy();
    expect(downloadResponse.headers()['content-type']).toContain('video/mp4');

    const filmBuffer = await downloadResponse.body();
    // A real assembled 12s MP4 is comfortably larger than a few KB.
    expect(filmBuffer.byteLength).toBeGreaterThan(10_000);
    // MP4 files contain an `ftyp` box near the start of the container.
    expect(filmBuffer.subarray(0, 64).includes(Buffer.from('ftyp'))).toBeTruthy();
  });
});
