/**
 * Exact loopback check shared by the preload and the log assertion.
 * localhost.example.com and 127.0.0.1.nip.io are not loopback.
 */

/** Hostname of a URL, a host:port, or a bare host. Empty when there is nothing to judge. */
export function hostnameOf(target) {
  const text = String(target ?? "").trim();
  if (!text) return "";
  try {
    const withScheme = text.includes("://") ? text : `http://${text}`;
    return new URL(withScheme).hostname.toLowerCase().replace(/^\[|\]$/g, "").replace(/\.$/, "");
  } catch {
    return text.toLowerCase();
  }
}

/** True for localhost, 127.0.0.0/8, and ::1. An empty target is not a provider call. */
export function isLoopback(target) {
  const host = hostnameOf(target);
  if (host === "") return true;
  if (host === "localhost" || host === "::1") return true;
  const match = host.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (!match) return false;
  const octets = match.slice(1).map((part) => Number(part));
  if (octets.some((octet) => octet > 255)) return false;
  return octets[0] === 127;
}
