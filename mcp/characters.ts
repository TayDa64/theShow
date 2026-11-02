/**
 * Characters, kept on disk so they outlive the session that created them.
 *
 * A character is a name plus the photos that show what that person looks like,
 * and both halves have to survive. The memory-only version lost the whole cast
 * when the process ended, portrait included, which made the one feature a phone
 * user needs most — drop a photo into chat, reuse it in every film after — the
 * one that stopped working the moment they came back.
 *
 * So each character owns a folder, its reference images are copied into that
 * folder, and the folder is the source of truth. ~/.theshow/jobs does the same
 * for films; THESHOW_CHARACTERS_DIR overrides, for tests.
 */

import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, join, sep } from "node:path";

export const CHARACTERS_DIR =
  process.env.THESHOW_CHARACTERS_DIR || join(homedir(), ".theshow", "characters");

/**
 * The characters directory in force right now.
 *
 * The env var is read per call rather than captured at import, so a test can
 * point THESHOW_CHARACTERS_DIR at a temp directory and the module follows it
 * without having to be re-imported in a particular order.
 */
function charactersRoot() {
  return process.env.THESHOW_CHARACTERS_DIR || CHARACTERS_DIR;
}

export type CharacterRecord = {
  id: string;
  name: string;
  role?: string;
  description?: string;
  /** Local paths point at copies inside this character's own refs folder. */
  referenceImageUrls: string[];
  createdAt: string;
  updatedAt: string;
  /** Where this character lives. Runtime detail, not written to character.json. */
  folder: string;
  /**
   * Images that could not be kept, or a record that could not be written. About
   * this save, not the character, so it is returned to the caller and never
   * written: reading last week's warning back tomorrow would be stale news.
   */
  warnings?: string[];
};

export type CharacterInput = {
  name: string;
  role?: string;
  description?: string;
  referenceImageUrls?: string[];
};

function shortHash(value: string) {
  return createHash("sha1").update(value).digest("hex").slice(0, 8);
}

/**
 * The filesystem-safe form of a name, so "Ana Marie" and "ana-marie" land in
 * the same place and neither can escape the characters directory.
 */
function slugFor(name: string) {
  const slug = name
    .trim()
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 60)
    .replace(/-+$/g, "");
  return slug || "character";
}

function sameName(a: string, b: string) {
  return a.trim().toLowerCase() === b.trim().toLowerCase();
}

/**
 * The folders a name can live in, in the order to try: the plain slug, then a
 * sibling with a short hash of the exact name.
 *
 * Slugs collide. "Ana Marie" and "Ana-Marie" both slug to `ana-marie`, and if
 * the second simply reused the folder it would silently overwrite the first —
 * a different character's face replacing this one's. The hash only depends on
 * the name, so the same name always resolves to the same folder: the first to
 * arrive takes the plain slug, and the other finds its own folder waiting.
 */
function candidateFolders(root: string, name: string) {
  const slug = slugFor(name);
  return [join(root, slug), join(root, `${slug}-${shortHash(name.trim().toLowerCase())}`)];
}

/** Read the record out of character.json text, or say why it cannot be used. */
function parseRecord(folder: string, raw: string): CharacterRecord | undefined {
  const file = join(folder, "character.json");
  try {
    const parsed = JSON.parse(raw) as Partial<CharacterRecord>;
    if (!parsed || typeof parsed.name !== "string" || !parsed.name.trim()) {
      throw new Error("the record has no name");
    }
    return {
      id:
        typeof parsed.id === "string" && parsed.id
          ? parsed.id
          : `char_${shortHash(parsed.name)}`,
      name: parsed.name.trim(),
      role: typeof parsed.role === "string" ? parsed.role : undefined,
      description: typeof parsed.description === "string" ? parsed.description : undefined,
      referenceImageUrls: Array.isArray(parsed.referenceImageUrls)
        ? parsed.referenceImageUrls.filter((ref): ref is string => typeof ref === "string")
        : [],
      createdAt: typeof parsed.createdAt === "string" ? parsed.createdAt : "",
      updatedAt: typeof parsed.updatedAt === "string" ? parsed.updatedAt : "",
      folder,
    };
  } catch (err) {
    // One unreadable character must not stop the rest of the cast from loading,
    // and it must not throw at the caller: a broken file is not a broken tool.
    console.error(`theShow: skipping character record ${file}:`, err);
    return undefined;
  }
}

