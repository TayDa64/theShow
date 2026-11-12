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

import { randomBytes } from "node:crypto";
import { chmodSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

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
  refresh_token?: unknown;
};

/** A render must finish with this much session left, or it is refused. */
export const SESSION_MARGIN_MS = 15 * 60 * 1000;

/**
 * Rewriting ~/.grok/auth.json is off unless this is 1, true, or yes.
 *
 * The Grok CLI refreshes that file itself. A second writer can rotate the
 * refresh token and lock the CLI out. This server refuses an expired session
 * instead of writing, until the operator opts in.
 */
export function grokSessionRefreshEnabled(): boolean {
  const flag = process.env.THESHOW_REFRESH_GROK_SESSION?.trim().toLowerCase();
  return flag === "1" || flag === "true" || flag === "yes";
}

const REFRESH_OFF =
  "Automatic refresh is off, so the session file was not rewritten. " +
  "Run `grok login`, or set THESHOW_REFRESH_GROK_SESSION=1.";

/** Write the session file by renaming a 0600 temp file in the same directory. */
function writeSessionFileAtomic(path: string, contents: string) {
  const tmp = join(dirname(path), `.auth-${randomBytes(8).toString("hex")}.tmp`);
  try {
    writeFileSync(tmp, contents, { encoding: "utf8", mode: 0o600 });
    chmodSync(tmp, 0o600);
    renameSync(tmp, path);
    chmodSync(path, 0o600);
  } catch (err) {
    try {
      unlinkSync(tmp);
    } catch {
      // The temp file may not exist if the write itself failed.
    }
    throw err;
  }
}

/**
 * Where the CLI session file lives.
 *
 * Tests set GROK_AUTH_FILE, or run under Vitest, and must never fall through
 * to the machine's ~/.grok/auth.json. That file is a live credential.
 */
export function grokAuthFilePath(): string {
  const fromEnv = process.env.GROK_AUTH_FILE;
  if (typeof fromEnv === "string" && fromEnv.trim()) return fromEnv.trim();
  if (process.env.VITEST || process.env.THESHOW_FORBID_HOME_AUTH === "1") {
    return "/nonexistent/theshow-test-auth.json";
  }
  return join(homedir(), ".grok", "auth.json");
}

function readGrokAuthFile(): { keyName: string; entry: GrokAuthEntry } | undefined {
  const path = grokAuthFilePath();
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

  // auth.json is keyed by "<issuer>::<client_id>". Any entry carrying a token
  // is a candidate; prefer the freshest one with a usable expiry.
  const record = parsed as Record<string, unknown>;
  const withToken = Object.entries(record).filter((pair): pair is [string, GrokAuthEntry] => {
    const value = pair[1];
    return Boolean(value) && typeof value === "object" && typeof (value as GrokAuthEntry).key === "string"
      && ((value as GrokAuthEntry).key as string).length > 0;
  });
  if (withToken.length === 0) return undefined;

  const expiryMs = (entry: GrokAuthEntry) => {
    const parsedExpiry = typeof entry.expires_at === "string" ? Date.parse(entry.expires_at) : NaN;
    return Number.isNaN(parsedExpiry) ? 0 : parsedExpiry;
  };
  withToken.sort((a, b) => expiryMs(b[1]) - expiryMs(a[1]));
  const [keyName, entry] = withToken[0];
  return { keyName, entry };
}

/**
 * Token endpoint for a CLI session key.
 *
 * The auth file key is "<issuer>::<client_id>". The grok CLI refreshes an
 * auth.x.ai session at https://auth.x.ai/oauth2/token. Posting that host at
 * /oauth/token returns 403 and does not rotate the session. Other Okta-style
 * issuers still refresh at issuer/v1/token, and anything else uses the origin's
 * /oauth/token. GROK_OAUTH_TOKEN_URL overrides all of these, which is how tests
 * point this at a fake responder.
 */
