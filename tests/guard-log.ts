/**
 * Reads a provider-net-guard log.
 * A loaded line is `guard-loaded <pid> <script>`. The check requires one line
 * for each server bundle process. A launcher marker does not stand in for the
 * bundle. Every other line must name a loopback target.
 */
import { isLoopback } from "./loopback-host.mjs";

export const GUARD_MARKER = "guard-loaded";

export type GuardedProcess = { pid: number; script: string };

export function assertGuardLog(text: string, required: readonly GuardedProcess[]): void {
  const lines = text.split("\n").filter((line) => line.length > 0);
  const loaded = new Set<string>();
  for (const line of lines) {
    if (!line.startsWith(`${GUARD_MARKER} `)) continue;
    const match = /^guard-loaded (\d+) (\S+)$/.exec(line);
    if (!match) {
      throw new Error(`unreadable guard marker: ${line}`);
    }
    loaded.add(`${match[1]} ${match[2]}`);
  }
  for (const process of required) {
    const key = `${process.pid} ${process.script}`;
    if (!loaded.has(key)) {
      throw new Error(`net guard was not loaded in ${process.script} pid ${process.pid}\n${text}`);
    }
  }
  if (required.length === 0) {
    throw new Error(`net guard check needs the server bundle processes\n${text}`);
  }
  for (const line of lines) {
    if (line.startsWith(`${GUARD_MARKER} `)) continue;
    const space = line.indexOf(" ");
    const target = space === -1 ? line : line.slice(space + 1);
    if (!target || target === "<undetermined>" || !isLoopback(target)) {
      throw new Error(`non-loopback network call: ${line}`);
    }
  }
}
