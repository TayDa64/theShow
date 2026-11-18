/**
 * Smoke and WCAG 2.2 AA for every Studio surface, on desktop and at 375px.
 * The Playwright project selects the dev server or the built server.
 */
import AxeBuilder from '@axe-core/playwright';
import type { Page } from '@playwright/test';
import { expect, test } from '../playwright/hermetic.ts';

const AXE_TAGS = ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa'];

type Watch = { errors: string[]; failed: string[] };

function watchPage(page: Page): Watch {
  const errors: string[] = [];
  const failed: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  page.on('console', (message) => {
    if (message.type() === 'error') errors.push(message.text());
  });
  page.on('response', (response) => {
    const url = new URL(response.url());
    if (url.hostname !== '127.0.0.1' && url.hostname !== 'localhost') return;
    if (response.status() < 400) return;
    if (url.pathname.endsWith('favicon.ico')) return;
    failed.push(`${response.status()} ${url.pathname}`);
  });
  return { errors, failed };
}

async function openStudio(page: Page): Promise<Watch> {
  const watch = watchPage(page);
  await page.goto('/');
  await expect(page).toHaveTitle('theShow');
  await expect(page.getByTestId('timeline-shell')).toBeVisible();
  await page.waitForTimeout(1500);
  return watch;
}

async function expectClean(watch: Watch): Promise<void> {
  expect(watch.errors).toEqual([]);
  expect(watch.failed).toEqual([]);
}

async function expectAxe(page: Page): Promise<void> {
  const result = await new AxeBuilder({ page }).withTags(AXE_TAGS).analyze();
  expect(result.violations).toEqual([]);
}

async function openPopup(page: Page, testId: string, title: string): Promise<void> {
  await page.getByTestId(testId).click();
  await expect(page.getByTestId('workspace-popup-title')).toHaveText(title);
}

const viewports = [
  { name: 'desktop', width: 1280, height: 800 },
  { name: 'mobile', width: 375, height: 800 },
] as const;

for (const viewport of viewports) {
  test.describe(`studio surfaces ${viewport.name}`, () => {
    test.use({ viewport: { width: viewport.width, height: viewport.height } });

    test('timeline shows the prompt and the asset target', async ({ page }) => {
      const watch = await openStudio(page);
      await expect(page.getByTestId('timeline-prompt-input')).toBeVisible();
      const html = await page.content();
      if (test.info().project.name === 'studio-built') {
        expect(html).not.toContain('@vite/client');
        expect(html).toMatch(/\/assets\/.+\.js/);
      } else {
        expect(html).toContain('@vite/client');
      }
      const nav = page.locator('nav');
      if (viewport.width < 1024) await expect(nav).toBeVisible();
      else await expect(nav).toBeHidden();
      await expectAxe(page);
      await expectClean(watch);
    });

    test('roster popup names a sample character', async ({ page }) => {
      const watch = await openStudio(page);
      await openPopup(page, 'workspace-button-characters', 'Roster');
      await expect(page.getByRole('heading', { name: 'Roster' })).toBeVisible();
      await expect(page.getByText('Kaelen Thorne').first()).toBeVisible();
      await expectAxe(page);
      await expectClean(watch);
    });

    test('scenes popup shows the first act', async ({ page }) => {
      const watch = await openStudio(page);
      await openPopup(page, 'workspace-button-scenes', 'Scenes');
      await expect(page.getByText('Act I: Handshake Protocol').first()).toBeVisible();
      await expectAxe(page);
      await expectClean(watch);
    });

    test('pipeline popup shows the export heading', async ({ page }) => {
      const watch = await openStudio(page);
      await openPopup(page, 'prompt-open-pipeline', 'Pipeline');
      await expect(page.getByRole('heading', { name: 'Pipeline Exports' })).toBeVisible();
      await expectAxe(page);
      await expectClean(watch);
    });

    test('account popup signed out offers sign-in', async ({ page }) => {
      const watch = await openStudio(page);
      await openPopup(page, 'account-workspace-trigger', 'Account');
      await expect(page.getByTestId('account-workspace-trigger')).toHaveAttribute('aria-label', 'Account');
      await expect(page.getByPlaceholder('operator@theshow.dev')).toBeVisible();
      await expectAxe(page);
      await expectClean(watch);
    });

    test('account popup signed in offers sign-out', async ({ page }) => {
      const watch = await openStudio(page);
      const registered = await page.request.post('/api/auth/register', {
        data: {
          name: 'Baseline Operator',
          email: `baseline-${viewport.name}-${Date.now()}@example.com`,
          password: 'Passw0rd!23',
        },
      });
      expect(registered.status()).toBe(201);
      await page.reload();
      await expect(page.getByTestId('timeline-shell')).toBeVisible();
      await page.waitForTimeout(1500);
      await openPopup(page, 'account-workspace-trigger', 'Account');
      await expect(page.getByTestId('account-workspace-trigger')).toHaveAttribute('aria-label', 'Baseline account');
      await expect(page.getByRole('button', { name: 'Sign out' })).toBeVisible();
      await expectAxe(page);
      await expectClean(watch);
    });
  });
}
