import React, { useMemo, useState } from 'react';
import { ArrowUpRight, Camera, Check, Clapperboard, Copy, Download, Film, RefreshCw, Scissors, Sparkles, Users } from 'lucide-react';
import type { AppViewState, CameraConfig, Character, ProjectTimelineManifest, Scene, TimelineClip } from '../types';
import { buildProjectTimelineManifest, getShotDialogueExcerpt, getStoryboardShotActiveGeneratedClip, syncSceneTimeline } from '../utils/storyforge';

interface TimelineViewProps {
  scenes: Scene[];
  characters: Character[];
  camera: CameraConfig;
  onSaveScenes: (scenes: Scene[]) => void;
  onUpdateCamera: (config: CameraConfig) => void;
  onOpenWorkspace?: (view: AppViewState) => void;
  activeWorkspace?: AppViewState | null;
}

function formatSeconds(value: number) {
  const rounded = Math.round(value * 10) / 10;
  return Number.isInteger(rounded) ? `${rounded.toFixed(0)}s` : `${rounded.toFixed(1)}s`;
}

function buildClipLabel(createdAt: string, durationSeconds: number, resolvedSeed?: number | null) {
  const time = new Date(createdAt).toLocaleString([], {
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
  });

  return `${time} • ${formatSeconds(durationSeconds)}${resolvedSeed ? ` • seed ${resolvedSeed}` : ''}`;
}

const SHOT_TYPE_OPTIONS: Array<{ value: CameraConfig['shotType']; label: string }> = [
  { value: 'close-up', label: 'Close-up' },
  { value: 'medium-shot', label: 'Medium' },
  { value: 'cowboy-shot', label: 'Cowboy' },
  { value: 'wide-landscape', label: 'Wide' },
];

const FOCAL_LENGTH_OPTIONS = [24, 35, 50, 85];

