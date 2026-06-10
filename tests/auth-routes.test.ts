import request from 'supertest';
import { generateSync } from 'otplib';
import { describe, expect, it } from 'vitest';
import { app } from '../server';

async function registerAccount(name: string, email: string) {
  const agent = request.agent(app);
  const response = await agent.post('/api/auth/register').send({
    name,
    email,
    password: 'Passw0rd!23',
  });

  expect(response.status).toBe(201);
  return {
    agent,
    csrfToken: response.body.csrfToken as string,
  };
}

describe('auth routes', () => {
  it('requires authentication for cloud state persistence', async () => {
    const response = await request(app)
      .post('/api/save-sandbox-state')
      .send({ scenes: [] });

    expect(response.status).toBe(401);
  });

  it('stores project state per authenticated user', async () => {
    const alpha = await registerAccount('Alpha', `alpha-${Date.now()}@example.com`);
    const beta = await registerAccount('Beta', `beta-${Date.now()}@example.com`);

    const alphaSave = await alpha.agent
      .post('/api/save-sandbox-state')
      .set('x-csrf-token', alpha.csrfToken)
      .send({
        characters: [{ id: '1', name: 'Alpha Hero' }],
        scenes: [{ id: 's1', title: 'Alpha Scene', description: 'Alpha only', lighting: 'cyberpunk-dusk', dialogues: [] }],
        camera: { shotType: 'close-up', focalLength: 50, tiltAngle: 'eye-level', aspectRatio: '16:9', showRuleOfThirds: true },
        exportSettings: { targetEngine: 'unreal-engine', exportFormat: 'fbx', includeLiveLink: false, meshLevel: 'high' },
        updatedAt: '2026-06-02T00:00:00.000Z',
      });

    expect(alphaSave.status).toBe(200);

    const betaSave = await beta.agent
      .post('/api/save-sandbox-state')
      .set('x-csrf-token', beta.csrfToken)
      .send({
        characters: [{ id: '1', name: 'Beta Hero' }],
        scenes: [{ id: 's1', title: 'Beta Scene', description: 'Beta only', lighting: 'moonlight-cold', dialogues: [] }],
        camera: { shotType: 'wide-landscape', focalLength: 24, tiltAngle: 'high', aspectRatio: '16:9', showRuleOfThirds: true },
        exportSettings: { targetEngine: 'unity', exportFormat: 'gltf', includeLiveLink: false, meshLevel: 'medium' },
        updatedAt: '2026-06-02T01:00:00.000Z',
      });

    expect(betaSave.status).toBe(200);

    const alphaLoad = await alpha.agent.get('/api/load-sandbox-state');
    const betaLoad = await beta.agent.get('/api/load-sandbox-state');

    expect(alphaLoad.status).toBe(200);
    expect(betaLoad.status).toBe(200);
    expect(alphaLoad.body.characters[0].name).toBe('Alpha Hero');
    expect(betaLoad.body.characters[0].name).toBe('Beta Hero');
  });

  it('links a personal Gemini provider and enforces the configured daily video limit', async () => {
    const { agent, csrfToken } = await registerAccount('Quota Tester', `quota-${Date.now()}@example.com`);

    const linkResponse = await agent
      .post('/api/auth/provider/gemini')
      .set('x-csrf-token', csrfToken)
      .send({
        label: 'Personal Gemini',
        apiKey: 'AIzaTestPersonalKey1234567890',
        dailyVideoLimit: 1,
      });

    expect(linkResponse.status).toBe(200);
    expect(linkResponse.body.provider.mode).toBe('personal');
    expect(linkResponse.body.provider.dailyVideoLimit).toBe(1);

    const firstRender = await agent
      .post('/api/generate-video')
      .set('x-csrf-token', csrfToken)
      .send({
        characters: [],
        scenes: [{ title: 'Quota Scene', description: 'A test render.' }],
        camera: { aspectRatio: '16:9' },
      });

    expect(firstRender.status).toBe(200);

    const secondRender = await agent
      .post('/api/generate-video')
      .set('x-csrf-token', csrfToken)
      .send({
        characters: [],
        scenes: [{ title: 'Quota Scene', description: 'A second test render.' }],
        camera: { aspectRatio: '16:9' },
      });

    expect(secondRender.status).toBe(429);
    expect(secondRender.body.error).toMatch(/Daily video generation quota reached/i);
  });

  it('creates a session from the Google OIDC callback flow', async () => {
    process.env.GOOGLE_OIDC_CLIENT_ID = 'google-client-id';
    process.env.GOOGLE_OIDC_CLIENT_SECRET = 'google-client-secret';
    process.env.GOOGLE_OIDC_REDIRECT_URI = 'http://localhost:3000/api/auth/google/callback';

    const agent = request.agent(app);
    const start = await agent.get('/api/auth/google/start?mode=login');
    expect(start.status).toBe(302);
    const redirect = new URL(start.headers.location);
    const state = redirect.searchParams.get('state');
    expect(state).toBeTruthy();

    const callback = await agent.get(`/api/auth/google/callback?state=${encodeURIComponent(state || '')}&code=mock-code`);
    expect(callback.status).toBe(302);
    expect(callback.headers.location).toContain('authResult=google-login-success');

    const session = await agent.get('/api/auth/session');
    expect(session.status).toBe(200);
    expect(session.body.isAuthenticated).toBe(true);
    expect(session.body.user.email).toBe('google-user@example.com');
    expect(session.body.user.googleLinked).toBe(true);
    expect(session.body.user.hasPassword).toBe(false);
  });

  it('requires a valid TOTP code after password verification when local 2FA is enabled', async () => {
    const { agent, csrfToken } = await registerAccount('Two Factor', `2fa-${Date.now()}@example.com`);

    const setup = await agent
      .post('/api/auth/2fa/setup')
      .set('x-csrf-token', csrfToken)
      .send({});
    expect(setup.status).toBe(200);
    const secret = setup.body.manualEntryKey as string;
    expect(secret).toBeTruthy();

    const confirm = await agent
      .post('/api/auth/2fa/confirm')
      .set('x-csrf-token', csrfToken)
      .send({
        token: generateSync({ secret }),
      });
    expect(confirm.status).toBe(200);
    expect(confirm.body.user.twoFactorEnabled).toBe(true);

    await agent
      .post('/api/auth/logout')
      .set('x-csrf-token', csrfToken)
      .send({});

    const login = await agent
      .post('/api/auth/login')
      .send({
        email: confirm.body.user.email,
        password: 'Passw0rd!23',
      });
    expect(login.status).toBe(202);
    expect(login.body.requiresTwoFactor).toBe(true);
    expect(login.body.challenge.challengeId).toBeTruthy();

    const verify = await agent
      .post('/api/auth/2fa/verify')
      .send({
        challengeId: login.body.challenge.challengeId,
        token: generateSync({ secret }),
      });
    expect(verify.status).toBe(200);
    expect(verify.body.isAuthenticated).toBe(true);
    expect(verify.body.user.twoFactorEnabled).toBe(true);
  });
});