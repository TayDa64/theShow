/**
 * Session expiry is checked before a render. Refresh uses the refresh token
 * against a stubbed token endpoint. The real ~/.grok/auth.json is never opened.
 */
import fs from 'fs';
import os from 'os';
import path from 'path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  ensureCredentialForJob,
  grokAuthFilePath,
  oauthTokenUrl,
  sessionCoversRender,
} from '../mcp/grok-auth.ts';

const tempDirs: string[] = [];

afterEach(() => {
  process.env.GROK_AUTH_FILE = '/nonexistent/theshow-test-auth.json';
  delete process.env.GROK_OAUTH_TOKEN_URL;
  delete process.env.THESHOW_REFRESH_GROK_SESSION;
  delete process.env.XAI_API_KEY;
  for (const dir of tempDirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

function writeSession(opts: { expiresAt: string; refresh?: string }) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'theshow-auth-'));
  tempDirs.push(dir);
  const authFile = path.join(dir, 'auth.json');
  fs.writeFileSync(authFile, JSON.stringify({
    'https://auth.example.test/oauth2/default::test-client': {
      key: 'test-access-token',
      expires_at: opts.expiresAt,
      ...(opts.refresh ? { refresh_token: opts.refresh } : {}),
    },
  }));
  process.env.GROK_AUTH_FILE = authFile;
  return authFile;
}

describe('session expiry before a render', () => {
  it('does not read the home auth file when GROK_AUTH_FILE is unset under Vitest', () => {
    delete process.env.GROK_AUTH_FILE;
    expect(grokAuthFilePath()).toBe('/nonexistent/theshow-test-auth.json');
    expect(grokAuthFilePath()).not.toContain(`${path.sep}.grok${path.sep}`);
  });

  it('refuses when the session expires before the job plus 15 minutes', () => {
    const now = Date.parse('2026-11-11T12:00:00.000Z');
    const expiresAt = new Date(now + 10 * 60 * 1000).toISOString();
    const result = sessionCoversRender({
      expiresAt,
      estimatedJobMs: 8 * 60 * 1000,
      now,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toMatch(/15 minute/i);
  });

  it('accepts a session that outlasts the job and the margin', () => {
    const now = Date.parse('2026-11-11T12:00:00.000Z');
    const expiresAt = new Date(now + 40 * 60 * 1000).toISOString();
    const result = sessionCoversRender({
      expiresAt,
      estimatedJobMs: 8 * 60 * 1000,
      now,
    });
    expect(result.ok).toBe(true);
  });

  it('refreshes with the refresh token when the session is too short', async () => {
    const authFile = writeSession({
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
      refresh: 'test-refresh-token',
    });
    process.env.THESHOW_REFRESH_GROK_SESSION = '1';
    process.env.GROK_OAUTH_TOKEN_URL = 'https://auth.example.test/oauth/token';
    const seen: string[] = [];
    const fetchImpl = (async (input: unknown, init?: { body?: string }) => {
      seen.push(String(input));
      expect(init?.body ?? '').not.toMatch(/test-access-token/);
      expect(init?.body ?? '').toContain('grant_type=refresh_token');
      return new Response(JSON.stringify({
        access_token: 'refreshed-access-token',
        expires_in: 3600,
        refresh_token: 'rotated-refresh-token',
      }), { status: 200 });
    }) as typeof fetch;

    const result = await ensureCredentialForJob(5 * 60 * 1000, { fetchImpl });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.refreshed).toBe(true);
      expect(result.credential.token).toBe('refreshed-access-token');
    }
    expect(seen).toEqual(['https://auth.example.test/oauth/token']);
    const saved = JSON.parse(fs.readFileSync(authFile, 'utf8')) as Record<string, { key: string; refresh_token: string }>;
    const entry = saved['https://auth.example.test/oauth2/default::test-client'];
    expect(entry.key).toBe('refreshed-access-token');
    expect(entry.refresh_token).toBe('rotated-refresh-token');
    expect(fs.statSync(authFile).mode & 0o777).toBe(0o600);
    const leftovers = fs.readdirSync(path.dirname(authFile)).filter((name) => name.endsWith('.tmp'));
    expect(leftovers).toEqual([]);
  });

  it('does not rewrite an expired session unless refresh is opted in', async () => {
    const authFile = writeSession({
      expiresAt: new Date(Date.now() - 60_000).toISOString(),
      refresh: 'test-refresh-token',
    });
    const before = fs.readFileSync(authFile, 'utf8');
    process.env.GROK_OAUTH_TOKEN_URL = 'https://auth.example.test/oauth/token';
    let called = false;
    const fetchImpl = (async () => {
      called = true;
      return new Response('{}', { status: 200 });
    }) as typeof fetch;

    const result = await ensureCredentialForJob(5 * 60 * 1000, { fetchImpl });
    expect(result.ok).toBe(false);
    expect(called).toBe(false);
    expect(fs.readFileSync(authFile, 'utf8')).toBe(before);
    if (!result.ok) {
      expect(result.reason).toMatch(/not rewritten/i);
      expect(result.reason).not.toMatch(/test-refresh-token|test-access-token/);
    }
  });

  it('refreshes an already-expired session when a refresh token is stored', async () => {
    const authFile = writeSession({
      expiresAt: new Date(Date.now() - 60_000).toISOString(),
      refresh: 'test-refresh-token',
    });
    process.env.THESHOW_REFRESH_GROK_SESSION = '1';
    process.env.GROK_OAUTH_TOKEN_URL = 'https://auth.example.test/oauth/token';
    const fetchImpl = (async () => new Response(JSON.stringify({
      access_token: 'refreshed-access-token',
      expires_in: 3600,
    }), { status: 200 })) as typeof fetch;

    const result = await ensureCredentialForJob(5 * 60 * 1000, { fetchImpl });
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.credential.token).toBe('refreshed-access-token');
    const saved = JSON.parse(fs.readFileSync(authFile, 'utf8')) as Record<string, { key: string }>;
    expect(saved['https://auth.example.test/oauth2/default::test-client'].key).toBe('refreshed-access-token');
  });

  it('refreshes an auth.x.ai session at /oauth2/token', () => {
    delete process.env.GROK_OAUTH_TOKEN_URL;
    expect(oauthTokenUrl('https://auth.x.ai::client-id')).toBe('https://auth.x.ai/oauth2/token');
    expect(oauthTokenUrl('https://auth.x.ai/oauth2/default::client-id')).toBe(
      'https://auth.x.ai/oauth2/token',
    );
    expect(oauthTokenUrl('https://auth.example.test/oauth2/default::client')).toBe(
      'https://auth.example.test/oauth2/default/v1/token',
    );
    expect(oauthTokenUrl('https://auth.example.test::client')).toBe(
      'https://auth.example.test/oauth/token',
    );
    process.env.GROK_OAUTH_TOKEN_URL = 'https://auth.example.test/override';
    expect(oauthTokenUrl('https://auth.x.ai::client-id')).toBe('https://auth.example.test/override');
  });

  it('refuses without calling a video endpoint when refresh is not possible', async () => {
    writeSession({ expiresAt: new Date(Date.now() + 60_000).toISOString() });
    let called = false;
    const fetchImpl = (async () => {
      called = true;
      return new Response('no', { status: 500 });
    }) as typeof fetch;
    const result = await ensureCredentialForJob(5 * 60 * 1000, { fetchImpl });
    expect(result.ok).toBe(false);
    expect(called).toBe(false);
    if (!result.ok) expect(result.reason).toMatch(/15 minute|no expiry|expires/i);
  });
});
