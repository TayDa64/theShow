/**
 * Reads a provider-net-guard log. Every spawned bundle must have written
 * `guard-loaded`, and every other line must be loopback. A swallowed fetch
 * still leaves `<kind> <target>` in the file, so the check does not depend
 * on the guard's throw escaping the caller.
 */
import { isLoopback } from "./loopback-host.mjs";

export const GUARD_MARKER = "guard-loaded";

export function assertGuardLog(text: string, minimumMarkers = 1): void {
  const lines = text.split("\n").filter((line) => line.length > 0);
  const markers = lines.filter((line) => line === GUARD_MARKER).length;
  if (markers < minimumMarkers) {
    throw new Error(`net guard was not loaded (${markers} ${GUARD_MARKER} marker(s), need ${minimumMarkers})\n${text}`);
  }
  for (const line of lines) {
    if (line === GUARD_MARKER) continue;
    const space = line.indexOf(" ");
    const target = space === -1 ? line : line.slice(space + 1);
    if (!isLoopback(target)) {
      throw new Error(`non-loopback network call: ${line}`);
    }
  }
}
