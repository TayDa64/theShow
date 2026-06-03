import request from 'supertest';
import { describe, expect, it } from 'vitest';
import { app } from '../server';

async function createAuthenticatedAgent() {
  const agent = request.agent(app);
  const registerResponse = await agent
    .post('/api/auth/register')
    .send({
      name: 'Rate Limit Tester',
      email: `rate-${Date.now()}-${Math.random().toString(36).slice(2, 8)}@example.com`,
      password: 'Passw0rd!23',
    });

  expect(registerResponse.status).toBe(201);

  return {
    agent,
    csrfToken: registerResponse.body.csrfToken as string,
  };
}

const endpoints = [
  {
    path: '/api/generate-shot-prompt',
    body: { scene: { title: 'A' }, shot: { title: 'Shot 1' }, camera: { shotType: 'medium-shot', focalLength: 50, tiltAngle: 'eye-level', aspectRatio: '16:9' } },
  },
  {
    path: '/api/generate-shot-video',
    body: { scene: { title: 'A' }, shot: { title: 'Shot 1', durationSeconds: 8 }, camera: { shotType: 'medium-shot', focalLength: 50, tiltAngle: 'eye-level', aspectRatio: '16:9' } },
  },
  {
    path: '/api/extend-clip',
    body: { prompt: 'Extend the sequence.', videoToExtend: 'clip-1.mp4', firstFrame: '/uploads/frame.png' },
  },
];

describe('generation rate limits', () => {
  it.each(endpoints)('returns HTTP 429 on the 11th request for $path', async ({ path, body }, index) => {
    const { agent, csrfToken } = await createAuthenticatedAgent();

    for (let attempt = 1; attempt <= 10; attempt += 1) {
      const response = await agent
        .post(path)
        .set('X-Forwarded-For', `203.0.113.${index + 1}`)
        .set('x-csrf-token', csrfToken)
        .send(body);

      expect(response.status).not.toBe(429);
    }

    const blocked = await agent
      .post(path)
      .set('X-Forwarded-For', `203.0.113.${index + 1}`)
      .set('x-csrf-token', csrfToken)
      .send(body);

    expect(blocked.status).toBe(429);
  });
});
