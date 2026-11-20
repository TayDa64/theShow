/**
 * Spend tools refuse before any generator call when the gate does not pass.
 * The server is driven over the MCP in-memory transport. Fetch is a spy.
 */
import fs from 'fs';
import os from 'os';
import path from 'path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { localImageRefAllowed } from '../mcp/grokVideo.ts';
import { JOBS_DIR, OUTPUT_DIR } from '../mcp/media.ts';
import { loadJobsFromDisk, server, setImageRootProbeForTests } from '../mcp/server.ts';

let client: Client;
const fetchCalls: string[] = [];

function toolText(result: unknown): string {
  if (!result || typeof result !== 'object' || !('content' in result)) return '';
  const content = result.content;
  if (!Array.isArray(content)) return '';
  const first = content[0] as { text?: string } | undefined;
  return first?.text ?? '';
}

beforeAll(async () => {
  process.env.THESHOW_CHARACTERS_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'theshow-cast-'));
  globalThis.fetch = (async (input: unknown) => {
    fetchCalls.push(String(input));
    throw new Error('spend spy: no generator call is allowed');
  }) as typeof fetch;

  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  client = new Client({ name: 'theshow-test', version: '0.0.0' });
  await client.connect(clientTransport);
});

afterAll(async () => {
  await client.close();
});

