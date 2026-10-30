import fs from 'fs';
import path from 'path';
import request from 'supertest';
import { afterEach, describe, expect, it } from 'vitest';
import { app } from '../server';

async function registerAccount() {
  const agent = request.agent(app);
  const response = await agent.post('/api/auth/register').send({
    name: 'Grok Backend Tester',
    email: `grok-backend-${Date.now()}-${Math.random().toString(36).slice(2, 8)}@example.com`,
    password: 'Passw0rd!23',
  });

  expect(response.status).toBe(201);
  return { agent, csrfToken: response.body.csrfToken as string };
}

const SHOT_BODY = {
  characters: [],
  scene: {
    id: 'scene-1',
    title: 'Test Scene',
    description: 'A test scene.',
    lighting: 'sunset-warm',
    dialogues: [],
  },
  shot: {
    id: 'shot-1',
    shotNumber: 1,
    title: 'Test Shot',
    shotType: 'medium-shot',
    durationSeconds: 6,
    action: 'The subject turns toward the camera.',
    dialogueLineIds: [],
    continuityNote: '',
    transitionInMode: 'none',
  },
  camera: {
    shotType: 'medium-shot',
    focalLength: 50,
    tiltAngle: 'eye-level',
    aspectRatio: '16:9',
  },
};

afterEach(() => {
  delete process.env.THESHOW_VIDEO_BACKEND;
});

describe('video backend selection', () => {
  it('keeps sandbox previews working when pinned to the sandbox backend', async () => {
    process.env.THESHOW_VIDEO_BACKEND = 'sandbox';
    const { agent, csrfToken } = await registerAccount();

    const response = await agent
      .post('/api/generate-shot-video')
      .set('x-csrf-token', csrfToken)
      .send(SHOT_BODY);

    expect(response.status).toBe(200);
    expect(response.body.videoBackend).toBe('sandbox');
    expect(response.body.isFallback).toBe(true);
    expect(response.body.operationName).toMatch(/^mock-operation-/);
  });

  it('reports a clear error rather than faking a render when no backend is configured', async () => {
    // Pretend the machine is unsigned-in: no API key and no Grok CLI session.
    process.env.THESHOW_VIDEO_BACKEND = 'auto';
    process.env.GROK_AUTH_FILE = path.join(process.cwd(), 'tests', 'fixtures', 'missing-auth.json');
    delete process.env.XAI_API_KEY;
    const { agent, csrfToken } = await registerAccount();

    try {
      const response = await agent
        .post('/api/generate-shot-video')
        .set('x-csrf-token', csrfToken)
        .send(SHOT_BODY);

      expect(response.status).toBe(503);
      expect(response.body.code).toBe('no-video-backend');
      expect(response.body.action).toContain('grok login');
    } finally {
      delete process.env.GROK_AUTH_FILE;
    }
  });
});

describe('grok clip operations', () => {
  it('serves a rendered clip through the authenticated download route', async () => {
    const { agent, csrfToken } = await registerAccount();
    const operationName = `grok-clip-${crypto.randomUUID()}`;
    const clipDir = path.join(process.cwd(), '.storyforge', 'grok-clips');
    fs.mkdirSync(clipDir, { recursive: true });

    // A real MP4 container header is enough to prove the route streams bytes
    // rather than a JSON error; rendering itself is covered by the live run.
    const clipPath = path.join(clipDir, `${operationName}.mp4`);
    fs.writeFileSync(clipPath, Buffer.from('00000018667479706d703432', 'hex'));
    fs.writeFileSync(
      path.join(clipDir, `${operationName}.json`),
      JSON.stringify({
        operationName,
        requestId: 'req-1',
        baseUrl: 'https://example.invalid',
        userId: (await agent.get('/api/auth/session')).body.user.id,
        prompt: 'test',
        aspectRatio: '16:9',
        durationSeconds: 6,
        createdAt: new Date().toISOString(),
        billedTo: 'Grok subscription',
        authKind: 'session',
        status: 'completed',
      }),
    );

    const recorded = await agent
      .post('/api/video-status')
      .set('x-csrf-token', csrfToken)
      .send({ operationName });

    // Ownership is enforced against the recorded render, so an unregistered
    // operation is rejected before any file is touched.
    expect(recorded.status).toBe(200);
    expect(recorded.body.done).toBe(true);
    expect(recorded.body.error).toContain('does not belong');

    fs.rmSync(clipPath, { force: true });
    fs.rmSync(path.join(clipDir, `${operationName}.json`), { force: true });
  });

  it('rejects an operation id that is not a Grok clip', async () => {
    const { agent, csrfToken } = await registerAccount();
    const response = await agent
      .post('/api/video-status')
      .set('x-csrf-token', csrfToken)
      .send({ operationName: 'mock-operation-veo-123-abc' });

    expect(response.status).toBe(200);
    expect(response.body.done).toBe(true);
    expect(response.body.error).toBeTruthy();
  });
});

