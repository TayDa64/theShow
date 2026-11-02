/**
 * Guards bookend frame control and still generation against the real request
 * shape the Grok proxy accepts.
 *
 * Every assertion here comes from a measurement that failed first:
 *
 *  - `first_frame` is silently ignored by the API. A shot sent with it landed at
 *    0.14 correlation against the supplied image, the same as an unpinned
 *    render, so the key is dead weight and must never be sent.
 *  - two full-size frames inline to ~600-720 KB each and the proxy answers
 *    `Failed to read request body: length limit exceeded`. Bookending means the
 *    pair has to share one budget.
 *  - image generation on the same subscription bills 2 cents a still, which is
 *    the whole economic case for boarding a film before rendering it.
 */
import fs from 'fs';
import os from 'os';
import path from 'path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

const ROOT = path.join(__dirname, '..');
const videoSource = fs.readFileSync(path.join(ROOT, 'mcp', 'grokVideo.ts'), 'utf8');
const serverSource = fs.readFileSync(path.join(ROOT, 'mcp', 'server.ts'), 'utf8');
const storyboardSource = fs.readFileSync(path.join(ROOT, 'mcp', 'storyboard.ts'), 'utf8');

function codeOnly(source: string) {
  return source
    .split('\n')
    .filter((line) => !line.trim().startsWith('//') && !line.trim().startsWith('*') && !line.trim().startsWith('/*'))
    .join('\n');
}

/**
 * A real credential resolver reads disk, so tests point it at a throwaway auth
 * file. Written the way the Grok CLI writes it: keyed by issuer, with a token.
 */
function useFakeGrokSession(dir: string) {
  const authFile = path.join(dir, 'auth.json');
  fs.writeFileSync(
    authFile,
    JSON.stringify({
      'https://auth.x.ai::test': {
        key: 'test-session-token',
        expires_at: new Date(Date.now() + 3_600_000).toISOString(),
        email: 'bookend-test@example.com',
      },
    }),
  );
  process.env.GROK_AUTH_FILE = authFile;
  delete process.env.XAI_API_KEY;
}

/** A tiny real PNG, so a "local image" is a readable file rather than a stub. */
function writePng(file: string, width: number, height: number) {
  const zlib = require('node:zlib') as typeof import('node:zlib');
  const raw = Buffer.alloc((width * 3 + 1) * height);
  for (let y = 0; y < height; y++) {
    const row = y * (width * 3 + 1);
    raw[row] = 0;
    for (let x = 0; x < width; x++) {
      const p = row + 1 + x * 3;
      raw[p] = (x * 7 + y * 13) % 256;
      raw[p + 1] = (x * 3 + y * 29) % 256;
      raw[p + 2] = (x * 17 + y * 5) % 256;
    }
  }
  const chunk = (type: string, data: Buffer) => {
    const len = Buffer.alloc(4);
    len.writeUInt32BE(data.length);
    const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(zlib.crc32(body));
    return Buffer.concat([len, body, crc]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;
  ihdr[9] = 2;
  fs.writeFileSync(
    file,
    Buffer.concat([
      Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
      chunk('IHDR', ihdr),
      chunk('IDAT', zlib.deflateSync(raw)),
      chunk('IEND', Buffer.alloc(0)),
    ]),
  );
}

const dataUriBytes = (uri: string) => Math.ceil((uri.length - uri.indexOf(',') - 1) * 0.75);

let tempDir: string;
const originalFetch = globalThis.fetch;

beforeEach(() => {
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'theshow-bookend-'));
  useFakeGrokSession(tempDir);
});

afterEach(() => {
  globalThis.fetch = originalFetch;
  delete process.env.GROK_AUTH_FILE;
  fs.rmSync(tempDir, { recursive: true, force: true });
});

