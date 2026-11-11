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
const videoSource = readFileSync(path.join(__dirname, '..', 'mcp', 'grokVideo.ts'), 'utf8');

/** Source with comment lines removed, so a note explaining a bug is not read as the bug. */
function codeOnly(source: string) {
  return source
    .split('\n')
    .filter((line) => !line.trim().startsWith('//') && !line.trim().startsWith('*'))
    .join('\n');
}

describe('paid renders are kept', () => {
  it('downloads clips into the durable media folder, not the system temp dir', () => {
    const code = codeOnly(serverSource);
    // A rendered clip is the only artefact here that cannot be regenerated for
    // free. Downloads used to land in a tmpdir, which a reboot clears while the
    // job record still pointed there, so a finished film could silently lose
    // its footage and retry_shot would have nothing to re-assemble from.
    const downloadDir = code.match(/const DOWNLOAD_DIR = ([^;]+);/);
    expect(downloadDir).not.toBeNull();
    expect(downloadDir?.[1]).not.toMatch(/tmpdir\(/);
    expect(downloadDir?.[1]).toContain('OUTPUT_DIR');
  });

  it('does not import the temp-dir helper it no longer needs', () => {
    expect(codeOnly(serverSource)).not.toMatch(/from "node:os"/);
  });
});

describe('hard cuts', () => {
  it('defaults both render_sequence and assemble_film to a zero fade', () => {
    const renderSeq = serverSource.slice(serverSource.indexOf('"render_sequence"'));
    expect(renderSeq.slice(0, 7000)).toMatch(/fadeDuration:\s*z\.number\(\)[^\n]*\.default\(0\)/);

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
    expect(renderSeq.slice(0, 7000)).toContain('resumeFromJobId');
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
    expect(skill).toContain('Joins default to hard cuts');
    expect(skill).toContain('| Continue a film | `resumeFromJobId` |');
  });

  it('no longer tells the model to restart a film to lengthen it', () => {
    expect(skill).not.toContain("Pass\nthe previous run's `lastFramePath` as `firstFrameUrl` to the next run");
  });
});

describe('the continuity block', () => {
  it('is built from configure_film answers and omits blanks', () => {
    const code = codeOnly(serverSource);
    expect(code).toContain('function buildContinuityBlock');
    expect(code).toContain('continuityBlock: buildContinuityBlock(v)');
    // Blank form fields must not turn into invented prose.
    expect(code).toContain('if (characters) parts.push');
    expect(code).toContain('if (never) parts.push');
  });

  it('is prepended to every shot prompt, not just the first', () => {
    const code = codeOnly(serverSource);
    expect(code).toContain('function composeShotPrompt');
    // The call must sit inside the per-shot loop, keyed off the job args.
    expect(code).toContain('const prompt = composeShotPrompt(args.continuity, shot.prompt)');
    // The face anchor is added per shot and passed through, never dropped
    // between the compose step and the request.
    expect(code).toContain('prompt: anchored,');
  });

  it('reaches the runner from render_sequence', () => {
    const renderSeq = serverSource.slice(serverSource.indexOf('"render_sequence"'));
    expect(renderSeq.slice(0, 5000)).toContain('continuity: z.string().optional()');
    expect(codeOnly(serverSource)).toContain('continuity: args.continuity');
  });
});

describe('the music bed', () => {
  const media = codeOnly(mediaSource);

  it('refuses a bed that is shorter than the film instead of looping it', () => {
    // Looping a 30-second cue under a three-minute film repeats the phrase.
    // The bed has to be written to length; a short file stops assembly.
    expect(media).toContain('assertBedCoversFilm');
    expect(media).not.toContain('-stream_loop');
  });

  it('trims the bed to the film and fades it out rather than cutting mid-note', () => {
    expect(media).toContain('atrim=0:${totalDuration.toFixed(3)}');
    expect(media).toContain('afade=t=out');
  });

  it('mixes under the clips instead of replacing their audio', () => {
    expect(media).toContain('amix=inputs=2:duration=first');
    expect(media).toContain('[aout][bed]');
  });

  it('keeps the film length authoritative', () => {
    // duration=first: a long bed must not stretch the picture.
    expect(media).toContain('duration=first');
  });

  it('is optional on both assembly tools and resolved before any render', () => {
    const assemble = serverSource.slice(serverSource.indexOf('"assemble_film"'));
    expect(assemble.slice(0, 2000)).toContain('audioTrackUrl');
    const renderSeq = serverSource.slice(serverSource.indexOf('"render_sequence"'));
    expect(renderSeq.slice(0, 5000)).toContain('audioTrackUrl');
    // In render_sequence the path resolves on the confirm path, ahead of the job.
    expect(codeOnly(serverSource)).toContain('audioTrackFile: args.audioTrackUrl ? await resolveToLocalFile');
  });
});

describe('retry_shot', () => {
  const tool = serverSource.slice(
    serverSource.indexOf('"retry_shot"'),
    serverSource.indexOf('"check_sequence"'),
  );
  const code = codeOnly(serverSource);

  it('re-renders one shot and reuses everything else', () => {
    expect(tool).toContain('shotIndex');
    // Before is carried, after is reused verbatim. Neither is rendered again.
    expect(code).toContain('carriedShots: before.length > 0 ? before : undefined');
    expect(code).toContain('trailingShots: after.length > 0 ? after : undefined');
  });

  it('defaults to re-rendering the original prompt on a bad roll', () => {
    expect(tool).toContain('const prompt = args.prompt ?? target.prompt;');
  });

  it('chains the replacement from the shot before it, like the original', () => {
    expect(code).toContain('resumeFramePath: before.at(-1)?.framePath ?? original.startFramePath');
  });

  it('re-assembles with the original film\u2019s settings, not new defaults', () => {
    expect(code).toContain('resolution: settings?.resolution ?? "720p"');
    expect(code).toContain('fadeDuration: settings?.fadeDuration ?? 0');
    expect(code).toContain('audioTrackFile: settings?.audioTrackFile');
  });

  it('warns that later shots are now on the wrong frame', () => {
    // The one thing a repair must never do is imply the film is unchanged.
    expect(code).toContain('still begin');
    expect(code).toContain('job.warnings!.push');
    expect(tool).toContain('caveat');
  });

  it('says nothing downstream depends on the last shot', () => {
    expect(tool).toContain('This is the last shot, so nothing downstream depends on it.');
  });

  it('refuses a running film, an unknown job, and an out-of-range shot', () => {
    expect(tool).toContain('That film is still rendering');
    expect(tool).toContain('Unknown jobId');
    expect(tool).toContain('No shot ${index} in that film');
  });

  it('reports money wasted on the replaced shot', () => {
    expect(code).toContain('filmSpentIncludingReplacedUsd');
  });
});

describe('the skill names every tool that exists', () => {
  it('covers every registered tool, including the stills-first pair', () => {
    const skill = readFileSync(
      path.join(__dirname, '..', 'skills', 'theshow', 'SKILL.md'),
      'utf8',
    );
    const registered = [...serverSource.matchAll(/^\s{2}"([a-z_]+)",$/gm)].map((m) => m[1]);
    // 11 before bookending and stills-first boarding: generate_still and
    // board_film are the two additions.
    expect(registered.length).toBe(13);
    for (const name of registered) {
      expect(skill, `${name} is registered but the skill never mentions it`).toContain(name);
    }
  });
});

describe('continuing a film after the cast changed', () => {
  it('warns when a resumed shot does not start on the frame the old film ends on', () => {
    // A film survives a restart and can be extended from a later session. The
    // shots it joins to were paid for earlier and cannot be checked by eye, so
    // a continuation that opens on a re-boarded frame silently grafts a new
    // cast onto the old film. Measured on the real film: the old last frame
    // scored 0.248 against the re-boarded opening frame, an unpinned join.
    const code = codeOnly(serverSource);
    expect(code).toContain('const continuationStartFrame');
    expect(code).toContain('resumeWarnings');
    expect(code).toMatch(/firstFrameUrl identical to the old film's last frame/);
  });

  it('honours an explicit first frame over chaining when resuming', () => {
    // The check has to test the frame that will actually be used, otherwise a
    // shot that pins a new first frame passes a check on a frame it ignores.
    const code = codeOnly(serverSource);
    expect(code).toMatch(/args\.shots\[0\]\?\.firstFrameUrl \?\? resumeFramePath/);
  });

  it('surfaces the warning on the estimate, before anything is spent', () => {
    const code = codeOnly(serverSource);
    expect(code).toContain('...(resumeWarnings.length > 0 ? { warnings: resumeWarnings } : {})');
  });
});

describe('the face anchor', () => {
  it('only rides along when the shot puts a person in frame', () => {
    const code = codeOnly(serverSource);
    // A shot with no person in it must not be given a face to invent.
    expect(code).toContain('mentionsPerson(prompt)');
    expect(code).toContain('Keep the face exactly as the first frame shows it.');
    // "his" was measured as no better and assumes a man.
    expect(code).not.toContain('Hold his face as the first frame shows it.');
  });
});

describe('a transient render failure is not a stopped film', () => {
  /**
   * Measured: with both ends pinned ("bookend"), the render proxy answers
   * "Video generation failed due to an internal error. Please try again." and
   * then succeeds on the next identical request - three tries on one picture
   * returned failed, completed, failed, while the same still rendered
   * first-frame-only every time. Before this, the first such blip stopped a
   * four-shot chain at shot one and spent nothing, which is safe but useless.
   */
  const code = codeOnly(serverSource);

  it('retries only when the API says the failure was its own', () => {
    expect(code).toContain('result.status === "failed" && result.retryable');
    expect(code).toContain('retries < 3');
  });

  it('degrades to a cut rather than stopping the film', () => {
    // Measured failure rate with a closing frame pinned: 1 in 4 rendered. Four
    // refusals in a row is rare but real, and a stopped chain means the rest of
    // the film is never made.
    expect(code).toContain('rendered without its closing frame');
    expect(code).toContain('job.warnings = [...(job.warnings ?? []), ...degradations]');
  });

  it('classifies internal_error as worth another try', () => {
    const video = codeOnly(videoSource);
    expect(video).toContain('function isTransientRenderFailure');
    expect(video).toContain('internal[_ ]error');
    expect(video).toContain('retryable: isTransientRenderFailure(poll)');
  });
});

describe('a closing frame that is accepted and then ignored', () => {
  /**
   * Measured on the 2026-11-02 four-shot proof film: shot 2 came back
   * `completed`, was billed in full, and ended 0.13 away from the board frame it
   * was pinned to, while the shots either side landed at 0.97 and 0.93. The poll
   * response never mentions it. A silent miss chains the next shot from the
   * wrong picture and reads later as the cast having changed, so the render
   * measures the clip's real last frame and says so when it disagrees.
   */
  it('measures the clip against the frame it was pinned to', () => {
    const code = codeOnly(serverSource);
    expect(mediaSource).toMatch(/export async function closingFrameAgreement/);
    expect(code).toContain('await closingFrameAgreement({ clip: clipPath, frame: pinnedClose })');
  });

  it('reports a missed close instead of passing it through as a good shot', () => {
    const code = codeOnly(serverSource);
    expect(code).toContain('if (agreement < CLOSING_FRAME_MATCH_THRESHOLD)');
    expect(code).toMatch(/degradations\.push\(/);
  });

  it('keeps the threshold that separated the real film', () => {
    // 0.13 and 0.18 were misses, 0.93 and 0.97 were hits on the proof film.
    expect(mediaSource).toMatch(/CLOSING_FRAME_MATCH_THRESHOLD = 0\.6\b/);
  });

  it('does not check a shot that was never given a closing frame', () => {
    const code = codeOnly(serverSource);
    const block = code.slice(code.indexOf('const pinnedClose = localImagePath'));
    expect(block.slice(0, 200)).toContain('if (pinnedClose) {');
  });

  it('never fails a rendered film because the comparison could not be taken', () => {
    expect(mediaSource).toMatch(/catch \{\s*\n\s*\/\/ A measurement that cannot be taken must not fail a film/);
  });
});

describe('the last-frame fallback keeps the LAST frame', () => {
  it('does not fall back to frame zero', () => {
    // The fallback used to select `n\,0`, so a clip whose tail would not seek
    // handed the next shot its first frame to chain from.
    expect(mediaSource).not.toContain('select=eq(n\\\\,0)');
    expect(mediaSource).toContain('"-vf", "reverse"');
  });
});

describe('shot contract validation before a render', () => {
  it('refuses to start render_sequence when contracts fail, unless overrideValidation is set', () => {
    const handler = serverSource.slice(
      serverSource.indexOf('"render_sequence"'),
      serverSource.indexOf('"check_sequence"'),
    );
    expect(handler).toContain('overrideValidation');
    expect(handler).toContain('gateRenderSequence');
    expect(handler).toContain('RENDER_BLOCKED_BY_CONTRACT');
    const gateIndex = handler.indexOf('gateRenderSequence');
    const jobIndex = handler.indexOf('const job: SequenceJob');
    expect(gateIndex).toBeGreaterThan(-1);
    expect(gateIndex).toBeLessThan(jobIndex);
  });
});
