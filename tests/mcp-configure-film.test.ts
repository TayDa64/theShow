/**
 * Guards the shape of the configure_film form.
 *
 * These assertions exist because three specific things broke while building it
 * and each failure was silent rather than loud:
 *
 *  - format:'uri' on the reference image rejected a plain local path
 *  - the tool count in the docs drifted behind the registry
 *  - a declined form has to be distinguishable from an unanswered one, because
 *    the skill tells the model not to render on either
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const serverSource = readFileSync(
  path.join(__dirname, '..', 'mcp', 'server.ts'),
  'utf8',
);

describe('configure_film', () => {
  it('does not constrain the reference image field to uri format', () => {
    // A chat attachment resolves to a path like /workspace/photo.png, which
    // fails a uri check with: must match format "uri".
    const formBlock = serverSource.slice(
      serverSource.indexOf('const FILM_FORM_SCHEMA'),
      serverSource.indexOf('server.registerTool(\n  "configure_film"'),
    );
    expect(formBlock).toContain('referenceImage');
    // Strip comments first: the source explains the format:"uri" bug in a note,
    // and the note must not count as the code doing it.
    const codeOnly = formBlock
      .split('\n')
      .filter((line) => !line.trim().startsWith('//'))
      .join('\n');
    expect(codeOnly).not.toMatch(/format:\s*"uri"/);
  });

  it('asks for every field the skill promises to collect', () => {
    const formBlock = serverSource.slice(
      serverSource.indexOf('const FILM_FORM_SCHEMA'),
      serverSource.indexOf('server.registerTool(\n  "configure_film"'),
    );
    for (const field of [
      'scene',
      'characters',
      'style',
      'shotCount',
      'shotSeconds',
      'aspectRatio',
      'audio',
      'neverShow',
      'referenceImage',
    ]) {
      expect(formBlock).toContain(`${field}: {`);
    }
  });

  it('only requires the scene, so a user can accept the defaults', () => {
    expect(serverSource).toContain('required: ["scene"]');
  });

  it('labels the returned cost as an estimate', () => {
    expect(serverSource).toContain('isEstimate: true');
  });

  it('tells the caller not to render on a decline or cancel', () => {
    expect(serverSource).toContain('The user dismissed the form. Do not render.');
    expect(serverSource).toContain('The user cancelled. Do not render.');
  });

  it('falls back to text when the client has no elicitation capability', () => {
    expect(serverSource).toContain('getClientCapabilities');
    expect(serverSource).toContain('elicitationSupported: false');
  });
});

describe('skill and docs', () => {
  const skill = readFileSync(
    path.join(__dirname, '..', 'skills', 'theshow', 'SKILL.md'),
    'utf8',
  );

  it('has the skill call configure_film before spending anything', () => {
    expect(skill).toContain('configure_film');
    expect(skill).toContain('Step 0');
  });

  it('warns that the form takes a path, not a file upload', () => {
    expect(skill.toLowerCase()).toContain('no file');
  });
});

describe('render_sequence and check_sequence', () => {
  const src = serverSource;

  it('refuses to spend anything without confirm', () => {
    // The estimate-only path must return before any render call.
    const gate = src.slice(
      src.indexOf('if (!args.confirm)'),
      src.indexOf('const job: SequenceJob'),
    );
    expect(gate).toContain('estimate-only');
    expect(gate).not.toContain('generateGrokClip');
    expect(gate).not.toContain('runSequenceJob');
  });

  it('runs the chain in the background instead of blocking the request', () => {
    // Awaiting a multi-shot chain outlived the client timeout and lost the film.
    expect(src).toContain('void runSequenceJob(job');
    expect(src).not.toContain('await runSequenceJob(job');
  });

  it('chains each shot from the previous frame inside the job', () => {
    const jobFn = src.slice(
      src.indexOf('async function runSequenceJob'),
      src.indexOf('server.registerTool(\n  "render_sequence"'),
    );
    expect(jobFn).toContain('firstFrameUrl: previousFrame');
    expect(jobFn).toContain('previousFrame = frame.path');
  });

  it('stops the chain on a failed shot rather than rendering the rest', () => {
    const jobFn = src.slice(
      src.indexOf('async function runSequenceJob'),
      src.indexOf('server.registerTool(\n  "render_sequence"'),
    );
    expect(jobFn).toContain('job.state = "stopped"');
  });

  it('ships a free polling tool', () => {
    // Bound to the handler: an unbounded slice would run into the next tool.
    const start = src.indexOf('"check_sequence"');
    const poll = src.slice(start, src.indexOf('sequenceJobs.get(args.jobId)', start) + 400);
    expect(poll).toContain('renders nothing and spends');
    expect(poll).not.toContain('generateGrokClip');
  });

  it('lets the caller supply their own story beats', () => {
    expect(src).toContain('beats: args.beats');
    expect(src).toContain('A supplied beat list wins');
  });
});

describe('phone photos', () => {
  const video = readFileSync(
    path.join(__dirname, '..', 'mcp', 'grokVideo.ts'),
    'utf8',
  );

  it('transcodes heic rather than labelling it png', () => {
    expect(video).toContain('heic');
    expect(video).toContain('heif');
  });

  it('steps down until the payload fits the budget', () => {
    expect(video).toContain('for (const attempt of attempts)');
    expect(video).toContain('INLINE_IMAGE_BUDGET_BYTES) return lastUrl');
  });
});

describe('resolution and cost', () => {
  it('sends resolution to the API', () => {
    const video = readFileSync(
      path.join(__dirname, '..', 'mcp', 'grokVideo.ts'),
      'utf8',
    );
    expect(video).toContain('if (job.resolution) body.resolution = job.resolution');
  });

  it('estimates from the resolution actually requested, not a flat rate', () => {
    // A flat 8 cents quoted the 480p rate while the default renders at 720p,
    // so every estimate came in about a third low.
    expect(serverSource).toContain('ratePerSecond(args.resolution)');
    expect(serverSource).toContain('"720p": 0.14');
    expect(serverSource).toContain('"1080p": 0.25');
  });

  it('defaults both render tools to 720p', () => {
    const defaults = serverSource.match(/z\.enum\(\["480p", "720p", "1080p"\]\)\.default\("720p"\)/g);
    expect(defaults?.length).toBe(2);
  });
});