/** Capture the JSON bodies a call submits, and return the canned answers. */
function stubFetch(responder: (url: string, body: any) => Response) {
  const bodies: any[] = [];
  globalThis.fetch = (async (input: any, init?: any) => {
    const url = String(input);
    let body: any;
    if (typeof init?.body === 'string') {
      try { body = JSON.parse(init.body); } catch { body = init.body; }
    }
    if (url.includes('/v1/videos/generations') || url.includes('/v1/images/generations')) {
      bodies.push({ url, body });
    }
    return responder(url, body);
  }) as typeof fetch;
  return bodies;
}

describe('bookend frames reach the request body', () => {
  it('sends the last frame as last_frame and never sends first_frame', async () => {
    const { generateGrokClip } = await import('../mcp/grokVideo.ts');
    const bodies = stubFetch((url) => {
      if (url.includes('/v1/videos/generations')) {
        return new Response(JSON.stringify({ request_id: 'req-bookend' }), { status: 200 });
      }
      return new Response(JSON.stringify({
        status: 'completed',
        video: { url: 'https://example.invalid/clip.mp4', duration: 8 },
        usage: { cost_in_usd_ticks: 2400000000 },
      }), { status: 200 });
    });

    const result = await generateGrokClip(
      {
        prompt: 'A lantern swings in the dark.',
        firstFrameUrl: 'https://example.invalid/first.png',
        lastFrameUrl: 'https://example.invalid/last.png',
        durationSeconds: 8,
      },
      // Submit only: the body shape is what this asserts, and polling would
      // sit through the real 5s status interval for no extra coverage.
      { waitForCompletion: false, timeoutSeconds: 60 },
    );

    expect(result.status).toBe('submitted');
    const body = bodies[0].body;
    expect(body.image).toEqual({ url: 'https://example.invalid/first.png' });
    expect(body.last_frame).toEqual({ url: 'https://example.invalid/last.png' });
    // The key the API ignores: sending it was measured at 0.14 correlation.
    expect(body).not.toHaveProperty('first_frame');
  });

  it('never contains a first_frame assignment anywhere in the source', () => {
    const code = codeOnly(videoSource);
    expect(code).not.toMatch(/body\.first_frame\s*=/);
    expect(code).toContain('body.last_frame = { url: pair.last };');
  });

  it('still sends a lone first frame as image, with no bookend keys', async () => {
    const { generateGrokClip } = await import('../mcp/grokVideo.ts');
    const bodies = stubFetch((url) => {
      if (url.includes('/v1/videos/generations')) {
        return new Response(JSON.stringify({ request_id: 'req-single' }), { status: 200 });
      }
      return new Response(JSON.stringify({ status: 'completed', video: { url: 'https://example.invalid/c.mp4' } }), { status: 200 });
    });

    await generateGrokClip(
      { prompt: 'x', firstFrameUrl: 'https://example.invalid/first.png' },
      { waitForCompletion: false, timeoutSeconds: 60 },
    );

    expect(bodies[0].body.image).toEqual({ url: 'https://example.invalid/first.png' });
    expect(bodies[0].body).not.toHaveProperty('last_frame');
    expect(bodies[0].body).not.toHaveProperty('first_frame');
  });

  it('accepts a last frame on its own, which is how a closing frame is pinned', async () => {
    const { generateGrokClip } = await import('../mcp/grokVideo.ts');
    const bodies = stubFetch((url) => {
      if (url.includes('/v1/videos/generations')) {
        return new Response(JSON.stringify({ request_id: 'req-last-only' }), { status: 200 });
      }
      return new Response(JSON.stringify({ status: 'completed', video: { url: 'https://example.invalid/c.mp4' } }), { status: 200 });
    });

    await generateGrokClip(
      { prompt: 'x', lastFrameUrl: 'https://example.invalid/last.png' },
      { waitForCompletion: false, timeoutSeconds: 60 },
    );

    expect(bodies[0].body.last_frame).toEqual({ url: 'https://example.invalid/last.png' });
    expect(bodies[0].body).not.toHaveProperty('image');
  });
});

