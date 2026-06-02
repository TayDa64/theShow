import React, { useEffect, useMemo, useState } from 'react';
import { Download, RefreshCw, Layers, Copy, Check, Terminal, Film, AlertTriangle, Wand2, Clapperboard } from 'lucide-react';
import type { ExportSettings, Character, Scene, CameraConfig, StoryboardSeedStrategy, StoryboardTransitionMode } from '../types';
import { createRenderSeed, getSceneDisplayBackground, getSceneStoryboardFrameAsset, getShotDialogueExcerpt, normalizeStoryboardShot, primeNextStoryboardShotContinuity, sanitizeStoryboardSeed, upsertSceneStoryboardFrameAsset } from '../utils/storyforge';

interface SubtitleCue {
  startRatio: number;
  endRatio: number;
  speaker: string;
  text: string;
  sentiment: string;
}

function buildEqualSplitSubtitleCues(scene: Scene, characters: Character[]): SubtitleCue[] {
  const dialogues = scene.dialogues || [];
  if (!dialogues.length) return [];

  return dialogues.map((dialogue, index) => ({
    startRatio: index / dialogues.length,
    endRatio: (index + 1) / dialogues.length,
    speaker: characters.find(character => character.id === dialogue.characterId)?.name || 'Unknown Actor',
    text: dialogue.text,
    sentiment: dialogue.sentiment,
  }));
}

function buildStoryboardAwareSubtitleCues(scene: Scene | undefined, characters: Character[]): SubtitleCue[] {
  if (!scene?.dialogues?.length) return [];

  const shots = scene.storyboardShots || [];
  if (!shots.length) {
    return buildEqualSplitSubtitleCues(scene, characters);
  }

  const timelineEntries: Array<{ weight: number; cue?: Omit<SubtitleCue, 'startRatio' | 'endRatio'> }> = [];
  const assignedDialogueIds = new Set<string>();

  for (const shot of shots) {
    const shotDuration = Math.max(shot.durationSeconds || 8, 1);
    const shotDialogueIds = Array.isArray(shot.dialogueLineIds) ? shot.dialogueLineIds : [];
    const shotDialogues = scene.dialogues.filter(dialogue => shotDialogueIds.includes(dialogue.id));

    shotDialogues.forEach(dialogue => assignedDialogueIds.add(dialogue.id));

    if (!shotDialogues.length) {
      timelineEntries.push({ weight: shotDuration });
      continue;
    }

    const weightPerDialogue = shotDuration / shotDialogues.length;
    for (const dialogue of shotDialogues) {
      timelineEntries.push({
        weight: weightPerDialogue,
        cue: {
          speaker: characters.find(character => character.id === dialogue.characterId)?.name || 'Unknown Actor',
          text: dialogue.text,
          sentiment: dialogue.sentiment,
        },
      });
    }
  }

  const assignedCueEntries = timelineEntries.filter(entry => !!entry.cue);
  if (!assignedCueEntries.length) {
    return buildEqualSplitSubtitleCues(scene, characters);
  }

  const fallbackWeight = assignedCueEntries.reduce((sum, entry) => sum + entry.weight, 0) / assignedCueEntries.length;
  const unassignedDialogues = scene.dialogues.filter(dialogue => !assignedDialogueIds.has(dialogue.id));

  for (const dialogue of unassignedDialogues) {
    timelineEntries.push({
      weight: fallbackWeight || 1,
      cue: {
        speaker: characters.find(character => character.id === dialogue.characterId)?.name || 'Unknown Actor',
        text: dialogue.text,
        sentiment: dialogue.sentiment,
      },
    });
  }

  const totalWeight = timelineEntries.reduce((sum, entry) => sum + entry.weight, 0) || 1;
  let elapsedWeight = 0;

  return timelineEntries.flatMap((entry) => {
    const startRatio = elapsedWeight / totalWeight;
    elapsedWeight += entry.weight;
    const endRatio = elapsedWeight / totalWeight;

    if (!entry.cue) {
      return [];
    }

    return [{
      ...entry.cue,
      startRatio,
      endRatio,
    }];
  });
}

interface ExportViewProps {
  settings: ExportSettings;
  onUpdateSettings: (set: ExportSettings) => void;
  onUpdateScenes: (scenes: Scene[]) => void;
  characters: Character[];
  scenes: Scene[];
  camera: CameraConfig;
}

type QuickRenderStatus = 'idle' | 'rendering' | 'completed' | 'failed';
type RenderMode = 'quick-preview' | 'storyboard';
type StoryboardRunStatus = 'idle' | 'rendering' | 'completed' | 'failed';
type StoryboardRetryMode = 'configured' | 'same' | 'new';
type StoryboardSeedSource = 'auto' | 'lock' | 'inherit-previous' | 'retry-same' | 'retry-new';

type StoryboardSceneShot = NonNullable<Scene['storyboardShots']>[number];

interface StoryboardJob {
  shotId: string;
  title: string;
  status: 'idle' | 'starting' | 'rendering' | 'completed' | 'failed';
  operationName?: string | null;
  error?: string | null;
  usingReferenceImages?: boolean;
  durationSeconds?: number;
  isQuotaExhausted?: boolean;
  seedStrategy?: StoryboardSeedStrategy;
  resolvedSeed?: number | null;
  seedSource?: StoryboardSeedSource | null;
  inheritedFromShotId?: string | null;
  inheritedFromSeed?: number | null;
  usingContinuityFrame?: boolean;
  continuitySource?: string | null;
}

interface PersistAnchorFrameResult {
  updatedScene: Scene;
  message: string;
  usedSandboxFallback: boolean;
  primedBridge: boolean;
  primedSeed: boolean;
}

interface StoryboardRenderResult {
  updatedScene: Scene;
  success: boolean;
  anchorSaved: boolean;
  anchorError: string | null;
}

function formatSeedStrategyLabel(strategy: StoryboardSeedStrategy | undefined) {
  switch (strategy) {
    case 'lock':
      return 'Locked seed';
    case 'inherit-previous':
      return 'Inherit previous';
    default:
      return 'Auto seed';
  }
}

function formatTransitionModeLabel(mode: StoryboardTransitionMode | undefined) {
  switch (mode) {
    case 'previous-shot':
      return 'Previous-shot bridge';
    case 'custom-frame':
      return 'Custom bridge frame';
    default:
      return 'No bridge frame';
  }
}

function getShotAnchorFrame(scene: Scene, shot: StoryboardSceneShot | undefined) {
  if (!shot) return undefined;
  return getSceneStoryboardFrameAsset(scene, shot.boardImageId);
}

function resolveContinuityBridge(scene: Scene, shot: StoryboardSceneShot | undefined, shotIndex: number) {
  if (!shot) {
    return {
      asset: undefined,
      sourceLabel: 'No bridge frame',
      summary: 'Continuity bridge metadata will appear once the storyboard shot is available.',
    };
  }

  if (shot.transitionInMode === 'custom-frame') {
    const asset = getSceneStoryboardFrameAsset(scene, shot.transitionInAssetId);
    return {
      asset,
      sourceLabel: asset ? `Custom: ${asset.label}` : 'Custom bridge pending',
      summary: asset
        ? `One Veo reference slot will be reserved for the custom bridge frame “${asset.label}” before character/background refs.`
        : 'Custom bridge mode is enabled, but no continuity frame has been selected yet.',
    };
  }

  if (shot.transitionInMode === 'previous-shot') {
    const previousShot = shotIndex > 0 ? scene.storyboardShots?.[shotIndex - 1] : undefined;
    const asset = previousShot ? getShotAnchorFrame(scene, previousShot) : undefined;
    return {
      asset,
      sourceLabel: previousShot
        ? (asset ? `Shot ${shotIndex} anchor` : `Shot ${shotIndex} anchor missing`)
        : 'Opening shot',
      summary: previousShot
        ? (asset
            ? `One Veo reference slot will be reserved for Shot ${shotIndex}'s anchor frame “${asset.label}”.`
            : `This shot is configured to use Shot ${shotIndex}'s anchor frame, but that prior shot does not have one yet.`)
        : 'Opening shots do not have a previous-shot bridge, so all reference slots remain available to the current beat.',
    };
  }

  return {
    asset: undefined,
    sourceLabel: 'No bridge frame',
    summary: 'No continuity bridge frame is reserved, so the full reference budget stays available for character/background continuity.',
  };
}

function formatSeedSourceLabel(source: StoryboardSeedSource | null | undefined) {
  switch (source) {
    case 'lock':
      return 'locked';
    case 'inherit-previous':
      return 'inherited';
    case 'retry-same':
      return 'retry / same';
    case 'retry-new':
      return 'retry / new';
    default:
      return 'auto';
  }
}

function resolveStoryboardShotSeed(
  shot: StoryboardSceneShot,
  previousShot: StoryboardSceneShot | undefined,
  mode: StoryboardRetryMode = 'configured',
) {
  const lockedSeed = sanitizeStoryboardSeed(shot.lockedSeed);
  const lastRenderSeed = sanitizeStoryboardSeed(shot.lastRenderSeed);
  const previousSeed = sanitizeStoryboardSeed(previousShot?.lastRenderSeed);

  if (mode === 'same') {
    return {
      resolvedSeed: lastRenderSeed || lockedSeed || previousSeed || createRenderSeed(),
      seedSource: 'retry-same' as const,
      inheritedFromShotId: previousSeed ? previousShot?.id || null : null,
      inheritedFromSeed: previousSeed,
    };
  }

  if (mode === 'new') {
    return {
      resolvedSeed: createRenderSeed(),
      seedSource: 'retry-new' as const,
      inheritedFromShotId: null,
      inheritedFromSeed: null,
    };
  }

  if (shot.seedStrategy === 'lock' && lockedSeed) {
    return {
      resolvedSeed: lockedSeed,
      seedSource: 'lock' as const,
      inheritedFromShotId: null,
      inheritedFromSeed: null,
    };
  }

  if (shot.seedStrategy === 'inherit-previous' && previousSeed) {
    return {
      resolvedSeed: previousSeed,
      seedSource: 'inherit-previous' as const,
      inheritedFromShotId: previousShot?.id || null,
      inheritedFromSeed: previousSeed,
    };
  }

  return {
    resolvedSeed: createRenderSeed(),
    seedSource: 'auto' as const,
    inheritedFromShotId: null,
    inheritedFromSeed: null,
  };
}

