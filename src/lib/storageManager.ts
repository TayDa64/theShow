import fs from 'fs';
import path from 'path';
import multer from 'multer';
import { v4 as uuidv4 } from 'uuid';

export const ALLOWED_IMAGE_MIME_TYPES = new Set(['image/png', 'image/jpeg', 'image/webp']);

const MIME_EXTENSION_MAP: Record<string, string> = {
  'image/png': '.png',
  'image/jpeg': '.jpg',
  'image/webp': '.webp',
};

export function isAllowedImageMimeType(mimeType: string | undefined | null) {
  return !!mimeType && ALLOWED_IMAGE_MIME_TYPES.has(mimeType.toLowerCase());
}

export function ensureDirectory(directoryPath: string) {
  fs.mkdirSync(directoryPath, { recursive: true });
  return directoryPath;
}

export function getUploadsRoot(baseDir = process.cwd()) {
  return ensureDirectory(path.join(baseDir, 'uploads'));
}

export function getTempClipsDirectory(baseDir = process.cwd()) {
  return ensureDirectory(path.join(getUploadsRoot(baseDir), 'temp-clips'));
}

export function getDatePartition(date = new Date()) {
  const year = String(date.getUTCFullYear());
  const month = String(date.getUTCMonth() + 1).padStart(2, '0');
  const day = String(date.getUTCDate()).padStart(2, '0');
  return path.join(year, month, day);
}

export function buildUploadTarget(options: {
  baseDir?: string;
  mimeType: string;
  date?: Date;
}) {
  const extension = MIME_EXTENSION_MAP[options.mimeType] || '.bin';
  const relativeDir = getDatePartition(options.date);
  const root = getUploadsRoot(options.baseDir);
  const absoluteDir = ensureDirectory(path.join(root, relativeDir));
  const filename = `${uuidv4()}${extension}`;
  const absolutePath = path.join(absoluteDir, filename);
  const relativePath = path.posix.join(relativeDir.split(path.sep).join('/'), filename);

  return {
    root,
    absoluteDir,
    filename,
    absolutePath,
    relativePath,
    publicUrl: `/uploads/${relativePath}`,
  };
}

export function createUploadMiddleware(baseDir = process.cwd()) {
  return multer({
    storage: multer.diskStorage({
      destination: (_req, file, callback) => {
        if (!isAllowedImageMimeType(file.mimetype)) {
          callback(new Error('Only PNG, JPEG, and WEBP uploads are supported.'), '');
          return;
        }

        const target = buildUploadTarget({ baseDir, mimeType: file.mimetype });
        callback(null, target.absoluteDir);
      },
      filename: (_req, file, callback) => {
        const target = buildUploadTarget({ baseDir, mimeType: file.mimetype });
        callback(null, target.filename);
      },
    }),
    limits: {
      fileSize: 10 * 1024 * 1024,
    },
    fileFilter: (_req, file, callback) => {
      if (!isAllowedImageMimeType(file.mimetype)) {
        callback(new Error('Only PNG, JPEG, and WEBP uploads are supported.'));
        return;
      }

      callback(null, true);
    },
  });
}

export function createUploadedAsset(file: Express.Multer.File, kind: string, label?: string) {
  const relativePath = path.relative(getUploadsRoot(), file.path).split(path.sep).join('/');
  return {
    id: `asset-${uuidv4()}`,
    kind,
    origin: 'upload',
    label: label || path.basename(file.originalname, path.extname(file.originalname)),
    url: `/uploads/${relativePath}`,
    mimeType: file.mimetype,
    createdAt: new Date().toISOString(),
  };
}

export async function saveBufferAsUpload(buffer: Buffer, mimeType: string, options?: { label?: string; baseDir?: string }) {
  const target = buildUploadTarget({ baseDir: options?.baseDir, mimeType });
  await fs.promises.writeFile(target.absolutePath, buffer);
  return {
    path: target.absolutePath,
    url: target.publicUrl,
    label: options?.label,
  };
}

export async function cleanupTempClips(baseDir = process.cwd(), maxAgeMs = 60 * 60 * 1000) {
  const tempDir = getTempClipsDirectory(baseDir);
  const entries = await fs.promises.readdir(tempDir, { withFileTypes: true });
  const now = Date.now();

  await Promise.all(entries.map(async (entry) => {
    if (!entry.isFile()) {
      return;
    }

    const fullPath = path.join(tempDir, entry.name);
    const stats = await fs.promises.stat(fullPath);
    if (now - stats.mtimeMs > maxAgeMs) {
      await fs.promises.rm(fullPath, { force: true });
    }
  }));
}
