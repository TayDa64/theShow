/**
 * Guards that a character — and the photos that make it that character — outlive
 * the session that created it.
 *
 * Every assertion here covers something that was broken or that would break the
 * phone flow quietly:
 *
 *  - characters lived in a Map, so the cast and its reference images were gone
 *    when the process ended. Nothing errored; the character was just absent.
 *  - a reference image was stored by the path it arrived on. Chat attachments
 *    are content-addressed and temporary, so that path is the one thing most
 *    likely to be gone next week. The photo has to be copied.
 */
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { mkdtempSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  CHARACTERS_DIR,
  listCharacters,
  loadAllCharacters,
  loadCharacter,
  loadCharacterSync,
  saveCharacter,
} from '../mcp/characters.ts';

let root: string;
let sourceDir: string;

/**
 * A fresh characters directory per test. THESHOW_CHARACTERS_DIR is read per call
 * rather than at import, so pointing it here is enough to keep every test off
 * the real ~/.theshow.
 */
beforeEach(() => {
  root = mkdtempSync(path.join(os.tmpdir(), 'theshow-characters-'));
  sourceDir = mkdtempSync(path.join(os.tmpdir(), 'theshow-char-source-'));
  process.env.THESHOW_CHARACTERS_DIR = root;
});

afterEach(() => {
  delete process.env.THESHOW_CHARACTERS_DIR;
  rmSync(root, { recursive: true, force: true });
  rmSync(sourceDir, { recursive: true, force: true });
});

/** Stand-in for a photo a user dropped into chat. */
function photo(name: string, bytes = 'fake-jpeg-bytes') {
  const file = path.join(sourceDir, name);
  writeFileSync(file, bytes);
  return file;
}

describe('a character survives the session', () => {
  it('loads back by name from disk, not from memory', async () => {
    await saveCharacter({
      name: 'Dad',
      role: 'lead',
      description: 'Tall, grey beard, sheepskin coat.',
    });

    // Nothing in this call path has seen the character before; the only source
    // of truth is the directory. This is the restart the old Map could not take.
    const loaded = await loadCharacter('Dad');
    expect(loaded).toBeDefined();
    expect(loaded!.name).toBe('Dad');
    expect(loaded!.role).toBe('lead');
    expect(loaded!.description).toBe('Tall, grey beard, sheepskin coat.');
    expect(loaded!.id).toBeTruthy();
  });

  it('survives a fresh module instance, not just a fresh call', async () => {
    await saveCharacter({ name: 'Dad', role: 'lead', description: 'Sheepskin coat.' });

    // Drop every cached module, so the next import has no memory of the save.
    // This is the restart the old in-memory store could not survive: nothing is
    // shared with the instance that wrote the character except the directory.
    vi.resetModules();
    const fresh = await import('../mcp/characters.ts');

    const loaded = await fresh.loadCharacter('Dad');
    expect(loaded?.role).toBe('lead');
    expect(loaded?.description).toBe('Sheepskin coat.');
  });

  it('writes the documented record shape to character.json', async () => {
    const saved = await saveCharacter({
      name: 'Mum',
      role: 'support',
      description: 'Short, sharp, always right.',
    });
    const raw = readFileSync(path.join(saved.folder, 'character.json'), 'utf8');
    const record = JSON.parse(raw);

    expect(Object.keys(record).sort()).toEqual(
      ['createdAt', 'description', 'id', 'name', 'referenceImageUrls', 'role', 'updatedAt'].sort(),
    );
    expect(record.name).toBe('Mum');
    expect(record.referenceImageUrls).toEqual([]);
    // Runtime details stay out of the file the user could edit by hand.
    expect(record.folder).toBeUndefined();
    expect(record.warnings).toBeUndefined();
  });

  it('omits a blank optional field instead of writing null into it', async () => {
    const saved = await saveCharacter({ name: 'Extra' });
    const record = JSON.parse(readFileSync(path.join(saved.folder, 'character.json'), 'utf8'));

    // A missing role must stay missing. `role: null` would read back as a role
    // someone deliberately cleared, and would show up that way in a storyboard.
    expect('role' in record).toBe(false);
    expect('description' in record).toBe(false);
    expect(record.name).toBe('Extra');
  });

  it('keeps the same id and creation time when the character is updated', async () => {
    const first = await saveCharacter({ name: 'Ana', role: 'hero' });
    const second = await saveCharacter({ name: 'Ana', description: 'Red coat.' });

    expect(second.id).toBe(first.id);
    expect(second.createdAt).toBe(first.createdAt);
    // An update must not blank the fields it did not mention.
    expect(second.role).toBe('hero');
    expect(second.description).toBe('Red coat.');
  });

  it('keeps the name case the user gave it while matching case-insensitively', async () => {
    await saveCharacter({ name: 'Ana Marie', role: 'hero' });
    expect((await loadCharacter('ana marie'))?.name).toBe('Ana Marie');
    expect(loadCharacterSync('ANA MARIE')?.role).toBe('hero');
  });
});

