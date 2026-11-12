/**
 * Admission control on the still and clip submit path.
 *
 * Don'ts are not sent. The lint runs before fetch. A negative list is stored
 * for the lint and the checklist and is absent from the request JSON. A failed
 * checklist deletes the local still and withholds the clip URL so neither can
 * pin the next shot. No paid API is called: fetch is stubbed.
 */
import { execFile } from 'node:child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { promisify } from 'node:util';
import zlib from 'node:zlib';
import { afterEach, describe, expect, it } from 'vitest';
import { acceptRenderedTake, reviewTake } from '../mcp/admission.ts';
import { featheredSubjectCutout } from '../mcp/cutout.ts';
import { heroPrompt, planBoardFrames } from '../mcp/storyboard.ts';
import { lintSentPrompt } from '../mcp/promptLint.ts';

const tempDirs: string[] = [];

afterEach(() => {
  process.env.GROK_AUTH_FILE = '/nonexistent/theshow-test-auth.json';
  delete process.env.XAI_API_KEY;
  for (const dir of tempDirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

function tempDir() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'theshow-admit-'));
  tempDirs.push(dir);
  return dir;
}

function useFakeSession(dir: string) {
  fs.writeFileSync(path.join(dir, 'auth.json'), JSON.stringify({
    'https://auth.example.test::client': {
      key: 'test-session-token',
      expires_at: new Date(Date.now() + 3_600_000).toISOString(),
    },
  }));
  process.env.GROK_AUTH_FILE = path.join(dir, 'auth.json');
  delete process.env.XAI_API_KEY;
}

function writePng(file: string, width: number, height: number) {
  const raw = Buffer.alloc((width * 3 + 1) * height);
  for (let y = 0; y < height; y++) {
    const row = y * (width * 3 + 1);
    raw[row] = 0;
    for (let x = 0; x < width; x++) {
      const p = row + 1 + x * 3;
      raw[p] = (x * 40 + width) % 256;
      raw[p + 1] = (y * 20 + height) % 256;
      raw[p + 2] = (x * 10 + y * 15) % 256;
    }
  }
  const chunk = (type: string, data: Buffer) => {
    const len = Buffer.alloc(4);
    len.writeUInt32BE(data.length);
    const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(zlib.crc32(body));
    return Buffer.concat([len, body, crc]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;
  ihdr[9] = 2;
  const png = Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw)),
    chunk('IEND', Buffer.alloc(0)),
  ]);
  fs.writeFileSync(file, png);
}

describe('prompt lint', () => {
  it('rejects a negated forbidden noun before any paid call', async () => {
    const { generateGrokStill } = await import('../mcp/grokVideo.ts');
    let called = false;
    globalThis.fetch = (async () => {
      called = true;
      throw new Error('fetch must not run');
    }) as typeof fetch;

    const result = await generateGrokStill(
      { prompt: 'There is no floor lamp.' },
      { outputDir: tempDir() },
    );

    expect(called).toBe(false);
    expect(result.code).toBe('prompt-rejected');
    expect(result.localPath).toBeUndefined();
    const hits = lintSentPrompt('There is no floor lamp.');
    expect(hits.some((hit) => hit.kind === 'negation' && hit.match.toLowerCase() === 'no')).toBe(true);
    expect(hits.some((hit) => hit.kind === 'forbidden' && /lamp/i.test(hit.match))).toBe(true);
  });

  it('accepts an affirmative description of what is in the frame', () => {
    const prompt = 'A tall man stands in the glass vestibule beside the oak bench.';
    expect(lintSentPrompt(prompt)).toEqual([]);
    expect(lintSentPrompt('He walks toward the camera at a brisk pace.')).toEqual([]);
    expect(lintSentPrompt('He speaks at an easy natural pace.')).not.toEqual([]);
  });

  it('keeps board and hero wording on the affirmative side of the lint', () => {
    const frames = planBoardFrames({
      shots: [
        { prompt: 'Wide empty street at dawn, lamplight still on.' },
        { prompt: 'A lamplighter walks the street, pole over one shoulder.' },
      ],
      aspectRatio: '16:9',
      cast: 'bald man, black beard, striped shirt, tan sherpa coat',
      baseImageUrl: '/refs/room.png',
    });
    for (const frame of frames) expect(lintSentPrompt(frame.prompt)).toEqual([]);
    const hero = heroPrompt({ scene: 'Halfway Station hall', cast: 'A tall man' });
    expect(lintSentPrompt(hero)).toEqual([]);
    expect(hero).toContain('person from the first photo');
    expect(hero).toContain('room in the second photo');
  });
});

