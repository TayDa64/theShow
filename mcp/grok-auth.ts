/**
 * Credential resolution for Grok Imagine Video.
 *
 * Two paths, tried in order:
 *
 *  1. XAI_API_KEY          - a pay-per-call API key, sent to https://api.x.ai
 *  2. Grok CLI session      - the OAuth session the `grok` CLI stores in
 *                             ~/.grok/auth.json, sent to the CLI inference proxy
 *                             (cli-chat-proxy.grok.com) so calls bill against the
 *                             user's existing Grok subscription instead of API credits.
 *
 * The session token is re-read from disk on every call, so a token the CLI
 * refreshes in the background is picked up without restarting the MCP server.
 */

import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export const API_BASE_URL = "https://api.x.ai";
export const PROXY_BASE_URL = "https://cli-chat-proxy.grok.com";

export type VideoCredential = {
  /** Which auth path resolved. */
  kind: "api-key" | "session";
  /** Base URL the credential is valid against. */
  baseUrl: string;
  /** Bearer token. */
  token: string;
  /** Human-readable origin, surfaced in tool output so the caller knows what paid. */
  source: string;
  /** ISO timestamp the token stops working, when known. */
  expiresAt?: string;
};

export type CredentialResult =
  | { ok: true; credential: VideoCredential }
  | {
      ok: false;
      reason: string;
      /** Machine-readable cause, so callers can pick an actionable message. */
      code: "missing" | "expired";
    };

/** `${VAR}` left unresolved by a config layer is not a credential. */
const UNRESOLVED_PLACEHOLDER = /^\$\{[A-Z0-9_]+\}$/;

type GrokAuthEntry = {
  key?: unknown;
  expires_at?: unknown;
  email?: unknown;
  auth_mode?: unknown;
};

function readGrokAuthFile(): GrokAuthEntry | undefined {
  const path = process.env.GROK_AUTH_FILE || join(homedir(), ".grok", "auth.json");
  let raw: string;
  try {
    raw = readFileSync(path, "utf8");
  } catch {
    return undefined;
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return undefined;
  }
  if (!parsed || typeof parsed !== "object") return undefined;

  // auth.json is keyed by "<issuer>::<client_id>. Any entry carrying a token
  // is a candidate; prefer the freshest one with a usable expiry.
  const entries = Object.values(parsed as Record<string, unknown>).filter(
    (value): value is GrokAuthEntry => Boolean(value) && typeof value === "object",
  );
  const withToken = entries.filter(
    (entry) => typeof entry.key === "string" && entry.key.length > 0,
  );
  if (withToken.length === 0) return undefined;

  const expiryMs = (entry: GrokAuthEntry) => {
    const parsedExpiry = typeof entry.expires_at === "string" ? Date.parse(entry.expires_at) : NaN;
    return Number.isNaN(parsedExpiry) ? 0 : parsedExpiry;
  };
  return withToken.sort((a, b) => expiryMs(b) - expiryMs(a))[0];
}

export function resolveVideoCredential(): CredentialResult {
  const rawKey = process.env.XAI_API_KEY;
  if (rawKey && rawKey.trim() && !UNRESOLVED_PLACEHOLDER.test(rawKey.trim())) {
    return {
      ok: true,
      credential: {
        kind: "api-key",
        baseUrl: API_BASE_URL,
        token: rawKey.trim(),
        source: "XAI_API_KEY",
      },
    };
  }

  const entry = readGrokAuthFile();
  if (!entry || typeof entry.key !== "string") {
    return {
      ok: false,
      code: "missing",
      reason:
        "No credential found. Set XAI_API_KEY, or sign in with the Grok CLI (`grok login --device-code`) so ~/.grok/auth.json exists.",
    };
  }

  const expiresAt = typeof entry.expires_at === "string" ? entry.expires_at : undefined;
  if (expiresAt) {
    const expiryMs = Date.parse(expiresAt);
    if (!Number.isNaN(expiryMs) && expiryMs <= Date.now()) {
      return {
        ok: false,
        code: "expired",
        reason:
          `Grok CLI session token expired at ${expiresAt}. Run any \`grok\` command (or \`grok login\`) ` +
          "to refresh it; this server re-reads the file on the next call.",
      };
    }
  }

  const who = typeof entry.email === "string" ? ` as ${entry.email}` : "";
  return {
    ok: true,
    credential: {
      kind: "session",
      baseUrl: PROXY_BASE_URL,
      token: entry.key,
      source: `Grok CLI session${who}`,
      expiresAt,
    },
  };
}
