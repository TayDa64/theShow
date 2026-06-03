import { describe, expect, it } from 'vitest';
import { buildUploadTarget, isAllowedImageMimeType } from '../src/lib/storageManager';

describe('storage manager', () => {
  it('accepts only png, jpeg, and webp image uploads', () => {
    expect(isAllowedImageMimeType('image/png')).toBe(true);
    expect(isAllowedImageMimeType('image/jpeg')).toBe(true);
    expect(isAllowedImageMimeType('image/webp')).toBe(true);
    expect(isAllowedImageMimeType('application/x-msdownload')).toBe(false);
  });

  it('creates date-partitioned uuid upload targets', () => {
    const target = buildUploadTarget({ mimeType: 'image/png', date: new Date('2026-06-02T00:00:00.000Z') });
    expect(target.relativePath).toMatch(/^2026\/06\/02\/[0-9a-f-]+\.png$/);
    expect(target.publicUrl).toMatch(/^\/uploads\/2026\/06\/02\//);
  });
});