describe('negative list', () => {
  it('never appears in the still or clip request', async () => {
    const dir = tempDir();
    useFakeSession(dir);
    const { generateGrokStill, generateGrokClip } = await import('../mcp/grokVideo.ts');
    const bodies: string[] = [];
    globalThis.fetch = (async (_input: unknown, init?: { body?: string }) => {
      if (init?.body) bodies.push(init.body);
      return new Response(JSON.stringify({ request_id: 'req-neg' }), { status: 200 });
    }) as typeof fetch;

    const negative = 'floor lamp, door handle, watermark';
    const prompt = 'He walks toward the camera at a brisk pace. <AUDIO_0>';
    await generateGrokClip(
      {
        prompt,
        voiceId: 'rex',
        pin: 'start',
        negative,
        firstFrameUrl: 'https://example.invalid/frame.png',
      },
      { waitForCompletion: false, timeoutSeconds: 30 },
    );
    const office = path.join(dir, 'office.png');
    writePng(office, 8, 8);
    await generateGrokStill(
      { prompt: 'A tall man stands in the glass vestibule.', negative, baseImageUrl: office },
      { outputDir: dir },
    );

    expect(bodies.length).toBeGreaterThan(0);
    for (const body of bodies) {
      const parsed = JSON.parse(body) as Record<string, unknown>;
      expect(body).not.toContain('floor lamp');
      expect(body).not.toContain('door handle');
      expect(body).not.toContain('watermark');
      expect(parsed).not.toHaveProperty('negative_prompt');
      expect(parsed).not.toHaveProperty('negative');
    }
    const clip = JSON.parse(bodies[0]) as { reference_audios?: unknown; prompt?: string };
    expect(clip.reference_audios).toEqual([{ voice_id: 'rex' }]);
    expect(clip.prompt).toBe(prompt);
  });
});

describe('post-generation checklist', () => {
  it('fails an object that changes rooms or appears from nowhere', () => {
    const moved = reviewTake({
      priorObjects: [{ id: 'bench', room: 'vestibule' }],
      objects: [{ id: 'bench', room: 'corridor' }],
    });
    expect(moved.ok).toBe(false);
    if (!moved.ok) expect(moved.failures.join(' ')).toMatch(/changed rooms/);

    const invented = reviewTake({
      priorObjects: [{ id: 'bench', room: 'vestibule' }],
      objects: [
        { id: 'bench', room: 'vestibule' },
        { id: 'lamp', room: 'vestibule', label: 'floor lamp' },
      ],
    }, 'floor lamp');
    expect(invented.ok).toBe(false);
    if (!invented.ok) {
      expect(invented.failures.join(' ')).toMatch(/not in the prior frame/);
      expect(invented.failures.join(' ')).toMatch(/floor lamp/);
    }
  });

  it('fails a squashed torso, a widened body, and shortened legs without a photo', () => {
    const squashed = reviewTake({ torsoPx: 40, legPx: 80 });
    expect(squashed.ok).toBe(false);
    if (!squashed.ok) expect(squashed.failures.join(' ')).toMatch(/Squashed torso/);

    const widened = reviewTake({ shoulderPx: 40, staturePx: 100 });
    expect(widened.ok).toBe(false);
    if (!widened.ok) expect(widened.failures.join(' ')).toMatch(/Widened body/);

    const shortLegs = reviewTake({ legPx: 30, staturePx: 100 });
    expect(shortLegs.ok).toBe(false);
    if (!shortLegs.ok) expect(shortLegs.failures.join(' ')).toMatch(/Shortened legs/);

    const shortRelative = reviewTake({ torsoPx: 150, legPx: 100 });
    expect(shortRelative.ok).toBe(false);
    if (!shortRelative.ok) expect(shortRelative.failures.join(' ')).toMatch(/short relative to the torso/);

    const tall = reviewTake({ torsoPx: 90, legPx: 100, shoulderPx: 25, staturePx: 190 });
    expect(tall.ok).toBe(true);
  });

  it('fails a vocal that runs past its pre-timed end', () => {
    const late = reviewTake({ vocalEndSeconds: 6.2, timedEndSeconds: 5 });
    expect(late.ok).toBe(false);
    if (!late.ok) expect(late.failures.join(' ')).toMatch(/past the pre-timed end/);
    expect(reviewTake({ vocalEndSeconds: 5, timedEndSeconds: 5 }).ok).toBe(true);
  });

  it('deletes a failed still and does not return it as a pin', async () => {
    const dir = tempDir();
    useFakeSession(dir);
    const { generateGrokStill } = await import('../mcp/grokVideo.ts');
    globalThis.fetch = (async (input: unknown) => {
      const url = String(input);
      if (url.includes('/v1/images/')) {
        return new Response(JSON.stringify({
          data: [{ url: 'https://example.invalid/still.png', mime_type: 'image/png' }],
          usage: { cost_in_usd_ticks: 200000000 },
        }), { status: 200 });
      }
      return new Response(Buffer.from('png-bytes'), { status: 200 });
    }) as typeof fetch;

    const result = await generateGrokStill(
      {
        prompt: 'A tall man stands in the glass vestibule.',
        admission: {
          priorObjects: [{ id: 'bench', room: 'vestibule' }],
          objects: [{ id: 'bench', room: 'corridor' }],
        },
      },
      { outputDir: dir },
    );

    expect(result.localPath).toBeUndefined();
    expect(result.code).toBe('rejected');
    expect(fs.readdirSync(dir).filter((name) => name.endsWith('.png'))).toEqual([]);
  });

  it('withholds a failed clip url so it cannot pin the next shot', async () => {
    const dir = tempDir();
    useFakeSession(dir);
    const { generateGrokClip } = await import('../mcp/grokVideo.ts');
    globalThis.fetch = (async (input: unknown, init?: { body?: string }) => {
      const url = String(input);
      if (url.includes('/v1/videos/generations')) {
        return new Response(JSON.stringify({ request_id: 'req-take' }), { status: 200 });
      }
      return new Response(JSON.stringify({
        status: 'completed',
        video: { url: 'https://example.invalid/take.mp4', duration: 8 },
      }), { status: 200 });
    }) as typeof fetch;

    const result = await generateGrokClip(
      {
        prompt: 'He walks toward the camera at a brisk pace.',
        admission: { vocalEndSeconds: 9, timedEndSeconds: 6 },
      },
      { waitForCompletion: true, timeoutSeconds: 20 },
    );

    expect(result.videoUrl).toBeUndefined();
    expect(result.status).toBe('failed');
    expect(result.error).toMatch(/will not be used as a pin/);
  }, 15_000);

  it('discards a failed file and keeps a passing one', async () => {
    const dir = tempDir();
    const failed = path.join(dir, 'failed.png');
    const kept = path.join(dir, 'kept.png');
    fs.writeFileSync(failed, 'take');
    fs.writeFileSync(kept, 'take');

    const dropped = await acceptRenderedTake(failed, {
      priorObjects: [{ id: 'coat', room: 'vestibule' }],
      objects: [{ id: 'lamp', room: 'vestibule' }],
    });
    expect(dropped.ok).toBe(false);
    expect(fs.existsSync(failed)).toBe(false);

    const passed = await acceptRenderedTake(kept, {
      priorObjects: [{ id: 'coat', room: 'vestibule' }],
      objects: [{ id: 'coat', room: 'vestibule' }],
    });
    expect(passed.ok).toBe(true);
    if (passed.ok) expect(passed.path).toBe(kept);
    expect(fs.readFileSync(kept, 'utf8')).toBe('take');
  });
});

