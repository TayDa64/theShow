import { describe, expect, it } from 'vitest';
import { STUDIO_DEFAULT_CROSSFADE_SECONDS } from '../src/lib/ffmpegComposer';
import { assertBedCoversFilm, planClipAudioFilters } from '../mcp/media';

describe('ffmpeg composer', () => {
  it('uses the approved 0.25 second studio crossfade', () => {
    expect(STUDIO_DEFAULT_CROSSFADE_SECONDS).toBe(0.25);
  });

  it('pads kept audio to the video duration and still refuses a short bed', () => {
    const muted = planClipAudioFilters({
      durations: [4, 5],
      clipHasAudio: [true, true],
      clipAudio: 'mute',
    });
    expect(muted.join(' ')).not.toMatch(/\[\d+:a\]/);
    expect(muted.every((line) => line.startsWith('anullsrc='))).toBe(true);

    const replaced = planClipAudioFilters({
      durations: [4],
      clipHasAudio: [true],
      clipAudio: 'replace',
    });
    expect(replaced.join(' ')).not.toMatch(/\[\d+:a\]/);

    const kept = planClipAudioFilters({
      durations: [4],
      clipHasAudio: [true],
      clipAudio: 'keep',
    });
    expect(kept[0]).toMatch(/^\[0:a\]/);
    expect(kept[0]).toContain('apad=whole_dur=4');

    expect(() => assertBedCoversFilm(14, 71)).toThrow(/shorter than the film/i);
    expect(() => assertBedCoversFilm(undefined, 8)).toThrow(/shorter than the film/i);
    expect(() => assertBedCoversFilm(71, 71)).not.toThrow();
  });
});