describe('reference images', () => {
  it('copies a local image into the character folder and points at the copy', async () => {
    const source = photo('portrait.jpg', 'the-only-photo-of-dad');
    const saved = await saveCharacter({ name: 'Dad', referenceImageUrls: [source] });

    const stored = saved.referenceImageUrls[0];
    expect(stored).not.toBe(source);
    expect(stored.startsWith(path.join(saved.folder, 'refs'))).toBe(true);

    // The copy is what makes this durable: the bytes are here, not only at the
    // chat attachment path that will disappear.
    expect(existsSync(stored)).toBe(true);
    expect(readFileSync(stored, 'utf8')).toBe('the-only-photo-of-dad');
  });

  it('keeps the photo usable after the original is deleted', async () => {
    const source = photo('portrait.jpg');
    const saved = await saveCharacter({ name: 'Dad', referenceImageUrls: [source] });
    rmSync(source);

    const loaded = await loadCharacter('Dad');
    expect(existsSync(loaded!.referenceImageUrls[0])).toBe(true);
    expect(readFileSync(loaded!.referenceImageUrls[0], 'utf8')).toBe('fake-jpeg-bytes');
  });

  it('creates the character anyway when a source file is unreadable, and says so', async () => {
    const good = photo('good.jpg', 'good-bytes');
    const missing = path.join(sourceDir, 'never-existed.jpg');

    const saved = await saveCharacter({
      name: 'Dad',
      role: 'lead',
      referenceImageUrls: [good, missing],
    });

    // The character is the point. Losing it because one of three photos went
    // stale would be the worse failure.
    expect(saved.name).toBe('Dad');
    expect(saved.role).toBe('lead');
    expect(saved.referenceImageUrls).toHaveLength(1);
    expect(readFileSync(saved.referenceImageUrls[0], 'utf8')).toBe('good-bytes');
    expect(saved.warnings?.join(' ')).toContain('never-existed.jpg');
    expect((await loadCharacter('Dad'))?.role).toBe('lead');
  });

  it('stores https URLs unchanged, because there is nothing to copy', async () => {
    const url = 'https://example.com/dad.png';
    const saved = await saveCharacter({ name: 'Dad', referenceImageUrls: [url] });

    expect(saved.referenceImageUrls).toEqual([url]);
    // No refs folder should be created for a remote reference.
    expect(existsSync(path.join(saved.folder, 'refs'))).toBe(false);
  });

  it('never copies a copy on update, so repeated saves do not pile up files', async () => {
    const source = photo('portrait.jpg');
    const first = await saveCharacter({ name: 'Dad', referenceImageUrls: [source] });
    const second = await saveCharacter({ name: 'Dad', description: 'Grey beard.' });

    expect(second.referenceImageUrls).toEqual(first.referenceImageUrls);
  });

  it('saves and loads a character with no reference images at all', async () => {
    // A named character with wardrobe notes is useful with no photo.
    const saved = await saveCharacter({ name: 'Stranger', description: 'Always in shadow.' });
    expect(saved.referenceImageUrls).toEqual([]);

    const loaded = await loadCharacter('Stranger');
    expect(loaded?.description).toBe('Always in shadow.');
    expect(loaded?.referenceImageUrls).toEqual([]);
  });
});

describe('two names that slug alike', () => {
  it('does not let one overwrite the other', async () => {
    const a = await saveCharacter({ name: 'Ana Marie', role: 'hero' });
    const b = await saveCharacter({ name: 'ana-marie', role: 'villain' });

    expect(a.folder).not.toBe(b.folder);
    expect((await loadCharacter('Ana Marie'))?.role).toBe('hero');
    expect((await loadCharacter('ana-marie'))?.role).toBe('villain');
    // Both must appear in the cast list, or one becomes invisible to planning.
    const all = await loadAllCharacters();
    expect(all.map((c) => c.name).sort()).toEqual(['Ana Marie', 'ana-marie'].sort());
  });

  it('is stable: the same colliding name always finds its own folder', async () => {
    await saveCharacter({ name: 'Ana Marie', role: 'hero' });
    const first = await saveCharacter({ name: 'ana-marie', role: 'villain' });
    const again = await saveCharacter({ name: 'ana-marie', role: 'villain' });

    expect(again.folder).toBe(first.folder);
    expect(again.id).toBe(first.id);
  });
});

describe('a damaged character folder', () => {
  it('skips a corrupt character.json and still loads the others', async () => {
    await saveCharacter({ name: 'Dad', role: 'lead' });
    const broken = path.join(root, 'broken-character');
    mkdirSync(broken, { recursive: true });
    writeFileSync(path.join(broken, 'character.json'), '{ this is not json', 'utf8');

    // A broken file is not a broken tool: the good character must still be here.
    const all = await loadAllCharacters();
    expect(all.map((c) => c.name)).toEqual(['Dad']);
    expect(await loadCharacter('Dad')).toBeDefined();
  });

  it('returns nothing rather than throwing for an unknown name', async () => {
    expect(await loadCharacter('Nobody')).toBeUndefined();
    expect(loadCharacterSync('Nobody')).toBeUndefined();
  });

  it('reports where characters are kept', async () => {
    await saveCharacter({ name: 'Dad' });
    const listed = await listCharacters();
    expect(listed.storage).toBe(root);
    expect(listed.characters.map((c) => c.name)).toEqual(['Dad']);
  });

  it('defaults to ~/.theshow/characters when no override is set', async () => {
    delete process.env.THESHOW_CHARACTERS_DIR;
    vi.resetModules();
    const fresh = await import('../mcp/characters.ts');
    expect(fresh.CHARACTERS_DIR.endsWith(path.join('.theshow', 'characters'))).toBe(true);
  });
});