describe('body size budgeting for a bookend', () => {
  it('shrinks both images so the pair fits one request body', async () => {
    const { generateGrokClip, BOOKEND_IMAGE_BUDGET_BYTES, BOOKEND_PAIR_BUDGET_BASE64_BYTES } =
      await import('../mcp/grokVideo.ts');
    // Big, noisy frames: the worst case for JPEG, and the size that actually
    // tripped the proxy limit at two per request.
    const first = path.join(tempDir, 'first.png');
    const last = path.join(tempDir, 'last.png');
    writePng(first, 848, 480);
    writePng(last, 848, 480);

    const bodies = stubFetch((url) => {
      if (url.includes('/v1/videos/generations')) {
        return new Response(JSON.stringify({ request_id: 'req-pair' }), { status: 200 });
      }
      return new Response(JSON.stringify({ status: 'completed', video: { url: 'https://example.invalid/c.mp4' } }), { status: 200 });
    });

    await generateGrokClip(
      { prompt: 'x', firstFrameUrl: first, lastFrameUrl: last },
      { waitForCompletion: false, timeoutSeconds: 60 },
    );

    const body = bodies[0].body;
    expect(body.image.url).toMatch(/^data:image\/jpeg;base64,/);
    expect(body.last_frame.url).toMatch(/^data:image\/jpeg;base64,/);

    const firstBytes = dataUriBytes(body.image.url);
    const lastBytes = dataUriBytes(body.last_frame.url);
    // Each frame has to fit the tighter pair budget, and the encoded pair has to
    // stay under what was measured working (about 155 KB in the live probe).
    expect(firstBytes).toBeLessThanOrEqual(BOOKEND_IMAGE_BUDGET_BYTES);
    expect(lastBytes).toBeLessThanOrEqual(BOOKEND_IMAGE_BUDGET_BYTES);
    expect(firstBytes + lastBytes).toBeLessThanOrEqual(BOOKEND_PAIR_BUDGET_BASE64_BYTES);
    expect(dataUriBytes(String(body.image.url)) + dataUriBytes(String(body.last_frame.url)))
      .toBeLessThan(220 * 1024);
  }, 30000);

  it('leaves a single image on the original 220 KB budget', () => {
    // Existing phone-photo behaviour must not change: one image still gets the
    // full single-image budget, only a pair is tightened.
    expect(videoSource).toContain('export const INLINE_IMAGE_BUDGET_BYTES = 220 * 1024;');
    const singleCall = videoSource.slice(
      videoSource.indexOf('} else if (job.firstFrameUrl) {'),
      videoSource.indexOf('} else if (job.lastFrameUrl) {'),
    );
    // A lone frame is inlined with no tighter budget argument at all.
    expect(singleCall).toContain('toApiImageRef(job.firstFrameUrl)');
    expect(singleCall).not.toContain('budgetBytes');
  });

  it('shrinks a reference set harder as the list grows', () => {
    const code = codeOnly(videoSource);
    expect(code).toContain('INLINE_IMAGE_BUDGET_BYTES / urls.length');
    expect(videoSource).toContain('export const BOOKEND_IMAGE_BUDGET_BYTES = 75 * 1024;');
  });
});

