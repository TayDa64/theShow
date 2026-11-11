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
import { JOBS_DIR } from '../mcp/media.ts';
import { loadJobsFromDisk, server } from '../mcp/server.ts';

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
});
