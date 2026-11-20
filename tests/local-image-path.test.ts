/**
 * Windows local image refs were refused on every machine.
 *
 * `/^[a-z][a-z0-9+.-]*:/i` treats `C:` as a URL scheme, and
 * `new URL('file:///C:/...').pathname` is `/C:/...`, which path.resolve on
 * Windows turns into `C:\C:\...` with `%20` still encoded. These cases run
 * with path.win32 on Linux CI. POSIX cases use the host path module.
 */
import { mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';

import { saveCharacter } from '../mcp/characters.ts';
import { localImageRefAllowed, toApiImageRef } from '../mcp/grokVideo.ts';
import { fileUrlToLocalPath, localPathFromRef } from '../mcp/localPath.ts';

const WIN32 = {
  platform: 'win32' as const,
  // The file is not on this machine. A throwing realpath keeps the lexical
  // check from depending on whichever Windows ancestors happen to exist.
  realpathSync: (): string => {
    throw new Error('missing');
  },
};
const MEDIA = 'C:\\Users\\Tay Liku\\.theshow\\media';
const STILL = 'board-e1685746e58d564e.jpg';
const INSIDE = `${MEDIA}\\${STILL}`;

const temps: string[] = [];

afterEach(() => {
  for (const dir of temps.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function tempDir(): string {
  const dir = mkdtempSync(path.join(tmpdir(), 'theshow-local-ref-'));
  temps.push(dir);
  return dir;
}

describe('Windows local image refs (path.win32, Linux CI)', () => {
  it('accepts a backslash drive path inside the output folder', () => {
    expect(localImageRefAllowed(INSIDE, [MEDIA], WIN32)).toBe(true);
  });

  it('accepts a forward-slash drive path inside the output folder', () => {
    expect(localImageRefAllowed(`C:/Users/Tay Liku/.theshow/media/${STILL}`, [MEDIA], WIN32)).toBe(true);
  });

  it('accepts a file:///C:/ URL with an encoded space inside the output folder', () => {
    const ref = `file:///C:/Users/Tay%20Liku/.theshow/media/${STILL}`;
    expect(fileUrlToLocalPath(ref, 'win32')).toBe(INSIDE);
    expect(localPathFromRef(ref, 'win32')).toBe(INSIDE);
    expect(localImageRefAllowed(ref, [MEDIA], WIN32)).toBe(true);
  });

  it('accepts a still inside a character folder when that folder is a root', () => {
    const character = 'C:\\Users\\Tay Liku\\.theshow\\characters\\dad';
    const portrait = `${character}\\refs\\face.jpg`;
    expect(localImageRefAllowed(portrait, [MEDIA, character], WIN32)).toBe(true);
  });

  it('refuses a drive path outside the roots', () => {
    expect(localImageRefAllowed('C:\\Windows\\Temp\\outside.jpg', [MEDIA], WIN32)).toBe(false);
    expect(localImageRefAllowed('D:/Users/Tay Liku/.theshow/media/board.jpg', [MEDIA], WIN32)).toBe(false);
  });

  it('refuses a drive path that traverses out of the root with ..', () => {
    const escaped = 'C:\\Users\\Tay Liku\\.theshow\\media\\..\\..\\..\\Windows\\outside.jpg';
    expect(localImageRefAllowed(escaped, [MEDIA], WIN32)).toBe(false);
  });

  it('refuses a file URL that traverses out of the root', () => {
    const ref = 'file:///C:/Users/Tay%20Liku/.theshow/media/../../../Windows/outside.jpg';
    expect(localImageRefAllowed(ref, [MEDIA], WIN32)).toBe(false);
  });

  it('refuses a drive-relative path that has no slash after the colon', () => {
    expect(localImageRefAllowed('C:board.jpg', [MEDIA], WIN32)).toBe(false);
  });

  it('refuses a file URL with a host that is outside the output folder', () => {
    expect(localImageRefAllowed('file://hostname/share/a.jpg', [MEDIA], WIN32)).toBe(false);
  });

  it('refuses http, ftp, and javascript, and still accepts https and data:image', () => {
    expect(localImageRefAllowed('http://example.invalid/a.jpg', [MEDIA], WIN32)).toBe(false);
    expect(localImageRefAllowed('ftp://example.invalid/a.jpg', [MEDIA], WIN32)).toBe(false);
    expect(localImageRefAllowed('javascript:alert(1)', [MEDIA], WIN32)).toBe(false);
    expect(localImageRefAllowed('https://example.invalid/a.jpg', [MEDIA], WIN32)).toBe(true);
    expect(localImageRefAllowed('data:image/jpeg;base64,aaaa', [MEDIA], WIN32)).toBe(true);
  });

  it('accepts a path whose realpath stays inside the root and refuses one that escapes', () => {
    expect(localImageRefAllowed(INSIDE, [MEDIA], {
      platform: 'win32',
      realpathSync: () => INSIDE,
    })).toBe(true);
    expect(localImageRefAllowed(INSIDE, [MEDIA], {
      platform: 'win32',
      realpathSync: () => 'D:\\secret\\alias.jpg',
    })).toBe(false);
  });
});

describe('host platform local image refs (POSIX on Linux CI)', () => {
  it('accepts a file inside the root and refuses one outside, including .. traversal', () => {
    const root = tempDir();
    const outside = tempDir();
    const inside = path.join(root, 'still.jpg');
    const secret = path.join(outside, 'secret.jpg');
    writeFileSync(inside, 'inside');
    writeFileSync(secret, 'secret');

    expect(localImageRefAllowed(inside, [root])).toBe(true);
    expect(localImageRefAllowed(secret, [root])).toBe(false);
    expect(localImageRefAllowed(path.join(root, '..', path.basename(outside), 'secret.jpg'), [root])).toBe(false);
  });

  it('accepts a file: URL with an encoded space and reads it back', async () => {
    const root = tempDir();
    const file = path.join(root, 'tay liku.jpg');
    writeFileSync(file, 'jpeg-bytes');
    const ref = pathToFileURL(file).href;

    expect(fileUrlToLocalPath(ref)).toBe(fileURLToPath(ref));
    expect(fileUrlToLocalPath(ref)).toBe(file);
    expect(localImageRefAllowed(ref, [root])).toBe(true);
    await expect(toApiImageRef(ref)).resolves.toBe(
      `data:image/jpeg;base64,${Buffer.from('jpeg-bytes').toString('base64')}`,
    );
  });

  it('refuses a symlink inside the root whose target is outside the root', () => {
    const root = tempDir();
    const outside = tempDir();
    const secret = path.join(outside, 'secret.jpg');
    writeFileSync(secret, 'secret');
    const link = path.join(root, 'link.jpg');
    symlinkSync(secret, link);

    expect(localImageRefAllowed(link, [root])).toBe(false);
  });

  it('refuses non-file schemes and accepts https and data:image', () => {
    const root = tempDir();
    expect(localImageRefAllowed('http://example.invalid/a.jpg', [root])).toBe(false);
    expect(localImageRefAllowed('ftp://example.invalid/a.jpg', [root])).toBe(false);
    expect(localImageRefAllowed('javascript:alert(1)', [root])).toBe(false);
    expect(localImageRefAllowed('https://example.invalid/a.jpg', [root])).toBe(true);
    expect(localImageRefAllowed('data:image/png;base64,aaaa', [root])).toBe(true);
  });

  it('copies a file: URL reference with an encoded space into the character folder', async () => {
    const characters = tempDir();
    const sourceDir = tempDir();
    const previous = process.env.THESHOW_CHARACTERS_DIR;
    process.env.THESHOW_CHARACTERS_DIR = characters;
    try {
      const photo = path.join(sourceDir, 'tay liku.jpg');
      writeFileSync(photo, 'face');

      const saved = await saveCharacter({
        name: 'Dad',
        referenceImageUrls: [pathToFileURL(photo).href],
      });

      expect(saved.warnings).toBeUndefined();
      expect(saved.referenceImageUrls).toHaveLength(1);
      expect(saved.referenceImageUrls[0]).not.toContain('%20');
      expect(readFileSync(saved.referenceImageUrls[0], 'utf8')).toBe('face');
    } finally {
      if (previous === undefined) delete process.env.THESHOW_CHARACTERS_DIR;
      else process.env.THESHOW_CHARACTERS_DIR = previous;
    }
  });
});
