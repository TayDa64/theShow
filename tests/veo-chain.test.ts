import { describe, expect, it, vi } from 'vitest';
import { buildClipChain, pollUntilComplete } from '../src/lib/veoChain';

describe('veo chain helpers', () => {
  it('runs the clip chain serially and threads video_to_extend forward', async () => {
    const events: string[] = [];

    const results = await buildClipChain([
      { prompt: 'Shot 1' },
      { prompt: 'Shot 2' },
      { prompt: 'Shot 3' },
    ], async (request, index) => {
      events.push(`start-${index}-${request.video_to_extend || 'none'}`);
      await Promise.resolve();
      events.push(`end-${index}`);
      return { video_to_extend: `clip-${index + 1}` };
    });

    expect(events).toEqual([
      'start-0-none',
      'end-0',
      'start-1-clip-1',
      'end-1',
      'start-2-clip-2',
      'end-2',
    ]);
    expect(results).toHaveLength(3);
  });

  it('times out polling after 150 retries', async () => {
    const poller = vi.fn(async () => ({ done: false }));

    await expect(pollUntilComplete(poller, { intervalMs: 0 })).rejects.toThrow('Polling timed out after 150 attempts.');
    expect(poller).toHaveBeenCalledTimes(150);
  });
});