describe('spend tools stop when the gate does not pass', () => {
  it('does not generate a clip without confirm', async () => {
    fetchCalls.length = 0;
    const result = await client.callTool({
      name: 'generate_controlled_clip',
      arguments: { prompt: 'A lantern.', confirm: false },
    });
    const body = JSON.parse(toolText(result));
    expect(body.action).toBe('estimate-only');
    expect(body.willRender).toBe(false);
    expect(fetchCalls).toEqual([]);
  });

  it('does not generate a clip when confirm is set and there is no ledger', async () => {
    fetchCalls.length = 0;
    const result = await client.callTool({
      name: 'generate_controlled_clip',
      arguments: { prompt: 'A lantern.', confirm: true },
    });
    const body = JSON.parse(toolText(result));
    expect(body.action).toBe('refused');
    expect(body.contractValidation.status).toBe('unchecked');
    expect(fetchCalls).toEqual([]);
  });

  it('does not buy stills when confirm is set and the contract fails', async () => {
    fetchCalls.length = 0;
    await client.callTool({
      name: 'create_character',
      arguments: {
        name: 'Gate Tay',
        wardrobe: {
          layers: [
            { id: 'coat', item: 'tan coat', order: 2, inReference: 'visible', closure: 'buttons' },
            { id: 'blazer', item: 'navy blazer', order: 1, inReference: 'visible' },
          ],
          startState: { worn: ['coat', 'blazer'] },
        },
      },
    });
    const result = await client.callTool({
      name: 'board_film',
      arguments: {
        confirm: true,
        characters: ['Gate Tay'],
        cast: 'one man in a tan coat',
        shots: [{
          prompt: 'He takes the coat and the blazer off.',
          wardrobeEvents: [
            { action: 'remove', layer: 'coat', to: 'hanger' },
            { action: 'remove', layer: 'blazer' },
          ],
        }],
      },
    });
    const body = JSON.parse(toolText(result));
    expect(body.action).toBe('refused');
    expect(body.willSpend).toBe(false);
    expect(body.contractValidation.blocked).toBe(true);
    expect(fetchCalls).toEqual([]);
  });

  it('gates a resumed film on the ledger stored with the job', async () => {
    fetchCalls.length = 0;
    const jobId = 'seq_resume_gate';
    const job = {
      id: jobId,
      startedAt: 1,
      state: 'completed',
      shotCount: 1,
      completed: 1,
      estimateUsd: 1,
      spentUsd: 1,
      shots: [{
        index: 1,
        title: 'Shot 1',
        status: 'completed',
        localPath: path.join(os.tmpdir(), 'clip.mp4'),
        framePath: path.join(os.tmpdir(), 'frame.png'),
        prompt: 'He stands.',
      }],
      ledger: {
        locations: [],
        props: [],
        wardrobeEvents: [],
        propEvents: [],
        shotSteps: [{ shot: 1, steps: ['one', 'two', 'three', 'four'] }],
      },
    };
    fs.mkdirSync(JOBS_DIR, { recursive: true });
    fs.writeFileSync(path.join(JOBS_DIR, `${jobId}.json`), JSON.stringify(job));
    await loadJobsFromDisk();

    const result = await client.callTool({
      name: 'render_sequence',
      arguments: {
        confirm: true,
        resumeFromJobId: jobId,
        shots: [{ prompt: 'He turns.', durationSeconds: 4 }],
      },
    });
    const body = JSON.parse(toolText(result));
    expect(body, JSON.stringify(body)).toMatchObject({ action: 'refused' });
    expect(body.contractValidation.violations.some(
      (entry: { code: string }) => entry.code === 'too-many-steps',
    )).toBe(true);
    expect(fetchCalls).toEqual([]);
  });

  it('keeps a stored sections-v2 style when the resume ledger omits it', async () => {
    fetchCalls.length = 0;
    const jobId = 'seq_resume_style';
    const job = {
      id: jobId,
      startedAt: 1,
      state: 'completed',
      shotCount: 1,
      completed: 1,
      estimateUsd: 1,
      spentUsd: 1,
      shots: [{
        index: 1,
        title: 'Shot 1',
        status: 'completed',
        prompt: 'He stands.',
      }],
      ledger: {
        locations: [],
        props: [],
        wardrobeEvents: [],
        propEvents: [],
        promptStyle: 'sections-v2',
        voiceId: 'rex',
        spokenLines: [{ shot: 1, line: 'Hello there.' }],
      },
    };
    fs.mkdirSync(JOBS_DIR, { recursive: true });
    fs.writeFileSync(path.join(JOBS_DIR, `${jobId}.json`), JSON.stringify(job));
    await loadJobsFromDisk();

    const result = await client.callTool({
      name: 'render_sequence',
      arguments: {
        confirm: false,
        resumeFromJobId: jobId,
        shots: [{
          prompt: 'He says, "Hello there." and sits.',
          durationSeconds: 4,
          lastFrameUrl: '/tmp/theshow-closing.png',
        }],
        ledger: {
          locations: [],
          props: [],
          wardrobeEvents: [],
          propEvents: [],
          spokenLines: [{ shot: 1, line: 'Hello there.' }],
        },
      },
    });
    const body = JSON.parse(toolText(result));
    expect(body.action).toBe('estimate-only');
    expect(body.contractValidation.status).toBe('fail');
    expect(body.contractValidation.blocked).toBe(true);
    expect(body.plan.continuity).toContain('pin is "start"');
    expect(fetchCalls).toEqual([]);
  });

  it('accepts overrideValidation on a cast board with no picture', async () => {
    fetchCalls.length = 0;
    const refused = await client.callTool({
      name: 'board_film',
      arguments: {
        confirm: true,
        cast: 'one man in a tan coat',
        shots: [{ prompt: 'He stands in the hall.' }],
      },
    });
    const blocked = JSON.parse(toolText(refused));
    expect(blocked.action).toBe('refused');
    expect(blocked.message).toContain('board_film');
    expect(blocked.message).not.toContain('render_sequence');
    expect(blocked.next).not.toContain('Call again with confirm: true');
    expect(blocked.contractValidation.blocked).toBe(true);

    const allowed = await client.callTool({
      name: 'board_film',
      arguments: {
        confirm: false,
        overrideValidation: true,
        cast: 'one man in a tan coat',
        shots: [{ prompt: 'He stands in the hall.' }],
      },
    });
    const estimate = JSON.parse(toolText(allowed));
    expect(estimate.action).toBe('estimate-only');
    expect(estimate.contractValidation.status).toBe('override');
    expect(estimate.contractValidation.blocked).toBe(false);
    expect(fetchCalls).toEqual([]);
  });

  it('estimates a still until confirm, and refuses a local path outside the allowed folders', async () => {
    fetchCalls.length = 0;
    const estimate = JSON.parse(toolText(await client.callTool({
      name: 'generate_still',
      arguments: { prompt: 'A lantern on a table.' },
    })));
    expect(estimate.action).toBe('estimate-only');
    expect(estimate.willSpend).toBe(false);
    expect(fetchCalls).toEqual([]);

    const refused = JSON.parse(toolText(await client.callTool({
      name: 'generate_still',
      arguments: {
        confirm: true,
        prompt: 'A lantern on a table.',
        baseImageUrl: '/tmp/theshow-outside-still.png',
      },
    })));
    expect(refused.action).toBe('refused');
    expect(refused.willSpend).toBe(false);
    expect(fetchCalls).toEqual([]);

    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'theshow-still-'));
    const inside = path.join(root, 'allowed-still.png');
    fs.writeFileSync(inside, 'not-a-real-image');
    expect(localImageRefAllowed(inside, [root])).toBe(true);
    expect(localImageRefAllowed('https://example.invalid/still.png', [root])).toBe(true);
    expect(localImageRefAllowed('/tmp/theshow-outside-still.png', [root])).toBe(false);
  });
});