describe('generate_still', () => {
  it('posts the model the subscription actually serves', async () => {
    // grok-2-image 404s; grok-imagine-image is the one that returns 200.
    expect(videoSource).toContain('job.model || "grok-imagine-image"');
    expect(videoSource).not.toContain('grok-2-image');
  });

  it('builds the right body and parses cost from ticks', async () => {
    const { generateGrokStill } = await import('../mcp/grokVideo.ts');
    const { USD_TICKS_PER_DOLLAR } = await import('../mcp/grokVideo.ts');
    const bodies = stubFetch((url) => {
      if (url.includes('/v1/images/generations')) {
        return new Response(JSON.stringify({
          data: [{ url: 'https://example.invalid/still.png', mime_type: 'image/png' }],
          // 200000000 ticks is exactly two cents, measured on a live call.
          usage: { cost_in_usd_ticks: 200000000 },
        }), { status: 200 });
      }
      return new Response(Buffer.from('not-an-image-but-bytes'), {
        status: 200,
        headers: { 'content-type': 'image/png' },
      });
    });

    const result = await generateGrokStill(
      { prompt: 'A wide empty street at dawn.', aspectRatio: '16:9' },
      { outputDir: tempDir },
    );

    const body = bodies[0].body;
    expect(bodies[0].url).toContain('/v1/images/generations');
    expect(body).toMatchObject({
      model: 'grok-imagine-image',
      prompt: 'A wide empty street at dawn.',
      n: 1,
      aspect_ratio: '16:9',
    });
    expect(result.costUsd).toBeCloseTo(200000000 / USD_TICKS_PER_DOLLAR, 8);
    expect(result.costUsd).toBeCloseTo(0.02, 6);
    expect(result.imageUrl).toBe('https://example.invalid/still.png');
    expect(result.localPath && fs.existsSync(result.localPath)).toBe(true);
    expect(result.aspectRatioParam).toBe('aspect_ratio');
  });

  it('falls back to another shape key rather than losing a paid still', async () => {
    const { generateGrokStill } = await import('../mcp/grokVideo.ts');
    const bodies = stubFetch((url, body) => {
      if (url.includes('/v1/images/generations')) {
        // Refuse the snake_case shape the way a stricter route would.
        if (body && 'aspect_ratio' in body) {
          return new Response(JSON.stringify({ error: 'unknown field aspect_ratio' }), { status: 400 });
        }
        return new Response(JSON.stringify({
          data: [{ url: 'https://example.invalid/still.png', mime_type: 'image/png' }],
          usage: { cost_in_usd_ticks: 200000000 },
        }), { status: 200 });
      }
      return new Response(Buffer.from('bytes'), { status: 200, headers: { 'content-type': 'image/png' } });
    });

    const result = await generateGrokStill(
      { prompt: 'x', aspectRatio: '9:16' },
      { outputDir: tempDir },
    );

    expect(bodies.length).toBe(2);
    expect(bodies[1].body.aspectRatio).toBe('9:16');
    expect(result.aspectRatioParam).toBe('aspectRatio');
    expect(result.localPath && fs.existsSync(result.localPath)).toBe(true);
  });

  it('reports a failure instead of inventing a URL', async () => {
    const { generateGrokStill } = await import('../mcp/grokVideo.ts');
    stubFetch(() => new Response(JSON.stringify({ error: 'model unavailable' }), { status: 500 }));

    const result = await generateGrokStill(
      { prompt: 'x', aspectRatio: '16:9' },
      { outputDir: tempDir },
    );

    expect(result.localPath).toBeUndefined();
    expect(result.imageUrl).toBeUndefined();
    expect(result.error).toBeTruthy();
    expect(result.detail).toContain('model unavailable');
  });

  it('reports a rejected credential without retrying every shape variant', async () => {
    const { generateGrokStill } = await import('../mcp/grokVideo.ts');
    const bodies = stubFetch(() => new Response('{"error":"bad token"}', { status: 401 }));

    const result = await generateGrokStill(
      { prompt: 'x', aspectRatio: '1:1' },
      { outputDir: tempDir },
    );

    expect(result.code).toBe('rejected');
    expect(bodies.length).toBe(1);
    expect(result.hint).toContain('grok login');
  });

  it('merges character portraits on the still, exactly like a clip', () => {
    const tool = serverSource.slice(
      serverSource.indexOf('"generate_still"'),
      serverSource.indexOf('"assemble_film"'),
    );
    expect(tool).toContain('mergeCharacterReferences(args.characters, args.referenceImageUrls)');
    expect(tool).toContain('generateGrokStill(');
    // A failed still must never return a made-up path.
    expect(tool).toContain('error: result.error ?? "Still generation failed"');
  });
});