async function readRecord(
  folder: string,
  options: { quiet?: boolean } = {},
): Promise<CharacterRecord | undefined> {
  const file = join(folder, "character.json");
  try {
    return parseRecord(folder, await readFile(file, "utf8"));
  } catch (err) {
    // A folder with no record yet is normal — it is about to be written, or a
    // save died between the mkdir and the write. Only complain when asked to.
    if (!options.quiet) {
      console.error(`theShow: skipping character folder ${folder}:`, err);
    }
    return undefined;
  }
}

/**
 * Which folder this character belongs in.
 *
 * The plain slug unless something else already owns it, in which case the
 * hash-suffixed sibling. A folder holding an unreadable record is treated as
 * taken rather than overwritten: a corrupt file may still be the only copy of
 * someone's character, and losing it to a later "create the same name" would be
 * the exact failure this module exists to prevent.
 */
async function folderForWrite(root: string, name: string) {
  const [plain, hashed] = candidateFolders(root, name);
  if (!existsSync(plain)) return plain;
  const record = await readRecord(plain, { quiet: true });
  return record && sameName(record.name, name) ? plain : hashed;
}

/** A stable filename for a copied photo, recognisable and unique per source. */
function copyNameFor(source: string) {
  const file = basename(source);
  const extension = file.match(/(\.[a-z0-9]+)$/i)?.[1]?.toLowerCase() ?? "";
  const stem = slugFor(file.replace(/\.[^.]*$/, "")).slice(0, 40) || "ref";
  return `${stem}-${shortHash(source)}${extension}`;
}

/**
 * Copy local reference images into the character's folder.
 *
 * Chat attachments are content-addressed and temporary: the file the user
 * dropped in this morning can be gone by the time they make a second film, and
 * a character whose portrait no longer exists cannot hold a face. Copying is
 * what turns "this one photo, this once" into a reference the character owns.
 *
 * A source that cannot be read does not fail the character. Losing the whole
 * cast because one path went stale is worse than a character saved with nine of
 * ten photos, so the failure is recorded and the rest are kept.
 */
async function keepReferences(input: {
  folder: string;
  refs: string[];
  warnings: string[];
}) {
  const refsDir = join(input.folder, "refs");
  const kept: string[] = [];
  const seen = new Set<string>();

  for (const ref of input.refs) {
    const trimmed = ref.trim();
    if (!trimmed || seen.has(trimmed)) continue;
    seen.add(trimmed);

    // A public URL or an inline data URI already travels with the record.
    if (/^(https?:|data:)/i.test(trimmed)) {
      kept.push(trimmed);
      continue;
    }

    const source = trimmed.startsWith("file://") ? new URL(trimmed).pathname : trimmed;

    // Already one of this character's copies (a re-save of a loaded record):
    // keep it rather than copying the copy under a new name.
    if (source === refsDir || source.startsWith(refsDir + sep)) {
      kept.push(source);
      continue;
    }

    const target = join(refsDir, copyNameFor(source));
    try {
      const bytes = await readFile(source);
      await mkdir(refsDir, { recursive: true });
      await writeFile(target, bytes);
      kept.push(target);
    } catch (err) {
      input.warnings.push(
        `Could not keep reference image ${source}: ${err instanceof Error ? err.message : "unreadable"}. ` +
          "The character was saved without it.",
      );
    }
  }

  return kept;
}

/**
 * Create or update a character on disk and return the record as written.
 *
 * Blanks are filled from what the folder already holds, so adding a portrait to
 * an existing character keeps the wardrobe notes the user already gave, and
 * re-saving without photos keeps the photos.
 */
