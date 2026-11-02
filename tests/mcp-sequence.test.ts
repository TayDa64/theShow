/**
 * Guards long-film behaviour: hard cuts, and continuing a finished job.
 *
 * Each assertion here exists because the thing it covers was broken and failed
 * quietly rather than loudly:
 *
 *  - `fadeDuration: 0` used to take the xfade path, and a zero-length xfade
 *    collapsed a three-shot film to its first clip. 2.04s of film, no error.
 *  - continuing a film by re-calling render_sequence re-rendered and re-billed
 *    every earlier shot, and assembled only the new tail.
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const serverSource = readFileSync(path.join(__dirname, '..', 'mcp', 'server.ts'), 'utf8');
const mediaSource = readFileSync(path.join(__dirname, '..', 'mcp', 'media.ts'), 'utf8');

/** Source with comment lines removed, so a note explaining a bug is not read as the bug. */
function codeOnly(source: string) {
  return source
    .split('\n')
    .filter((line) => !line.trim().startsWith('//') && !line.trim().startsWith('*'))
    .join('\n');
}

describe('hard cuts', () => {
  it('defaults both render_sequence and assemble_film to a zero fade', () => {
    const renderSeq = serverSource.slice(serverSource.indexOf('"render_sequence"'));
    expect(renderSeq.slice(0, 2500)).toMatch(/fadeDuration:\s*z\.number\(\)[^\n]*\.default\(0\)/);

    const assemble = serverSource.slice(serverSource.indexOf('"assemble_film"'));
    expect(assemble.slice(0, 1200)).toMatch(/fadeDuration:\s*z\.number\(\)[^\n]*\.default\(0\)/);
  });

  it('takes a concat path for a zero fade instead of an xfade with duration 0', () => {
    const code = codeOnly(mediaSource);
    // The bug: a fade of 0 still went through xfade, which produces only the
    // first clip. The fix is a distinct branch, keyed off wantsFade.
    expect(code).toContain('const wantsFade = input.fadeDuration > 0;');
    expect(code).toContain('if (fade === 0)');
    expect(code).toContain('concat=n=${n}:v=1:a=0');
    expect(code).toContain('concat=n=${n}:v=0:a=1');
  });

  it('never builds an xfade with a zero duration', () => {
    const code = codeOnly(mediaSource);
    // The xfade line must sit inside the branch that only runs for a real fade.
    const xfadeIndex = code.indexOf('xfade=transition=fade:duration=${fade}');
    const elseIndex = code.indexOf('} else {', code.indexOf('if (fade === 0)'));
    expect(xfadeIndex).toBeGreaterThan(elseIndex);
  });
});

describe('continuing a film', () => {
  it('exposes resumeFromJobId on render_sequence', () => {
    const renderSeq = serverSource.slice(serverSource.indexOf('"render_sequence"'));
    expect(renderSeq.slice(0, 3000)).toContain('resumeFromJobId');
  });

  it('refuses a running job, because continuing it would render the film twice', () => {
    expect(serverSource).toContain('error: "That job is still running"');
    expect(serverSource).toContain('Continuing a running job renders it twice.');
  });

  it('refuses an unknown job id before anything is spent', () => {
    const handler = serverSource.slice(
      serverSource.indexOf('"render_sequence"'),
      serverSource.indexOf('"check_sequence"'),
    );
    const unknownIndex = handler.indexOf('error: "Unknown resumeFromJobId"');
    const confirmIndex = handler.indexOf('if (!args.confirm)');
    // Both must exist, and the id check must come first: a bad id should never
    // reach the estimate, let alone a render.
    expect(unknownIndex).toBeGreaterThan(-1);
    expect(unknownIndex).toBeLessThan(confirmIndex);
  });

  it('carries earlier shots into the job and chains from the last rendered frame', () => {
    const code = codeOnly(serverSource);
    expect(code).toContain('carriedShots: carried.length > 0 ? carried : undefined');
    expect(code).toContain('resumeFramePath');
    expect(code).toContain('carried.at(-1)?.framePath');
    // Carried shots must land in the assembly, or continuing a film produces a
    // film made only of its newest leg.
    expect(code).toContain('const carried = args.carriedShots ?? [];');
    expect(code).toContain('job.shots.push(...carried);');
  });

  it('counts the whole film, not just the new shots, in progress', () => {
    const code = codeOnly(serverSource);
    expect(code).toContain('shotCount: carried.length + shotCount');
    expect(code).toContain('const shotNumber = carried.length + i + 1;');
  });

  it('reports this run\u2019s spend separately from the film total', () => {
    const code = codeOnly(serverSource);
    expect(code).toContain('filmTotalUsd');
    expect(code).toContain('carriedOverUsd');
  });

  it('tells the model to continue rather than re-render', () => {
    expect(serverSource).toContain('resumeFromJobId set to this jobId');
  });
});

describe('the skill matches the tools', () => {
  const skill = readFileSync(
    path.join(__dirname, '..', 'skills', 'theshow', 'SKILL.md'),
    'utf8',
  );

  it('documents resumeFromJobId and the hard-cut default', () => {
    expect(skill).toContain('resumeFromJobId');
    expect(skill).toContain('hard cuts by default');
    expect(skill).toContain('| Continue a film | `resumeFromJobId` |');
  });

  it('no longer tells the model to restart a film to lengthen it', () => {
    expect(skill).not.toContain("Pass\nthe previous run's `lastFramePath` as `firstFrameUrl` to the next run");
  });
});