describe('render_sequence takes explicit per-shot frames', () => {
  const renderSeq = serverSource.slice(
    serverSource.indexOf('"render_sequence"'),
    serverSource.indexOf('"retry_shot"'),
  );

  it('accepts both frames on a shot', () => {
    expect(renderSeq).toContain('firstFrameUrl: z.string().optional()');
    expect(renderSeq).toContain('lastFrameUrl: z.string().optional()');
  });

  it('passes lastFrameUrl into the clip job', () => {
    const code = codeOnly(serverSource);
    expect(code).toContain('lastFrameUrl: shot.lastFrameUrl,');
    expect(code).toContain('firstFrameUrl: shotFirstFrame,');
  });

  it('prefers an explicit first frame over chaining', () => {
    // A boarded shot's opening frame is the picture the user approved. Chaining
    // over it would replace it with a near-miss and undo the bookend.
    expect(codeOnly(serverSource)).toContain('const shotFirstFrame = shot.firstFrameUrl ?? previousFrame;');
  });

  it('records the pinned frames on the shot and persists them with the job', () => {
    const code = codeOnly(serverSource);
    expect(code).toContain('lastFrameUrl?: string;');
    expect(code).toContain('lastFramePath?: string;');
    expect(code).toContain('lastFrameUrl: shot.lastFrameUrl,');
    expect(code).toContain('lastFramePath: localImagePath(shot.lastFrameUrl),');
    // persistJob writes the whole job, so the record has to be on the job.
    expect(code).toContain('JSON.stringify(job, null, 2)');
  });

  it('counts shared boundaries in the plan, so a boarded film is reported as one', () => {
    expect(codeOnly(serverSource)).toContain('const sharedBoundaries = args.shots.reduce');
    expect(renderSeq).toContain('sharedBoundaryFrames: sharedBoundaries');
  });
});

describe('the board keeps its own money limits', () => {
  it('prices a board from measured still cost, not a guess', () => {
    // Two cents is the measured figure, and every billable frame — including the
    // hero frame a base-plus-portrait board buys first — must go through it.
    expect(storyboardSource).toContain('export const STILL_USD = 0.02;');
    expect(storyboardSource).toContain('const billable = missing.length + heroStills;');
    expect(storyboardSource).toContain('const estimatedUsd = Math.round(billable * STILL_USD * 100) / 100;');
  });

  it('gates on maxCostUsd before any still is rendered', () => {
    const code = codeOnly(storyboardSource);
    const gate = code.indexOf('const overBudget');
    const render = code.indexOf('await deps.generateStill');
    expect(gate).toBeGreaterThan(-1);
    expect(render).toBeGreaterThan(gate);
    expect(code).toContain('if (!input.confirm || overBudget)');
  });

  it('looks for a still on disk before pricing it as new', () => {
    const code = codeOnly(storyboardSource);
    expect(code.indexOf('await findExistingStill')).toBeLessThan(
      code.indexOf('const estimatedUsd = Math.round(billable * STILL_USD'),
    );
    expect(code).toContain('reusedStills: existing.length - missing.length');
  });

  it('names stills from their own prompt, so a re-run finds the same file', () => {
    // The hash input is the full prompt, optionally with the base picture mixed
    // in so a changed base cannot reuse frames bought against the old one. The
    // prompt still has to be in there: that is what makes a re-run free.
    expect(storyboardSource).toContain('createHash("sha1").update(hashInput)');
    // The stem must be derived from what the frame is EDITED FROM, which is the
    // hero frame when one exists, not the location photo the caller passed.
    expect(storyboardSource).toContain('opts.baseFingerprint ?? opts.baseImageUrl');
  });
});

