/**
 * Browser fixture for the default Playwright suite.
 * Fonts stay a CSS import in src/index.css. This stub answers those requests
 * in the page so the suite does not need fonts.googleapis.com or any other
 * non-loopback host. The opt-in live spec does not use this fixture.
 */
import { test as base, expect } from '@playwright/test';

const LOOPBACK = new Set(['127.0.0.1', 'localhost', '::1']);

export const test = base.extend({
  page: async ({ page }, use) => {
    await page.route('**/*', async (route) => {
      let host = '';
      try {
        host = new URL(route.request().url()).hostname.toLowerCase();
      } catch {
        await route.abort('blockedbyclient');
        return;
      }
      if (LOOPBACK.has(host)) {
        await route.continue();
        return;
      }
      if (host === 'fonts.googleapis.com' || host === 'fonts.gstatic.com') {
        const stylesheet = route.request().resourceType() === 'stylesheet'
          || route.request().url().includes('css');
        await route.fulfill({
          status: 200,
          contentType: stylesheet ? 'text/css' : 'font/woff2',
          body: stylesheet ? '/* offline font stub */' : '',
        });
        return;
      }
      await route.abort('blockedbyclient');
    });
    await use(page);
  },
});

export { expect };
