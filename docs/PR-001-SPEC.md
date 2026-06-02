# PR-001: World-Class Film Pipeline
# 8-Second Clip Chain, FFmpeg Assembly & Veo API Maximization

**Branch:** `feat/film-pipeline` | **Base:** `main` | **Status:** Draft
**Labels:** `enhancement` `critical` `architecture`
**Milestone:** v1.0  Ship a Real Movie

---

## Problem Statement

The repo generates individual 8-second Veo clips but never assembles them
into a film. Three Veo 3.1 API capabilities that solve continuity are unused:
`first_frame` (exact bridge), `video_to_extend` (scene extension), and
Gemini cinematic prompt generation. The LiveLink + 3D export UI is fully
simulated. Four bugs break core functionality.

**The 8-second limit is solved by a serial `video_to_extend` waterfall:**

```
Beat (e.g. 30s scene)
  Clip A (8s, anchor)    last frame F1
  Clip B (8s, extend A)   last frame F2
  Clip C (8s, extend B)   last frame F3
  [~11-12 clips for 90s]

Scene boundary  2s AI transition clip (first_frame=F3, last_frame=F4)

All clips  FFmpeg xfade cascade  single 1080p H.264/AAC MP4
```

---

## New Dependencies (add to package.json)

```json
"fluent-ffmpeg": "^2.1.3",
"@ffmpeg-installer/ffmpeg": "^1.1.0",
"express-rate-limit": "^7.5.0",
"uuid": "^11.1.0"
```

DevDependencies:
```json
"vitest": "^2.1.9",
"supertest": "^7.0.0",
"@types/supertest": "^6.0.2",
"@vitest/coverage-v8": "^2.1.9",
"eslint": "^9.5.0",
"@typescript-eslint/eslint-plugin": "^8.0.0",
"@typescript-eslint/parser": "^8.0.0"
```

Fix `package.json` name: `"react-example"`  `"the-show"`

---

## New Files (create verbatim)

### `src/lib/geminiDirector.ts`  Cinematic Prompt Engine
Calls Gemini 2.0 Flash with a cinematographer system prompt.
Input: character, scene, camera, dialogue data.
Output: `{ veoPrompt, audioDirection, colorGrade }` JSON.
Fallback: construct basic prompt from raw fields if Gemini fails.