function describeSeedLineage(
  shot: StoryboardSceneShot,
  shotIndex: number,
  job: StoryboardJob,
  previousShot: StoryboardSceneShot | undefined,
) {
  if (job.seedSource === 'retry-same' && job.resolvedSeed) {
    return `Retried with the last applied seed ${job.resolvedSeed.toLocaleString()}.`;
  }

  if (job.seedSource === 'retry-new' && job.resolvedSeed) {
    return `Retried with a fresh exploratory seed ${job.resolvedSeed.toLocaleString()}.`;
  }

  if (job.seedSource === 'inherit-previous') {
    if (job.inheritedFromSeed) {
      return `Inherited Shot ${shotIndex}'s render seed ${job.inheritedFromSeed.toLocaleString()} for continuity carry-over.`;
    }

    return `Will inherit the previous shot seed once Shot ${shotIndex} has rendered.`;
  }

  if (job.seedSource === 'lock') {
    return job.resolvedSeed
      ? `Pinned to locked seed ${job.resolvedSeed.toLocaleString()} for reproducible rerenders.`
      : 'Locked seed mode is active, but no valid locked seed has been stored yet.';
  }

  if (job.resolvedSeed) {
    return `Auto mode resolved seed ${job.resolvedSeed.toLocaleString()} for this render pass.`;
  }

  if (shot.seedStrategy === 'inherit-previous' && !previousShot?.lastRenderSeed) {
    return shotIndex === 0
      ? 'Opening shot has no previous seed yet, so the first render will fall back to auto.'
      : `Shot ${shotIndex + 1} is waiting on Shot ${shotIndex}'s first completed render before it can inherit continuity.`;
  }

  return 'Seed lineage will appear here after the render request is resolved.';
}

