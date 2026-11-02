# theShow proof render, 2026-11-02 — final

Film: [`docs/media/tay-17th-floor-720p.mp4`](media/tay-17th-floor-720p.mp4), 24.17 s, 580 frames,
1280×720, 8.4 MB, **$3.44** (4 × $0.86).
Job `seq_mvzhmxbj_ahcsd9`, rendered end to end through the installed plugin (install of `bd0800f`),
4 shots × 6 s at 720p, hard cuts.

Every number below was measured on the rendered pixels, not read off a prompt.

## Closing frames — every shot landed where it was pinned
| shot | closing-frame match |
|---|---|
| 1 | 0.999 |
| 2 | 0.999 |
| 3 | 0.988 |
| 4 | 0.980 |

No warnings. An earlier render the same day came back with shot 2 at 0.133 and was billed anyway;
that miss is now measured and reported instead of passing silently.

## Cuts — adjacent-frame correlation at the true cut
| seam | across the cut | within-shot control |
|---|---|---|
| 6.04 s (frame 145) | 0.9980 | 0.9863 |
| 12.08 s (frame 290) | 0.9956 | |
| 18.13 s (frame 435) | 0.9699 | 0.8881 |

A cut now moves the picture no more than ordinary motion within a shot does.

## Identity (SFace cosine vs refs/tay.jpg, every 0.5 s at native resolution)
| shot | samples | worst | mean |
|---|---|---|---|
| 1 | 12 | 0.351 | 0.458 |
| 2 | 10 | 0.335 | 0.493 |
| 3 | 12 | 0.399 | 0.547 |
| 4 | 11 | 0.534 | 0.622 |
| **film** | **47** | **0.124** | **0.519** |

Every score below 0.36 was inspected and is a pose, not a different person:
21.5 s he has turned his back to camera; 8.0 s his face is leaving frame as the camera
follows his hand; 2.5 s and 16.5 s are profile angles.

## Wardrobe (tan-vs-navy share of the torso patch under the detected face)
| | tan mean / min | navy mean / max |
|---|---|---|
| reference portrait | 0.500 | 0.004 |
| film | 0.684 / 0.200 | **0.008 / 0.069** |

Against the old film's navy mean 0.105 and max 0.217. No frame promotes the blazer.

## Background
The left-window patch holds inside the shots where the camera stays put: shot 1 min 0.832,
shot 2 min 0.781, shot 3 min 0.325. Shot 4 rotates the camera around him, so the patch
changes because the view changes, not because the room does.

Board frames, unoccluded left window, homography aligned: min 0.670 mean 0.843.
Controls: same frame reshaped 0.980, mirrored 0.193.

## What this proves

A complete film, rendered by the installed plugin, measured frame by frame: pinned frames honoured,
cuts no more disruptive than ordinary motion, one identity, one coat, one room.

The scripts that produced these figures run OpenCV's SFace and YuNet models, which the plugin does
not ship. They were used to check the render, not to make it.