### `src/lib/veoChain.ts`  8-Second Clip Chain Engine
- `buildClipChain(config: ChainConfig): Promise>ChainedClip[]>`
- - `numberOfClips = Math.ceil(targetDurationSeconds / 8)`
  - - Clip 0: POST `/api/generate-shot-video` (anchor with first_frame)
    - - Clips 1..N: POST `/api/extend-clip` in SERIAL waterfall (await each)
      - - After each clip: POST `/api/extract-frame` for last-frame PNG
        - - `pollUntilComplete(operationName, maxRetries=150)`  5-min ceiling
          - - **NOTE: Do NOT refactor waterfall to Promise.all  extend requires source clip to be fully generated.**
           
            - ### `src/lib/ffmpegComposer.ts`  Server-Side Assembly
            - - `FADE_DURATION = 0.5` (500ms crossfade)
              - - `assembleFilm(clips, outputPath, options)`: validates paths, builds
                -   cascaded xfade filter graph, audio crossfade chain, outputs 1080p H.264
                -   - Offset formula: `sum of (duration - FADE_DURATION)` for all prior clips
                    - - Example (3x 8s clips): xfade offsets = 7.5s, 15.0s
                      - - `extractLastFrame(clipPath, outputPngPath)`: runs
                        -   `ffmpeg -sseof -0.1 -i clip.mp4 -frames:v 1 -q:v 2 out.png`
                       
                        -   ### `src/lib/storageManager.ts`  Durable File Storage
                        -   - MIME validation: only `image/png`, `image/jpeg`, `image/webp`
                            - - UUID filenames, date-partitioned dirs (`uploads/YYYY/MM/DD/`)
                              - - `cleanupTempClips()`: deletes `.mp4` files older than 1 hour
                               
                                - ### `src/types/pipeline.ts`  Pipeline Types
                                - ```typescript
                                  type PipelineStatus = 'idle'|'prompting'|'generating'|'extending'|
                                    'transitioning'|'assembling'|'complete'|'error';
                                  interface ChainedClip { operationName, localPath, duration,
                                    lastFramePath, clipIndex, extensionOf }
                                  interface FilmAssemblyJob { id, sceneIds, shots, outputPath,
                                    status, progress, errorMessage, startedAt, completedAt }
                                  ```

                                  ### `tsconfig.server.json`
                                  ```json
                                  {
                                    "compilerOptions": {
                                      "target": "ES2022", "module": "NodeNext",
                                      "moduleResolution": "NodeNext", "strict": true,
                                      "esModuleInterop": true, "resolveJsonModule": true
                                    },
                                    "include": ["server.ts", "src/lib/**/*.ts", "src/types/**/*.ts"],
                                    "exclude": ["node_modules", "dist", "src/components", "tests"]
                                  }
                                  ```

                                  ### `tests/setup.ts`  Vitest global mocks (fluent-ffmpeg, @google/genai)
                                  ### `tests/rate-limit.smoke.test.ts`  HTTP 429 after 11th req
                                  ### `tests/ffmpeg-assembly.test.ts`  xfade graph + extractLastFrame
                                  ### `tests/veo-chain.test.ts`  serial waterfall, pollUntilComplete
                                  ### `tests/storage-manager.test.ts`  MIME validation
                                  ### `.github/workflows/ci.yml`  8-job CI pipeline (see CI companion doc)

                                  ---

                                  ## Modified Files

                                  ### `server.ts`  Five new routes + security

                                  **Rate limiter (add before routes):**
                                  ```typescript
                                  const videoGenLimiter = rateLimit({
                                    windowMs: 60 * 1000, max: 10,
                                    message: { error: 'Too many generation requests. Please wait.' }
                                  });
                                  app.use('/api/generate-shot-video', videoGenLimiter);
                                  app.use('/api/generate-video', videoGenLimiter);
                                  app.use('/api/extend-clip', videoGenLimiter);
                                  ```

                                  **Multer MIME validation:**
                                  ```typescript
                                  const fileFilter = (req, file, cb) => {
                                    const allowed = ['image/png','image/jpeg','image/webp'];
                                    allowed.includes(file.mimetype) ? cb(null,true)
                                      : cb(new Error('Invalid file type'));
                                  };
                                  const upload = multer({ storage, fileFilter,
                                    limits: { fileSize: 10 * 1024 * 1024 } });
                                  ```

                                  **New routes to add:**
                                  - `POST /api/generate-shot-prompt`  Gemini 2.0 Flash cinematic prompt
                                  - - `POST /api/extend-clip`  download source  Gemini Files API upload
                                    -    wait ACTIVE  veo-3.1-generate-preview with video_to_extend
                                    -    - `POST /api/extract-frame`  FFmpeg server-side last-frame extraction
                                         - - `POST /api/assemble-film`  download all clips  assembleFilm()  MP4
                                           - - `GET /api/download-film/:filmId`  stream assembled MP4
                                            
                                             - ### `src/App.tsx`  Three targeted changes
                                            
                                             - **BUG-02 fix  timestamp-based cloud sync merge:**
                                             - ```typescript
                                               // Only apply cloud state if newer than local
                                               const cloudTs = data.updatedAt ? new Date(data.updatedAt).getTime() : 0;
                                               const localTs = +(localStorage.getItem('sf_updatedAt') ?? 0);
                                               if (cloudTs >= localTs) { /* apply cloud state */ }
                                               // On each save debounce:
                                               localStorage.setItem('sf_updatedAt', new Date().toISOString());
                                               ```

                                               **BUG-06 fix  render isCloudLoading in header:**
                                               Replace always-green LIVELINK badge with reactive SYNCING.../SYNCED
                                               indicator. Pulse amber while `isCloudLoading`, static green when done.

                                               ### `src/components/ExportView.tsx`  Six targeted fixes

                                               **BUG-01  Polling timeout:**
                                               ```typescript
                                               async function pollUntilComplete(
                                                 operationName: string,
                                                 onProgress?: (attempt: number) => void,
                                                 maxRetries = 150 // 5 minute ceiling
                                               ): Promise>string> {
                                                 return new Promise((resolve, reject) => {
                                                   let attempts = 0;
                                                   const id = setInterval(async () => {
                                                     if (++attempts > maxRetries) {
                                                       clearInterval(id);
                                                       reject(new Error(`Render timed out after 5 minutes`));
                                                       return;
                                                     }
                                                     // ... poll /api/video-status
                                                   }, 2000);
                                                 });
                                               }
                                               ```
                                               Add cancelRenderRef = useRef(false) and Cancel Render button.

                                               **BUG-03 fix  bridge frame via first_frame (not reference_images):**
                                               WHEN `transitionInMode === 'previous-shot'`:
                                               - BEFORE: `referenceImages.push(bridgeFrameBase64)`  WRONG
                                               - - AFTER: `{ firstFrame: bridgeFrameBase64, referenceImages: [charRef1, charRef2, bgRef] }`
                                                 - Update `/api/generate-shot-video` route to pass firstFrame as
                                                 - `GenerateVideosConfig.first_frame`, referenceImages as `reference_images`.
                                                
                                                 - **BUG-04 fix  halt queue on shot failure:**
                                                 - ```typescript
                                                   if (!success) {
                                                     setRenderLog(prev => [...prev,
                                                       `Shot ${index+1} failed. Halting to preserve continuity.`,
                                                       `Re-render from shot ${index+1} after fixing the issue.`
                                                     ]);
                                                     break;
                                                   }
                                                   ```

                                                   **Remove LiveLink simulation:**
                                                   Delete: handleTriggerSync, isSocketConnecting useEffect, hardcoded
                                                   logPool array, engine target selector, FBX/glTF/USD dropdowns, LOD slider.
                                                   Replace with: honest Video Export panel (resolution, transition style,
                                                   burn subtitles checkbox, Assemble Full Film button, Download Film link).

                                                   **Add handleAssembleFullFilm:**
                                                   - Collect operationName from all complete shots across all scenes
                                                   - - POST `/api/assemble-film` with jobId + clips array
                                                     - - Set filmDownloadUrl on success  render Download Film anchor
                                                      
                                                       - **BUG-03b  server-side frame extraction:**
                                                       - Remove captureVideoFrameBlob() entirely.
                                                       - Replace all calls with:
                                                       - ```typescript
                                                         async function extractAnchorFrame(operationName: string) {
                                                           const res = await fetch('/api/extract-frame', {
                                                             method: 'POST',
                                                             headers: { 'Content-Type': 'application/json' },
                                                             body: JSON.stringify({ operationName })
                                                           });
                                                           return (await res.json()).frameBase64 ?? null;
                                                         }
                                                         ```

                                                         ---

                                                         ## Bug Summary

                                                         | ID | File | Severity | Fix |
                                                         |----|------|----------|-----|
                                                         | BUG-01 | ExportView.tsx | Critical | Add maxRetries=150 + Cancel button to polling loop |
                                                         | BUG-02 | App.tsx | Critical | Timestamp-based cloud sync merge |
                                                         | BUG-03 | ExportView.tsx | Critical | first_frame not reference_images for bridge + server-side extraction |
                                                         | BUG-04 | ExportView.tsx | Critical | Halt render queue on shot failure |
                                                         | BUG-05 | package.json | Minor | name: react-example  the-show |
                                                         | BUG-06 | App.tsx | Medium | Render isCloudLoading state in header badge |

                                                         ---

                                                         ## Security Fixes

                                                         | Fix | Detail |
                                                         |-----|--------|
                                                         | Multer MIME validation | Reject non image/png/jpeg/webp uploads with HTTP 400 |
                                                         | Rate limiting | 10 req/min/IP on all generation endpoints, HTTP 429 on breach |
                                                         | Path traversal guard | Validate upload filenames against `../` segments |
                                                         | API key bundle check | CI fails if GEMINI_API_KEY found in dist/assets/ |

                                                         ---

                                                         ## Implementation Order

                                                         1. package.json (deps + name fix)
                                                         2. 2. tsconfig.server.json
                                                            3. 3. src/types/pipeline.ts
                                                               4. 4. src/lib/storageManager.ts
                                                                  5. 5. src/lib/ffmpegComposer.ts
                                                                     6. 6. src/lib/geminiDirector.ts
                                                                        7. 7. src/lib/veoChain.ts
                                                                           8. 8. server.ts (5 new routes + security)
                                                                              9. 9. src/components/ExportView.tsx (6 fixes)
                                                                                 10. 10. src/App.tsx (3 changes)
                                                                                     11. 11. tests/setup.ts
                                                                                         12. 12. tests/rate-limit.smoke.test.ts
                                                                                             13. 13. tests/ffmpeg-assembly.test.ts
                                                                                                 14. 14. tests/veo-chain.test.ts
                                                                                                     15. 15. tests/storage-manager.test.ts
                                                                                                         16. 16. CHANGELOG.md
                                                                                                             17. 17. .github/workflows/ci.yml
                                                                                                                
                                                                                                                 18. ---
                                                                                                                
                                                                                                                 19. ## Acceptance Criteria
                                                                                                                
                                                                                                                 20. - [ ] `npm run typecheck` passes with zero errors (client + server)
                                                                                                                     - [ ] - [ ] `npm run test`  all 5 test suites green
                                                                                                                     - [ ] - [ ] `npm run build`  dist/assets/ contains no GEMINI_API_KEY string
                                                                                                                     - [ ] - [ ] POST /api/extend-clip with a valid operationName returns a new operationName
                                                                                                                     - [ ] - [ ] POST /api/assemble-film with 3 clips returns a downloadable MP4 URL
                                                                                                                     - [ ] - [ ] POST /api/generate-shot-video with a bridge frame uses first_frame (not reference_images[0])
                                                                                                                     - [ ] - [ ] 11th request to /api/generate-shot-video returns HTTP 429
                                                                                                                     - [ ] - [ ] Upload of a .exe file to /api/upload-reference returns HTTP 400
                                                                                                                     - [ ] - [ ] ExportView renders no LiveLink badge, no FBX/USD/glTF dropdowns
                                                                                                                     - [ ] - [ ] 'Assemble Full Film' button collects all complete shots and calls /api/assemble-film
                                                                                                                     - [ ] - [ ] All 8 GitHub Actions CI jobs pass green on this branch
                                                                                                                    
                                                                                                                     - [ ] ---
                                                                                                                    
                                                                                                                     - [ ] ## Companion Documents
                                                                                                                    
                                                                                                                     - [ ] - Full server route code, complete test files, CHANGELOG.md content,
                                                                                                                     - [ ]   and .github/workflows/ci.yml YAML are specified in:
                                                                                                                     - [ ]     **docs/PR-001-CI-COMPANION.md** (to be committed next)
                                                                                                                    
                                                                                                                     - [ ] - The PR-001 and PR-001-CI Word documents are available via
                                                                                                                     - [ ]   the project's Copilot conversation for reference.
                                                                                                                    
                                                                                                                     - [ ]   ---
                                                                                                                    
                                                                                                                     - [ ]   *Last updated: 2026-06-02 by Copilot + TayDa64*
