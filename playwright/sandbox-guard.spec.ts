/**
 * The lion shot must come back as a sandbox preview.
 * Removing THESHOW_VIDEO_BACKEND=sandbox from the Playwright webServer makes
 * this request 503 with code no-video-backend, because an unpinned server
 * with no credential refuses to pretend a mock clip is a render.
 */
import { expect, test } from './hermetic.ts';
import { browserFetch } from './browser-api.ts';

test('a lion shot reports the sandbox provider and never Grok or Gemini', async ({ page }) => {
  await page.goto('/');
  const registered = await browserFetch(page, '/api/auth/register', {
    data: {
      name: 'Sandbox Guard',
      email: `sandbox-guard-${Date.now()}@example.com`,
      password: 'Passw0rd!23',
    },
  });
  expect(registered.status()).toBe(201);
  const account = await registered.json();
  const csrf = account.csrfToken as string;
  expect(account.provider?.mode).toBe('sandbox');

  const response = await browserFetch(page, '/api/generate-shot-video', {
    headers: { 'x-csrf-token': csrf },
    data: {
      characters: [{ id: 'lion-1', name: 'Tawny Lion', role: 'Pride Greeter' }],
      scene: {
        id: 'lion-greeting-scene',
        title: 'Two Lions Greet at Dawn',
        description: 'Two lions meet on the open savanna and exchange a warm greeting.',
        lighting: 'sunset-warm',
        dialogues: [],
      },
      shot: {
        id: 'lion-greeting-shot-1',
        shotNumber: 1,
        title: 'Tawny Lion greeting',
        shotType: 'medium-shot',
        durationSeconds: 6,
        action: 'Tawny Lion greets the other lion warmly.',
        dialogueExcerpt: 'Good morning, friend. The savanna is warm today.',
      },
      camera: { aspectRatio: '16:9', shotType: 'medium-shot', focalLength: 50, tiltAngle: 'eye-level' },
      resolvedSeed: 1234,
    },
  });

  expect(response.status(), await response.text()).toBe(200);
  const body = await response.json();
  expect(body.isFallback).toBe(true);
  expect(body.providerMode).toBe('sandbox');
  expect(body.backend).toBe('sandbox');
  expect(body.videoBackend).toBe('sandbox');
  expect(body.code).not.toBe('no-video-backend');
  const text = JSON.stringify(body);
  expect(text).not.toMatch(/"backend":"grok"|"backend":"gemini"|"videoBackend":"grok"|"videoBackend":"gemini"/);
});
