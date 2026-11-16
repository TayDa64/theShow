/**
 * Calls the Studio API from inside the page.
 *
 * The built server (NODE_ENV=production) marks the session cookie Secure.
 * Chromium sends that cookie on http://127.0.0.1 document and page fetches.
 * Playwright's APIRequestContext does not, so a register followed by another
 * API-context call is 401 on the built server.
 */
import type { Page } from '@playwright/test';

export type BrowserResponse = {
  status: () => number;
  ok: () => boolean;
  json: () => Promise<any>;
  text: () => Promise<string>;
  headers: () => Record<string, string>;
  body: () => Promise<Buffer>;
};

export async function browserFetch(
  page: Page,
  urlPath: string,
  init: { method?: string; data?: unknown; headers?: Record<string, string>; binary?: boolean } = {},
): Promise<BrowserResponse> {
  const result = await page.evaluate(
    async ({ urlPath: target, method, data, headers, binary }) => {
      const response = await fetch(target, {
        method,
        credentials: 'same-origin',
        headers: {
          ...(data !== undefined ? { 'content-type': 'application/json' } : {}),
          ...(headers ?? {}),
        },
        body: data === undefined ? undefined : JSON.stringify(data),
      });
      const contentType = response.headers.get('content-type') ?? '';
      if (binary) {
        const bytes = Array.from(new Uint8Array(await response.arrayBuffer()));
        return { status: response.status, ok: response.ok, contentType, text: '', bytes };
      }
      const text = await response.text();
      return { status: response.status, ok: response.ok, contentType, text, bytes: [] as number[] };
    },
    {
      urlPath,
      method: init.method ?? 'POST',
      data: init.data,
      headers: init.headers,
      binary: init.binary ?? false,
    },
  );
  return {
    status: () => result.status,
    ok: () => result.ok,
    text: async () => result.text,
    json: async () => JSON.parse(result.text),
    headers: () => ({ 'content-type': result.contentType }),
    body: async () => Buffer.from(result.bytes),
  };
}