const IMAGE_ERROR = 'A local image has to be inside the output folder or a character folder.';

describe('clip and sequence tools refuse local images outside the allowed roots', () => {
  const MEDIA = 'C:\\Users\\Tay Liku\\.theshow\\media';

  async function call(name: 'generate_controlled_clip' | 'render_sequence', image: string) {
    fetchCalls.length = 0;
    if (name === 'generate_controlled_clip') {
      return client.callTool({
        name,
        arguments: { prompt: 'A lantern.', confirm: false, firstFrameUrl: image },
      });
    }
    return client.callTool({
      name,
      arguments: {
        confirm: false,
        shots: [{ prompt: 'A lantern.', durationSeconds: 4, firstFrameUrl: image }],
      },
    });
  }

  it('accepts a still inside the output folder and refuses one outside', async () => {
    fs.mkdirSync(OUTPUT_DIR, { recursive: true });
    const inside = path.join(OUTPUT_DIR, 'board-allowed.jpg');
    fs.writeFileSync(inside, 'jpeg-bytes');

    for (const name of ['generate_controlled_clip', 'render_sequence'] as const) {
      const allowed = JSON.parse(toolText(await call(name, inside)));
      expect(allowed.action).toBe('estimate-only');
      expect(allowed.error).toBeUndefined();
      expect(fetchCalls).toEqual([]);

      const remote = JSON.parse(toolText(await call(name, 'https://example.invalid/still.png')));
      expect(remote.action).toBe('estimate-only');
      expect(fetchCalls).toEqual([]);

      const data = JSON.parse(toolText(await call(name, 'data:image/jpeg;base64,aaaa')));
      expect(data.action).toBe('estimate-only');
      expect(fetchCalls).toEqual([]);

      const refused = JSON.parse(toolText(await call(name, '/tmp/theshow-outside-clip.png')));
      expect(refused.action).toBe('refused');
      expect(refused.willSpend).toBe(false);
      expect(refused.willRender).toBe(false);
      expect(refused.error).toContain(IMAGE_ERROR);
      expect(fetchCalls).toEqual([]);
    }
  });

  it('accepts a lowercase drive file URL when the root check uses win32', async () => {
    setImageRootProbeForTests({
      roots: [MEDIA],
      check: {
        platform: 'win32',
        realpathSync: () => {
          throw new Error('missing');
        },
      },
    });
    try {
      for (const name of ['generate_controlled_clip', 'render_sequence'] as const) {
        const allowed = JSON.parse(toolText(await call(
          name,
          'file:///c:/Users/Tay%20Liku/.theshow/media/board-x.jpg',
        )));
        expect(allowed.action).toBe('estimate-only');
        expect(allowed.error).toBeUndefined();
        expect(fetchCalls).toEqual([]);

        const sibling = JSON.parse(toolText(await call(
          name,
          'C:\\Users\\Tay Liku\\.theshow\\media-evil\\x.jpg',
        )));
        expect(sibling.action).toBe('refused');
        expect(sibling.error).toContain(IMAGE_ERROR);
        expect(fetchCalls).toEqual([]);
      }
    } finally {
      setImageRootProbeForTests(undefined);
    }
  });
});
