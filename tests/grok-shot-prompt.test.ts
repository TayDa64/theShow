import fs from 'fs';
import os from 'os';
import path from 'path';
import zlib from 'zlib';
import { describe, expect, it } from 'vitest';
import { featheredSubjectCutout } from '../mcp/cutout.ts';
import { lintSentPrompt } from '../mcp/promptLint.ts';
import {
  GROK_SHOT_STORED_NEGATIVE,
  buildGrokShotPrompt,
  durationForStudioGrokShot,
  studioGrokReferenceUrls,
  studioGrokResolution,
  studioQuote,
} from '../src/lib/grokShotPrompt.ts';

function writePng(file: string, width: number, height: number) {
  const raw = Buffer.alloc((width * 3 + 1) * height);
  for (let y = 0; y < height; y += 1) {
    const row = y * (width * 3 + 1);
    raw[row] = 0;
    for (let x = 0; x < width; x += 1) {
      const i = row + 1 + x * 3;
      const center = x > width * 0.3 && x < width * 0.7 && y > height * 0.2 && y < height * 0.8;
      raw[i] = center ? 180 : 20;
      raw[i + 1] = center ? 140 : 20;
      raw[i + 2] = center ? 120 : 20;
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
  fs.writeFileSync(file, Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw)),
    chunk('IEND', Buffer.alloc(0)),
  ]));
}

describe('studio Grok shot prompt', () => {
  it('keeps the room in the prompt only when no frame is pinned', () => {
    const shared = {
      action: 'The subject turns toward the camera.',
      shotType: 'medium-shot',
      cameraAngle: 'eye-level',
      focalLength: 50,
      aspectRatio: '16:9',
      sceneDescription: 'The glass vestibule holds an oak bench.',
      lighting: 'cool daylight',
    };
    const pinned = buildGrokShotPrompt({ ...shared, pinnedFrame: true });
    const open = buildGrokShotPrompt({ ...shared, pinnedFrame: false });

    expect(pinned).toContain('The subject turns toward the camera.');
    expect(pinned).not.toContain('vestibule');
    expect(pinned).not.toContain('cool daylight');
    expect(open).toContain('Setting: The glass vestibule holds an oak bench.');
    expect(open).toContain('Light: cool daylight');
    expect(lintSentPrompt(pinned, GROK_SHOT_STORED_NEGATIVE)).toEqual([]);
    expect(lintSentPrompt(open, GROK_SHOT_STORED_NEGATIVE)).toEqual([]);
    expect(pinned).not.toMatch(/\b(do not|without|never|avoid)\b/i);
  });

  it('sends framing always, and wardrobe only when no frame is pinned', () => {
    const shared = {
      action: 'The subject turns toward the camera.',
      composition: 'A medium frame with the subject left of center.',
      continuityNotes: 'The oak bench stays against the glass.',
      wardrobe: 'Tay wears a grey coat.',
      sceneDescription: 'The glass vestibule holds an oak bench.',
      pinnedFrame: false,
    };
    const open = buildGrokShotPrompt(shared);
    const pinned = buildGrokShotPrompt({ ...shared, pinnedFrame: true });
    expect(open).toContain('Framing: A medium frame with the subject left of center.');
    expect(open).toContain('Wardrobe: Tay wears a grey coat.');
    expect(open).toContain('Continuity: The oak bench stays against the glass.');
    expect(pinned).toContain('Framing: A medium frame with the subject left of center.');
    expect(pinned).not.toContain('Wardrobe:');
    expect(pinned).not.toContain('oak bench');
    expect(studioQuote(6, '480p').basis).toBe('6s at $0.08/s for 480p = $0.48.');
    expect(studioQuote(8, '720p').totalUsd).toBeCloseTo(1.12, 5);
  });

  it('names the spoken line with the voice tag when a voice is set', () => {
    const prompt = buildGrokShotPrompt({
      action: 'The subject turns toward the camera.',
      pinnedFrame: true,
      dialogue: 'Hello there friend.',
      voiceId: 'rex',
    });
    expect(prompt).toContain('<AUDIO_0>');
    expect(prompt).toContain('briskly');
    expect(prompt).toContain('Hello there friend.');
    expect(prompt).not.toContain('easy natural pace');
    expect(lintSentPrompt(prompt, GROK_SHOT_STORED_NEGATIVE)).toEqual([]);
  });

  it('defaults resolution to 720p and keeps an explicit 480p', () => {
    expect(studioGrokResolution(undefined)).toBe('720p');
    expect(studioGrokResolution('')).toBe('720p');
    expect(studioGrokResolution('480p')).toBe('480p');
    expect(studioGrokResolution('1080p')).toBe('1080p');
  });

  it('sizes a clip to an explicit track and leaves a silent shot on its own duration', () => {
    expect(durationForStudioGrokShot(6, undefined)).toBe(6);
    expect(durationForStudioGrokShot(6, null)).toBe(6);
    expect(durationForStudioGrokShot(6, '')).toBe(6);
    expect(durationForStudioGrokShot(6, 5)).toBe(5);
    expect(durationForStudioGrokShot(4, 20)).toBe(15);
  });

  it('keeps a pinned start frame out of the reference list and cutouts a local portrait', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'grok-shot-refs-'));
    const portrait = path.join(dir, 'portrait.png');
    const start = path.join(dir, 'start.png');
    writePng(portrait, 32, 48);
    writePng(start, 32, 48);
    const before = fs.readFileSync(portrait);

    const refs = await studioGrokReferenceUrls({
      personUrls: [portrait, start, 'https://example.invalid/face.png'],
      backgroundUrl: 'https://example.invalid/room.png',
      pinnedUrl: start,
      resolve: (url) => url,
      cutout: featheredSubjectCutout,
    });

    expect(refs).toHaveLength(3);
    expect(refs[0]).toMatch(/portrait\.cutout\.png$/);
    expect(refs).not.toContain(start);
    expect(refs).toContain('https://example.invalid/face.png');
    expect(refs).toContain('https://example.invalid/room.png');
    expect(fs.readFileSync(portrait).equals(before)).toBe(true);
  });
});
