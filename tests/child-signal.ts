import type { ChildProcess } from "node:child_process";

/** Resolve when the child has exited, including when it already has. */
export function waitForChildClose(child: ChildProcess): Promise<void> {
  return new Promise((resolve) => {
    if (child.exitCode !== null || child.signalCode !== null) {
      resolve();
      return;
    }
    child.once("close", () => resolve());
  });
}

/**
 * Wait until a child prints `needle`, or until the ceiling passes.
 * The condition is the signal itself. The ceiling is only a backstop.
 */
export async function waitForChildSignal(
  child: ChildProcess,
  text: () => string,
  needle: string,
  ceilingMs: number,
): Promise<void> {
  const started = Date.now();
  while (!text().includes(needle)) {
    if (child.exitCode !== null || child.signalCode !== null) {
      throw new Error(`child exited before ${needle}\n${text()}`);
    }
    if (Date.now() - started >= ceilingMs) {
      throw new Error(`child did not signal ${needle} within ${ceilingMs}ms\n${text()}`);
    }
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}
