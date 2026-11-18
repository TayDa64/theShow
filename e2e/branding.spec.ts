/**
 * Branding: theShow title, provider names only when that engine is active,
 * and the Liku Labs footer. Sandbox only — the Veo-active case mocks auth status.
 */
import AxeBuilder from '@axe-core/playwright';
import type { Page, Route } from '@playwright/test';
import { expect, test } from '../playwright/hermetic.ts';

const AXE_TAGS = ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa'];
const FOOTER_TEXT = 'brought 2 you by TayDa64 from Liku Labs';
const BRAND = /\bVeo\b|Gemini/;

async function saveShot(page: Page, name: string): Promise<void> {
  const dir = process.env.THESHOW_BRAND_SHOTS;
  if (!dir) return;
  if (name.startsWith('footer-')) {
    const footer = page.getByRole('contentinfo');
    await footer.scrollIntoViewIfNeeded();
    await page.screenshot({ path: `${dir}/${name}.png` });
    await footer.screenshot({ path: `${dir}/${name}-element.png` });
    return;
  }
  await page.screenshot({ path: `${dir}/${name}.png` });
}

function channel(value: number): number {
  const srgb = value / 255;
  return srgb <= 0.03928 ? srgb / 12.92 : ((srgb + 0.055) / 1.055) ** 2.4;
}

function contrastRatio(foreground: [number, number, number], background: [number, number, number]): number {
  const fg = 0.2126 * channel(foreground[0]) + 0.7152 * channel(foreground[1]) + 0.0722 * channel(foreground[2]);
  const bg = 0.2126 * channel(background[0]) + 0.7152 * channel(background[1]) + 0.0722 * channel(background[2]);
  const lighter = Math.max(fg, bg);
  const darker = Math.min(fg, bg);
  return (lighter + 0.05) / (darker + 0.05);
}

