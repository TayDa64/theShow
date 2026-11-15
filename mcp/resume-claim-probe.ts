/**
 * Test seam for a failure after a film claim is taken.
 * Production leaves this unset. Tests install a probe and clear it afterwards.
 */
type ResumeClaimProbe = () => void | Promise<void>;

let probe: ResumeClaimProbe | undefined;

export function setResumeClaimProbe(next: ResumeClaimProbe | undefined): void {
  probe = next;
}

export async function runResumeClaimProbe(): Promise<void> {
  if (probe) await probe();
}