describe('base image routes the still to the edit endpoint', () => {
  it('posts to /v1/images/edits with the picture as the subject', async () => {
    // Measured: on `/v1/images/generations` a reference is a hint the prompt
    // overrules. A bald bearded portrait plus a prompt describing a red-haired
    // woman returned the woman, not the man. On `/v1/images/edits` with the same
    // picture as `image`, the man survived intact and she was added beside him.
    // That difference is the whole face-fidelity fix, so it must not regress to
    // a plain generation with a reference attached.
    const { generateGrokStill } = await import('../mcp/grokVideo.ts');
    const seen: Array<{ url: string; body: any }> = [];
    globalThis.fetch = (async (input: any, init?: any) => {
      const url = String(input);
      if (url.includes('/v1/images/')) {
        seen.push({ url, body: JSON.parse(init.body) });
        return new Response(JSON.stringify({
          data: [{ url: 'https://example.invalid/edited.png', mime_type: 'image/png' }],
          usage: { cost_in_usd_ticks: 220000000 },
        }), { status: 200 });
      }
      return new Response(Buffer.from('bytes'), { status: 200 });
    }) as typeof fetch;

    const base = path.join(tempDir, 'office.png');
    writePng(base, 8, 8);

    const result = await generateGrokStill(
      { prompt: 'He stands at the desk.', aspectRatio: '16:9', baseImageUrl: base },
      { outputDir: tempDir },
    );

    expect(result.route).toBe('edits');
    expect(seen[0].url).toContain('/v1/images/edits');
    expect(seen[0].body.image).toBeTruthy();
    // 220000000 ticks: an edit billed 0.022 where a plain still bills 0.020.
    expect(result.costUsd).toBeCloseTo(0.022, 4);
  });

  it('leaves a plain still on the generations route', async () => {
    const { generateGrokStill } = await import('../mcp/grokVideo.ts');
    const seen: string[] = [];
    globalThis.fetch = (async (input: any) => {
      const url = String(input);
      if (url.includes('/v1/images/')) {
        seen.push(url);
        return new Response(JSON.stringify({
          data: [{ url: 'https://example.invalid/s.png', mime_type: 'image/png' }],
          usage: { cost_in_usd_ticks: 200000000 },
        }), { status: 200 });
      }
      return new Response(Buffer.from('bytes'), { status: 200 });
    }) as typeof fetch;

    const result = await generateGrokStill(
      { prompt: 'A wide empty street.', aspectRatio: '16:9' },
      { outputDir: tempDir },
    );
    expect(result.route).toBe('generations');
    expect(seen[0]).toContain('/v1/images/generations');
  });
});

describe('picture order on the edit route', () => {
  /**
   * The first picture is the subject; the rest are context. That ordering is
   * load-bearing: a portrait placed first ("put this man in the office in the
   * second photo") kept a face that no amount of prompt wording held, and the
   * edited still kept the sherpa coat too. Reversing it turns the edit into
   * "draw a room with a stranger in it".
   */
  it('puts the portrait first and the base last', async () => {
    const { generateGrokStill } = await import('../mcp/grokVideo.ts');
    const seen: any[] = [];
    globalThis.fetch = (async (input: any, init?: any) => {
      const url = String(input);
      if (url.includes('/v1/images/')) {
        seen.push(JSON.parse(init.body));
        return new Response(JSON.stringify({
          data: [{ url: 'https://example.invalid/h.png', mime_type: 'image/png' }],
          usage: { cost_in_usd_ticks: 220000000 },
        }), { status: 200 });
      }
      return new Response(Buffer.from('bytes'), { status: 200 });
    }) as typeof fetch;

    const portrait = path.join(tempDir, 'portrait.png');
    const office = path.join(tempDir, 'office.png');
    writePng(portrait, 8, 8);
    writePng(office, 8, 8);

    await generateGrokStill(
      {
        prompt: 'Place this man in the office in the second photo.',
        aspectRatio: '16:9',
        baseImageUrl: office,
        referenceImageUrls: [portrait],
      },
      { outputDir: tempDir },
    );

    expect(Array.isArray(seen[0].image)).toBe(true);
    expect(seen[0].image).toHaveLength(2);
    // Both are data URIs, so identity is checked by decoding the first bytes.
    const head = (uri: string) => Buffer.from(uri.slice(uri.indexOf(',') + 1), 'base64').subarray(0, 8).toString('hex');
    expect(head(seen[0].image[0])).toBe('89504e470d0a1a0a');
    // And the competing reference key must be gone, not duplicated.
    expect(seen[0].reference_images).toBeUndefined();
  });
});