export function oauthTokenUrl(authKeyName: string): string | undefined {
  const override = process.env.GROK_OAUTH_TOKEN_URL;
  if (typeof override === "string" && override.trim()) return override.trim();
  const issuer = authKeyName.split("::")[0]?.trim();
  if (!issuer || !/^https:\/\//i.test(issuer)) return undefined;
  try {
    const url = new URL(issuer);
    if (url.hostname === "auth.x.ai") return "https://auth.x.ai/oauth2/token";
    if (url.pathname.includes("/oauth2/")) {
      const base = issuer.endsWith("/") ? issuer : `${issuer}/`;
      return new URL("v1/token", base).toString();
    }
    return new URL("/oauth/token", url.origin).toString();
  } catch {
    return undefined;
  }
}

export function sessionCoversRender(opts: {
  expiresAt?: string;
  estimatedJobMs: number;
  now?: number;
  marginMs?: number;
}): { ok: true; neededUntilMs: number } | { ok: false; reason: string; neededUntilMs: number } {
  const now = opts.now ?? Date.now();
  const margin = opts.marginMs ?? SESSION_MARGIN_MS;
  const neededUntilMs = now + Math.max(0, opts.estimatedJobMs) + margin;
  if (!opts.expiresAt) {
    return {
      ok: false,
      neededUntilMs,
      reason: "Grok session has no expiry, so it cannot be shown to outlast this render.",
    };
  }
  const expiryMs = Date.parse(opts.expiresAt);
  if (Number.isNaN(expiryMs)) {
    return { ok: false, neededUntilMs, reason: "Grok session expiry could not be read." };
  }
  if (expiryMs <= neededUntilMs) {
    return {
      ok: false,
      neededUntilMs,
      reason:
        `Grok session expires at ${opts.expiresAt}, which is before this render would finish ` +
        "plus a 15 minute margin.",
    };
  }
  return { ok: true, neededUntilMs };
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

  const stored = readGrokAuthFile();
  const entry = stored?.entry;
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

type RefreshResponse = {
  access_token?: unknown;
  expires_in?: unknown;
  refresh_token?: unknown;
};

/**
 * Exchange a stored refresh token for a new access token and write it back.
 *
 * This is not an image, video, or speech call. If the file has no refresh
 * token, or the token endpoint refuses, the caller still does not spend.
 * The token itself is never put in the returned reason.
 */
export async function refreshGrokSession(opts: {
  fetchImpl?: typeof fetch;
  now?: number;
} = {}): Promise<{ ok: true; expiresAt: string } | { ok: false; reason: string }> {
  if (!grokSessionRefreshEnabled()) {
    return { ok: false, reason: REFRESH_OFF };
  }
  const stored = readGrokAuthFile();
  if (!stored || typeof stored.entry.refresh_token !== "string" || !stored.entry.refresh_token) {
    return { ok: false, reason: "Grok session has no refresh token." };
  }
  const tokenUrl = oauthTokenUrl(stored.keyName);
  if (!tokenUrl) {
    return { ok: false, reason: "Grok session issuer has no token endpoint." };
  }
  const clientId = stored.keyName.split("::")[1]?.trim();
  const body = new URLSearchParams({
    grant_type: "refresh_token",
    refresh_token: stored.entry.refresh_token,
  });
  if (clientId) body.set("client_id", clientId);

  const fetchImpl = opts.fetchImpl ?? fetch;
  let response: Response;
  try {
    response = await fetchImpl(tokenUrl, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: body.toString(),
    });
  } catch {
    return { ok: false, reason: "Grok session refresh could not reach the token endpoint." };
  }
  if (!response.ok) {
    return { ok: false, reason: `Grok session refresh was refused (HTTP ${response.status}).` };
  }

  let parsed: RefreshResponse;
  try {
    parsed = await response.json() as RefreshResponse;
  } catch {
    return { ok: false, reason: "Grok session refresh returned an unreadable body." };
  }
  if (typeof parsed.access_token !== "string" || !parsed.access_token) {
    return { ok: false, reason: "Grok session refresh did not return an access token." };
  }

  const now = opts.now ?? Date.now();
  const expiresIn = Number(parsed.expires_in);
  const expiresAt = new Date(now + (Number.isFinite(expiresIn) && expiresIn > 0 ? expiresIn * 1000 : 60 * 60 * 1000)).toISOString();
  const path = grokAuthFilePath();
  let file: Record<string, unknown>;
  try {
    file = JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
  } catch {
    return { ok: false, reason: "Grok session file could not be updated." };
  }
  const current = file[stored.keyName];
  if (!current || typeof current !== "object") {
    return { ok: false, reason: "Grok session file could not be updated." };
  }
  file[stored.keyName] = {
    ...current,
    key: parsed.access_token,
    expires_at: expiresAt,
    ...(typeof parsed.refresh_token === "string" && parsed.refresh_token
      ? { refresh_token: parsed.refresh_token }
      : {}),
  };
  try {
    writeSessionFileAtomic(path, JSON.stringify(file, null, 2));
  } catch {
    return { ok: false, reason: "Grok session file could not be updated." };
  }
  return { ok: true, expiresAt };
}

/**
 * Credential check that runs before any paid render.
 *
 * An API key has no session expiry. A CLI session must outlast the job plus
 * 15 minutes. A session that is already expired, or that will not last, is
 * refreshed once when a refresh token is present, then checked again.
 * Failure refuses the render. The refusal reason never includes a token.
 */
export async function ensureCredentialForJob(
  estimatedJobMs: number,
  opts: { fetchImpl?: typeof fetch; now?: number } = {},
): Promise<CredentialResult & { refreshed?: boolean }> {
  const first = resolveVideoCredential();
  if (first.ok && first.credential.kind === "api-key") return first;

  let shortReason: string | undefined;
  if (first.ok) {
    const covers = sessionCoversRender({
      expiresAt: first.credential.expiresAt,
      estimatedJobMs,
      now: opts.now,
    });
    if (covers.ok) return first;
    shortReason = covers.reason;
  } else if (first.code !== "expired") {
    return first;
  }

  if (!grokSessionRefreshEnabled()) {
    const why = first.ok
      ? (shortReason ?? "The Grok session will not last the job.")
      : first.reason;
    return {
      ok: false,
      code: "expired",
      reason: `${why} ${REFRESH_OFF}`,
    };
  }

  const refreshed = await refreshGrokSession(opts);
  if (!refreshed.ok) {
    if (first.ok) {
      const covers = sessionCoversRender({
        expiresAt: first.credential.expiresAt,
        estimatedJobMs,
        now: opts.now,
      });
      if (!covers.ok) return { ok: false, code: "expired", reason: covers.reason };
      return { ok: false, code: "expired", reason: refreshed.reason };
    }
    return { ok: false, code: "expired", reason: refreshed.reason };
  }

  const second = resolveVideoCredential();
  if (!second.ok) return second;
  if (second.credential.kind === "api-key") return { ...second, refreshed: true };
  const again = sessionCoversRender({
    expiresAt: second.credential.expiresAt,
    estimatedJobMs,
    now: opts.now,
  });
  if (!again.ok) return { ok: false, code: "expired", reason: again.reason };
  return { ...second, refreshed: true };
}
