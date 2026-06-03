import fs from 'fs';
import os from 'os';
import path from 'path';
import request from 'supertest';
import { describe, expect, it } from 'vitest';
import { app } from '../server';

async function createAuthenticatedAgent() {
  const agent = request.agent(app);
  const registerResponse = await agent
    .post('/api/auth/register')
    .send({
      name: 'Film Tester',
      email: `film-${Date.now()}-${Math.random().toString(36).slice(2, 8)}@example.com`,
      password: 'Passw0rd!23',
    });

  expect(registerResponse.status).toBe(201);
  return {
    agent,
    csrfToken: registerResponse.body.csrfToken as string,
  };
}

describe('film pipeline routes', () => {
  it('assembles 3 clips and returns a downloadable MP4 URL', async () => {
    const { agent, csrfToken } = await createAuthenticatedAgent();
    const clipBodies = await Promise.all([1, 2, 3].map(async (index) => {
      const generation = await agent
        .post('/api/generate-video')
        .set('x-csrf-token', csrfToken)
        .send({
          characters: [],
          scenes: [{ title: `Scene ${index}`, description: `Beat ${index}` }],
          camera: { aspectRatio: '16:9' },
        });

      expect(generation.status).toBe(200);

      return {
        shotId: `shot-${index}`,
        title: `Shot ${index}`,
        order: index,
        operationName: generation.body.operationName,
        durationSeconds: 8,
      };
    }));

    const response = await agent
      .post('/api/assemble-film')
      .set('x-csrf-token', csrfToken)
      .send({ clips: clipBodies });

    expect(response.status).toBe(200);
    expect(response.body.downloadUrl).toMatch(/^\/api\/download-film\//);

    const download = await agent.get(response.body.downloadUrl);
    expect(download.status).toBe(200);
  });

  it('rejects non-image uploads for reference assets', async () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'upload-route-'));
    const exePath = path.join(tempDir, 'payload.exe');
    fs.writeFileSync(exePath, Buffer.from('MZ'));

    const response = await request(app)
      .post('/api/upload-reference')
      .attach('file', exePath, { contentType: 'application/x-msdownload' });

    expect(response.status).toBe(400);
  });
});
