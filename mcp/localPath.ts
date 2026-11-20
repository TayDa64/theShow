/**
 * Local paths for image and media references.
 *
 * A Windows drive path (`C:\...` or `C:/...`) is not a URL. Treating `C:` as a
 * scheme refuses every local file the app just wrote. file: URLs are converted
 * with fileURLToPath so `%20` is decoded and a drive URL is not left as
 * `/C:/...`, which path.resolve on Windows turns into `C:\C:\...`.
 */
import path from "node:path";
import { fileURLToPath } from "node:url";

export type LocalPathPlatform = "posix" | "win32";

/** Injected for tests. Production uses the host path module and realpath. */
export type LocalPathCheck = {
  platform?: LocalPathPlatform;
  realpathSync?: (target: string) => string;
};

const WINDOWS_DRIVE_PATH = /^[a-zA-Z]:[\\/]/;
const URL_SCHEME = /^[a-z][a-z0-9+.-]*:/i;

export function isWindowsDrivePath(ref: string): boolean {
  return WINDOWS_DRIVE_PATH.test(ref);
}

/** True for http:, ftp:, javascript:, and any scheme other than file:. */
export function isRefusedUrlScheme(ref: string): boolean {
  if (isWindowsDrivePath(ref)) return false;
  return URL_SCHEME.test(ref) && !ref.toLowerCase().startsWith("file:");
}

export function hostLocalPathPlatform(): LocalPathPlatform {
  return process.platform === "win32" ? "win32" : "posix";
}

export function pathApiFor(platform: LocalPathPlatform): path.PlatformPath {
  switch (platform) {
    case "win32":
      return path.win32;
    case "posix":
      return path.posix;
    default: {
      const unexpected: never = platform;
      throw new Error(`Unexpected path platform ${unexpected}`);
    }
  }
}

/**
 * file: URL to a filesystem path, via node:url fileURLToPath.
 *
 * fileURLToPath follows the host. On Linux, a Windows drive URL comes back as
 * `/C:/Users/Tay Liku/...` (space decoded, drive still behind a leading slash).
 * When a test asks for win32 semantics, that form is normalized with
 * path.win32, which is the path fileURLToPath returns on Windows. A Windows
 * host uses fileURLToPath directly, including UNC paths.
 */
export function fileUrlToLocalPath(
  ref: string,
  platform: LocalPathPlatform = hostLocalPathPlatform(),
): string {
  const decoded = fileURLToPath(ref);
  if (platform === "win32" && process.platform !== "win32") {
    const drive = /^\/([A-Za-z]:\/.*)$/.exec(decoded);
    if (drive) return path.win32.normalize(drive[1]);
  }
  return decoded;
}

/** Plain paths pass through. file: URLs are converted with fileURLToPath. */
export function localPathFromRef(
  ref: string,
  platform: LocalPathPlatform = hostLocalPathPlatform(),
): string {
  if (ref.toLowerCase().startsWith("file:")) return fileUrlToLocalPath(ref, platform);
  return ref;
}
