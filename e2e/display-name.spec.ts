/**
 * Signed-in header shows the display name and never the email.
 * Sandbox only. The account profile is the credential exception.
 */
import AxeBuilder from '@axe-core/playwright';
import type { Page } from '@playwright/test';
import { expect, test } from '../playwright/hermetic.ts';

const AXE_TAGS = ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa'];

const viewports = [
  { name: 'desktop', width: 1280, height: 800 },
  { name: 'mobile', width: 375, height: 800 },
] as const;

async function expectAxe(page: Page): Promise<void> {
  const result = await new AxeBuilder({ page }).withTags(AXE_TAGS).analyze();
  expect(result.violations).toEqual([]);
}

async function register(page: Page, email: string): Promise<void> {
  const registered = await page.request.post('/api/auth/register', {
    data: { name: 'Ada Lovelace', email, password: 'Passw0rd!23' },
  });
  expect(registered.status()).toBe(201);
  await page.reload();
  await expect(page.getByTestId('timeline-shell')).toBeVisible();
}

async function closePopup(page: Page): Promise<void> {
  const popup = page.getByTestId('workspace-popup');
  if (await popup.isVisible()) {
    await page.getByTestId('popup-close-button').click();
    await expect(popup).toBeHidden();
  }
}

for (const viewport of viewports) {
  test.describe(`display name ${viewport.name}`, () => {
    test.use({ viewport: { width: viewport.width, height: viewport.height } });

    test('keeps the email out of the header, timeline, pipeline, scenes, and footer', async ({ page }) => {
      const email = `dn-${viewport.name}-${Date.now()}@example.com`;
      await page.goto('/');
      await register(page, email);

      const headerText = await page.locator('header').evaluate((element) => element.textContent || '');
      expect(headerText).not.toContain(email);
      expect(headerText).not.toContain('@');
      expect(headerText).toContain('Ada');
      await expect(page.getByTestId('account-workspace-trigger')).toHaveAttribute('aria-label', 'Ada account');
      await expect(page.getByTestId('account-workspace-trigger')).toContainText('Ada');
      const status = await page.getByTestId('header-status').evaluate((element) => element.textContent || '');
      expect(status).toContain('Sandbox mode • Ada Lovelace');
      expect(status).not.toContain(email);

      const timeline = await page.getByTestId('timeline-shell').evaluate((element) => element.textContent || '');
      expect(timeline).not.toContain(email);

      await page.getByTestId('workspace-button-scenes').click();
      await expect(page.getByTestId('workspace-popup-title')).toHaveText('Scenes');
      const scenes = await page.getByTestId('workspace-popup').evaluate((element) => element.textContent || '');
      expect(scenes).not.toContain(email);
      await closePopup(page);

      await page.getByTestId('prompt-open-pipeline').click();
      await expect(page.getByTestId('workspace-popup-title')).toHaveText('Pipeline');
      const pipeline = await page.getByTestId('workspace-popup').evaluate((element) => element.textContent || '');
      expect(pipeline).not.toContain(email);
      await closePopup(page);

      const footer = await page.locator('footer').evaluate((element) => element.textContent || '');
      expect(footer).not.toContain(email);
      expect(footer).toContain('brought 2 you by TayDa64 from Liku Labs');

      const shotDir = process.env.THESHOW_DISPLAY_SHOTS;
      if (shotDir) {
        await page.screenshot({ path: `${shotDir}/${viewport.name}-header.png` });
      }
      await expectAxe(page);
    });

    test('labels the sign-in email on the account profile and edits the display name', async ({ page }) => {
      const email = `dn-acct-${viewport.name}-${Date.now()}@example.com`;
      await page.goto('/');
      await register(page, email);
      await page.getByTestId('account-workspace-trigger').click();
      await expect(page.getByTestId('workspace-popup-title')).toHaveText('Account');
      await expect(page.getByText('Sign-in email')).toBeVisible();
      await expect(page.getByTestId('sign-in-email')).toHaveText(email);
      await expect(page.getByTestId('account-display-name')).toHaveText('Ada Lovelace');

      await page.getByTestId('display-name-input').fill('   ');
      await page.getByTestId('display-name-save').click();
      await expect(page.getByTestId('display-name-error')).toHaveText('Name is required.');

      await page.getByTestId('display-name-input').fill('Grace Hopper');
      await page.getByTestId('display-name-save').click();
      await expect(page.getByTestId('account-display-name')).toHaveText('Grace Hopper');
      await expect(page.getByTestId('account-workspace-trigger')).toContainText('Grace');
      const headerText = await page.locator('header').evaluate((element) => element.textContent || '');
      expect(headerText).not.toContain(email);
      expect(headerText).toContain('Grace');

      const shotDir = process.env.THESHOW_DISPLAY_SHOTS;
      if (shotDir) {
        await page.getByTestId('display-name-save').scrollIntoViewIfNeeded();
        await page.screenshot({ path: `${shotDir}/${viewport.name}-account.png` });
      }
      await expectAxe(page);
    });
  });
}