export async function saveCharacter(input: CharacterInput): Promise<CharacterRecord> {
  const name = input.name.trim();
  if (!name) throw new Error("A character needs a name.");

  const root = charactersRoot();
  const folder = await folderForWrite(root, name);
  const existing = await readRecord(folder, { quiet: true });
  const warnings: string[] = [];

  const referenceImageUrls = await keepReferences({
    folder,
    refs: input.referenceImageUrls ?? existing?.referenceImageUrls ?? [],
    warnings,
  });

  const now = new Date().toISOString();
  const record: CharacterRecord = {
    id: existing?.id ?? `char_${Date.now().toString(36)}_${shortHash(name)}`,
    name,
    role: input.role ?? existing?.role,
    description: input.description ?? existing?.description,
    referenceImageUrls,
    createdAt: existing?.createdAt || now,
    updatedAt: now,
    folder,
  };

  // Exactly the documented shape on disk: the runtime extras stay in memory.
  const onDisk = {
    id: record.id,
    name: record.name,
    role: record.role,
    description: record.description,
    referenceImageUrls: record.referenceImageUrls,
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
  };

  try {
    await mkdir(folder, { recursive: true });
    await writeFile(join(folder, "character.json"), JSON.stringify(onDisk, null, 2), "utf8");
  } catch (err) {
    // A failed write must never lose the character. The caller keeps the record
    // it was handed, and the next save tries again.
    const message = err instanceof Error ? err.message : String(err);
    warnings.push(`Could not write ${join(folder, "character.json")}: ${message}`);
    console.error(`theShow: could not save character ${name}:`, err);
  }

  if (warnings.length > 0) record.warnings = warnings;
  return record;
}

/** A character by name, or undefined when there is no such character on disk. */
export async function loadCharacter(name: string): Promise<CharacterRecord | undefined> {
  const root = charactersRoot();
  for (const folder of candidateFolders(root, name)) {
    const record = await readRecord(folder, { quiet: true });
    if (record && sameName(record.name, name)) return record;
  }
  return undefined;
}

/**
 * The same lookup, synchronous.
 *
 * Storyboard planning reads characters while it is building shots, and those
 * call sites are synchronous by design. One small JSON file on a cache miss is
 * cheaper than threading a promise through every caller.
 */
export function loadCharacterSync(name: string): CharacterRecord | undefined {
  const root = charactersRoot();
  for (const folder of candidateFolders(root, name)) {
    let raw: string;
    try {
      raw = readFileSync(join(folder, "character.json"), "utf8");
    } catch {
      continue;
    }
    const record = parseRecord(folder, raw);
    if (record && sameName(record.name, name)) return record;
  }
  return undefined;
}

/**
 * Every character on disk, newest version of each.
 *
 * Two folders can carry the same character after a race or a rename that left an
 * old copy behind; the one written most recently wins. Deduplication is keyed on
 * the exact name as well as the slug, because two names that merely slug alike
 * are two different characters — collapsing them here would hide one of them
 * from plan_storyboard, which is the collision this module already guards
 * against on the write side.
 */
export async function loadAllCharacters(): Promise<CharacterRecord[]> {
  const root = charactersRoot();
  let folders: string[];
  try {
    folders = await readdir(root);
  } catch {
    // No characters directory yet: a first run.
    return [];
  }

  const newest = new Map<string, CharacterRecord>();
  for (const entry of folders) {
    const record = await readRecord(join(root, entry));
    if (!record) continue;
    const key = `${slugFor(record.name)}|${record.name.trim().toLowerCase()}`;
    const previous = newest.get(key);
    if (!previous || record.updatedAt > previous.updatedAt) newest.set(key, record);
  }

  return [...newest.values()].sort((a, b) => a.name.localeCompare(b.name));
}

/** Every character, plus where they are kept, for a tool that reports both. */
export async function listCharacters() {
  return { characters: await loadAllCharacters(), storage: charactersRoot() };
}