describe('quick preview route', () => {
  const QUICK_PREVIEW_BODY = {
    characters: [],
    scenes: [{ id: 'scene-1', title: 'Quick Scene', description: 'The lead steps into view.', lighting: 'sunset-warm', dialogues: [] }],
    camera: { shotType: 'medium-shot', focalLength: 50, tiltAngle: 'eye-level', aspectRatio: '16:9' },
  };

  it('renders a mock preview only when the sandbox backend is pinned', async () => {
    process.env.THESHOW_VIDEO_BACKEND = 'sandbox';
    const { agent, csrfToken } = await registerAccount();

    const response = await agent
      .post('/api/generate-video')
      .set('x-csrf-token', csrfToken)
      .send(QUICK_PREVIEW_BODY);

    expect(response.status).toBe(200);
    expect(response.body.operationName).toMatch(/^mock-operation-/);
    expect(response.body.isFallback).toBe(true);
    expect(response.body.videoBackend).toBe('sandbox');
  });

  it('reports the missing credential instead of faking a preview', async () => {
    process.env.THESHOW_VIDEO_BACKEND = 'auto';
    process.env.GROK_AUTH_FILE = path.join(process.cwd(), 'tests', 'fixtures', 'missing-auth.json');
    delete process.env.XAI_API_KEY;
    const { agent, csrfToken } = await registerAccount();

    try {
      const response = await agent
        .post('/api/generate-video')
        .set('x-csrf-token', csrfToken)
        .send(QUICK_PREVIEW_BODY);

      expect(response.status).toBe(503);
      expect(response.body.code).toBe('grok-credential-missing');
      expect(response.body.action).toContain('grok login');
      // The regression this guards: a mock operation that reports success.
      expect(response.body.operationName).toBeUndefined();
      expect(response.body.isFallback).toBeUndefined();
    } finally {
      delete process.env.GROK_AUTH_FILE;
    }
  });

  it('surfaces a rejected subscription credential as an error, never a mock preview', async () => {
    process.env.THESHOW_VIDEO_BACKEND = 'grok';
    process.env.XAI_API_KEY = 'test-key-not-used-upstream';
    const { agent, csrfToken } = await registerAccount();
    const originalFetch = globalThis.fetch;

    globalThis.fetch = (async () => new Response('{"error":"bad key"}', { status: 401 })) as typeof fetch;

    try {
      const response = await agent
        .post('/api/generate-video')
        .set('x-csrf-token', csrfToken)
        .send(QUICK_PREVIEW_BODY);

      expect(response.status).toBe(503);
      expect(response.body.code).toBe('grok-credential-missing');
      expect(response.body.error).toContain('rejected');
      expect(response.body.operationName).toBeUndefined();
    } finally {
      globalThis.fetch = originalFetch;
      delete process.env.XAI_API_KEY;
    }
  });

  it('renders a quick preview on the Grok backend and returns the clip handle', async () => {
    process.env.THESHOW_VIDEO_BACKEND = 'grok';
    process.env.XAI_API_KEY = 'test-key-not-used-upstream';
    const { agent, csrfToken } = await registerAccount();
    const originalFetch = globalThis.fetch;
    const submittedBodies: any[] = [];
    let operationName = '';

    // A complete fake of the three calls a Grok render makes: submit, poll, and
    // download the finished clip. Nothing leaves the machine and nothing is billed.
    globalThis.fetch = (async (input: any, init?: any) => {
      const url = String(input);
      if (url.endsWith('/v1/videos/generations')) {
        submittedBodies.push(JSON.parse(String(init?.body)));
        return new Response(JSON.stringify({ request_id: 'req-quick-preview-1' }), { status: 200 });
      }
      if (url.includes('/v1/videos/req-quick-preview-1')) {
        return new Response(JSON.stringify({
          status: 'completed',
          video: { url: 'https://example.invalid/clip.mp4', duration: 8 },
          usage: { cost_in_usd_ticks: 2400000000 },
        }), { status: 200 });
      }
      return new Response(Buffer.from('00000018667479706d703432', 'hex'), {
        status: 200,
        headers: { 'content-type': 'video/mp4' },
      });
    }) as typeof fetch;

    try {
      const response = await agent
        .post('/api/generate-video')
        .set('x-csrf-token', csrfToken)
        .send(QUICK_PREVIEW_BODY);

      expect(response.status).toBe(200);
      operationName = response.body.operationName;
      expect(operationName).toMatch(/^grok-clip-/);
      expect(response.body.isFallback).toBe(false);
      expect(response.body.backend).toBe('grok');
      expect(response.body.videoBackend).toBe('grok');
      expect(response.body.billedTo).toBe('xAI API credits');
      expect(response.body.authSource).toBe('XAI_API_KEY');
      expect(response.body.durationSeconds).toBe(8);
      expect(response.body.clipUrl).toBe(`/api/video-download?operationName=${operationName}`);
      // 2.4e9 ticks is $0.24, which is what the route must report verbatim.
      expect(response.body.costUsd).toBeCloseTo(0.24, 5);

      // Quick Preview sends no shot, so the prompt must still carry the scene and
      // camera anchors the storyboard path builds.
      expect(submittedBodies[0].prompt).toContain('[AESTHETIC STYLIZATION ANCHOR]');
      expect(submittedBodies[0].prompt).toContain('Quick Scene');
      expect(submittedBodies[0].duration).toBe(8);
      expect(submittedBodies[0].aspect_ratio).toBe('16:9');
    } finally {
      globalThis.fetch = originalFetch;
      delete process.env.XAI_API_KEY;

      if (operationName) {
        const clipDir = path.join(process.cwd(), '.storyforge', 'grok-clips');
        fs.rmSync(path.join(clipDir, `${operationName}.mp4`), { force: true });
        fs.rmSync(path.join(clipDir, `${operationName}.json`), { force: true });
      }
    }
  }, 20000);
});
