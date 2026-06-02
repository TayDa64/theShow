import fs from 'fs';
import os from 'os';
import path from 'path';
import request from 'supertest';
import { describe, expect, it } from 'vitest';
import { app } from '../server';

describe('film pipeline routes', () => {
  it('assembles 3 clips and returns a downloadable MP4 URL', async () => {
    const clips = [1, 2, 3].map((index) => ({
      shotId: `shot-${index}`,
      title: `Shot ${index}`,
      order: index,
      operationName: `mock-operation-${index}`,
      durationSeconds: 8,
    }));

    const response = await request(app)
      .post('/api/assemble-film')
      .send({ clips });

    expect(response.status).toBe(200);
    expect(response.body.downloadUrl).toMatch(/^\/api\/download-film\//);

    const download = await request(app).get(response.body.downloadUrl);
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