export function ExportView({ settings, onUpdateSettings, onUpdateScenes, characters, scenes, camera }: ExportViewProps) {
  const [copied, setCopied] = useState(false);
  const [syncLogs, setSyncLogs] = useState<string[]>([
    'System: Sync server listening on post-socket port 5020...',
    'Idle: Waiting for Game Engine handshake...'
  ]);
  const [isSocketConnecting, setIsSocketConnecting] = useState(false);
  const [renderMode, setRenderMode] = useState<RenderMode>('quick-preview');

  const [selectedSceneId, setSelectedSceneId] = useState<string>(scenes[0]?.id || '');
  const selectedScene = useMemo(
    () => scenes.find(scene => scene.id === selectedSceneId) || scenes[0],
    [scenes, selectedSceneId],
  );

  const [videoStatus, setVideoStatus] = useState<QuickRenderStatus>('idle');
  const [operationName, setOperationName] = useState<string | null>(null);
  const [renderProgress, setRenderProgress] = useState(0);
  const [renderMessage, setRenderMessage] = useState('');
  const [videoError, setVideoError] = useState<string | null>(null);
  const [isQuotaExhausted, setIsQuotaExhausted] = useState(false);
  const [activeSubtitle, setActiveSubtitle] = useState<{ speaker: string; text: string; sentiment: string } | null>(null);

  const [isGeneratingStoryboardPlan, setIsGeneratingStoryboardPlan] = useState(false);
  const [storyboardRunStatus, setStoryboardRunStatus] = useState<StoryboardRunStatus>('idle');
  const [storyboardProgressText, setStoryboardProgressText] = useState('');
  const [storyboardJobs, setStoryboardJobs] = useState<StoryboardJob[]>([]);
  const [savingAnchorShotId, setSavingAnchorShotId] = useState<string | null>(null);

  useEffect(() => {
    if (scenes.length > 0 && !scenes.some(scene => scene.id === selectedSceneId)) {
      setSelectedSceneId(scenes[0].id);
    }
  }, [scenes, selectedSceneId]);

  useEffect(() => {
    setVideoStatus('idle');
    setOperationName(null);
    setRenderProgress(0);
    setRenderMessage('');
    setVideoError(null);
    setIsQuotaExhausted(false);
    setActiveSubtitle(null);
    setStoryboardRunStatus('idle');
    setStoryboardProgressText('');
    setStoryboardJobs([]);
  }, [selectedSceneId]);

  useEffect(() => {
    if (!isSocketConnecting) return;

    let idx = 0;
    const logPool = [
      'Engine handshake: Detected Unreal Engine 5.4.2 endpoint...',
      'Auth payload: Key verified for workspace character continuity',
      `Push event: Character [${characters[0]?.name || 'subject'}] data synced successfully`,
      'Config event: Viewport aspect ratio matches grid camera sequence...',
      'LiveLink Pipeline state matches: Connected, listening for asset alterations.'
    ];

    const timer = setInterval(() => {
      if (idx < logPool.length) {
        setSyncLogs(prev => [...prev, `[${new Date().toLocaleTimeString()}] ${logPool[idx]}`]);
        idx++;
      } else {
        setIsSocketConnecting(false);
        clearInterval(timer);
      }
    }, 1200);

    return () => clearInterval(timer);
  }, [isSocketConnecting, characters]);

  const storyboardShots = selectedScene?.storyboardShots || [];
  const activeBackground = selectedScene ? getSceneDisplayBackground(selectedScene) : null;
  const quickPreviewSubtitleCues = useMemo(
    () => buildStoryboardAwareSubtitleCues(selectedScene, characters),
    [selectedScene, characters],
  );

  const handleUpdate = (updates: Partial<ExportSettings>) => {
    onUpdateSettings({ ...settings, ...updates });
  };

  const handleTriggerSync = () => {
    setIsSocketConnecting(true);
    setSyncLogs([
      'Handshake initialized...',
      'Querying active characters and scenery configurations...'
    ]);
  };

  const upsertScene = (updatedScene: Scene) => {
    const nextScenes = scenes.some(scene => scene.id === updatedScene.id)
      ? scenes.map(scene => scene.id === updatedScene.id ? updatedScene : scene)
      : [...scenes, updatedScene];
    onUpdateScenes(nextScenes);
  };

  const updateSceneStoryboardShot = (sceneToUpdate: Scene, shotId: string, updates: Partial<StoryboardSceneShot>) => {
    const nextShots = (sceneToUpdate.storyboardShots || []).map((shot, index) => (
      shot.id === shotId
        ? normalizeStoryboardShot({ ...shot, ...updates }, index)
        : normalizeStoryboardShot(shot, index)
    ));

    const updatedScene = {
      ...sceneToUpdate,
      storyboardShots: nextShots,
    };

    upsertScene(updatedScene);
    return updatedScene;
  };

  const drawCoverImage = (context: CanvasRenderingContext2D, image: CanvasImageSource, width: number, height: number) => {
    const sourceWidth = 'width' in image ? Number(image.width) || width : width;
    const sourceHeight = 'height' in image ? Number(image.height) || height : height;
    const sourceRatio = sourceWidth / sourceHeight;
    const targetRatio = width / height;

    let drawWidth = width;
    let drawHeight = height;
    let offsetX = 0;
    let offsetY = 0;

    if (sourceRatio > targetRatio) {
      drawHeight = height;
      drawWidth = height * sourceRatio;
      offsetX = (width - drawWidth) / 2;
    } else {
      drawWidth = width;
      drawHeight = width / sourceRatio;
      offsetY = (height - drawHeight) / 2;
    }

    context.drawImage(image, offsetX, offsetY, drawWidth, drawHeight);
  };

  const wrapCanvasText = (
    context: CanvasRenderingContext2D,
    text: string,
    x: number,
    y: number,
    maxWidth: number,
    lineHeight: number,
    maxLines: number,
  ) => {
    const words = text.trim().split(/\s+/).filter(Boolean);
    const lines: string[] = [];
    let currentLine = '';

    for (const word of words) {
      const nextLine = currentLine ? `${currentLine} ${word}` : word;
      if (context.measureText(nextLine).width <= maxWidth || !currentLine) {
        currentLine = nextLine;
        continue;
      }

      lines.push(currentLine);
      currentLine = word;

      if (lines.length === maxLines - 1) {
        break;
      }
    }

    if (currentLine && lines.length < maxLines) {
      lines.push(currentLine);
    }

    if (lines.length === maxLines && words.length && context.measureText(lines[maxLines - 1]).width > maxWidth) {
      while (lines[maxLines - 1].length > 3 && context.measureText(`${lines[maxLines - 1]}…`).width > maxWidth) {
        lines[maxLines - 1] = lines[maxLines - 1].slice(0, -1).trimEnd();
      }
      lines[maxLines - 1] = `${lines[maxLines - 1]}…`;
    }

    lines.forEach((line, index) => {
      context.fillText(line, x, y + (index * lineHeight));
    });

    return lines.length;
  };

  const loadCanvasImage = async (url: string) => {
    const response = await fetch(url);
    if (!response.ok) {
      throw new Error('Could not download the continuity image source.');
    }

    const blob = await response.blob();
    if (!blob.size) {
      throw new Error('Continuity image source was empty.');
    }

    const objectUrl = URL.createObjectURL(blob);

    try {
      return await new Promise<HTMLImageElement>((resolve, reject) => {
        const image = new Image();
        image.onload = () => resolve(image);
        image.onerror = () => reject(new Error('Continuity image source could not be decoded.'));
        image.src = objectUrl;
      });
    } finally {
      URL.revokeObjectURL(objectUrl);
    }
  };

  const captureVideoFrameBlob = async (clipUrl: string, captureRatio = 0.92) => {
    const clipResponse = await fetch(clipUrl);
    if (!clipResponse.ok) {
      throw new Error('Could not download the rendered clip for anchor-frame capture.');
    }

    const clipBlob = await clipResponse.blob();
    if (!clipBlob.size) {
      throw new Error('Rendered clip download was empty, so no anchor frame could be captured.');
    }

    return new Promise<Blob>((resolve, reject) => {
      const video = document.createElement('video');
      const objectUrl = URL.createObjectURL(clipBlob);
      let isSettled = false;

      const cleanup = () => {
        video.pause();
        video.removeAttribute('src');
        video.load();
        video.remove();
        URL.revokeObjectURL(objectUrl);
      };

      const settle = (callback: () => void) => {
        if (isSettled) return;
        isSettled = true;
        callback();
        cleanup();
      };

      const fail = (message: string) => settle(() => reject(new Error(message)));

      const capture = () => {
        try {
          const canvas = document.createElement('canvas');
          canvas.width = video.videoWidth || 1280;
          canvas.height = video.videoHeight || 720;
          const context = canvas.getContext('2d');
          if (!context) {
            fail('Could not prepare the anchor-frame capture canvas.');
            return;
          }

          context.drawImage(video, 0, 0, canvas.width, canvas.height);
          canvas.toBlob((blob) => {
            if (!blob) {
              fail('Could not convert the captured frame into a PNG.');
              return;
            }

            settle(() => resolve(blob));
          }, 'image/png');
        } catch {
          fail('Rendered clip frame capture failed.');
        }
      };

      video.preload = 'auto';
      video.muted = true;
      video.playsInline = true;
      video.src = objectUrl;
      video.className = 'fixed -left-[9999px] top-0 w-px h-px opacity-0 pointer-events-none';

      video.addEventListener('error', () => fail('Could not load the rendered clip for anchor-frame capture.'), { once: true });
      video.addEventListener('loadedmetadata', () => {
        const duration = Number.isFinite(video.duration) ? video.duration : 0;
        const targetTime = duration > 0.35
          ? Math.max(0, Math.min(duration - 0.08, duration * captureRatio))
          : 0;

        if (targetTime > 0.05) {
          video.addEventListener('seeked', capture, { once: true });
          video.currentTime = targetTime;
          return;
        }

        capture();
      }, { once: true });

      document.body.appendChild(video);
      video.load();
    });
  };

  const captureStoryboardFallbackFrame = async (
    sceneSnapshot: Scene,
    shot: StoryboardSceneShot,
    captureMeta: Pick<StoryboardJob, 'title' | 'resolvedSeed' | 'usingContinuityFrame' | 'continuitySource'>,
  ) => {
    const canvas = document.createElement('canvas');
    canvas.width = 1280;
    canvas.height = 720;
    const context = canvas.getContext('2d');

    if (!context) {
      throw new Error('Could not prepare the fallback anchor-frame canvas.');
    }

    const shotIndex = Math.max(0, (sceneSnapshot.storyboardShots || []).findIndex(item => item.id === shot.id));
    const continuityBridge = resolveContinuityBridge(sceneSnapshot, shot, shotIndex);
    const backgroundSourceUrl = getShotAnchorFrame(sceneSnapshot, shot)?.url
      || continuityBridge.asset?.url
      || getSceneDisplayBackground(sceneSnapshot)
      || null;

    if (backgroundSourceUrl) {
      try {
        const image = await loadCanvasImage(backgroundSourceUrl);
        drawCoverImage(context, image, canvas.width, canvas.height);
      } catch {
        const fallbackGradient = context.createLinearGradient(0, 0, canvas.width, canvas.height);
        fallbackGradient.addColorStop(0, '#0f172a');
        fallbackGradient.addColorStop(0.45, '#18181b');
        fallbackGradient.addColorStop(1, '#020617');
        context.fillStyle = fallbackGradient;
        context.fillRect(0, 0, canvas.width, canvas.height);
      }
    } else {
      const fallbackGradient = context.createLinearGradient(0, 0, canvas.width, canvas.height);
      fallbackGradient.addColorStop(0, '#0f172a');
      fallbackGradient.addColorStop(0.45, '#18181b');
      fallbackGradient.addColorStop(1, '#020617');
      context.fillStyle = fallbackGradient;
      context.fillRect(0, 0, canvas.width, canvas.height);
    }

    const vignette = context.createLinearGradient(0, 0, 0, canvas.height);
    vignette.addColorStop(0, 'rgba(2, 6, 23, 0.18)');
    vignette.addColorStop(0.55, 'rgba(2, 6, 23, 0.38)');
    vignette.addColorStop(1, 'rgba(2, 6, 23, 0.82)');
    context.fillStyle = vignette;
    context.fillRect(0, 0, canvas.width, canvas.height);

    context.fillStyle = 'rgba(9, 9, 11, 0.72)';
    context.fillRect(56, 52, 236, 44);
    context.fillStyle = '#cbd5f5';
    context.font = '600 18px Inter, system-ui, sans-serif';
    context.fillText(`Scene ${shot.shotNumber} Anchor`, 76, 80);

    context.fillStyle = 'rgba(9, 9, 11, 0.72)';
    context.fillRect(56, 482, 1168, 182);

    context.fillStyle = '#818cf8';
    context.font = '600 20px Inter, system-ui, sans-serif';
    context.fillText(sceneSnapshot.title || 'Storyboard Scene', 88, 532);

    context.fillStyle = '#ffffff';
    context.font = '700 36px Inter, system-ui, sans-serif';
    context.fillText(shot.title || `Shot ${shot.shotNumber}`, 88, 578);

    context.fillStyle = '#e4e4e7';
    context.font = '500 22px Inter, system-ui, sans-serif';
    const dialogueExcerpt = getShotDialogueExcerpt(sceneSnapshot, characters, shot) || shot.action || captureMeta.title || 'Storyboard continuity still';
    wrapCanvasText(context, dialogueExcerpt, 88, 620, 1080, 28, 2);

    context.fillStyle = '#a1a1aa';
    context.font = '500 18px Inter, system-ui, sans-serif';
    const footer = `${formatSeedStrategyLabel(shot.seedStrategy)} · ${captureMeta.resolvedSeed ? `Seed ${captureMeta.resolvedSeed.toLocaleString()}` : 'Seed pending'} · ${captureMeta.usingContinuityFrame ? (captureMeta.continuitySource || 'Continuity bridge used') : 'Sandbox continuity still'}`;
    context.fillText(footer, 88, 680);

    return new Promise<Blob>((resolve, reject) => {
      canvas.toBlob((blob) => {
        if (!blob) {
          reject(new Error('Could not convert the fallback anchor frame into a PNG.'));
          return;
        }

        resolve(blob);
      }, 'image/png');
    });
  };

  const persistShotAnchorFrame = async ({
    sceneSnapshot,
    shot,
    operationName,
    title,
    resolvedSeed,
    usingContinuityFrame,
    continuitySource,
    announceProgress = false,
    mode = 'manual',
  }: {
    sceneSnapshot: Scene;
    shot: StoryboardSceneShot;
    operationName: string;
    title: string;
    resolvedSeed?: number | null;
    usingContinuityFrame?: boolean;
    continuitySource?: string | null;
    announceProgress?: boolean;
    mode?: 'manual' | 'automatic';
  }): Promise<PersistAnchorFrameResult> => {
    setSavingAnchorShotId(shot.id);

    if (announceProgress) {
      setStoryboardProgressText(
        mode === 'automatic'
          ? `Shot ${shot.shotNumber} rendered. Capturing an anchor frame for downstream continuity...`
          : `Capturing an anchor frame for Shot ${shot.shotNumber}...`,
      );
    }

    try {
      const clipUrl = `/api/video-download?operationName=${encodeURIComponent(operationName)}`;
      let usedSandboxFallback = false;
      let frameBlob: Blob;

      try {
        frameBlob = await captureVideoFrameBlob(clipUrl);
      } catch (error) {
        if (!operationName.startsWith('mock-operation-')) {
          throw error;
        }

        usedSandboxFallback = true;
        frameBlob = await captureStoryboardFallbackFrame(sceneSnapshot, shot, {
          title,
          resolvedSeed,
          usingContinuityFrame,
          continuitySource,
        });
      }

      const safeLabel = (title || shot.title || `shot-${shot.shotNumber}`)
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, '-')
        .replace(/^-+|-+$/g, '')
        .slice(0, 40) || `shot-${shot.shotNumber}`;

      const formData = new FormData();
      formData.append('file', frameBlob, `${safeLabel}-anchor.png`);
      formData.append('kind', 'storyboard-frame');
      formData.append('label', `${title || shot.title} anchor frame`);

      const response = await fetch('/api/upload-reference', {
        method: 'POST',
        body: formData,
      });

      if (!response.ok) {
        throw new Error('Failed to upload the captured anchor frame.');
      }

      const data = await response.json();
      if (!data?.asset?.id) {
        throw new Error('Anchor-frame upload did not return asset metadata.');
      }

      const sceneWithAsset = upsertSceneStoryboardFrameAsset(sceneSnapshot, data.asset);
      const sceneWithAnchor = updateSceneStoryboardShot(sceneWithAsset, shot.id, { boardImageId: data.asset.id });
      const currentShotIndex = sceneWithAnchor.storyboardShots?.findIndex(item => item.id === shot.id) ?? -1;
      const nextShotBefore = currentShotIndex >= 0 ? sceneWithAnchor.storyboardShots?.[currentShotIndex + 1] : undefined;
      const primedScene = primeNextStoryboardShotContinuity(sceneWithAnchor, shot.id);
      const nextShotAfter = currentShotIndex >= 0 ? primedScene.storyboardShots?.[currentShotIndex + 1] : undefined;
      const primedBridge = nextShotBefore?.transitionInMode !== nextShotAfter?.transitionInMode && nextShotAfter?.transitionInMode === 'previous-shot';
      const primedSeed = nextShotBefore?.seedStrategy !== nextShotAfter?.seedStrategy && nextShotAfter?.seedStrategy === 'inherit-previous';
      const updatedScene = primedScene !== sceneWithAnchor ? primedScene : sceneWithAnchor;

      if (primedScene !== sceneWithAnchor) {
        upsertScene(primedScene);
      }

      const message = `${mode === 'automatic' ? 'Auto-saved' : 'Saved'} ${usedSandboxFallback
        ? `a sandbox continuity still for Shot ${shot.shotNumber}.`
        : `an anchor frame for Shot ${shot.shotNumber}.`}${primedBridge || primedSeed
          ? ` Shot ${nextShotAfter?.shotNumber || shot.shotNumber + 1} was primed for ${[
            primedBridge ? 'previous-shot bridging' : null,
            primedSeed ? 'seed inheritance' : null,
          ].filter(Boolean).join(' + ')}.`
          : ' Previous-shot bridges can use it on the next render.'}`;

      if (announceProgress) {
        setStoryboardProgressText(message);
      }

      return {
        updatedScene,
        message,
        usedSandboxFallback,
        primedBridge,
        primedSeed,
      };
    } catch (error: any) {
      const baseMessage = error?.message || 'Could not save an anchor frame from the rendered clip.';
      const message = mode === 'automatic'
        ? `${baseMessage} The clip still rendered successfully, and you can save the anchor manually.`
        : baseMessage;

      if (announceProgress) {
        setStoryboardProgressText(message);
      }

      throw new Error(message);
    } finally {
      setSavingAnchorShotId(null);
    }
  };

  const saveShotAnchorFrame = async (job: StoryboardJob) => {
    const sceneSnapshot = scenes.find(scene => scene.id === selectedSceneId) || selectedScene;
    if (!sceneSnapshot?.storyboardShots?.length || !job.operationName) return;

    const shot = sceneSnapshot.storyboardShots.find(item => item.id === job.shotId);
    if (!shot) return;

    try {
      await persistShotAnchorFrame({
        sceneSnapshot,
        shot,
        operationName: job.operationName,
        title: job.title,
        resolvedSeed: job.resolvedSeed,
        usingContinuityFrame: job.usingContinuityFrame,
        continuitySource: job.continuitySource,
        announceProgress: true,
        mode: 'manual',
      });
    } catch (error: any) {
      console.warn('Anchor frame capture failed:', error);
    }
  };

  const handleTimeUpdate = (e: React.SyntheticEvent<HTMLVideoElement, Event>) => {
    const video = e.currentTarget;
    const currTime = video.currentTime;
    const duration = video.duration || 10;

    if (!quickPreviewSubtitleCues.length) {
      setActiveSubtitle(null);
      return;
    }

    const activeCue = quickPreviewSubtitleCues.find((cue, index) => {
      const startTime = cue.startRatio * duration;
      const endTime = cue.endRatio * duration;
      const isLastCue = index === quickPreviewSubtitleCues.length - 1;
      return currTime >= startTime && (isLastCue ? currTime <= endTime : currTime < endTime);
    });

    setActiveSubtitle(activeCue
      ? {
          speaker: activeCue.speaker,
          text: activeCue.text,
          sentiment: activeCue.sentiment,
        }
      : null);
  };

  const waitForOperationCompletion = (operationNameValue: string, onUpdate?: (data: any) => void) => {
    return new Promise<any>((resolve) => {
      const intervalId = setInterval(async () => {
        try {
          const response = await fetch('/api/video-status', {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
            },
            body: JSON.stringify({ operationName: operationNameValue }),
          });

          const data = await response.json();
          if (onUpdate) {
            onUpdate(data);
          }

          if (data.done) {
            clearInterval(intervalId);
            resolve(data);
          }
        } catch (error: any) {
          clearInterval(intervalId);
          resolve({ done: true, error: error?.message || 'Status Query Timeout' });
        }
      }, 2000);
    });
  };

  const triggerQuickPreview = async () => {
    if (!selectedScene) return;

    try {
      setVideoStatus('rendering');
      setRenderProgress(5);
      setRenderMessage('Synthesizing screenplay storyboard assets...');
      setVideoError(null);
      setIsQuotaExhausted(false);

      const response = await fetch('/api/generate-video', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({
          characters,
          scenes: [selectedScene].filter(Boolean),
          camera
        })
      });

      if (!response.ok) {
        throw new Error('Failed to hand off prompt parameters to the Veo video engine.');
      }

      const data = await response.json();
      const opName = data.operationName;
      setOperationName(opName);
      setIsQuotaExhausted(!!data.isQuotaExhausted);

      const result = await waitForOperationCompletion(opName, (statusData) => {
        if (statusData.progress !== undefined) {
          setRenderProgress(statusData.progress);
        }
        if (statusData.status) {
          setRenderMessage(statusData.status);
        }
      });

      if (result.error) {
        setVideoStatus('failed');
        setVideoError(result.error);
      } else {
        setVideoStatus('completed');
      }
    } catch (error: any) {
      setVideoStatus('failed');
      setVideoError(error.message || 'Rendering Pipeline Error');
    }
  };

  const generateStoryboardPlan = async () => {
    if (!selectedScene) return [] as Scene['storyboardShots'];

    try {
      setIsGeneratingStoryboardPlan(true);
      const response = await fetch('/api/generate-storyboard', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          scene: selectedScene,
          characters,
          camera,
        }),
      });

      if (!response.ok) {
        throw new Error('Failed to build storyboard plan.');
      }

      const data = await response.json();
      const shots = Array.isArray(data?.shots)
        ? data.shots.map((shot: any, index: number) => normalizeStoryboardShot(shot, index))
        : [];

      if (shots.length) {
        upsertScene({
          ...selectedScene,
          storyboardShots: shots,
        });
      }

      return shots;
    } catch (error) {
      console.warn('Storyboard planning from export view failed:', error);
      return [];
    } finally {
      setIsGeneratingStoryboardPlan(false);
    }
  };

  const updateStoryboardJob = (shotId: string, updates: Partial<StoryboardJob>) => {
    setStoryboardJobs(prev => prev.map(job => job.shotId === shotId ? { ...job, ...updates } : job));
  };

  const renderStoryboardShot = async (
    sceneSnapshot: Scene,
    shotIndex: number,
    retryMode: StoryboardRetryMode = 'configured',
  ): Promise<StoryboardRenderResult> => {
    const shot = sceneSnapshot.storyboardShots?.[shotIndex];
    if (!shot) {
      return {
        updatedScene: sceneSnapshot,
        success: false,
        anchorSaved: false,
        anchorError: null,
      };
    }

    const previousShot = shotIndex > 0 ? sceneSnapshot.storyboardShots?.[shotIndex - 1] : undefined;
    const seedResolution = resolveStoryboardShotSeed(shot, previousShot, retryMode);

    updateStoryboardJob(shot.id, {
      title: shot.title,
      status: 'starting',
      operationName: null,
      error: null,
      seedStrategy: shot.seedStrategy || 'auto',
      resolvedSeed: seedResolution.resolvedSeed,
      seedSource: seedResolution.seedSource,
      inheritedFromShotId: seedResolution.inheritedFromShotId,
      inheritedFromSeed: seedResolution.inheritedFromSeed,
      isQuotaExhausted: false,
    });

    try {
      const response = await fetch('/api/generate-shot-video', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          characters,
          scene: sceneSnapshot,
          shot,
          camera,
          resolvedSeed: seedResolution.resolvedSeed,
        }),
      });

      if (!response.ok) {
        throw new Error('Failed to start storyboard shot render.');
      }

      const data = await response.json();
      const appliedSeed = sanitizeStoryboardSeed(data?.resolvedSeed) || seedResolution.resolvedSeed;
      const updatedScene = updateSceneStoryboardShot(sceneSnapshot, shot.id, { lastRenderSeed: appliedSeed });

      updateStoryboardJob(shot.id, {
        status: 'rendering',
        operationName: data.operationName,
        usingReferenceImages: !!data.usingReferenceImages,
        durationSeconds: data.durationSeconds,
        isQuotaExhausted: !!data.isQuotaExhausted,
        resolvedSeed: appliedSeed,
        seedStrategy: shot.seedStrategy || 'auto',
        seedSource: seedResolution.seedSource,
        inheritedFromShotId: seedResolution.inheritedFromShotId,
        inheritedFromSeed: seedResolution.inheritedFromSeed,
        usingContinuityFrame: !!data.usingContinuityFrame,
        continuitySource: data.continuitySource || null,
      });

      const result = await waitForOperationCompletion(data.operationName);
      if (result.error) {
        updateStoryboardJob(shot.id, {
          status: 'failed',
          error: result.error,
        });
        return {
          updatedScene,
          success: false,
          anchorSaved: false,
          anchorError: null,
        };
      }

      let finalScene = updatedScene;
      let anchorSaved = false;
      let anchorError: string | null = null;

      const renderedShot = updatedScene.storyboardShots?.[shotIndex];
      if (renderedShot) {
        try {
          const anchorResult = await persistShotAnchorFrame({
            sceneSnapshot: updatedScene,
            shot: renderedShot,
            operationName: data.operationName,
            title: shot.title,
            resolvedSeed: appliedSeed,
            usingContinuityFrame: !!data.usingContinuityFrame,
            continuitySource: data.continuitySource || null,
            announceProgress: true,
            mode: 'automatic',
          });
          finalScene = anchorResult.updatedScene;
          anchorSaved = true;
        } catch (error: any) {
          anchorError = error?.message || `Shot ${shot.shotNumber} rendered, but automatic anchor capture failed. You can save it manually.`;
          console.warn('Automatic anchor frame capture failed:', error);
        }
      }

      updateStoryboardJob(shot.id, {
        status: 'completed',
      });

      return {
        updatedScene: finalScene,
        success: true,
        anchorSaved,
        anchorError,
      };
    } catch (error: any) {
      updateStoryboardJob(shot.id, {
        status: 'failed',
        error: error?.message || 'Storyboard render failed.',
      });

      return {
        updatedScene: sceneSnapshot,
        success: false,
        anchorSaved: false,
        anchorError: null,
      };
    }
  };

  const retryStoryboardShot = async (shotId: string, retryMode: Exclude<StoryboardRetryMode, 'configured'>) => {
    const sceneSnapshot = scenes.find(scene => scene.id === selectedSceneId) || selectedScene;
    if (!sceneSnapshot?.storyboardShots?.length) return;

    const shotIndex = sceneSnapshot.storyboardShots.findIndex(shot => shot.id === shotId);
    if (shotIndex < 0) return;

    setStoryboardRunStatus('rendering');
    setStoryboardProgressText(
      retryMode === 'same'
        ? `Retrying shot ${shotIndex + 1} with the same seed lineage...`
        : `Retrying shot ${shotIndex + 1} with a fresh exploratory seed...`,
    );

    const { success, anchorSaved, anchorError } = await renderStoryboardShot(sceneSnapshot, shotIndex, retryMode);

    setStoryboardRunStatus(success ? 'completed' : 'failed');
    setStoryboardProgressText(success
      ? (anchorSaved
          ? 'Shot retry complete. Seed lineage, last render seed, and the anchor frame were refreshed automatically.'
          : (anchorError || 'Shot retry complete, but automatic anchor capture failed. You can save it manually.'))
      : 'Shot retry failed. You can retry with the same seed or force a new one.');
  };

  const triggerStoryboardRender = async () => {
    if (!selectedScene) return;

    let shots = storyboardShots;
    let workingScene = selectedScene;
    if (!shots.length) {
      shots = (await generateStoryboardPlan()) || [];
      workingScene = scenes.find(scene => scene.id === selectedScene.id) || {
        ...selectedScene,
        storyboardShots: shots,
      };
    }

    if (!shots.length) {
      setStoryboardRunStatus('failed');
      setStoryboardProgressText('No storyboard shots were available to render.');
      return;
    }

    const initialJobs: StoryboardJob[] = shots.map(shot => ({
      shotId: shot.id,
      title: shot.title,
      status: 'idle',
      operationName: null,
      error: null,
      seedStrategy: shot.seedStrategy || 'auto',
      resolvedSeed: shot.lastRenderSeed ?? null,
      seedSource: null,
      inheritedFromShotId: null,
      inheritedFromSeed: null,
      usingContinuityFrame: false,
      continuitySource: null,
    }));

    setStoryboardJobs(initialJobs);
    setStoryboardRunStatus('rendering');

    let hasFailure = false;
    const anchorWarnings: string[] = [];

    for (let index = 0; index < shots.length; index++) {
      const shot = shots[index];
      setStoryboardProgressText(`Rendering shot ${index + 1} of ${shots.length}: ${shot.title}`);
      const { updatedScene, success, anchorSaved, anchorError } = await renderStoryboardShot(workingScene, index, 'configured');
      workingScene = updatedScene;

      if (!success) {
        hasFailure = true;
      } else if (!anchorSaved && anchorError) {
        anchorWarnings.push(`Shot ${index + 1}: ${anchorError}`);
      }
    }

    setStoryboardRunStatus(hasFailure ? 'failed' : 'completed');
    setStoryboardProgressText(hasFailure
      ? 'Storyboard render finished with at least one failed shot. You can re-run to regenerate the sequence.'
      : anchorWarnings.length
        ? `Storyboard render complete, but ${anchorWarnings.length === 1 ? '1 shot needs' : `${anchorWarnings.length} shots need`} manual anchor follow-up. ${anchorWarnings[0]}`
        : 'Storyboard render complete. Each shot clip rendered successfully and its anchor frame was auto-captured for downstream continuity.');
  };

  const syncPayload = JSON.stringify({
    timestamp: new Date().toISOString(),
    engineProfile: settings.targetEngine,
    format: settings.exportFormat,
    actors: characters.map(character => ({
      name: character.name,
      role: character.role,
      activeImage: character.thumbnail,
      referenceCount: character.referenceAssets?.length || 0,
      appearance: {
        age: character.properties.age,
        physique: character.properties.build,
        hair: `${character.properties.hairStyle} (${character.properties.hairColor})`,
        iris: character.properties.eyeColor,
        backstory: character.properties.backstory,
      }
    })),
    sequence: scenes.map(scene => ({
      title: scene.title,
      lighting: scene.lighting,
      atmosphereNotes: scene.atmosphereNotes,
      backgroundReferenceCount: scene.backgroundAssets?.length || 0,
      beats: scene.dialogues.map(dialogue => ({
        actor: characters.find(character => character.id === dialogue.characterId)?.name || 'Unknown',
        dialogue: dialogue.text,
        vibe: dialogue.sentiment,
      })),
      storyboard: (scene.storyboardShots || []).map(shot => ({
        title: shot.title,
        shotType: shot.shotType,
        durationSeconds: shot.durationSeconds,
        action: shot.action,
        composition: shot.composition,
        continuityNotes: shot.continuityNotes,
        dialogueExcerpt: shot.dialogueExcerpt,
        boardImageId: shot.boardImageId ?? null,
        transitionInMode: shot.transitionInMode || 'none',
        transitionInAssetId: shot.transitionInAssetId ?? null,
        seedStrategy: shot.seedStrategy || 'auto',
        lockedSeed: shot.lockedSeed ?? null,
        lastRenderSeed: shot.lastRenderSeed ?? null,
      })),
    })),
    camera: {
      type: camera.shotType,
      aspect: camera.aspectRatio,
      lens: `${camera.focalLength}mm`
    }
  }, null, 2);

  const handleCopyPayload = () => {
    navigator.clipboard.writeText(syncPayload);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  const handleDownloadPayload = () => {
    const blob = new Blob([syncPayload], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = `storyforge-${settings.targetEngine}-profile.json`;
    link.click();
    URL.revokeObjectURL(url);
  };

  const storyboardCompletionPercent = storyboardJobs.length
    ? Math.round((storyboardJobs.filter(job => job.status === 'completed').length / storyboardJobs.length) * 100)
    : 0;

  const storyboardRenderedJobs = storyboardJobs.filter(job => job.status === 'completed' && job.operationName);
  const storyboardManifest = useMemo(() => {
    if (!selectedScene) return null;

    return {
      generatedAt: new Date().toISOString(),
      mode: 'storyboard-playlist',
      scene: {
        id: selectedScene.id,
        title: selectedScene.title,
        lighting: selectedScene.lighting,
        atmosphereNotes: selectedScene.atmosphereNotes || '',
      },
      camera: {
        shotType: camera.shotType,
        focalLength: camera.focalLength,
        tiltAngle: camera.tiltAngle,
        aspectRatio: camera.aspectRatio,
      },
      playlist: storyboardJobs.map((job, index) => {
        const shot = storyboardShots.find(item => item.id === job.shotId);
        const continuityBridge = shot ? resolveContinuityBridge(selectedScene, shot, index) : null;
        return {
          order: index + 1,
          shotId: job.shotId,
          title: job.title,
          status: job.status,
          operationName: job.operationName || null,
          clipUrl: job.operationName ? `/api/video-download?operationName=${encodeURIComponent(job.operationName)}` : null,
          usingReferenceImages: !!job.usingReferenceImages,
          durationSeconds: job.durationSeconds || shot?.durationSeconds || null,
          shotType: shot?.shotType || null,
          dialogueExcerpt: shot?.dialogueExcerpt || getShotDialogueExcerpt(selectedScene, characters, shot) || null,
          continuityNotes: shot?.continuityNotes || null,
          boardImageId: shot?.boardImageId ?? null,
          transitionInMode: shot?.transitionInMode || 'none',
          transitionInAssetId: shot?.transitionInAssetId ?? null,
          usingContinuityFrame: !!job.usingContinuityFrame,
          continuitySource: job.continuitySource || null,
          continuityBridgeSource: continuityBridge?.sourceLabel || null,
          continuityBridgeSummary: continuityBridge?.summary || null,
          seedStrategy: shot?.seedStrategy || job.seedStrategy || 'auto',
          lockedSeed: shot?.lockedSeed ?? null,
          resolvedSeed: job.resolvedSeed ?? shot?.lastRenderSeed ?? null,
          seedSource: job.seedSource || null,
          inheritedFromShotId: job.inheritedFromShotId || null,
          inheritedFromSeed: job.inheritedFromSeed ?? null,
          error: job.error || null,
        };
      }),
    };
  }, [selectedScene, storyboardJobs, storyboardShots, camera, characters]);

  const handleDownloadStoryboardManifest = () => {
    if (!storyboardManifest) return;

    const blob = new Blob([JSON.stringify(storyboardManifest, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = `${selectedScene?.title?.replace(/[^a-z0-9]+/gi, '-').toLowerCase() || 'storyboard'}-manifest.json`;
    link.click();
    URL.revokeObjectURL(url);
  };

  return (
    <div className="space-y-6 animate-in fade-in duration-300">
      <div>
        <h2 className="text-lg font-medium tracking-tight text-white">Pipeline Exports</h2>
        <p className="text-[11px] text-zinc-500 font-mono mt-0.5">Continuity-first export pipeline with quick previews and storyboard shot rendering.</p>
      </div>

      <div className="bg-zinc-900/40 border border-zinc-900 p-5 rounded-2xl space-y-4">
        <label className="text-[10px] font-mono text-zinc-400 uppercase tracking-widest block">Target System Profile</label>
        <div className="grid grid-cols-1 gap-2 sm:grid-cols-3">
          {[
            { id: 'blender', label: 'Blender 3D', hint: 'Best for animations / glTF' },
            { id: 'unreal-engine', label: 'Unreal Engine', hint: 'Metahuman LiveLink' },
            { id: 'unity', label: 'Unity Engine', hint: 'Asset integration' }
          ].map(engine => (
            <button
              key={engine.id}
              onClick={() => handleUpdate({ targetEngine: engine.id as ExportSettings['targetEngine'] })}
              className={`p-3 rounded-xl border text-left transition-all cursor-pointer ${
                settings.targetEngine === engine.id
                  ? 'bg-indigo-600/10 border-indigo-500 text-indigo-300'
                  : 'bg-zinc-950 border-zinc-900 text-zinc-500 hover:text-zinc-300'
              }`}
            >
              <div className="text-xs font-semibold text-white">{engine.label}</div>
              <div className="text-[9px] font-mono text-zinc-500 mt-1 leading-tight">{engine.hint}</div>
            </button>
          ))}
        </div>
      </div>

      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
        <div className="bg-zinc-900/40 border border-zinc-900 p-4 rounded-xl space-y-2">
          <span className="text-[10px] font-mono text-zinc-500 uppercase">Format Choice</span>
          <select
            title="Export format"
            value={settings.exportFormat}
            onChange={e => handleUpdate({ exportFormat: e.target.value as ExportSettings['exportFormat'] })}
            className="w-full bg-zinc-950 border border-zinc-900 text-zinc-200 text-xs rounded-lg py-2 px-2.5 focus:outline-none focus:border-indigo-500 appearance-none h-[36px]"
          >
            <option value="fbx">FBX Animation Mesh (.fbx)</option>
            <option value="gltf">glTF 2.0 Web Transmission (.gltf)</option>
            <option value="usd">Universal Scene Description (.usd)</option>
          </select>
        </div>

        <div className="bg-zinc-900/40 border border-zinc-900 p-4 rounded-xl space-y-2">
          <span className="text-[10px] font-mono text-zinc-500 uppercase">LOD Mesh Level</span>
          <select
            title="Mesh detail level"
            value={settings.meshLevel}
            onChange={e => handleUpdate({ meshLevel: e.target.value as ExportSettings['meshLevel'] })}
            className="w-full bg-zinc-950 border border-zinc-900 text-zinc-200 text-xs rounded-lg py-2 px-2.5 focus:outline-none focus:border-indigo-500 appearance-none h-[36px]"
          >
            <option value="high">High cinematic (LOD 0)</option>
            <option value="medium">Medium dynamic (LOD 1)</option>
            <option value="low">Low performance (LOD 2)</option>
          </select>
        </div>
      </div>

      <div className="bg-gradient-to-b from-zinc-950 to-zinc-900 border border-zinc-900 rounded-2xl p-5 space-y-4 shadow-xl">
        <div className="flex items-start justify-between gap-3">
          <div className="space-y-1">
            <div className="flex items-center gap-2">
              <span className={`w-2 h-2 rounded-full ${
                renderMode === 'quick-preview'
                  ? (videoStatus === 'rendering' ? 'bg-indigo-400 animate-pulse' : 'bg-indigo-500')
                  : (storyboardRunStatus === 'rendering' ? 'bg-indigo-400 animate-pulse' : 'bg-indigo-500')
              }`} />
              <h3 className="text-sm font-semibold text-zinc-100 flex items-center gap-1.5 font-sans">
                {renderMode === 'quick-preview' ? 'Veo Quick Preview' : 'Storyboard Shot Renderer'}
              </h3>
            </div>
            <p className="text-[11px] text-zinc-400 font-mono">
              {renderMode === 'quick-preview'
                ? 'Fast one-clip concept preview that preserves the current pipeline.'
                : 'Continuity-first Veo 3.1 workflow: each storyboard shot becomes its own clip, with up to 3 total reference images and 8-second reference mode constraints.'}
            </p>
          </div>

          <div className="flex items-center gap-2 bg-zinc-950/80 border border-zinc-900 rounded-xl p-1">
            <button
              type="button"
              onClick={() => setRenderMode('quick-preview')}
              className={`px-3 py-1.5 rounded-lg text-xs font-semibold transition-colors ${renderMode === 'quick-preview' ? 'bg-indigo-600 text-white' : 'text-zinc-400 hover:text-zinc-200'}`}
            >
              Quick Preview
            </button>
            <button
              type="button"
              onClick={() => setRenderMode('storyboard')}
              className={`px-3 py-1.5 rounded-lg text-xs font-semibold transition-colors ${renderMode === 'storyboard' ? 'bg-indigo-600 text-white' : 'text-zinc-400 hover:text-zinc-200'}`}
            >
              Storyboard Mode
            </button>
          </div>
        </div>

        <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3 bg-zinc-950 p-3 rounded-xl border border-zinc-900">
          <div className="space-y-0.5">
            <span className="text-[10px] font-mono text-zinc-500 uppercase tracking-widest block">Screenplay Scene Target</span>
            <span className="text-xs text-zinc-450">Choose which scene to preview or render as storyboard clips.</span>
          </div>
          <select
            title="Select export scene"
            value={selectedSceneId}
            onChange={(e) => setSelectedSceneId(e.target.value)}
            className="w-full min-w-0 bg-zinc-900 border border-zinc-800 text-zinc-200 text-xs rounded-lg py-1.5 px-3 focus:outline-none focus:border-indigo-500 cursor-pointer sm:w-auto sm:min-w-[220px]"
          >
            {scenes.map((scene, index) => (
              <option key={scene.id} value={scene.id}>
                Scene {index + 1}: {scene.title} ({scene.dialogues.length} lines)
              </option>
            ))}
          </select>
        </div>

        {renderMode === 'quick-preview' ? (
          <>
            {videoStatus === 'idle' && (
              <button
                onClick={triggerQuickPreview}
                className="bg-indigo-600 hover:bg-indigo-500 text-white text-xs font-semibold px-4 py-2 rounded-xl flex items-center gap-1.5 transition-all shadow-md shadow-indigo-600/20 cursor-pointer"
              >
                <Film className="w-3.5 h-3.5" />
                <span>Export Video</span>
              </button>
            )}

            {videoStatus === 'rendering' && (
              <div className="bg-zinc-950/60 border border-zinc-900 p-4 rounded-xl space-y-3 animate-in fade-in duration-300">
                <div className="flex justify-between items-center text-[10.5px] font-mono">
                  <span className="text-zinc-400 flex items-center gap-1.5">
                    <RefreshCw className="w-3.5 h-3.5 text-indigo-400 animate-spin" />
                    <span>{renderMessage || 'Veo Sequence compiling...'}</span>
                  </span>
                  <span className="text-indigo-400 font-bold">{renderProgress}%</span>
                </div>
                <progress
                  className="storyforge-progress w-full h-1.5"
                  value={renderProgress}
                  max={100}
                />
                <p className="text-[9px] font-mono text-zinc-500 text-center leading-tight">
                  Quick Preview uses the existing one-scene Lite path. For long dialogue and continuity-first output, switch to Storyboard Mode.
                </p>
              </div>
            )}

            {videoStatus === 'completed' && operationName && (
              <div className="space-y-3 animate-in zoom-in-95 duration-300">
                <div className="border border-zinc-900 bg-zinc-950 rounded-xl overflow-hidden relative aspect-video flex items-center justify-center group/video shadow-2xl">
                  <video
                    src={`/api/video-download?operationName=${encodeURIComponent(operationName)}`}
                    controls
                    autoPlay
                    className="w-full h-full object-contain"
                    referrerPolicy="no-referrer"
                    onTimeUpdate={handleTimeUpdate}
                    onEnded={() => setActiveSubtitle(null)}
                  />

                  {activeSubtitle && (
                    <div className="absolute bottom-14 left-1/2 -translate-x-1/2 w-[92%] max-w-[500px] bg-zinc-950/90 backdrop-blur-md border border-zinc-900/80 p-3 rounded-2xl flex items-start gap-3 pointer-events-none animate-in fade-in slide-in-from-bottom-2 duration-300">
                      <div className="w-1 h-8 bg-indigo-500 rounded-full flex-shrink-0 self-center" />
                      <div className="flex-1 min-w-0">
                        <div className="flex items-center gap-1.5 mb-1">
                          <span className="text-[10px] font-bold text-indigo-400 font-sans tracking-wide uppercase">{activeSubtitle.speaker}</span>
                          <span className={`text-[8px] font-mono tracking-wider font-semibold uppercase px-1.5 py-0.5 rounded ${
                            activeSubtitle.sentiment === 'tense' ? 'bg-red-500/15 text-red-400 border border-red-500/10' :
                            activeSubtitle.sentiment === 'playful' ? 'bg-emerald-500/15 text-emerald-400 border border-emerald-500/10' :
                            activeSubtitle.sentiment === 'mysterious' ? 'bg-fuchsia-500/15 text-fuchsia-400 border border-fuchsia-500/10' :
                            activeSubtitle.sentiment === 'determined' ? 'bg-indigo-500/15 text-indigo-400 border border-indigo-500/10' :
                            'bg-zinc-900 text-zinc-500 border border-zinc-800'
                          }`}>{activeSubtitle.sentiment}</span>
                        </div>
                        <p className="text-[11px] leading-relaxed text-zinc-200 font-medium font-sans">“{activeSubtitle.text}”</p>
                      </div>
                    </div>
                  )}
                </div>

                {isQuotaExhausted && (
                  <div className="bg-amber-500/5 border border-amber-500/10 rounded-xl p-3.5 space-y-2 text-[11px] font-sans text-zinc-300">
                    <div className="flex items-center gap-2 text-amber-400 font-semibold">
                      <AlertTriangle className="w-4 h-4 flex-shrink-0" />
                      <span>Why is Sandbox mode active?</span>
                    </div>
                    <p className="leading-relaxed">
                      The Google GenAI Veo quick-preview model (<code className="font-mono text-[10px] bg-zinc-950 px-1 py-0.5 rounded text-indigo-300">veo-3.1-lite</code>) can return <strong className="text-amber-300">429 Resource Exhausted</strong> until billing and quota are configured.
                    </p>
                  </div>
                )}

                <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
                  {isQuotaExhausted ? (
                    <span className="text-[10px] font-mono text-amber-400 flex items-center gap-1.5 bg-amber-500/5 border border-amber-500/10 px-2 py-1 rounded">
                      ● Veo API capacity limit reached (Sandbox pre-visualization active)
                    </span>
                  ) : (
                    <span className="text-[10px] font-mono text-emerald-400 flex items-center gap-1 bg-emerald-500/5 border border-emerald-500/10 px-2 py-1 rounded">
                      ● Quick preview render complete
                    </span>
                  )}
                  <div className="flex flex-wrap gap-2">
                    <button
                      onClick={() => {
                        const anchor = document.createElement('a');
                        anchor.href = `/api/video-download?operationName=${encodeURIComponent(operationName)}`;
                        anchor.download = `storyforge-previsualization-${Date.now()}.mp4`;
                        document.body.appendChild(anchor);
                        anchor.click();
                        document.body.removeChild(anchor);
                      }}
                      className="bg-zinc-800 hover:bg-zinc-700 text-zinc-200 hover:text-white px-3 py-1.5 rounded-lg text-xs font-medium flex items-center gap-1 transition-all cursor-pointer"
                    >
                      <Download className="w-3 h-3" />
                      <span>Download file</span>
                    </button>
                    <button
                      onClick={triggerQuickPreview}
                      className="bg-indigo-950 hover:bg-indigo-900 border border-indigo-500/20 text-indigo-300 px-3 py-1.5 rounded-lg text-xs font-semibold flex items-center gap-1 transition-all cursor-pointer"
                    >
                      <RefreshCw className="w-3 h-3" />
                      <span>Re-render clip</span>
                    </button>
                  </div>
                </div>
              </div>
            )}

            {videoStatus === 'failed' && (
              <div className="bg-red-950/20 border border-red-500/10 p-4 rounded-xl space-y-3">
                <div className="flex items-center gap-2 text-red-400 text-xs font-bold">
                  <AlertTriangle className="w-4 h-4 flex-shrink-0" />
                  <span>Compilation Aborted</span>
                </div>
                <p className="text-[10.5px] font-mono text-zinc-400 leading-normal">{videoError || 'Engine could not verify target compilation frames.'}</p>
                <div className="flex justify-end pt-1">
                  <button
                    onClick={triggerQuickPreview}
                    className="bg-red-500/10 hover:bg-red-500/20 border border-red-500/20 text-red-400 px-3.5 py-1.5 rounded-lg text-xs font-semibold flex items-center gap-1 transition-all cursor-pointer"
                  >
                    <RefreshCw className="w-3 h-3" />
                    <span>Retry Render</span>
                  </button>
                </div>
              </div>
            )}
          </>
        ) : (
          <div className="space-y-5">
            <div className="flex flex-wrap items-center justify-between gap-3 bg-zinc-950/70 border border-zinc-900 rounded-2xl p-4">
              <div className="space-y-1">
                <div className="flex items-center gap-2 text-zinc-100 text-sm font-semibold">
                  <Clapperboard className="w-4 h-4 text-indigo-400" />
                  <span>Storyboard film sheet</span>
                </div>
                <p className="text-[11px] text-zinc-500 font-mono">
                  Veo 3.1 reference-image mode supports up to 3 total reference images per shot and requires 8-second shots when references are used. Successful renders auto-save anchor frames for downstream continuity.
                </p>
              </div>
              <div className="flex flex-wrap items-center gap-2">
                <button
                  type="button"
                  onClick={generateStoryboardPlan}
                  disabled={isGeneratingStoryboardPlan}
                  className="bg-indigo-600/15 hover:bg-indigo-600/25 text-indigo-300 border border-indigo-500/20 text-xs font-semibold px-3 py-2 rounded-xl flex items-center gap-1.5 disabled:opacity-50"
                >
                  <Wand2 className={`w-3.5 h-3.5 ${isGeneratingStoryboardPlan ? 'animate-spin' : ''}`} />
                  <span>{isGeneratingStoryboardPlan ? 'Planning...' : (storyboardShots.length ? 'Refresh Board' : 'Build Board')}</span>
                </button>
                <button
                  type="button"
                  onClick={triggerStoryboardRender}
                  disabled={isGeneratingStoryboardPlan || !selectedScene}
                  className="bg-zinc-100 hover:bg-white text-zinc-950 text-xs font-semibold px-4 py-2 rounded-xl flex items-center gap-1.5 shadow-lg disabled:opacity-50"
                >
                  <Film className="w-3.5 h-3.5" />
                  <span>Render Storyboard Clips</span>
                </button>
              </div>
            </div>

            {selectedScene && storyboardShots.length > 0 ? (
              <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 xl:grid-cols-3">
                {storyboardShots.map((shot, index) => {
                  const anchorFrame = getShotAnchorFrame(selectedScene, shot);
                  const continuityBridge = resolveContinuityBridge(selectedScene, shot, index);

                  return (
                  <div key={shot.id} className="bg-zinc-950 border border-zinc-900 rounded-2xl p-4 space-y-3 shadow-lg">
                    <div className="text-[11px] font-mono text-zinc-400 italic">Project Title:</div>
                    <div className="space-y-1">
                      <div className="text-sm font-semibold text-white truncate">{selectedScene.title}</div>
                      <div className="text-[11px] font-mono text-zinc-500">Storyboard panel {index + 1}</div>
                    </div>

                    <div className="text-[11px] font-mono text-zinc-400">Scene Number: {scenes.findIndex(scene => scene.id === selectedScene.id) + 1}</div>

                    <div className="aspect-[4/3] rounded-xl border-2 border-zinc-800 overflow-hidden bg-zinc-900/60 relative">
                      {anchorFrame?.url ? (
                        <img src={anchorFrame.url} alt={`${shot.title} anchor frame`} className="w-full h-full object-cover" referrerPolicy="no-referrer" />
                      ) : activeBackground ? (
                        <img src={activeBackground} alt={`${shot.title} storyboard background`} className="w-full h-full object-cover opacity-70" referrerPolicy="no-referrer" />
                      ) : (
                        <div className="w-full h-full bg-[radial-gradient(circle_at_top,_rgba(99,102,241,0.18),_transparent_45%)]" />
                      )}
                      <div className="absolute inset-x-0 top-0 h-5 bg-[repeating-linear-gradient(90deg,rgba(255,255,255,0.85)_0_8px,transparent_8px_14px)] opacity-30" />
                      <div className="absolute inset-x-0 bottom-0 h-5 bg-[repeating-linear-gradient(90deg,rgba(255,255,255,0.85)_0_8px,transparent_8px_14px)] opacity-30" />
                      <div className="absolute top-2 left-2 bg-zinc-950/85 border border-zinc-700/80 rounded-full px-2 py-1 text-[9px] font-mono uppercase tracking-wider text-white">
                        Shot {index + 1}
                      </div>
                      {anchorFrame && (
                        <div className="absolute bottom-2 left-2 bg-emerald-500/85 rounded-full px-2 py-1 text-[9px] font-mono uppercase tracking-wider text-white">
                          Anchor
                        </div>
                      )}
                    </div>

                    <div className="grid grid-cols-1 gap-2 text-[10px] font-semibold text-zinc-200 sm:grid-cols-3">
                      <div className="bg-zinc-900 rounded-lg px-2 py-1.5">Shot {index + 1}</div>
                      <div className="bg-zinc-900 rounded-lg px-2 py-1.5 truncate" title={shot.shotType}>{shot.shotType}</div>
                      <div className="bg-zinc-900 rounded-lg px-2 py-1.5">{shot.durationSeconds}s</div>
                    </div>

                    <div className="flex flex-wrap gap-2 text-[10px] font-mono">
                      <span className="bg-zinc-900 rounded-full px-2 py-1 text-zinc-300 border border-zinc-800">
                        {formatSeedStrategyLabel(shot.seedStrategy || 'auto')}
                      </span>
                      <span className="bg-zinc-900 rounded-full px-2 py-1 text-zinc-400 border border-zinc-800">
                        {shot.lastRenderSeed ? `Seed ${shot.lastRenderSeed.toLocaleString()}` : 'Seed pending'}
                      </span>
                      <span className="bg-zinc-900 rounded-full px-2 py-1 text-zinc-400 border border-zinc-800">
                        {formatTransitionModeLabel(shot.transitionInMode || 'none')}
                      </span>
                    </div>

                    <div className="rounded-xl border border-zinc-900 bg-zinc-900/50 px-3 py-2 text-[10px] font-mono text-zinc-500 leading-relaxed">
                      {continuityBridge.summary}
                    </div>

                    <div className="space-y-2 text-[11px] text-zinc-300 leading-relaxed">
                      <p className="min-h-[38px]">{shot.title}</p>
                      <div className="border-t border-zinc-900 pt-2 min-h-[44px]">{getShotDialogueExcerpt(selectedScene, characters, shot) || shot.action}</div>
                    </div>
                  </div>
                );})}
              </div>
            ) : (
              <div className="rounded-2xl border border-dashed border-zinc-800 bg-zinc-950/40 px-5 py-10 text-center text-zinc-500 text-sm space-y-2">
                <p>No storyboard shots found for this scene yet.</p>
                <p className="text-[11px] font-mono">Build the board first, then render each shot as its own clip to avoid dialogue compression.</p>
              </div>
            )}

            {storyboardRunStatus === 'rendering' && storyboardJobs.length > 0 && (
              <div className="bg-zinc-950/60 border border-zinc-900 p-4 rounded-xl space-y-3 animate-in fade-in duration-300">
                <div className="flex justify-between items-center text-[10.5px] font-mono">
                  <span className="text-zinc-400 flex items-center gap-1.5">
                    <RefreshCw className="w-3.5 h-3.5 text-indigo-400 animate-spin" />
                    <span>{storyboardProgressText || 'Storyboard sequence compiling...'}</span>
                  </span>
                  <span className="text-indigo-400 font-bold">{storyboardCompletionPercent}%</span>
                </div>
                <progress
                  className="storyforge-progress w-full h-1.5"
                  value={storyboardCompletionPercent}
                  max={100}
                />
                <p className="text-[9px] font-mono text-zinc-500 text-center leading-tight">
                  Storyboard mode renders one Veo clip per shot, which is how the project avoids compressing long dialogue into a single 8–10 second video.
                </p>
              </div>
            )}

            {storyboardJobs.length > 0 && (
              <div className="space-y-3">
                <div className="flex items-center justify-between">
                  <h4 className="text-sm font-semibold text-white flex items-center gap-2">
                    <Layers className="w-4 h-4 text-indigo-400" />
                    <span>Shot Queue</span>
                  </h4>
                  <span className="text-[10px] font-mono text-zinc-500 uppercase tracking-widest">{storyboardJobs.length} clip jobs</span>
                </div>

                <div className="space-y-3">
                  {storyboardJobs.map((job, index) => {
                    const shot = storyboardShots.find(item => item.id === job.shotId);
                    const previousShot = index > 0 ? storyboardShots[index - 1] : undefined;
                    const continuityBridge = shot && selectedScene ? resolveContinuityBridge(selectedScene, shot, index) : null;
                    return (
                      <div key={job.shotId} className="bg-zinc-950 border border-zinc-900 rounded-2xl p-4 space-y-3">
                        <div className="flex items-start justify-between gap-3">
                          <div>
                            <div className="text-xs font-semibold text-white">Shot {index + 1}: {job.title}</div>
                            <div className="text-[10px] font-mono text-zinc-500 mt-1">
                              {job.usingReferenceImages ? 'Reference-image mode (Veo 3.1 / 8s)' : 'Prompt-only mode'}
                              {job.durationSeconds ? ` • ${job.durationSeconds}s` : ''}
                            </div>
                          </div>
                          <span className={`text-[10px] font-mono uppercase tracking-wider px-2 py-1 rounded-full ${
                            job.status === 'completed' ? 'bg-emerald-500/10 text-emerald-400 border border-emerald-500/20' :
                            job.status === 'failed' ? 'bg-red-500/10 text-red-400 border border-red-500/20' :
                            job.status === 'rendering' || job.status === 'starting' ? 'bg-indigo-500/10 text-indigo-300 border border-indigo-500/20' :
                            'bg-zinc-900 text-zinc-500 border border-zinc-800'
                          }`}>{job.status}</span>
                        </div>

                        <div className="text-[11px] text-zinc-300 leading-relaxed min-h-[32px]">
                          {shot ? (getShotDialogueExcerpt(selectedScene!, characters, shot) || shot.action) : 'Awaiting shot details.'}
                        </div>

                        <div className="grid grid-cols-1 gap-2 sm:grid-cols-4">
                          <div className="rounded-xl border border-zinc-900 bg-zinc-900/60 px-3 py-2">
                            <div className="text-[9px] font-mono uppercase tracking-wider text-zinc-500">Seed strategy</div>
                            <div className="mt-1 text-[11px] text-zinc-200">{formatSeedStrategyLabel(job.seedStrategy || shot?.seedStrategy || 'auto')}</div>
                          </div>
                          <div className="rounded-xl border border-zinc-900 bg-zinc-900/60 px-3 py-2">
                            <div className="text-[9px] font-mono uppercase tracking-wider text-zinc-500">Resolved seed</div>
                            <div className="mt-1 text-[11px] text-zinc-200">
                              {job.resolvedSeed ? job.resolvedSeed.toLocaleString() : (shot?.lastRenderSeed ? shot.lastRenderSeed.toLocaleString() : 'Pending')}
                            </div>
                          </div>
                          <div className="rounded-xl border border-zinc-900 bg-zinc-900/60 px-3 py-2">
                            <div className="text-[9px] font-mono uppercase tracking-wider text-zinc-500">Seed source</div>
                            <div className="mt-1 text-[11px] text-zinc-200">{formatSeedSourceLabel(job.seedSource)}</div>
                          </div>
                          <div className="rounded-xl border border-zinc-900 bg-zinc-900/60 px-3 py-2">
                            <div className="text-[9px] font-mono uppercase tracking-wider text-zinc-500">Bridge frame</div>
                            <div className="mt-1 text-[11px] text-zinc-200">{formatTransitionModeLabel(shot?.transitionInMode || 'none')}</div>
                          </div>
                        </div>

                        {job.usingContinuityFrame && (
                          <div className="rounded-xl border border-emerald-500/15 bg-emerald-500/5 px-3 py-2.5 text-[10px] font-mono text-emerald-300 leading-relaxed">
                            Runtime continuity bridge used: {job.continuitySource || 'A continuity frame was applied for this shot.'}
                          </div>
                        )}

                        {continuityBridge && (
                          <div className="rounded-xl border border-zinc-900 bg-zinc-900/40 px-3 py-2.5 text-[10px] font-mono text-zinc-500 leading-relaxed">
                            {continuityBridge.summary}
                          </div>
                        )}

                        {shot && (
                          <div className="rounded-xl border border-zinc-900 bg-zinc-900/40 px-3 py-2.5 text-[10px] font-mono text-zinc-500 leading-relaxed">
                            {describeSeedLineage(shot, index, job, previousShot)}
                          </div>
                        )}

                        {job.status === 'completed' && job.operationName && (
                          <div className="space-y-2">
                            <div className="border border-zinc-900 bg-zinc-900 rounded-xl overflow-hidden aspect-video">
                              <video
                                src={`/api/video-download?operationName=${encodeURIComponent(job.operationName)}`}
                                controls
                                className="w-full h-full object-contain"
                                referrerPolicy="no-referrer"
                              />
                            </div>
                            <div className="flex flex-wrap justify-end gap-2">
                              <button
                                type="button"
                                onClick={() => saveShotAnchorFrame(job)}
                                disabled={savingAnchorShotId === job.shotId || !job.operationName}
                                className="bg-emerald-950 hover:bg-emerald-900 border border-emerald-500/20 text-emerald-300 px-3 py-1.5 rounded-lg text-xs font-semibold flex items-center gap-1 transition-all disabled:opacity-50"
                              >
                                <Clapperboard className="w-3 h-3" />
                                <span>{savingAnchorShotId === job.shotId ? 'Saving anchor...' : (shot?.boardImageId ? 'Refresh anchor frame' : 'Save anchor frame')}</span>
                              </button>
                              <button
                                type="button"
                                onClick={() => retryStoryboardShot(job.shotId, 'same')}
                                disabled={job.status === 'starting' || job.status === 'rendering'}
                                className="bg-indigo-950 hover:bg-indigo-900 border border-indigo-500/20 text-indigo-300 px-3 py-1.5 rounded-lg text-xs font-semibold flex items-center gap-1 transition-all disabled:opacity-50"
                              >
                                <RefreshCw className="w-3 h-3" />
                                <span>Retry same seed</span>
                              </button>
                              <button
                                type="button"
                                onClick={() => retryStoryboardShot(job.shotId, 'new')}
                                disabled={job.status === 'starting' || job.status === 'rendering'}
                                className="bg-zinc-900 hover:bg-zinc-800 border border-zinc-700 text-zinc-200 px-3 py-1.5 rounded-lg text-xs font-semibold flex items-center gap-1 transition-all disabled:opacity-50"
                              >
                                <RefreshCw className="w-3 h-3" />
                                <span>Retry new seed</span>
                              </button>
                              <button
                                onClick={() => {
                                  const anchor = document.createElement('a');
                                  anchor.href = `/api/video-download?operationName=${encodeURIComponent(job.operationName || '')}`;
                                  anchor.download = `storyforge-shot-${index + 1}-${Date.now()}.mp4`;
                                  document.body.appendChild(anchor);
                                  anchor.click();
                                  document.body.removeChild(anchor);
                                }}
                                className="bg-zinc-800 hover:bg-zinc-700 text-zinc-200 hover:text-white px-3 py-1.5 rounded-lg text-xs font-medium flex items-center gap-1 transition-all cursor-pointer"
                              >
                                <Download className="w-3 h-3" />
                                <span>Download shot</span>
                              </button>
                            </div>
                          </div>
                        )}

                        {job.status === 'failed' && (
                          <div className="space-y-2">
                            <div className="bg-red-950/20 border border-red-500/10 rounded-xl p-3 text-[11px] text-zinc-300">
                              {job.error || 'Storyboard shot render failed.'}
                            </div>
                            <div className="flex flex-wrap justify-end gap-2">
                              <button
                                type="button"
                                onClick={() => retryStoryboardShot(job.shotId, 'same')}
                                disabled={job.status === 'starting' || job.status === 'rendering'}
                                className="bg-indigo-950 hover:bg-indigo-900 border border-indigo-500/20 text-indigo-300 px-3 py-1.5 rounded-lg text-xs font-semibold flex items-center gap-1 transition-all disabled:opacity-50"
                              >
                                <RefreshCw className="w-3 h-3" />
                                <span>Retry same seed</span>
                              </button>
                              <button
                                type="button"
                                onClick={() => retryStoryboardShot(job.shotId, 'new')}
                                disabled={job.status === 'starting' || job.status === 'rendering'}
                                className="bg-zinc-900 hover:bg-zinc-800 border border-zinc-700 text-zinc-200 px-3 py-1.5 rounded-lg text-xs font-semibold flex items-center gap-1 transition-all disabled:opacity-50"
                              >
                                <RefreshCw className="w-3 h-3" />
                                <span>Retry new seed</span>
                              </button>
                            </div>
                          </div>
                        )}

                        {job.isQuotaExhausted && (
                          <div className="bg-amber-500/5 border border-amber-500/10 rounded-xl p-3 text-[11px] text-zinc-300">
                            Veo quota was exhausted for this shot, so sandbox fallback media was used instead.
                          </div>
                        )}
                      </div>
                    );
                  })}
                </div>
              </div>
            )}

            {storyboardRunStatus === 'completed' && storyboardRenderedJobs.length > 0 && (
              <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between bg-emerald-500/5 border border-emerald-500/10 px-3 py-3 rounded-xl">
                <div className="text-[10px] font-mono text-emerald-400 flex items-center gap-1">
                  ● Storyboard sequence render complete — long dialogue has been preserved as separate shot clips instead of a single compressed preview.
                </div>
                <button
                  type="button"
                  onClick={handleDownloadStoryboardManifest}
                  className="bg-zinc-100 hover:bg-white text-zinc-950 text-xs font-semibold px-3 py-2 rounded-xl flex items-center gap-1.5 shadow-lg transition-colors"
                >
                  <Download className="w-3.5 h-3.5" />
                  <span>Download Manifest</span>
                </button>
              </div>
            )}

            {storyboardRunStatus === 'failed' && storyboardJobs.length > 0 && (
              <div className="text-[10px] font-mono text-amber-400 flex items-center gap-1 bg-amber-500/5 border border-amber-500/10 px-3 py-2 rounded-xl">
                ● Storyboard render finished with issues. Completed shots are still available below and you can re-run the sequence.
              </div>
            )}
          </div>
        )}
      </div>

      <div className="bg-zinc-950 border border-zinc-900 rounded-2xl p-4 space-y-4">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2">
            <Terminal className="w-4 h-4 text-emerald-400" />
            <span className="text-xs font-semibold text-zinc-200 font-sans">Live Pipeline Bridge Link</span>
          </div>

          <button
            onClick={handleTriggerSync}
            disabled={isSocketConnecting}
            className={`flex items-center gap-1 text-[10px] font-mono font-medium tracking-tight px-3 py-1 rounded-full border cursor-pointer transition-all ${
              isSocketConnecting
                ? 'bg-amber-500/10 text-amber-400 border-amber-500/20'
                : 'bg-emerald-500/10 text-emerald-400 border-emerald-500/20 hover:bg-emerald-500/20'
            }`}
          >
            <RefreshCw className={`w-3 h-3 ${isSocketConnecting ? 'animate-spin' : ''}`} />
            <span>{isSocketConnecting ? 'Pushing sync packet...' : 'Trigger Live Sync'}</span>
          </button>
        </div>

        <div className="bg-zinc-900/90 rounded-xl p-3 aspect-[4/2] overflow-y-auto font-mono text-[10px] text-zinc-400 space-y-1 scrollbar-thin scrollbar-thumb-zinc-850">
          {syncLogs.map((log, index) => (
            <div key={index} className={log.includes('Push') || log.includes('handshake') ? 'text-emerald-400' : 'text-zinc-500'}>
              {log}
            </div>
          ))}
        </div>
      </div>

      <div className="space-y-2">
        <div className="flex items-center justify-between">
          <label className="text-[10px] font-mono text-zinc-400 uppercase tracking-widest block">Local Continuity Engine Blueprint Schema</label>
          <div className="flex gap-2">
            <button
              onClick={handleCopyPayload}
              className="p-1 px-2 hover:bg-zinc-800 rounded text-zinc-400 hover:text-white transition-all text-xs flex items-center gap-1 font-mono cursor-pointer"
            >
              {copied ? <Check className="w-3 h-3 text-emerald-400" /> : <Copy className="w-3 h-3" />}
              <span>{copied ? 'Copied' : 'JSON schema'}</span>
            </button>
          </div>
        </div>

        <div className="relative">
          <textarea
            readOnly
            title="Export payload schema"
            value={syncPayload}
            className="w-full bg-zinc-900/30 border border-zinc-900 rounded-2xl p-4 text-[10.5px] font-mono text-zinc-500 h-[180px] resize-none focus:outline-none focus:ring-0 leading-relaxed"
          />
          <button
            onClick={handleDownloadPayload}
            className="absolute bottom-4 right-4 bg-zinc-100 text-zinc-900 hover:bg-white text-xs font-semibold px-4 py-2 rounded-xl flex items-center gap-1.5 shadow-lg cursor-pointer transition-colors"
          >
            <Download className="w-3.5 h-3.5" />
            <span>Save Profile</span>
          </button>
        </div>
      </div>
    </div>
  );
}
