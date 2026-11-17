/**
 * Pipeline production feed. Dev and built, 1280 and 375.
 * The home is the pinned Playwright directory, never a real ~/.theshow.
 */
import AxeBuilder from '@axe-core/playwright';
import { expect, test } from '../playwright/hermetic.ts';
import { seedStudioHome, STUDIO_CANARY, STUDIO_JOBS } from '../playwright/studio-home.ts';
import fs from 'fs';
import path from 'path';

const AXE_TAGS = ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa'];

const viewports = [
  { name: 'desktop', width: 1280, height: 800 },
  { name: 'mobile', width: 375, height: 800 },
] as const;

async function openPipeline(page: import('@playwright/test').Page): Promise<void> {
  await page.goto('/');
  await expect(page.getByTestId('timeline-shell')).toBeVisible();
  await page.getByTestId('prompt-open-pipeline').click();
  await expect(page.getByTestId('production-feed')).toBeVisible();
}

for (const viewport of viewports) {
  test.describe(`production feed ${viewport.name}`, () => {
    test.use({ viewport: { width: viewport.width, height: viewport.height } });

    test.beforeEach(() => {
      seedStudioHome();
    });

    test('shows seeded films and does not leak secrets', async ({ page }) => {
      const methods: string[] = [];
      page.on('request', (request) => {
        if (new URL(request.url()).pathname === '/api/production/feed') methods.push(request.method());
      });
      await openPipeline(page);
      const feed = page.getByTestId('production-feed');
      await expect(feed.getByText('seq_pw_running')).toBeVisible();
      await expect(feed.getByText('seq_pw_completed')).toBeVisible();
      await expect(feed.getByText('seq_pw_stopped')).toBeVisible();
      await expect(feed.getByText('Budget crossed')).toBeVisible();
      await expect(feed.getByText(/Review 1 findings/)).toBeVisible();
      await expect(feed.getByText(/retry-alone/)).toBeVisible();
      await expect(feed.getByText('Reconciled from the job file.').first()).toBeVisible();
      await expect(feed.getByText(/torn line/)).toBeVisible();
      await expect(feed.getByText('film.mp4')).toBeVisible();
      const text = await feed.innerText();
      expect(text).not.toContain(STUDIO_CANARY);
      expect(text).not.toContain('CANARY_PROMPT_do_not_leak');
      expect(text).not.toContain('/tmp/should-not-appear');
      expect(methods.every((method) => method === 'GET')).toBe(true);
      expect(methods.length).toBeGreaterThan(0);
      const overflow = await page.evaluate(() => document.documentElement.scrollWidth > document.documentElement.clientWidth + 2);
      expect(overflow).toBe(false);
      const motion = await feed.evaluate((node) => getComputedStyle(node).animationName);
      expect(motion === 'none' || motion === '').toBe(true);
      const axe = await new AxeBuilder({ page }).withTags(AXE_TAGS).analyze();
      expect(axe.violations).toEqual([]);
    });

    test('announces a transition and ignores the next poll', async ({ page }) => {
      await openPipeline(page);
      await expect(page.getByTestId('production-feed').getByText('seq_pw_running')).toBeVisible();
      const status = page.getByRole('status');
      await expect(status).toHaveText('');
      const next = JSON.parse(fs.readFileSync(path.join(STUDIO_JOBS, 'seq_pw_running.json'), 'utf8')) as { state: string };
      next.state = 'completed';
      const tmp = path.join(STUDIO_JOBS, 'seq_pw_running.json.tmp-swap');
      fs.writeFileSync(tmp, JSON.stringify(next));
      fs.renameSync(tmp, path.join(STUDIO_JOBS, 'seq_pw_running.json'));
      fs.appendFileSync(path.join(STUDIO_JOBS, '.events', 'seq_pw_running.jsonl'), '');
      await expect(status).toContainText('seq_pw_running completed', { timeout: 12_000 });
      const announced = await status.innerText();
      await page.waitForTimeout(6_000);
      await expect(status).toHaveText(announced);
      expect(announced).not.toContain('started');
    });

    test('shows the empty and error states without taking the pipeline down', async ({ page }) => {
      await page.route('**/api/production/feed**', async (route) => {
        const flag = new URL(route.request().url()).searchParams.get('probe');
        if (flag === 'empty') {
          await route.fulfill({
            status: 200,
            contentType: 'application/json',
            body: JSON.stringify({ version: 1, generatedAt: '2020-01-01T00:00:00.000Z', cursor: '', jobs: [], events: [], abstentions: [], truncated: false }),
          });
          return;
        }
        await route.fulfill({ status: 200, contentType: 'application/json', body: 'not-json' });
      });
      await page.goto('/');
      await page.getByTestId('prompt-open-pipeline').click();
      await expect(page.getByTestId('production-feed-error')).toHaveText('Production feed unavailable');
      await expect(page.getByRole('heading', { name: 'Pipeline Exports' })).toBeVisible();
      await page.unroute('**/api/production/feed**');
      await page.route('**/api/production/feed**', async (route) => {
        await route.fulfill({
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify({ version: 1, generatedAt: '2020-01-01T00:00:00.000Z', cursor: '', jobs: [], events: [], abstentions: [], truncated: false }),
        });
      });
      await page.reload();
      await expect(page.getByTestId('timeline-shell')).toBeVisible();
      if (!(await page.getByTestId('production-feed').isVisible())) {
        await page.getByTestId('prompt-open-pipeline').click();
      }
      await expect(page.getByText('No MCP films yet.')).toBeVisible();
      await expect(page.getByRole('heading', { name: 'Pipeline Exports' })).toBeVisible();
    });
  });
}
