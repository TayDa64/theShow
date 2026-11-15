/**
 * Request shape for a clip: voice id, and start-only pinning.
 * Fetch is stubbed. No credential file under ~/.grok is read.
 */
import fs from 'fs';
import os from 'os';
import path from 'path';
import { afterEach, describe, expect, it } from 'vitest';
import { generateGrokClip } from '../mcp/grokVideo.ts';

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'theshow-payload-'));

function useFakeSession() {
  const authFile = path.join(tempDir, 'auth.json');
  const expires = new Date(Date.now() + 3_600_000).toISOString();
  fs.writeFileSync(authFile, JSON.stringify({
    'https://auth.example.test::client': {
      key: 'test-session-token',
      expires_at: expires,
    },
  }));
  process.env.GROK_AUTH_FILE = authFile;
  delete process.env.XAI_API_KEY;
}

afterEach(() => {
  process.env.GROK_AUTH_FILE = '/nonexistent/theshow-test-auth.json';
});

function stubFetch() {
  const bodies: Array<Record<string, unknown>> = [];
  globalThis.fetch = (async (_input: unknown, init?: { body?: string }) => {
    if (init?.body) bodies.push(JSON.parse(init.body) as Record<string, unknown>);
    return new Response(JSON.stringify({ request_id: 'req-payload' }), { status: 200 });
  }) as typeof fetch;
  return bodies;
}

describe('clip request payload', () => {
  it('sends reference_audios voice_id when a voice is set', async () => {
    useFakeSession();
    const bodies = stubFetch();
    await generateGrokClip(
      {
        prompt: 'He says the line.',
        firstFrameUrl: 'https://example.invalid/first.png',
        voiceId: 'rex',
        pin: 'start',
      },
      { waitForCompletion: false, timeoutSeconds: 30 },
    );
    expect(bodies[0].reference_audios).toEqual([{ voice_id: 'rex' }]);
    expect(bodies[0]).not.toHaveProperty('last_frame');
  });

  it('omits the end frame when pin is start', async () => {
    useFakeSession();
    const bodies = stubFetch();
    await generateGrokClip(
      {
        prompt: 'He walks in.',
        firstFrameUrl: 'https://example.invalid/first.png',
        lastFrameUrl: 'https://example.invalid/last.png',
        pin: 'start',
      },
      { waitForCompletion: false, timeoutSeconds: 30 },
    );
    expect(bodies[0].image).toEqual({ url: 'https://example.invalid/first.png' });
    expect(bodies[0]).not.toHaveProperty('last_frame');
    expect(Object.keys(bodies[0]).sort()).toEqual(
      ['aspect_ratio', 'duration', 'image', 'model', 'prompt'].sort(),
    );
  });

  it('sends the end frame only when pin is both', async () => {
    useFakeSession();
    const bodies = stubFetch();
    await generateGrokClip(
      {
        prompt: 'He walks in.',
        firstFrameUrl: 'https://example.invalid/first.png',
        lastFrameUrl: 'https://example.invalid/last.png',
        pin: 'both',
      },
      { waitForCompletion: false, timeoutSeconds: 30 },
    );
    expect(bodies[0].last_frame).toEqual({ url: 'https://example.invalid/last.png' });
  });
});