export function TimelineView({
  scenes,
  characters,
  camera,
  onSaveScenes,
  onUpdateCamera,
  onOpenWorkspace,
  activeWorkspace = null,
}: TimelineViewProps) {
  const [copied, setCopied] = useState(false);
  const [promptDraft, setPromptDraft] = useState('');
  const [selectedPreviewClipId, setSelectedPreviewClipId] = useState<string | null>(null);
  const syncedScenes = useMemo(() => scenes.map(syncSceneTimeline), [scenes]);
  const manifest = useMemo<ProjectTimelineManifest>(() => buildProjectTimelineManifest(scenes), [scenes]);
  const manifestJson = useMemo(() => JSON.stringify(manifest, null, 2), [manifest]);
  const includedTimelineClips = useMemo(
    () => [...manifest.clips].filter((clip) => clip.includeInCut).sort((left, right) => left.order - right.order),
    [manifest],
  );
  const readyTimelineClips = useMemo(
    () => includedTimelineClips.filter((clip) => !!clip.clipUrl),
    [includedTimelineClips],
  );
  const selectedPreviewClip = useMemo(
    () => readyTimelineClips.find((clip) => clip.clipId === selectedPreviewClipId)
      || readyTimelineClips[0]
      || includedTimelineClips[0]
      || null,
    [includedTimelineClips, readyTimelineClips, selectedPreviewClipId],
  );

  const selectedScene = useMemo(
    () => scenes.find((scene) => scene.id === selectedPreviewClip?.sceneId) || null,
    [scenes, selectedPreviewClip?.sceneId],
  );
  const selectedShot = useMemo(
    () => selectedScene?.storyboardShots?.find((shot) => shot.id === selectedPreviewClip?.shotId) || null,
    [selectedPreviewClip?.shotId, selectedScene],
  );
  const availableClips = selectedShot?.generatedClips || [];
  const selectedSourceClip = availableClips.find((candidate) => candidate.id === selectedPreviewClip?.selectedSourceClipId)
    || getStoryboardShotActiveGeneratedClip(selectedShot || undefined);
  const maxTrimEnd = selectedSourceClip?.durationSeconds || selectedPreviewClip?.sourceDurationSeconds || 8;

  const refreshTimeline = () => {
    onSaveScenes(syncedScenes);
  };

  const updateTimelineClip = (sceneId: string, shotId: string, updates: Partial<TimelineClip>) => {
    onSaveScenes(scenes.map((scene) => {
      if (scene.id !== sceneId) {
        return scene;
      }

      return {
        ...scene,
        timelineClips: (scene.timelineClips || []).map((clip) => (
          clip.shotId === shotId
            ? { ...clip, ...updates, updatedAt: new Date().toISOString() }
            : clip
        )),
      };
    }));
  };

  const copyManifest = async () => {
    await navigator.clipboard.writeText(manifestJson);
    setCopied(true);
    window.setTimeout(() => setCopied(false), 1800);
  };

  const downloadManifest = () => {
    const blob = new Blob([manifestJson], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement('a');
    anchor.href = url;
    anchor.download = 'storyforge-timeline-manifest.json';
    anchor.click();
    URL.revokeObjectURL(url);
  };

  const workspaceQuickActions: Array<{
    id: Extract<AppViewState, 'characters' | 'scenes' | 'export'>;
    label: string;
    hint: string;
    icon: React.ComponentType<{ className?: string }>;
  }> = [
    {
      id: 'characters',
      label: 'Roster',
      hint: 'Character continuity and references',
      icon: Users,
    },
    {
      id: 'scenes',
      label: 'Scene',
      hint: 'Acts, dialogue, and background continuity',
      icon: Clapperboard,
    },
    {
      id: 'export',
      label: 'Pipeline',
      hint: 'Generate, assemble, and export the cut',
      icon: ArrowUpRight,
    },
  ];

  return (
    <div className="space-y-4 animate-in fade-in duration-300" data-testid="timeline-shell">
      <section className="rounded-[24px] border border-zinc-900 bg-zinc-950/82 p-3 md:p-4 shadow-xl shadow-black/20">
        <div className="flex flex-col gap-3 lg:flex-row lg:items-start lg:justify-between">
          <div className="space-y-1.5">
            <div className="inline-flex items-center gap-2 rounded-full border border-indigo-500/20 bg-indigo-500/10 px-3 py-1 text-[10px] font-mono uppercase tracking-[0.22em] text-indigo-300">
              <Sparkles className="h-3.5 w-3.5" />
              <span>Timeline-first generation</span>
            </div>
            <div>
              <h2 className="text-base font-semibold tracking-tight text-white">Main editing canvas</h2>
              <p className="mt-1 max-w-3xl text-[12px] leading-relaxed text-zinc-400">
                Timeline remains the main filmmaking surface. Scene, roster, and pipeline tools now feed this cut as persistent popups.
              </p>
            </div>
          </div>

          <div className="flex flex-wrap items-center gap-2">
            <button
              type="button"
              onClick={refreshTimeline}
              className="inline-flex items-center gap-1.5 rounded-xl border border-zinc-800 bg-zinc-900 px-3 py-2 text-xs font-semibold text-zinc-200 transition-colors hover:bg-zinc-800"
              data-testid="refresh-timeline"
            >
              <RefreshCw className="h-3.5 w-3.5" />
              <span>Refresh Timeline</span>
            </button>
            <button
              type="button"
              onClick={copyManifest}
              className="inline-flex items-center gap-1.5 rounded-xl border border-zinc-800 bg-zinc-900 px-3 py-2 text-xs font-semibold text-zinc-200 transition-colors hover:bg-zinc-800"
            >
              {copied ? <Check className="h-3.5 w-3.5 text-emerald-400" /> : <Copy className="h-3.5 w-3.5" />}
              <span>{copied ? 'Copied' : 'Copy Manifest'}</span>
            </button>
            <button
              type="button"
              onClick={downloadManifest}
              className="inline-flex items-center gap-1.5 rounded-xl border border-indigo-500/20 bg-indigo-600/15 px-3 py-2 text-xs font-semibold text-indigo-300 transition-colors hover:bg-indigo-600/25"
            >
              <Download className="h-3.5 w-3.5" />
              <span>Download Flattened JSON</span>
            </button>
          </div>
        </div>

        <div className="mt-3 grid gap-3 xl:grid-cols-[minmax(0,1fr)_300px]">
          <div className="space-y-3">
            <div className="overflow-hidden rounded-[20px] border border-zinc-900 bg-zinc-950" data-testid="timeline-preview">
              <div className="aspect-[16/7.3] bg-[radial-gradient(circle_at_top,_rgba(99,102,241,0.16),_transparent_42%),linear-gradient(180deg,rgba(24,24,27,0.15),rgba(9,9,11,0.96))]">
                {selectedPreviewClip?.clipUrl ? (
                  <video
                    key={selectedPreviewClip.clipId}
                    src={selectedPreviewClip.clipUrl}
                    controls
                    className="h-full w-full object-contain"
                    referrerPolicy="no-referrer"
                  />
                ) : (
                  <div className="flex h-full flex-col items-center justify-center gap-2 px-5 text-center">
                    <div className="inline-flex h-10 w-10 items-center justify-center rounded-full border border-zinc-800 bg-zinc-900/80">
                      <Film className="h-4 w-4 text-indigo-400" />
                    </div>
                    <div>
                      <div className="text-sm font-semibold text-white">Preview player</div>
                      <p className="mt-1 max-w-md text-[11px] leading-relaxed text-zinc-500">
                        Render storyboard clips to preview the selected beat from the current cut.
                      </p>
                    </div>
                  </div>
                )}
              </div>
            </div>

            <div className="rounded-[20px] border border-zinc-900 bg-zinc-950/70 p-3" data-testid="timeline-scrubber">
              <div className="flex items-center justify-between gap-3">
                <div>
                  <div className="text-[10px] font-mono uppercase tracking-[0.24em] text-zinc-500">Project timeline</div>
                  <div className="mt-1 text-sm font-semibold text-white">
                    {includedTimelineClips.length ? `${includedTimelineClips.length} beats in the current cut` : 'No beats included yet'}
                  </div>
                </div>
                <div className="text-right text-[10px] font-mono text-zinc-500">
                  <div>{readyTimelineClips.length} playable clips</div>
                  <div>{formatSeconds(manifest.estimatedDurationSeconds)} runtime</div>
                </div>
              </div>

              <div className="mt-3">
                {includedTimelineClips.length ? (
                  <div className="flex items-center gap-2 overflow-x-auto pb-1">
                    <span className="shrink-0 text-[10px] font-mono text-zinc-500">00:00</span>
                    <div className="flex min-w-full gap-2">
                      {includedTimelineClips.map((clip) => (
                        <button
                          key={clip.clipId}
                          type="button"
                          onClick={() => setSelectedPreviewClipId(clip.clipId)}
                          className={`group flex min-w-[120px] items-center gap-2 rounded-2xl border px-3 py-2 text-left transition-colors ${
                            selectedPreviewClip?.clipId === clip.clipId
                              ? 'border-indigo-500/40 bg-indigo-500/10 text-indigo-200'
                              : clip.dirty
                                ? 'border-amber-500/20 bg-amber-500/5 text-amber-100'
                                : 'border-zinc-800 bg-zinc-900/70 text-zinc-200 hover:bg-zinc-900'
                          }`}
                          style={{ flex: `${Math.max(clip.playbackDurationSeconds, 1.2)} 0 0` }}
                          data-testid={`timeline-beat-${clip.clipId}`}
                        >
                          <div className="min-w-0 flex-1">
                            <div className="truncate text-[9px] font-mono uppercase tracking-[0.18em] text-zinc-500 group-hover:text-zinc-400">
                              {clip.sceneTitle}
                            </div>
                            <div className="truncate text-xs font-semibold">{clip.title}</div>
                          </div>
                          <div className="shrink-0 rounded-full border border-zinc-800 bg-zinc-950/80 px-2 py-1 text-[9px] font-mono text-zinc-400">
                            {formatSeconds(clip.playbackDurationSeconds)}
                          </div>
                        </button>
                      ))}
                    </div>
                    <span className="shrink-0 text-[10px] font-mono text-zinc-500">
                      {formatSeconds(manifest.estimatedDurationSeconds)}
                    </span>
                  </div>
                ) : (
                  <div className="rounded-2xl border border-dashed border-zinc-800 bg-zinc-950/40 px-4 py-4 text-sm text-zinc-500">
                    Build storyboard shots, render clips, then choose which beats belong in the cut.
                  </div>
                )}
              </div>
            </div>
          </div>

          <aside className="rounded-[20px] border border-zinc-900 bg-zinc-950/72 p-3" data-testid="current-beat-panel">
            <div className="text-[10px] font-mono uppercase tracking-[0.24em] text-zinc-500">Current beat</div>
            <div className="mt-2 rounded-[18px] border border-zinc-900 bg-zinc-900/40 p-3">
              <div className="text-sm font-semibold text-white">
                {selectedPreviewClip?.title || 'Select a beat from the timeline'}
              </div>
              <div className="mt-1 text-[11px] leading-relaxed text-zinc-500">
                {selectedPreviewClip
                  ? `${selectedPreviewClip.sceneTitle} • Shot ${selectedPreviewClip.shotNumber}`
                  : 'The selected beat stays visible here while the rest of the shell focuses on the edit controls below.'}
              </div>

              <div className="mt-3 grid grid-cols-2 gap-2">
                <div className="rounded-2xl border border-zinc-900 bg-zinc-950/80 p-2.5">
                  <div className="text-[9px] font-mono uppercase tracking-[0.18em] text-zinc-500">Playback</div>
                  <div className="mt-1 text-sm font-semibold text-zinc-100">
                    {selectedPreviewClip ? formatSeconds(selectedPreviewClip.playbackDurationSeconds) : '—'}
                  </div>
                </div>
                <div className="rounded-2xl border border-zinc-900 bg-zinc-950/80 p-2.5">
                  <div className="text-[9px] font-mono uppercase tracking-[0.18em] text-zinc-500">Trim window</div>
                  <div className="mt-1 text-sm font-semibold text-zinc-100">
                    {selectedPreviewClip
                      ? `${formatSeconds(selectedPreviewClip.trimStartSeconds)} - ${formatSeconds(selectedPreviewClip.trimEndSeconds)}`
                      : '—'}
                  </div>
                </div>
              </div>

              <div className="mt-3 rounded-2xl border border-zinc-900 bg-zinc-950/60 px-3 py-2.5 text-[11px] leading-relaxed text-zinc-400">
                {selectedPreviewClip?.dirtyReason || 'This beat is clean. Use the controls below to refine source selection, trims, camera framing, or open a popup workspace.'}
              </div>
            </div>
          </aside>
        </div>

        <div className="mt-3 grid gap-3 xl:grid-cols-[minmax(0,1fr)_340px]">
          <section className="rounded-[20px] border border-zinc-900 bg-zinc-950/72 p-3" data-testid="camera-dock">
            <div className="flex items-center gap-2">
              <Camera className="h-4 w-4 text-indigo-400" />
              <div>
                <div className="text-sm font-semibold text-white">Camera dock</div>
                <div className="text-[11px] leading-relaxed text-zinc-500">
                  Inline camera controls now live below the scrubber instead of competing as a separate workspace.
                </div>
              </div>
            </div>

            <div className="mt-3 grid gap-3 md:grid-cols-[180px_minmax(0,1fr)]">
              <div className="rounded-[18px] border border-zinc-900 bg-zinc-950/80 p-3">
                <div className="text-[9px] font-mono uppercase tracking-[0.18em] text-zinc-500">Active frame</div>
                <div className="mt-2 aspect-[4/3] rounded-2xl border border-zinc-800 bg-[radial-gradient(circle_at_center,_rgba(99,102,241,0.1),_transparent_55%)] p-3">
                  <div className={`flex h-full items-center justify-center rounded-2xl border border-indigo-500/20 ${camera.aspectRatio === '16:9' ? 'aspect-[16/9]' : 'aspect-[9/16]'} max-h-full w-full bg-zinc-950/70`}>
                    <div className="h-10 w-10 rounded-full border border-dashed border-indigo-400/40" />
                  </div>
                </div>
              </div>

              <div className="grid gap-3">
                <div className="grid gap-3 sm:grid-cols-2">
                  <label className="space-y-1">
                    <span className="text-[10px] font-mono uppercase tracking-[0.18em] text-zinc-500">Shot type</span>
                    <select
                      value={camera.shotType}
                      onChange={(event) => onUpdateCamera({ ...camera, shotType: event.target.value as CameraConfig['shotType'] })}
                      className="w-full rounded-xl border border-zinc-800 bg-zinc-900 px-3 py-2 text-sm text-zinc-200 outline-none transition-colors focus:border-indigo-500/40"
                    >
                      {SHOT_TYPE_OPTIONS.map((option) => (
                        <option key={option.value} value={option.value}>{option.label}</option>
                      ))}
                    </select>
                  </label>

                  <label className="space-y-1">
                    <span className="text-[10px] font-mono uppercase tracking-[0.18em] text-zinc-500">Angle</span>
                    <select
                      value={camera.tiltAngle}
                      onChange={(event) => onUpdateCamera({ ...camera, tiltAngle: event.target.value as CameraConfig['tiltAngle'] })}
                      className="w-full rounded-xl border border-zinc-800 bg-zinc-900 px-3 py-2 text-sm text-zinc-200 outline-none transition-colors focus:border-indigo-500/40"
                    >
                      <option value="low">Low</option>
                      <option value="eye-level">Eye level</option>
                      <option value="high">High</option>
                    </select>
                  </label>
                </div>

                <div className="grid gap-3 sm:grid-cols-2">
                  <div className="space-y-1">
                    <span className="text-[10px] font-mono uppercase tracking-[0.18em] text-zinc-500">Aspect</span>
                    <div className="grid grid-cols-2 gap-2">
                      {(['16:9', '9:16'] as CameraConfig['aspectRatio'][]).map((aspect) => (
                        <button
                          key={aspect}
                          type="button"
                          onClick={() => onUpdateCamera({ ...camera, aspectRatio: aspect })}
                          className={`rounded-xl border px-3 py-2 text-xs font-semibold transition-colors ${
                            camera.aspectRatio === aspect
                              ? 'border-indigo-500/30 bg-indigo-500/10 text-indigo-200'
                              : 'border-zinc-800 bg-zinc-900 text-zinc-300 hover:bg-zinc-800'
                          }`}
                        >
                          {aspect}
                        </button>
                      ))}
                    </div>
                  </div>

                  <div className="space-y-1">
                    <span className="text-[10px] font-mono uppercase tracking-[0.18em] text-zinc-500">Grid</span>
                    <button
                      type="button"
                      onClick={() => onUpdateCamera({ ...camera, showRuleOfThirds: !camera.showRuleOfThirds })}
                      className={`w-full rounded-xl border px-3 py-2 text-xs font-semibold transition-colors ${
                        camera.showRuleOfThirds
                          ? 'border-indigo-500/30 bg-indigo-500/10 text-indigo-200'
                          : 'border-zinc-800 bg-zinc-900 text-zinc-300 hover:bg-zinc-800'
                      }`}
                    >
                      {camera.showRuleOfThirds ? 'Rule of thirds on' : 'Rule of thirds off'}
                    </button>
                  </div>
                </div>

                <div className="space-y-1">
                  <span className="text-[10px] font-mono uppercase tracking-[0.18em] text-zinc-500">Lens</span>
                  <div className="grid grid-cols-4 gap-2">
                    {FOCAL_LENGTH_OPTIONS.map((focalLength) => (
                      <button
                        key={focalLength}
                        type="button"
                        onClick={() => onUpdateCamera({ ...camera, focalLength })}
                        className={`rounded-xl border px-3 py-2 text-xs font-semibold transition-colors ${
                          camera.focalLength === focalLength
                            ? 'border-zinc-100 bg-zinc-100 text-zinc-950'
                            : 'border-zinc-800 bg-zinc-900 text-zinc-300 hover:bg-zinc-800'
                        }`}
                      >
                        {focalLength}mm
                      </button>
                    ))}
                  </div>
                </div>
              </div>
            </div>
          </section>

          <section className="rounded-[20px] border border-zinc-900 bg-zinc-950/72 p-3" data-testid="beat-inspector">
            <div className="text-[10px] font-mono uppercase tracking-[0.24em] text-zinc-500">Beat inspector</div>
            {selectedPreviewClip && selectedScene && selectedShot ? (
              <div className="mt-2 space-y-3">
                <div>
                  <div className="text-sm font-semibold text-white">{selectedPreviewClip.title}</div>
                  <div className="mt-1 text-[11px] leading-relaxed text-zinc-500">
                    {getShotDialogueExcerpt(selectedScene, characters, selectedShot) || selectedShot.action}
                  </div>
                </div>

                <label className="space-y-1">
                  <span className="text-[10px] font-mono uppercase tracking-[0.18em] text-zinc-500">Source clip version</span>
                  <select
                    value={selectedPreviewClip.selectedSourceClipId || ''}
                    onChange={(event) => updateTimelineClip(selectedScene.id, selectedShot.id, {
                      selectedSourceClipId: event.target.value || null,
                    })}
                    className="w-full rounded-xl border border-zinc-800 bg-zinc-900 px-3 py-2 text-sm text-zinc-200 outline-none transition-colors focus:border-indigo-500/40"
                    disabled={!availableClips.length}
                  >
                    {!availableClips.length && <option value="">No saved renders yet</option>}
                    {availableClips.map((clip) => (
                      <option key={clip.id} value={clip.id}>
                        {buildClipLabel(clip.createdAt, clip.durationSeconds, clip.resolvedSeed)}
                      </option>
                    ))}
                  </select>
                </label>

                <div className="grid grid-cols-2 gap-3">
                  <button
                    type="button"
                    onClick={() => updateTimelineClip(selectedScene.id, selectedShot.id, {
                      includeInCut: !selectedPreviewClip.includeInCut,
                    })}
                    className={`rounded-xl border px-3 py-2 text-xs font-semibold transition-colors ${
                      selectedPreviewClip.includeInCut
                        ? 'border-emerald-500/20 bg-emerald-500/10 text-emerald-300'
                        : 'border-zinc-800 bg-zinc-900 text-zinc-300 hover:bg-zinc-800'
                    }`}
                  >
                    {selectedPreviewClip.includeInCut ? 'Included in cut' : 'Add to cut'}
                  </button>
                  <button
                    type="button"
                    onClick={() => updateTimelineClip(selectedScene.id, selectedShot.id, {
                      useFullSource: !selectedPreviewClip.useFullSource,
                      trimStartSeconds: 0,
                      trimEndSeconds: selectedSourceClip?.durationSeconds || selectedPreviewClip.sourceDurationSeconds,
                    })}
                    className={`rounded-xl border px-3 py-2 text-xs font-semibold transition-colors ${
                      selectedPreviewClip.useFullSource
                        ? 'border-indigo-500/20 bg-indigo-500/10 text-indigo-300'
                        : 'border-zinc-800 bg-zinc-900 text-zinc-300 hover:bg-zinc-800'
                    }`}
                  >
                    {selectedPreviewClip.useFullSource ? 'Using full clip' : 'Use full clip'}
                  </button>
                </div>

                <div className="grid grid-cols-2 gap-3">
                  <label className="space-y-1">
                    <span className="text-[10px] font-mono uppercase tracking-[0.18em] text-zinc-500">Preferred length</span>
                    <input
                      type="number"
                      min={1}
                      max={30}
                      step={0.5}
                      value={selectedPreviewClip.preferredDurationSeconds ?? selectedPreviewClip.recommendedDurationSeconds}
                      onChange={(event) => {
                        const nextDuration = Number(event.target.value || selectedPreviewClip.recommendedDurationSeconds);
                        updateTimelineClip(selectedScene.id, selectedShot.id, {
                          preferredDurationSeconds: nextDuration,
                          trimEndSeconds: Math.min(maxTrimEnd, (selectedPreviewClip.trimStartSeconds || 0) + nextDuration),
                        });
                      }}
                      className="w-full rounded-xl border border-zinc-800 bg-zinc-900 px-3 py-2 text-sm text-zinc-200 outline-none transition-colors focus:border-indigo-500/40"
                    />
                  </label>
                  <div className="space-y-1">
                    <span className="text-[10px] font-mono uppercase tracking-[0.18em] text-zinc-500">Recommended</span>
                    <div className="rounded-xl border border-zinc-800 bg-zinc-900 px-3 py-2 text-sm text-zinc-100">
                      {formatSeconds(selectedPreviewClip.recommendedDurationSeconds)}
                    </div>
                  </div>
                </div>

                {!selectedPreviewClip.useFullSource && (
                  <div className="grid grid-cols-2 gap-3">
                    <label className="space-y-1">
                      <span className="text-[10px] font-mono uppercase tracking-[0.18em] text-zinc-500">Trim start</span>
                      <div className="relative">
                        <Scissors className="pointer-events-none absolute left-3 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-zinc-500" />
                        <input
                          type="number"
                          min={0}
                          max={Math.max(maxTrimEnd - 0.5, 0)}
                          step={0.5}
                          value={selectedPreviewClip.trimStartSeconds}
                          onChange={(event) => {
                            const nextStart = Number(event.target.value || 0);
                            updateTimelineClip(selectedScene.id, selectedShot.id, {
                              trimStartSeconds: nextStart,
                              trimEndSeconds: Math.max(selectedPreviewClip.trimEndSeconds, nextStart + 0.5),
                            });
                          }}
                          className="w-full rounded-xl border border-zinc-800 bg-zinc-900 py-2 pl-9 pr-3 text-sm text-zinc-200 outline-none transition-colors focus:border-indigo-500/40"
                        />
                      </div>
                    </label>
                    <label className="space-y-1">
                      <span className="text-[10px] font-mono uppercase tracking-[0.18em] text-zinc-500">Trim end</span>
                      <input
                        type="number"
                        min={selectedPreviewClip.trimStartSeconds + 0.5}
                        max={maxTrimEnd}
                        step={0.5}
                        value={selectedPreviewClip.trimEndSeconds}
                        onChange={(event) => {
                          const nextEnd = Number(event.target.value || maxTrimEnd);
                          updateTimelineClip(selectedScene.id, selectedShot.id, {
                            trimEndSeconds: nextEnd,
                          });
                        }}
                        className="w-full rounded-xl border border-zinc-800 bg-zinc-900 px-3 py-2 text-sm text-zinc-200 outline-none transition-colors focus:border-indigo-500/40"
                      />
                    </label>
                  </div>
                )}
              </div>
            ) : (
              <div className="mt-2 rounded-2xl border border-dashed border-zinc-800 bg-zinc-950/40 px-4 py-6 text-sm text-zinc-500">
                Select a beat from the scrubber to edit source versions, trims, and inclusion in the cut.
              </div>
            )}
          </section>
        </div>

        <section className="mt-3 rounded-[20px] border border-zinc-900 bg-zinc-950/72 p-3" data-testid="workspace-dock">
          <div className="text-[10px] font-mono uppercase tracking-[0.24em] text-zinc-500">Workspace</div>
          <div className="mt-2 flex flex-wrap gap-2">
            {workspaceQuickActions.map((action) => {
              const Icon = action.icon;
              const isActive = activeWorkspace === action.id;
              return (
                <button
                  key={action.id}
                  type="button"
                  onClick={() => onOpenWorkspace?.(action.id)}
                  className={`rounded-2xl border px-3 py-2 text-left transition-colors ${
                    isActive
                      ? 'border-indigo-500/30 bg-indigo-500/10 text-indigo-200'
                      : 'border-zinc-800 bg-zinc-900 text-zinc-300 hover:bg-zinc-800'
                  }`}
                  data-testid={`workspace-button-${action.id}`}
                >
                  <div className="flex items-center gap-2 text-xs font-semibold">
                    <Icon className="h-3.5 w-3.5" />
                    <span>{action.label}</span>
                  </div>
                  <div className="mt-1 text-[10px] text-zinc-500">{action.hint}</div>
                </button>
              );
            })}
          </div>
        </section>

        <section className="mt-3 grid gap-3 lg:grid-cols-[minmax(0,1fr)_220px]" data-testid="prompt-dock">
          <label className="block rounded-[20px] border border-zinc-900 bg-zinc-950/72 p-3">
            <span className="mb-2 block text-[10px] font-mono uppercase tracking-[0.24em] text-zinc-500">Prompt dock</span>
            <div className="flex items-center gap-2 rounded-[18px] border border-indigo-500/25 bg-zinc-950 px-3 py-2 shadow-[0_0_0_1px_rgba(99,102,241,0.05)]">
              <input
                type="text"
                value={promptDraft}
                onChange={(event) => setPromptDraft(event.target.value)}
                placeholder="Prompt the next timeline revision, then open Pipeline to render it..."
                className="h-10 flex-1 bg-transparent text-sm text-zinc-100 outline-none placeholder:text-zinc-500"
                data-testid="timeline-prompt-input"
              />
              <button
                type="button"
                onClick={() => onOpenWorkspace?.('export')}
                className="inline-flex h-10 w-10 items-center justify-center rounded-full bg-indigo-500 text-white transition-colors hover:bg-indigo-400"
                title="Open Generate / Export"
                data-testid="prompt-open-pipeline"
              >
                <Sparkles className="h-4 w-4" />
              </button>
            </div>
          </label>

          <div className="grid grid-cols-2 gap-2">
            {[
              { label: 'Included', value: manifest.includedClipCount },
              { label: 'Dirty', value: manifest.dirtyClipCount },
              { label: 'Ready', value: manifest.readyClipCount },
              { label: 'Segments', value: manifest.totalClipCount },
            ].map((item) => (
              <div key={item.label} className="rounded-[20px] border border-zinc-900 bg-zinc-950/72 p-3">
                <div className="text-[9px] font-mono uppercase tracking-[0.18em] text-zinc-500">{item.label}</div>
                <div className="mt-1 text-base font-semibold text-white">{item.value}</div>
              </div>
            ))}
          </div>
        </section>
      </section>
    </div>
  );
}