describe('portrait cutout', () => {
  it('removes the edge background and leaves the original file untouched', async () => {
    const dir = tempDir();
    const source = path.join(dir, 'portrait.png');
    writePng(source, 32, 48);
    const before = fs.readFileSync(source);

    const cutout = await featheredSubjectCutout(source);
    expect(cutout.ok).toBe(true);
    if (!cutout.ok) return;
    expect(cutout.path).not.toBe(source);
    expect(fs.readFileSync(source).equals(before)).toBe(true);

    const exec = promisify(execFile);
    const { stdout } = await exec('ffmpeg', [
      '-v', 'error',
      '-i', cutout.path,
      '-f', 'rawvideo',
      '-pix_fmt', 'rgba',
      'pipe:1',
    ], { encoding: 'buffer', maxBuffer: 8 * 1024 * 1024 });
    const pixels = stdout as unknown as Buffer;
    const alphaAt = (x: number, y: number) => pixels[(y * 32 + x) * 4 + 3];
    expect(alphaAt(16, 24)).toBeGreaterThan(200);
    expect(alphaAt(0, 0)).toBeLessThan(40);
  });
});

describe('plate-first image order', () => {
  it('keeps the portrait first unless the caller asks for the plate first', async () => {
    const dir = tempDir();
    useFakeSession(dir);
    const { generateGrokStill } = await import('../mcp/grokVideo.ts');
    const bodies: Array<{ image: string[] }> = [];
    globalThis.fetch = (async (input: unknown, init?: { body?: string }) => {
      const url = String(input);
      if (url.includes('/v1/images/') && init?.body) {
        bodies.push(JSON.parse(init.body) as { image: string[] });
        return new Response(JSON.stringify({
          data: [{ url: 'https://example.invalid/edited.png', mime_type: 'image/png' }],
          usage: { cost_in_usd_ticks: 200000000 },
        }), { status: 200 });
      }
      return new Response(Buffer.from('bytes'), { status: 200 });
    }) as typeof fetch;

    const portrait = path.join(dir, 'portrait.png');
    const office = path.join(dir, 'office.png');
    writePng(portrait, 8, 8);
    writePng(office, 9, 9);
    const portraitBytes = fs.readFileSync(portrait);
    const officeBytes = fs.readFileSync(office);
    const decoded = (uri: string) => Buffer.from(uri.slice(uri.indexOf(',') + 1), 'base64');

    await generateGrokStill(
      {
        prompt: 'A tall man stands in the glass vestibule.',
        baseImageUrl: office,
        referenceImageUrls: [portrait],
      },
      { outputDir: dir },
    );
    await generateGrokStill(
      {
        prompt: 'A tall man stands in the glass vestibule.',
        baseImageUrl: office,
        referenceImageUrls: [portrait],
        imageOrder: 'plate-first',
      },
      { outputDir: dir },
    );

    expect(decoded(bodies[0].image[0]).equals(portraitBytes)).toBe(true);
    expect(decoded(bodies[0].image[1]).equals(officeBytes)).toBe(true);
    expect(decoded(bodies[1].image[0]).equals(officeBytes)).toBe(true);
    expect(decoded(bodies[1].image[1]).equals(portraitBytes)).toBe(true);
  });
});
