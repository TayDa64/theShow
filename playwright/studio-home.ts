/**
 * Pinned Studio home for Playwright. The config process creates a fresh
 * directory for this run and publishes it through THESHOW_PLAYWRIGHT_HOME
 * and a pointer file, so a worker that did not inherit the env still uses
 * the same path. That path is never a real ~/.theshow.
 */
import fs from 'fs';
import os from 'os';
import path from 'path';

const POINTER = path.join(os.tmpdir(), 'theshow-playwright-home-pointer');

export function studioHome(): string {
  const fromEnv = process.env.THESHOW_PLAYWRIGHT_HOME;
  if (fromEnv && fromEnv.length > 0) return fromEnv;
  return fs.readFileSync(POINTER, 'utf8').trim();
}

export function studioJobs(): string {
  return path.join(studioHome(), 'jobs');
}

const CANARY = 'pw-canary-token';

function owner() {
  return {
    pid: process.pid,
    token: CANARY,
    host: os.hostname(),
    heartbeatAt: Date.now(),
  };
}

function job(id: string, extra: Record<string, unknown>): string {
  return `${JSON.stringify({
    id,
    startedAt: 1_700_000_000_000,
    shotCount: 1,
    completed: 1,
    estimateUsd: 1,
    spentUsd: 1,
    shots: [{ index: 1, title: 'Shot', status: 'completed', prompt: 'CANARY_PROMPT_do_not_leak' }],
    ...extra,
  }, null, 2)}\n`;
}

export function seedStudioHome(): void {
  const home = studioHome();
  const jobs = studioJobs();
  fs.rmSync(home, { recursive: true, force: true });
  const events = path.join(jobs, '.events');
  fs.mkdirSync(events, { recursive: true });
  fs.mkdirSync(path.join(home, 'media'), { recursive: true });
  fs.mkdirSync(path.join(home, 'characters'), { recursive: true });
  const write = (name: string, body: string) => fs.writeFileSync(path.join(jobs, name), body);
  write('seq_pw_running.json', job('seq_pw_running', {
    state: 'running',
    completed: 0,
    spentUsd: 0,
    shots: [],
    owner: owner(),
  }));
  write('seq_pw_completed.json', job('seq_pw_completed', {
    state: 'completed',
    finishedAt: 1_700_000_000_100,
    filmPath: '/tmp/should-not-appear/film.mp4',
  }));
  write('seq_pw_stopped.json', job('seq_pw_stopped', {
    state: 'stopped',
    finishedAt: 1_700_000_000_200,
    shots: [{ index: 1, title: 'Shot', status: 'failed', prompt: 'CANARY_PROMPT_do_not_leak' }],
  }));
  write('seq_pw_budget.json', job('seq_pw_budget', {
    state: 'completed',
    finishedAt: 1_700_000_000_300,
    spentUsd: 5,
    spendLedger: {
      version: 1,
      spentUsd: 5,
      pendingUsd: 0,
      thresholdUsd: 1,
      entries: [{ kind: 'video', usd: 5 }],
    },
  }));
  write('seq_pw_review.json', job('seq_pw_review', {
    state: 'completed',
    finishedAt: 1_700_000_000_400,
    continuityReview: {
      version: 1,
      findings: [{ class: 'measured', topic: 'wardrobe', summary: 'CANARY_PROMPT_do_not_leak' }],
      executed: false,
      willRender: false,
      willSpend: false,
      mutatedPaths: [],
    },
  }));
  write('seq_pw_repair.json', job('seq_pw_repair', {
    state: 'completed',
    finishedAt: 1_700_000_000_500,
    repairProposal: {
      version: 1,
      badShot: 1,
      resolution: '720p',
      options: [{
        id: 'retry-alone',
        costUsd: 1.12,
        fixes: [],
        leavesBroken: [],
        shotsToRender: [1],
        stillsToBuy: 0,
        requiresApproval: true,
      }],
      executed: false,
      willRender: false,
      willSpend: false,
    },
  }));
  write('seq_pw_legacy.json', job('seq_pw_legacy', {
    state: 'completed',
    finishedAt: 1_700_000_000_600,
  }));
  write('seq_pw_torn.json', job('seq_pw_torn', {
    state: 'completed',
    finishedAt: 1_700_000_000_700,
  }));
  fs.writeFileSync(path.join(events, 'seq_pw_torn.jsonl'), '{"torn":');
}

export const STUDIO_CANARY = CANARY;
