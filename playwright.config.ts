import { defineConfig, devices } from '@playwright/test';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { seedStudioHome } from './playwright/studio-home';

const STUDIO_HOME = process.env.THESHOW_PLAYWRIGHT_HOME
  ?? path.join(os.tmpdir(), `theshow-playwright-${process.pid}-${Date.now().toString(36)}`);
const STUDIO_JOBS = path.join(STUDIO_HOME, 'jobs');
if (!process.env.THESHOW_PLAYWRIGHT_HOME) {
  process.env.THESHOW_PLAYWRIGHT_HOME = STUDIO_HOME;
  fs.writeFileSync(path.join(os.tmpdir(), 'theshow-playwright-home-pointer'), `${STUDIO_HOME}\n`);
}

const devURL = 'http://127.0.0.1:3100';
const builtURL = 'http://127.0.0.1:3101';

// Hard pin. An unpinned server with no credential returns 503 no-video-backend
// instead of a sandbox clip, and the sandbox guard fails.
const SANDBOX_BACKEND = 'sandbox';

seedStudioHome();

function studioEnv(port: string, nodeEnv: string | undefined): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    PORT: port,
    HOME: STUDIO_HOME,
    DISABLE_HMR: 'true',
    THESHOW_VIDEO_BACKEND: SANDBOX_BACKEND,
    THESHOW_JOBS_DIR: STUDIO_JOBS,
    THESHOW_OUTPUT_DIR: path.join(STUDIO_HOME, 'media'),
    THESHOW_CHARACTERS_DIR: path.join(STUDIO_HOME, 'characters'),
    GROK_AUTH_FILE: '/nonexistent/theshow-test-auth.json',
    THESHOW_FORBID_HOME_AUTH: '1',
  };
  delete env.XAI_API_KEY;
  delete env.GROK_API_KEY;
  delete env.GEMINI_API_KEY;
  delete env.RUN_LIVE_VEO;
  if (nodeEnv) env.NODE_ENV = nodeEnv;
  else delete env.NODE_ENV;
  // The opt-in live spec is the only path that may leave sandbox, and only
  // on the dev server. CI fails the job when RUN_LIVE_VEO is set.
  if (nodeEnv !== 'production' && (process.env.RUN_LIVE_VEO === '1' || process.env.RUN_LIVE_VEO === 'true')) {
    env.RUN_LIVE_VEO = process.env.RUN_LIVE_VEO;
    env.THESHOW_VIDEO_BACKEND = process.env.THESHOW_VIDEO_BACKEND ?? 'gemini';
    if (process.env.GEMINI_API_KEY) env.GEMINI_API_KEY = process.env.GEMINI_API_KEY;
  }
  return env;
}

export default defineConfig({
  testDir: '.',
  testMatch: ['e2e/**/*.spec.ts', 'playwright/**/*.spec.ts'],
  workers: 1,
  fullyParallel: false,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 2 : 0,
  reporter: process.env.CI ? [['html', { open: 'never' }], ['list']] : 'list',
  use: {
    trace: 'on-first-retry',
    screenshot: 'only-on-failure',
    video: 'retain-on-failure',
    headless: true,
    reducedMotion: 'reduce',
    // Proof run: the browser cannot reach anything but loopback. Font CSS is
    // fulfilled inside the page fixture, so it never needs this proxy.
    ...(process.env.THESHOW_BLOCK_EXTERNAL === '1'
      ? { proxy: { server: 'http://127.0.0.1:9', bypass: '127.0.0.1,localhost' } }
      : {}),
  },
  projects: [
    {
      name: 'studio-dev',
      use: { ...devices['Desktop Chrome'], baseURL: devURL },
    },
    {
      name: 'studio-built',
      testIgnore: /lion-greeting-live/,
      use: { ...devices['Desktop Chrome'], baseURL: builtURL },
    },
  ],
  webServer: [
    {
      command: 'npm run dev',
      url: devURL,
      reuseExistingServer: false,
      timeout: 120_000,
      env: studioEnv('3100', undefined),
    },
    {
      command: 'npm run build && npm start',
      url: builtURL,
      reuseExistingServer: false,
      timeout: 180_000,
      env: studioEnv('3101', 'production'),
    },
  ],
});