async function register(page: Page, email: string): Promise<void> {
  const registered = await page.request.post('/api/auth/register', {
    data: { name: 'Brand Operator', email, password: 'Passw0rd!23' },
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

async function openWorkspace(page: Page, testId: string, title: string): Promise<void> {
  await closePopup(page);
  await page.getByTestId(testId).click();
  await expect(page.getByTestId('workspace-popup-title')).toHaveText(title);
}

async function assertNoProviderBrands(page: Page): Promise<void> {
  const hits = await page.evaluate(() => {
    const brand = /\bVeo\b|Gemini/;
    const excluded = new Set<Element>();
    document.querySelectorAll('[data-testid="gemini-provider-form"]').forEach((form) => {
      excluded.add(form);
      form.querySelectorAll('*').forEach((child) => excluded.add(child));
    });
    const insideForm = (element: Element | null) => {
      let current = element;
      while (current) {
        if (excluded.has(current)) return true;
        current = current.parentElement;
      }
      return false;
    };
    const found: string[] = [];
    const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
    let current = walker.nextNode();
    while (current) {
      const parent = current.parentElement;
      const text = current.textContent || '';
      if (parent && !insideForm(parent) && brand.test(text)) {
        found.push(text.trim().slice(0, 180));
      }
      current = walker.nextNode();
    }
    document.body.querySelectorAll('*').forEach((element) => {
      if (insideForm(element)) return;
      for (const attr of ['title', 'aria-label', 'placeholder']) {
        const value = element.getAttribute(attr);
        if (value && brand.test(value)) found.push(`${attr}: ${value}`);
      }
      if (element instanceof HTMLInputElement || element instanceof HTMLTextAreaElement) {
        if (brand.test(element.value)) found.push(`value: ${element.value}`);
      }
    });
    return found;
  });
  expect(hits, `provider brand leaked outside the Account connection form: ${hits.join(' | ')}`).toEqual([]);
}

async function footerContrast(page: Page): Promise<number> {
  const sample = await page.getByRole('contentinfo').evaluate((element) => {
    const canvas = document.createElement('canvas');
    canvas.width = 1;
    canvas.height = 1;
    const context = canvas.getContext('2d', { willReadFrequently: true });
    const sampleColor = (value: string) => {
      if (!context) return null;
      context.clearRect(0, 0, 1, 1);
      context.fillStyle = '#000';
      context.fillStyle = value;
      context.fillRect(0, 0, 1, 1);
      const pixel = context.getImageData(0, 0, 1, 1).data;
      return { rgb: [pixel[0], pixel[1], pixel[2]] as [number, number, number], alpha: pixel[3] / 255 };
    };
    const color = sampleColor(getComputedStyle(element).color);
    let node: Element | null = element;
    let background: [number, number, number] | null = null;
    while (node) {
      const parsed = sampleColor(getComputedStyle(node).backgroundColor);
      if (parsed && parsed.alpha > 0.01) {
        background = parsed.rgb;
        break;
      }
      node = node.parentElement;
    }
    return { color: color?.rgb ?? null, background };
  });
  expect(sample.color).not.toBeNull();
  expect(sample.background).not.toBeNull();
  return contrastRatio(sample.color!, sample.background!);
}

function boxesIntersect(
  a: { x: number; y: number; width: number; height: number },
  b: { x: number; y: number; width: number; height: number },
): boolean {
  return a.x < b.x + b.width && a.x + a.width > b.x && a.y < b.y + b.height && a.y + a.height > b.y;
}

async function expectFooterClearOfNav(page: Page, mobile: boolean): Promise<void> {
  const footer = page.getByRole('contentinfo');
  await footer.evaluate((element) => {
    const scroller = element.parentElement;
    if (scroller) scroller.scrollTop = scroller.scrollHeight;
  });
  await expect(footer).toBeVisible();
  await expect(footer).toHaveText(FOOTER_TEXT);
  if (!mobile) {
    await expect(page.locator('nav')).toBeHidden();
    return;
  }
  const footerBox = await footer.boundingBox();
  const navBox = await page.locator('nav').boundingBox();
  expect(footerBox).not.toBeNull();
  expect(navBox).not.toBeNull();
  expect(boxesIntersect(footerBox!, navBox!)).toBe(false);
  expect(footerBox!.y + footerBox!.height).toBeLessThanOrEqual(navBox!.y + 1);
}

test.describe('theShow branding', () => {
  test('title, header, and footer on desktop and mobile', async ({ page }) => {
    for (const viewport of [
      { width: 1280, height: 800, mobile: false },
      { width: 375, height: 800, mobile: true },
      { width: 320, height: 800, mobile: true },
    ]) {
      await page.setViewportSize({ width: viewport.width, height: viewport.height });
      await page.goto('/');
      await expect(page).toHaveTitle('theShow');
      await expect(page.getByRole('heading', { level: 1, name: 'theShow' })).toBeVisible();
      await expect(page.getByTestId('brand-mark')).toHaveText('tS');
      await saveShot(page, `header-${viewport.width}`);
      await expectFooterClearOfNav(page, viewport.mobile);
      await saveShot(page, `footer-${viewport.width}`);
      const ratio = await footerContrast(page);
      expect(ratio).toBeGreaterThanOrEqual(4.5);
      const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
      expect(overflow).toBeLessThanOrEqual(1);
      const axe = await new AxeBuilder({ page }).include('footer').withRules(['color-contrast']).analyze();
      expect(axe.violations).toEqual([]);
    }
  });

  test('sandbox surfaces do not name Veo or Gemini except the Account connection form', async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 800 });
    await page.goto('/');
    await expect(page.getByTestId('timeline-shell')).toBeVisible();
    await assertNoProviderBrands(page);
    await register(page, `brand-sandbox-${Date.now()}@example.com`);
    await assertNoProviderBrands(page);

    await openWorkspace(page, 'workspace-button-scenes', 'Scenes');
    await expect(page.getByText('Act I: Handshake Protocol').first()).toBeVisible();
    await assertNoProviderBrands(page);

    await openWorkspace(page, 'workspace-button-characters', 'Roster');
    await page.getByText('Kaelen Thorne').first().click();
    await expect(page.getByText('Character style')).toBeVisible();
    await assertNoProviderBrands(page);

    await openWorkspace(page, 'prompt-open-pipeline', 'Pipeline');
    await expect(page.getByRole('heading', { name: 'Sandbox quick preview' })).toBeVisible();
    await expect(page.getByText('Sandbox-only render mode')).toBeVisible();
    await assertNoProviderBrands(page);

    await page.getByRole('button', { name: 'Storyboard Mode' }).click();
    await expect(page.getByRole('heading', { name: 'Sandbox storyboard renderer' })).toBeVisible();
    await page.getByRole('button', { name: 'Build Board' }).click();
    await expect(page.getByText('Storyboard panel 1').first()).toBeVisible({ timeout: 20_000 });
    await page.getByRole('button', { name: 'Review render contract' }).click();
    await expect(page.getByText('Sandbox preview. Nothing is billed.').first()).toBeVisible({ timeout: 20_000 });
    await expect(page.getByText('Nothing is sent to a live video engine.').first()).toBeVisible();
    await saveShot(page, 'pipeline-storyboard-1280');
    await assertNoProviderBrands(page);

    await openWorkspace(page, 'account-workspace-trigger', 'Account');
    const form = page.getByTestId('gemini-provider-form');
    await expect(form).toBeVisible();
    await expect(form.getByText('Gemini API key', { exact: true })).toBeVisible();
    await expect(form.getByRole('button', { name: 'Connect personal Gemini API key' })).toBeVisible();
    await assertNoProviderBrands(page);

    await page.setViewportSize({ width: 375, height: 800 });
    await closePopup(page);
    await assertNoProviderBrands(page);
    await openWorkspace(page, 'workspace-button-scenes', 'Scenes');
    await assertNoProviderBrands(page);
    await openWorkspace(page, 'workspace-button-characters', 'Roster');
    await assertNoProviderBrands(page);
    await openWorkspace(page, 'prompt-open-pipeline', 'Pipeline');
    await expect(page.getByRole('heading', { name: 'Sandbox quick preview' })).toBeVisible();
    await page.getByRole('button', { name: 'Storyboard Mode' }).click();
    await expect(page.getByRole('heading', { name: 'Sandbox storyboard renderer' })).toBeVisible();
    await saveShot(page, 'pipeline-storyboard-375');
    await assertNoProviderBrands(page);
    await openWorkspace(page, 'account-workspace-trigger', 'Account');
    await expect(page.getByTestId('gemini-provider-form')).toBeVisible();
    await assertNoProviderBrands(page);
    await expectFooterClearOfNav(page, true);
  });

  test('mocked Gemini backend names Veo on Pipeline and Gemini on AI Suggest', async ({ page }) => {
    await page.route('**/api/auth/session', async (route: Route) => {
      const response = await route.fetch();
      const payload = await response.json();
      payload.provider = {
        ...(payload.provider || {}),
        mode: 'workspace',
        status: 'connected',
        videoBackend: 'gemini',
        videoBackendLabel: 'Gemini Veo',
        videoBilling: 'Gemini API quota',
        liveVideoEnabled: true,
      };
      await route.fulfill({ response, json: payload });
    });
    await page.setViewportSize({ width: 1280, height: 800 });
    await page.goto('/');
    await expect(page.getByTestId('timeline-shell')).toBeVisible();
    await register(page, `brand-veo-${Date.now()}@example.com`);
    await page.getByTestId('prompt-open-pipeline').click();
    await expect(page.getByTestId('workspace-popup-title')).toHaveText('Pipeline');
    await expect(page.getByRole('heading', { name: 'Veo quick preview' })).toBeVisible();
    await page.getByRole('button', { name: 'Storyboard Mode' }).click();
    await expect(page.getByRole('heading', { name: 'Veo storyboard renderer' })).toBeVisible();
    await expect(page.getByText('Workspace Gemini provider active')).toBeVisible();
    await closePopup(page);
    await page.getByTestId('workspace-button-scenes').click();
    await expect(page.getByTestId('workspace-popup-title')).toHaveText('Scenes');
    await expect(page.getByRole('button', { name: 'Auto-suggest dialogue using Gemini AI' })).toBeVisible();
  });

  test('mocked Grok backend does not name Veo or Gemini', async ({ page }) => {
    await page.route('**/api/auth/session', async (route: Route) => {
      const response = await route.fetch();
      const payload = await response.json();
      payload.provider = {
        ...(payload.provider || {}),
        mode: 'sandbox',
        status: 'disconnected',
        videoBackend: 'grok',
        videoBackendLabel: 'Grok Imagine Video',
        videoBilling: 'Grok subscription',
        liveVideoEnabled: true,
      };
      await route.fulfill({ response, json: payload });
    });
    await page.setViewportSize({ width: 1280, height: 800 });
    await page.goto('/');
    await expect(page.getByTestId('timeline-shell')).toBeVisible();
    await register(page, `brand-grok-${Date.now()}@example.com`);
    await assertNoProviderBrands(page);

    await page.getByTestId('prompt-open-pipeline').click();
    await expect(page.getByTestId('workspace-popup-title')).toHaveText('Pipeline');
    await expect(page.getByRole('heading', { name: 'Grok quick preview' })).toBeVisible();
    await expect(page.getByText('Grok Imagine Video active — billed to Grok subscription')).toBeVisible();
    await expect(page.getByText('Rendering with Grok Imagine Video, billed to your Grok subscription.')).toBeVisible();
    await assertNoProviderBrands(page);
    await page.getByRole('button', { name: 'Storyboard Mode' }).click();
    await expect(page.getByRole('heading', { name: 'Grok storyboard renderer' })).toBeVisible();
    await expect(page.getByText('Each storyboard shot is its own Grok clip.')).toBeVisible();
    await assertNoProviderBrands(page);

    await closePopup(page);
    await page.getByTestId('workspace-button-scenes').click();
    await expect(page.getByTestId('workspace-popup-title')).toHaveText('Scenes');
    await expect(page.getByRole('button', { name: 'Auto-suggest dialogue' })).toBeVisible();
    await assertNoProviderBrands(page);

    await closePopup(page);
    await page.getByTestId('workspace-button-characters').click();
    await expect(page.getByTestId('workspace-popup-title')).toHaveText('Roster');
    await page.getByText('Kaelen Thorne').first().click();
    await expect(page.getByText('Character style')).toBeVisible();
    await assertNoProviderBrands(page);

    await closePopup(page);
    await page.getByTestId('account-workspace-trigger').click();
    await expect(page.getByTestId('workspace-popup-title')).toHaveText('Account');
    await expect(page.getByTestId('gemini-provider-form')).toBeVisible();
    await assertNoProviderBrands(page);
  });
});

test.describe('axe still covers branded chrome', () => {
  test('studio shell has no axe violations with the footer', async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 800 });
    await page.goto('/');
    await expect(page.getByTestId('timeline-shell')).toBeVisible();
    const result = await new AxeBuilder({ page }).withTags(AXE_TAGS).analyze();
    expect(result.violations).toEqual([]);
  });
});
