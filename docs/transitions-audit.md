# theShow: seamless-transitions audit

Verified on `origin/main` @ **76631a4b81c1664bf556bfcf4abb6a8e68399597** (Merge PR #25). `git fetch origin main` did not move the branch. No paid calls, no network generation. Bundles, `node_modules`, `dist`, `uploads`, and `package-lock.json` are excluded from the search. This file is the gate before feature code.

The planner audit in issue #28 is confirmed on the code paths below. Two measurements differ, and both are called out. The original Grok files named in that audit (`/workspace/theshow-ad/v2/raw/{shot1,shot2,film}.mp4`) are not on this machine, so those YDIF and container-tag numbers were not re-read. The same trim math and the same concat graph were re-run on synthetic clips.

## What the two composers do today

| Path | Entry | Composer | ffmpeg | Join today |
|---|---|---|---|---|
| Studio "Assemble Full Film" | `POST /api/assemble-film` (`server.ts:2213`) | `src/lib/ffmpegComposer.ts` `assembleFilm` | Always `@ffmpeg-installer` (`ffmpegComposer.ts:8`). This tree's binary is N-47683, libavformat **58.24.100**. It has `acrossfade` and no `xfade`. | A 0.5 s dissolve graph is built, fails, and is replaced by a silent hard-cut concat. Tails are pacing trims. |
| MCP `render_sequence` / `assemble_film` / `retry_shot` | `mcp/server.ts:3584`, `:2544`, `:4813` | `mcp/media.ts` `assembleClips` | System ffmpeg when it has `xfade`, else the installer (`media.ts:60-82`) | One global `fadeDuration` (default 0). Chained clips are not cut at the chain frame. Hard-cut audio and video are concatenated separately. |

## Reproduced evidence (offline)

Binary: `node_modules/@ffmpeg-installer/linux-x64/ffmpeg` (N-47683-g0e8eb07980-static).

```
... acrossfade        AA->A      Cross fade two input audio streams.
```

`xfade` is absent. System ffmpeg 6.1.1 has both `xfade` and `acrossfade`. A two-clip dissolve on the bundled binary exits 1 with:

```
[AVFilterGraph] No such filter: 'xfade'
Error initializing complex filters.
Invalid argument
```

`isUnsupportedTransitionFilterError` (`ffmpegComposer.ts:94-96`) matches both lines, so the second line also swallows an unrelated graph error.

Synthetic source (system ffmpeg, libx264 crf 18, 320x180, 24 fps): `nullsrc,geq=lum='16+mod(N*3\,220)'` plus 8.000 s AAC. Decoded `signalstats` YAVG matched `16+(N*3)%220` on all 193 frames (0 mismatches). Video duration 8.041667 s, `nb_frames=193`, audio duration 8.000000 s. A PNG round-trip of the same frame reads YAVG one unit low (frame 191 is 149 in the video and 148 in the PNG), so frame identity below is a pixel match (PSNR `inf`), not a PNG YAVG invert.

| Check | Result |
|---|---|
| Bundled and system `-sseof -0.1` on the 193-frame clip | Pixel-identical to source frame **191** (N-2). Same on all-intra and GOP-48 encodes. |
| Bundled and system `-sseof -0.15` | Pixel-identical to source frame **190** (N-3). |
| `-update 1` with no `-frames:v 1`, both binaries | Frame **192** (the true last frame). |
| Studio graph, bundled ffmpeg: clip A (0..192) trimmed `end=7.1` plus clip B (B[0] = A[191], 193 frames) trimmed `end=5.7`, concat | **308 frames, 12.833333 s video, 12.825000 s audio**, encoder tag `Lavf58.24.100`. Indices `0..170` then `191..`. One index jump at output frame 171 (170 → 191), 21 frames / 0.875 s dropped before the chain frame. Seam YDIF on this luma ramp is 63. That is not the planner's 33.99, which was measured on the missing Grok film. |
| MCP hard-cut graph, system ffmpeg: full A plus B that starts at 190, separate video concat and audio concat, `fps=24`, audio not padded to video | **386 frames**. Video 16.083333 s, audio 16.000000 s. Index jump at output frame 193: **192 → 190** (two frames past the chain frame, then a backward jump). |
| Same graph, three copies of A | Video **24.125000 s**, audio **24.000000 s**, **+41.67 ms per clip**. Matches the planner's 24.125 vs 24.000 and ~42 ms/clip. |

Diffs from the planner audit, and nothing else moved:

- Muxer tag on a file written by this installer binary is `Lavf58.24.100`. libavformat in `-version` is 58.24.100. libavutil is 56.24.101. The planner's real `film.mp4` tag `Lavf58.24.101` was not re-read (files absent). The build id N-47683 matches.
- `-sseof` still returns N-2 and N-3. A first YAVG read of the PNG looked like frame 44 because the PNG is 1 level darker and `16+(44*3)%220 = 148`. Pixel match against the source corrects that. Tests that recover N must decode the video, or allow ±0.5 on a PNG.

## Root causes (confirmed at these lines)

1. No join model. Studio sends trims only (`src/components/ExportView.tsx:1401-1413`). The manifest already has `usingContinuityFrame` / `continuitySource` (`src/utils/storyforge.ts:843-844`). `ChainedClip.bridgeFrameUrl` is unused (`src/types/pipeline.ts:17`). MCP records the chain (`mcp/server.ts:3489` `openingFramePath`, `:3570` `framePath`) and then assembles plain files with one global fade (`:3584-3601`, retry at `:4813-4831`).
2. Studio auto-trims the tail to a pacing estimate. `syncSceneTimeline` sets `trimEndSeconds` from `min(source, preferred)` when no trim is stored (`storyforge.ts:782-788`). `useFullSource ?? false` (`storyforge.ts:180`). The estimate, including a 0.6 s continuity buffer, is `storyforge.ts:697-729` (`:715`).
3. Studio pins the 2018 ffmpeg (`ffmpegComposer.ts:8`). The dissolve (`:41-53`, `FADE_DURATION = 0.5` at `:10`) always fails. The matcher (`:90-97`, broad clause `:96`) silently reruns concat (`:131-139`). The return (`:141-144`) and `FilmAssemblyJob` (`pipeline.ts:20-27`) carry no mode and no joins.
4. The extracted frame is not the last frame and is not indexed. Studio seeks `-sseof -0.1` (`ffmpegComposer.ts:152`). MCP seeks `-sseof -0.15` (`mcp/media.ts:181`). The reverse fallback (`media.ts:191`) is the true last frame, but the seek succeeds first, so it is not what production uses.
5. Studio does not conform (`ffmpegComposer.ts:37-38`). MCP hard-codes `fps=24` (`media.ts:460`) and scale-pads to the first clip (`:466-471`).
6. MCP hard cuts concat video and audio separately (`media.ts:488-489`). Clip audio is not trimmed or padded to the video length (`planClipAudioFilters` at `:357` uses the probed format duration). Measured drift is above.
7. Whole-second rounding on the assemble path: `server.ts:2245-2246` calls `normalizeMockVideoDuration` (`src/lib/mockVideoAsset.ts:22-28`), which `Math.round`s 8.0417 to 8. xfade offsets use 0.1 s timeline values (`ffmpegComposer.ts:42-44`, `roundTimelineValue` at `storyforge.ts:78-80`).
8. Tests lock the dissolve and the seek: `tests/ffmpeg-assembly.test.ts:9-20` and `:44-53`. Assembly is the fluent-ffmpeg mock (`tests/setup.ts:145`, exercised at `ffmpeg-assembly.test.ts:83-100`). No test decodes a frame.

`retry_shot` re-assembles with `settings.fadeDuration ?? 0` (`mcp/server.ts:4822`). The call starts at `:4813`, not `:4817`. Board-matched stills are counted at `mcp/server.ts:3872-3877` and are not passed to the composer. `getShotAnchorFrameUrl` is `server.ts:954-957`. `resolveContinuityReferenceForShot` is `server.ts:1041-1062`. `POST /api/extract-frame` is `server.ts:2173`. The extend path extracts a frame at `server.ts:1993-1997`. Timeline beats have no join indicator between them (`src/components/TimelineView.tsx:241-266`).

## Search hits

Every hit from the four commands, excluding bundles. Purpose is one line per hit.

### assembleFilm, graphs, FADE_DURATION, matcher, setFfmpegPath

| file:line | Purpose |
|---|---|
| `server.ts:10` | Studio server imports `assembleFilm` and `extractLastFrame`. |
| `server.ts:2267` | Assemble route calls `assembleFilm` after rounding trims. |
| `src/lib/ffmpegComposer.ts:8` | Pins the installer ffmpeg for every Studio command. |
| `src/lib/ffmpegComposer.ts:10` | Global 0.5 s fade, not per join. |
| `src/lib/ffmpegComposer.ts:26` | Dissolve graph builder. |
| `src/lib/ffmpegComposer.ts:44` | xfade offset from rounded playback seconds. |
| `src/lib/ffmpegComposer.ts:48` | Dissolve xfade on every join. |
| `src/lib/ffmpegComposer.ts:49` | acrossfade with no offset of its own. |
| `src/lib/ffmpegComposer.ts:67` | Silent hard-cut concat graph. |
| `src/lib/ffmpegComposer.ts:90` | Over-broad transition-error matcher. |
| `src/lib/ffmpegComposer.ts:102` | Assembly command takes the dissolve graph type. |
| `src/lib/ffmpegComposer.ts:123` | `assembleFilm` entry. |
| `src/lib/ffmpegComposer.ts:132` | First attempt is always the dissolve graph. |
| `src/lib/ffmpegComposer.ts:134` | Non-matching errors rethrow; matching errors fall through. |
| `src/lib/ffmpegComposer.ts:138` | Silent concat retry. |
| `tests/setup.ts:93` | Mock fluent-ffmpeg records `setFfmpegPath` and never runs a binary. |
| `tests/ffmpeg-assembly.test.ts:5` | Test imports the dissolve builder and `FADE_DURATION`. |
| `tests/ffmpeg-assembly.test.ts:10` | Three-clip dissolve fixture. |
| `tests/ffmpeg-assembly.test.ts:16` | Asserts the 0.5 s constant. |
| `tests/ffmpeg-assembly.test.ts:23` | Single-clip graph fixture. |
| `tests/ffmpeg-assembly.test.ts:34` | Trimmed dissolve fixture. |
| `tests/ffmpeg-assembly.test.ts:97` | Mocked assemble writes no real media. |

### MCP assembly, probes, fadeDuration

| file:line | Purpose |
|---|---|
| `mcp/media.ts:34` | Tool-path type includes `hasXfade`. |
| `mcp/media.ts:60` | Resolver: `FFMPEG_PATH`, then `/usr/bin/ffmpeg`, then `ffmpeg`, then the installer. |
| `mcp/media.ts:77` | Probes the chosen binary for `xfade`. |
| `mcp/media.ts:90` | `probeDuration` uses the resolver. |
| `mcp/media.ts:106` | Geometry probe uses the resolver. Width and height only. |
| `mcp/media.ts:124` | Audio-stream probe uses the resolver. |
| `mcp/media.ts:147` | First-frame extract uses the resolver. |
| `mcp/media.ts:171` | `extractLastFrame` entry. |
| `mcp/media.ts:176` | Last-frame extract uses the resolver. |
| `mcp/media.ts:228` | Tail correlation uses the resolver. |
| `mcp/media.ts:292` | Still correlation uses the resolver. |
| `mcp/media.ts:348` | `planClipAudioFilters`. Does not force audio length to the video. |
| `mcp/media.ts:363` | `assembleClips` entry. |
| `mcp/media.ts:365` | One fade duration for every join. |
| `mcp/media.ts:385` | Assembly reads `hasXfade` from the resolver. |
| `mcp/media.ts:404` | Single-clip stream copy. |
| `mcp/media.ts:418` | Fade is wanted only when `fadeDuration > 0`. |
| `mcp/media.ts:421` | Fade clamped to half the shortest clip. |
| `mcp/media.ts:424` | No fade and no xfade: try stream-copy concat. |
| `mcp/media.ts:440` | Stream-copy success returns `mode: "concat"`. |
| `mcp/media.ts:460` | Conform fps hard-coded to 24. |
| `mcp/media.ts:472` | Audio filters applied after the video conform. |
| `mcp/media.ts:548` | xfade result reports one `fadeSeconds`. |
| `mcp/media.ts:549` | Concat result reports `fadeSeconds: 0` and no per-join record. |
| `mcp/grokVideo.ts:19` | Grok helper imports the resolver. Out of scope for join logic. |
| `mcp/grokVideo.ts:175` | Grok helper runs ffmpeg through the resolver. |
| `mcp/cutout.ts:13` | Cutout imports the resolver. |
| `mcp/cutout.ts:27` | Cutout runs ffmpeg through the resolver. |
| `mcp/server.ts:28` | Tool server imports `assembleClips`. |
| `mcp/server.ts:31` | Tool server imports `extractLastFrame`. |
| `mcp/server.ts:2288` | `extract_last_frame` calls `extractLastFrame`. |
| `mcp/server.ts:2517` | `assemble_film` schema: `fadeDuration` default 0. |
| `mcp/server.ts:2544` | `assemble_film` calls `assembleClips`. |
| `mcp/server.ts:2546` | Passes the global fade through. |
| `mcp/server.ts:2722` | Job settings store one `fadeDuration`. |
| `mcp/server.ts:3347` | `render_sequence` args store one `fadeDuration`. |
| `mcp/server.ts:3544` | After each shot, extract a frame (N-3 today). |
| `mcp/server.ts:3589` | Sequence assembly calls `assembleClips` with full files. |
| `mcp/server.ts:3591` | Sequence assembly passes the global fade. |
| `mcp/server.ts:3731` | `render_sequence` schema: `fadeDuration` default 0. |
| `mcp/server.ts:3959` | Quote text echoes `fadeDuration`. |
| `mcp/server.ts:4065` | Persisted sequence settings copy `fadeDuration`. |
| `mcp/server.ts:4149` | Another settings copy of `fadeDuration`. |
| `mcp/server.ts:4822` | `retry_shot` re-assembles with `settings.fadeDuration ?? 0`. |
| `tests/ffmpeg-assembly.test.ts:6` | Studio test imports `planClipAudioFilters`. |
| `tests/ffmpeg-assembly.test.ts:49` | Asserts the mocked `-sseof -0.1` seek. |
| `tests/ffmpeg-assembly.test.ts:56` | Mute audio plan. |
| `tests/ffmpeg-assembly.test.ts:64` | Replace audio plan. |
| `tests/ffmpeg-assembly.test.ts:71` | Keep audio plan. |
| `tests/fixtures/mcp-tool-input-schemas.json:1470` | Pinned `assemble_film.fadeDuration` schema. |
| `tests/fixtures/mcp-tool-input-schemas.json:2151` | Pinned `render_sequence.fadeDuration` schema. |
| `tests/e2e-bundles.test.ts:29` | Bundle test imports `resolveTools`. |
| `tests/e2e-bundles.test.ts:543` | Bundle assemble fixture uses `fadeDuration: 0`. |
| `tests/e2e-bundles.test.ts:564` | Bundle test resolves ffmpeg. |
| `tests/admission.test.ts:18` | Admission test imports `resolveTools`. |
| `tests/admission.test.ts:321` | Admission test resolves ffmpeg. |
| `tests/phase1-tools.test.ts:13` | Imports `resolveTools`. |
| `tests/phase1-tools.test.ts:336` | Fixture `fadeDuration: 0`. |
| `tests/phase1-tools.test.ts:400` | Fixture `fadeDuration: 0`. |
| `tests/phase1-tools.test.ts:468` | Fixture `fadeDuration: 0`. |
| `tests/phase1-tools.test.ts:519` | Fixture `fadeDuration: 0`. |
| `tests/phase1-tools.test.ts:575` | Fixture `fadeDuration: 0`. |
| `tests/phase1-tools.test.ts:608` | Fixture `fadeDuration: 0`. |
| `tests/phase1-tools.test.ts:685` | Resolves ffmpeg. |
| `tests/phase1-tools.test.ts:702` | Fixture `fadeDuration: 0`. |
| `tests/phase1-tools.test.ts:755` | Fixture `fadeDuration: 0`. |
| `tests/phase1-tools.test.ts:800` | Fixture `fadeDuration: 0`. |
| `tests/phase1-tools.test.ts:852` | Fixture `fadeDuration: 0`. |
| `tests/phase1-recovery.test.ts:41` | Fixture `fadeDuration: 0`. |
| `tests/phase2-tools.test.ts:146` | Fixture `fadeDuration: 0`. |
| `tests/phase2-tools.test.ts:264` | Fixture `fadeDuration: 0`. |
| `tests/phase2-tools.test.ts:296` | Fixture `fadeDuration: 0`. |
| `tests/phase2-tools.test.ts:488` | Fixture `fadeDuration: 0`. |
| `tests/phase2-recovery.test.ts:68` | Fixture `fadeDuration: 0`. |
| `tests/phase2-transport.test.ts:49` | Fixture `fadeDuration: 0`. |
| `tests/phase3-recovery.test.ts:44` | Fixture `fadeDuration: 0`. |
| `tests/mcp-sequence.test.ts:7` | Comment: fade 0 must not take the xfade path. |
| `tests/mcp-sequence.test.ts:49` | Locks `render_sequence` fade default 0. |
| `tests/mcp-sequence.test.ts:52` | Locks `assemble_film` fade default 0. |
| `tests/mcp-sequence.test.ts:59` | Locks `wantsFade = fadeDuration > 0`. |
| `tests/mcp-sequence.test.ts:231` | Locks retry `fadeDuration ?? 0`. |

### Trims and whole-second duration

| file:line | Purpose |
|---|---|
| `server.ts:75` | Imports `normalizeMockVideoDuration`. |
| `server.ts:930` | Render path rounds a requested duration. |
| `server.ts:1859` | Shot render rounds duration. |
| `server.ts:2024` | Another render path rounds duration. |
| `server.ts:2148` | Extend path rounds duration. |
| `server.ts:2245` | Assemble path rounds clip duration to a whole second. |
| `server.ts:2246` | Assemble path rounds source duration the same way. |
| `server.ts:2248` | Assemble clamps `trimStartSeconds`. |
| `server.ts:2252` | Assemble clamps `trimEndSeconds`. |
| `server.ts:2259` | Stores the rounded source duration. |
| `server.ts:2260` | Stores the clamped trim start. |
| `server.ts:2261` | Stores the clamped trim end. |
| `server.ts:2262` | Playback length is the rounded trim delta. |
| `src/types/pipeline.ts:13` | `ChainedClip.sourceDurationSeconds`. |
| `src/types/pipeline.ts:14` | `ChainedClip.trimStartSeconds`. |
| `src/types/pipeline.ts:15` | `ChainedClip.trimEndSeconds`. |
| `src/types/pipeline.ts:16` | `ChainedClip.playbackDurationSeconds`. |
| `src/types.ts:205` | Timeline `useFullSource`. |
| `src/types.ts:208` | Timeline `sourceDurationSeconds`. |
| `src/types.ts:209` | Timeline `trimStartSeconds`. |
| `src/types.ts:210` | Timeline `trimEndSeconds`. |
| `src/types.ts:211` | Timeline `playbackDurationSeconds`. |
| `src/lib/mockVideoAsset.ts:22` | `Math.round` duration clamp used by the assemble route. |
| `src/lib/mockVideoAsset.ts:73` | Mock-video cache key uses the rounded duration. |
| `src/lib/ffmpegComposer.ts:12` | Playback window. `\|\|` treats a trim of 0 as unset. |
| `src/lib/ffmpegComposer.ts:13` | Source duration falls back through 8. |
| `src/lib/ffmpegComposer.ts:14` | Trim start. |
| `src/lib/ffmpegComposer.ts:15` | Trim end. |
| `src/lib/ffmpegComposer.ts:16` | Trim end clamped to the source. |
| `src/lib/ffmpegComposer.ts:17` | Playback seconds. |
| `src/lib/ffmpegComposer.ts:20` | Returned trim start. |
| `src/lib/ffmpegComposer.ts:21` | Returned trim end. |
| `src/lib/ffmpegComposer.ts:22` | Returned playback seconds. |
| `src/lib/ffmpegComposer.ts:26` | Dissolve builder signature includes the trim fields. |
| `src/lib/ffmpegComposer.ts:37` | Video trim, no fps or scale. |
| `src/lib/ffmpegComposer.ts:38` | Audio trim. Assumes an audio stream. |
| `src/lib/ffmpegComposer.ts:44` | Offset adds playback seconds. |
| `src/lib/ffmpegComposer.ts:67` | Concat builder signature. |
| `src/lib/ffmpegComposer.ts:76` | Concat video trim. |
| `src/lib/ffmpegComposer.ts:77` | Concat audio trim. |
| `src/utils/storyforge.ts:162` | Normalizer context source duration. |
| `src/utils/storyforge.ts:165` | Clamps source duration. |
| `src/utils/storyforge.ts:166` | Reads source duration. |
| `src/utils/storyforge.ts:170` | Clamps trim start. |
| `src/utils/storyforge.ts:171` | Reads trim start. |
| `src/utils/storyforge.ts:173` | Trim-start upper bound. |
| `src/utils/storyforge.ts:175` | Clamps trim end. |
| `src/utils/storyforge.ts:176` | Reads trim end. |
| `src/utils/storyforge.ts:177` | Trim-end lower bound. |
| `src/utils/storyforge.ts:178` | Trim-end upper bound. |
| `src/utils/storyforge.ts:180` | `useFullSource` defaults false. |
| `src/utils/storyforge.ts:181` | Playback is full source or the trim delta. |
| `src/utils/storyforge.ts:182` | Full-source playback branch. |
| `src/utils/storyforge.ts:183` | Trimmed playback rounded to 0.1 s. |
| `src/utils/storyforge.ts:193` | Stored `useFullSource`. |
| `src/utils/storyforge.ts:198` | Stored source duration. |
| `src/utils/storyforge.ts:199` | Stored trim start, rounded. |
| `src/utils/storyforge.ts:200` | Stored trim end, rounded. |
| `src/utils/storyforge.ts:201` | Stored playback. |
| `src/utils/storyforge.ts:512` | Shot normalizer copies source duration. |
| `src/utils/storyforge.ts:746` | Sync rounds the source duration. |
| `src/utils/storyforge.ts:754` | Recommended playback is capped by the source. |
| `src/utils/storyforge.ts:771` | Passes source duration into the clip normalizer. |
| `src/utils/storyforge.ts:777` | Sync clamps trim start. |
| `src/utils/storyforge.ts:778` | Full source forces trim start 0. |
| `src/utils/storyforge.ts:780` | Trim-start upper bound. |
| `src/utils/storyforge.ts:782` | Sync chooses trim end. |
| `src/utils/storyforge.ts:783` | Full source uses the whole source as trim end. |
| `src/utils/storyforge.ts:785` | Missing trim end becomes `min(source, preferred pacing)`. |
| `src/utils/storyforge.ts:786` | Trim-end lower bound. |
| `src/utils/storyforge.ts:787` | Trim-end upper bound. |
| `src/utils/storyforge.ts:789` | Sync playback length. |
| `src/utils/storyforge.ts:790` | Full-source playback. |
| `src/utils/storyforge.ts:791` | Trimmed playback rounded to 0.1 s. |
| `src/utils/storyforge.ts:798` | Dirty when the estimate exceeds the source. |
| `src/utils/storyforge.ts:799` | Dirty-reason text. |
| `src/utils/storyforge.ts:806` | Stored trim start. |
| `src/utils/storyforge.ts:807` | Stored trim end. |
| `src/utils/storyforge.ts:808` | Stored playback. |
| `src/utils/storyforge.ts:809` | Stored source duration. |
| `src/utils/storyforge.ts:861` | Manifest duration sums playback seconds. |
| `src/components/ExportView.tsx:1408` | Assemble body sends playback as `durationSeconds`. |
| `src/components/ExportView.tsx:1409` | Assemble body sends source duration. |
| `src/components/ExportView.tsx:1410` | Assemble body sends trim start. |
| `src/components/ExportView.tsx:1411` | Assemble body sends trim end. No join fields. |
| `src/components/TimelineView.tsx:83` | Trim slider max. |
| `src/components/TimelineView.tsx:253` | Beat width tracks playback. |
| `src/components/TimelineView.tsx:263` | Beat label shows playback. |
| `src/components/TimelineView.tsx:297` | Current-beat playback readout. |
| `src/components/TimelineView.tsx:304` | Trim-window readout. |
| `src/components/TimelineView.tsx:475` | "Use full clip" toggles `useFullSource`. |
| `src/components/TimelineView.tsx:476` | Full clip sets trim start 0. |
| `src/components/TimelineView.tsx:477` | Full clip sets trim end to the source. |
| `src/components/TimelineView.tsx:480` | Toggle label branch. |
| `src/components/TimelineView.tsx:485` | Toggle label text. |
| `src/components/TimelineView.tsx:502` | Duration edit writes `trimEndSeconds`. |
| `src/components/TimelineView.tsx:516` | Trim sliders hidden when using the full source. |
| `src/components/TimelineView.tsx:527` | Trim-start slider value. |
| `src/components/TimelineView.tsx:531` | Trim-start slider writes `trimStartSeconds`. |
| `src/components/TimelineView.tsx:532` | Trim-start slider also moves trim end. |
| `src/components/TimelineView.tsx:543` | Trim-end slider min. |
| `src/components/TimelineView.tsx:546` | Trim-end slider value. |
| `src/components/TimelineView.tsx:550` | Trim-end slider writes `trimEndSeconds`. |

### Continuity, chain frames, board frames

| file:line | Purpose |
|---|---|
| `server.ts:1046` | Custom-frame continuity branch. |
| `server.ts:1055` | Previous-shot continuity uses the previous shot's anchor asset. |
| `server.ts:1152` | New shots after the first default to `previous-shot`. |
| `server.ts:1434` | Render draft type has `continuitySource`. |
| `server.ts:1557` | Reads `transitionInMode` while building a render. |
| `server.ts:1561` | Chooses `bridgeFrame` and does not record an index. |
| `server.ts:1571` | Pin flag follows the bridge frame. |
| `server.ts:1593` | Drops the bridge URL from reference images. |
| `server.ts:1602` | Stores the bridge URL on the draft. |
| `server.ts:1611` | Start frame is the bridge when pinned. |
| `server.ts:1695` | Persists the pinned URL. |
| `server.ts:1708` | `firstFrameUrl` is the bridge URL. |
| `server.ts:1710` | Stores a continuity label, not a frame index. |
| `server.ts:1760` | Generated clip gets `usingContinuityFrame`. |
| `server.ts:1761` | Generated clip gets `continuitySource`. |
| `server.ts:1842` | Another clip record of the boolean. |
| `server.ts:1843` | Another clip record of the label. |
| `server.ts:1888` | Sandbox clip record of the boolean. |
| `server.ts:1889` | Sandbox clip record of the label. |
| `server.ts:1993` | Extend path allocates a frame file. |
| `server.ts:1995` | Extend path calls Studio `extractLastFrame` (N-2). |
| `server.ts:1997` | Returns that path. |
| `server.ts:2042` | Extend resolves a bridge frame. |
| `server.ts:2050` | Extend sends it as `firstFrameUrl`. |
| `server.ts:2052` | Extend continuity label. |
| `server.ts:2083` | Extend clip boolean. |
| `server.ts:2084` | Extend clip label. |
| `server.ts:2108` | Extend fallback boolean. |
| `server.ts:2138` | Another extend boolean. |
| `server.ts:2165` | Extend error path boolean. |
| `src/types/pipeline.ts:17` | `bridgeFrameUrl` is on the request type and unused by the composer. |
| `src/types.ts:155` | Generated clip `continuitySource`. |
| `src/types.ts:156` | Generated clip `usingContinuityFrame`. |
| `src/types.ts:191` | Shot `transitionInMode`. |
| `src/types.ts:230` | Manifest `continuitySource`. |
| `src/types.ts:231` | Manifest `usingContinuityFrame`. |
| `src/utils/storyforge.ts:121` | Clip normalizer copies `transitionInMode`. |
| `src/utils/storyforge.ts:146` | Copies `continuitySource`. |
| `src/utils/storyforge.ts:147` | Copies `usingContinuityFrame`. |
| `src/utils/storyforge.ts:357` | Seeded shots after the first use `previous-shot`. |
| `src/utils/storyforge.ts:406` | Transition mode default. |
| `src/utils/storyforge.ts:408` | Transition mode normalizer. |
| `src/utils/storyforge.ts:580` | Previous-shot priming check. |
| `src/utils/storyforge.ts:622` | Clears previous-shot when the anchor goes away. |
| `src/utils/storyforge.ts:623` | Clears the custom asset in that branch. |
| `src/utils/storyforge.ts:628` | Keeps an explicit custom bridge. |
| `src/utils/storyforge.ts:632` | Otherwise primes `previous-shot`. |
| `src/utils/storyforge.ts:667` | A `none` transition is primed forward. |
| `src/utils/storyforge.ts:668` | Writes `previous-shot`. |
| `src/utils/storyforge.ts:715` | Continuity buffer inside the pacing estimate. |
| `src/utils/storyforge.ts:843` | Manifest copies `continuitySource`. |
| `src/utils/storyforge.ts:844` | Manifest copies `usingContinuityFrame`. |
| `src/components/ExportView.tsx:155` | Local job type boolean. |
| `src/components/ExportView.tsx:156` | Local job type label. |
| `src/components/ExportView.tsx:225` | Custom-frame label helper. |
| `src/components/ExportView.tsx:236` | Previous-shot label helper. |
| `src/components/ExportView.tsx:548` | Anchor save reads the boolean. |
| `src/components/ExportView.tsx:549` | Anchor save reads the label. |
| `src/components/ExportView.tsx:558` | Anchor result type boolean. |
| `src/components/ExportView.tsx:559` | Anchor result type label. |
| `src/components/ExportView.tsx:574` | Auto-saves the anchor via `/api/extract-frame`. |
| `src/components/ExportView.tsx:600` | Primes the next shot to `previous-shot` after the anchor save. |
| `src/components/ExportView.tsx:659` | Stores the boolean on the generated clip. |
| `src/components/ExportView.tsx:660` | Stores the label on the generated clip. |
| `src/components/ExportView.tsx:963` | Poll result boolean. |
| `src/components/ExportView.tsx:964` | Poll result label. |
| `src/components/ExportView.tsx:996` | Another poll label. |
| `src/components/ExportView.tsx:997` | Another poll boolean. |
| `src/components/ExportView.tsx:1018` | Another poll boolean. |
| `src/components/ExportView.tsx:1019` | Another poll label. |
| `src/components/ExportView.tsx:1178` | Reset clears the boolean. |
| `src/components/ExportView.tsx:1179` | Reset clears the label. |
| `src/components/ExportView.tsx:1259` | Render body sends `transitionInMode`. |
| `src/components/ExportView.tsx:1332` | Local render copy of `transitionInMode`. |
| `src/components/ExportView.tsx:1334` | Local render copy of the boolean. |
| `src/components/ExportView.tsx:1335` | Local render copy of the label. |
| `src/components/ExportView.tsx:1789` | Storyboard card shows the bridge mode. |
| `src/components/ExportView.tsx:1895` | Shot detail shows the bridge mode. |
| `src/components/ExportView.tsx:1905` | Shows the continuity boolean. |
| `src/components/ExportView.tsx:1907` | Shows the continuity label. |
| `src/components/ScenesView.tsx:127` | Custom-frame helper. |
| `src/components/ScenesView.tsx:131` | Previous-shot helper. |
| `src/components/ScenesView.tsx:485` | Upload can set `custom-frame`. |
| `src/components/ScenesView.tsx:1030` | Badge class for previous-shot. |
| `src/components/ScenesView.tsx:1031` | Badge text "bridge chained" / "bridge free". |
| `src/components/ScenesView.tsx:1216` | Transition select value. |
| `src/components/ScenesView.tsx:1218` | Transition select writes `transitionInMode`. |
| `src/components/ScenesView.tsx:1229` | Transition hint. |
| `src/components/ScenesView.tsx:1232` | Custom-frame controls. |
| `src/components/ScenesView.tsx:1258` | Previous-shot controls. |
| `src/components/ScenesView.tsx:1275` | Custom asset controls. |
| `mcp/server.ts:625` | Storyboard note mentions `lastFrameUrl`. |
| `mcp/server.ts:1759` | Shot input type `lastFrameUrl`. |
| `mcp/server.ts:1790` | Closing frame is sent only when pin is both. |
| `mcp/server.ts:1823` | Another `lastFrameUrl` field. |
| `mcp/server.ts:1873` | `generate_controlled_clip` schema `lastFrameUrl`. |
| `mcp/server.ts:1881` | Schema text for pin both. |
| `mcp/server.ts:1988` | Closing-frame sent flag. |
| `mcp/server.ts:2277` | `extract_last_frame` description. |
| `mcp/server.ts:2293` | Tool returns `framePath` only. No index or pts. |
| `mcp/server.ts:2299` | Tells the caller to pass `framePath` as `firstFrameUrl`. |
| `mcp/server.ts:2493` | Still tool mentions frame URL fields. |
| `mcp/server.ts:2684` | Job shot `framePath`. |
| `mcp/server.ts:2690` | Job shot `lastFrameUrl`. |
| `mcp/server.ts:2703` | Job shot `openingFramePath`. A later shot is chained when this equals the previous `framePath`. |
| `mcp/server.ts:3334` | Sequence shot input `lastFrameUrl`. |
| `mcp/server.ts:3387` | Next opening frame is the previous extracted frame. |
| `mcp/server.ts:3424` | Passes `lastFrameUrl` into the render. |
| `mcp/server.ts:3457` | Retry when the closing frame was refused. |
| `mcp/server.ts:3488` | Shot entry starts with an empty `framePath`. |
| `mcp/server.ts:3489` | Records `openingFramePath`. |
| `mcp/server.ts:3491` | Records `lastFrameUrl`. |
| `mcp/server.ts:3492` | Records `lastFramePath`. |
| `mcp/server.ts:3529` | Local path of the pinned close. |
| `mcp/server.ts:3557` | Admission failure clears `framePath`. |
| `mcp/server.ts:3570` | Stores the extracted frame path. |
| `mcp/server.ts:3581` | Trailing shots keep the previous `framePath`. |
| `mcp/server.ts:3644` | `render_sequence` schema `lastFrameUrl`. |
| `mcp/server.ts:3724` | Schema text for pin both. |
| `mcp/server.ts:3815` | Resume frame is the carried shot's `framePath`. |
| `mcp/server.ts:3837` | Quote lists `lastFrameUrl`s. |
| `mcp/server.ts:3857` | Resume warning compares opening frame to `framePath`. |
| `mcp/server.ts:3868` | Counts shots that have `lastFrameUrl`. |
| `mcp/server.ts:3874` | Board-match: `lastFrameUrl === next.firstFrameUrl`. |
| `mcp/server.ts:4213` | `board_film` text about frame URLs. |
| `mcp/server.ts:4831` | Retry resumes from the previous `framePath`. |
| `mcp/server.ts:4981` | Review reads `openingFramePath`. |
| `mcp/server.ts:5002` | Review uses `framePath` as the last frame. |
| `mcp/server.ts:5146` | Shot schema `framePath`. |
| `mcp/server.ts:5170` | Review payload `framePath`. |
| `mcp/server.ts:5188` | Continuity payload `framePath`. |
| `mcp/server.ts:5189` | Continuity payload `firstFramePath`. |
| `mcp/server.ts:5192` | Whether both frames were recorded. |
| `mcp/server.ts:5596` | Feed skips a shot with no opening frame on disk. |
| `mcp/server.ts:5615` | Feed cites `openingFramePath` when the file exists. |
| `mcp/server.ts:5616` | Returns that path. |
| `mcp/storyboard.ts:88` | Board shot type `lastFrameUrl`. |
| `mcp/storyboard.ts:638` | Board assigns `lastFrameUrl`. |
| `mcp/storyboard.ts:687` | Board reads `lastFrameUrl`. |
| `mcp/crossFilm.ts:56` | Cross-film schema `openingFramePath`. |
| `mcp/grokVideo.ts:37` | Render job `lastFrameUrl`. |
| `mcp/grokVideo.ts:43` | Comment on bookend behaviour. |
| `mcp/grokVideo.ts:424` | Whether to send the closing frame. |
| `mcp/grokVideo.ts:425` | Bookend pair when both frames exist. |
| `mcp/grokVideo.ts:429` | Builds the bookend pair. |
| `mcp/grokVideo.ts:434` | Closing frame only. |
| `mcp/grokVideo.ts:435` | Sends `last_frame`. |
| `mcp/continuityReview.ts:403` | Review frame path from `lastFramePath`. |
| `mcp/continuity.ts:681` | Continuity helper frame-path list. |
| `mcp/repairPlan.ts:20` | Repair shot `framePath`. |
| `mcp/repairPlan.ts:117` | Repair already treats equal frame paths as one boundary. Assembly does not. |
| `mcp/repairPlan.ts:122` | Repair artifact is the previous `framePath`. |
