import { defineConfig, devices } from '@playwright/test';

const baseURL = process.env.PLAYWRIGHT_BASE_URL ?? 'http://127.0.0.1:3100';

export default defineConfig({
  testDir: '.',
  testMatch: ['e2e/**/*.spec.ts', 'playwright/**/*.spec.ts'],
  workers: 1,
  fullyParallel: false,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 2 : 0,
  reporter: process.env.CI ? [['html', { open: 'never' }], ['list']] : 'list',
  use: {
    baseURL,
    trace: 'on-first-retry',
    screenshot: 'only-on-failure',
    video: 'retain-on-failure',
    headless: true,
  },
  projects: [
    {
      name: 'chromium',
      use: { ...devices['Desktop Chrome'] },
    },
  ],
  webServer: {
    command: 'npm run dev',
    url: baseURL,
    reuseExistingServer: false,
    timeout: 120 * 1000,
    env: {
      ...process.env,
      PORT: '3100',
      DISABLE_HMR: 'true',
      // Explicitly forward live-generation credentials so the opt-in live Veo spec
      // (RUN_LIVE_VEO=1) can reach a real workspace provider. When unset, the app
      // stays in sandbox mode and the live spec is skipped — zero quota is used.
      ...(process.env.GEMINI_API_KEY ? { GEMINI_API_KEY: process.env.GEMINI_API_KEY } : {}),
      ...(process.env.WORKSPACE_VIDEO_DAILY_LIMIT
        ? { WORKSPACE_VIDEO_DAILY_LIMIT: process.env.WORKSPACE_VIDEO_DAILY_LIMIT }
        : {}),
    },
  },
});
