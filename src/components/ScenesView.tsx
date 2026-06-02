import React, { useEffect, useRef, useState } from 'react';
import { Play, Plus, Trash2, Volume2, Sparkles, Edit, Check, X, Wand2, Clapperboard, ChevronDown, ChevronUp } from 'lucide-react';
import type { ReferenceAsset, Scene, Character, DialogueLine, CameraConfig, StoryboardSeedStrategy, StoryboardShotType, StoryboardTransitionMode } from '../types';
import {
  applyStoryboardContinuityAutomation,
  createBlankStoryboardShot,
  getSceneBackgroundAssets,
  getSceneStoryboardFrameAsset,
  getSceneStoryboardFrameAssets,
  getSceneDisplayBackground,
  getShotDialogueExcerpt,
  getStoryboardContinuityStats,
  normalizeScene,
  normalizeStoryboardShot,
  primeNextStoryboardShotContinuity,
  sanitizeStoryboardSeed,
  upsertSceneBackgroundAsset,
  upsertSceneStoryboardFrameAsset,
} from '../utils/storyforge';

interface ScenesViewProps {
  scenes: Scene[];
  characters: Character[];
  camera: CameraConfig;
  onSaveScenes: (scenes: Scene[]) => void;
}

const SHOT_TYPE_OPTIONS: StoryboardShotType[] = [
  'wide-landscape',
  'medium-shot',
  'close-up',
  'cowboy-shot',
  'two-shot',
  'over-the-shoulder',
  'tracking',
];

const SEED_STRATEGY_OPTIONS: Array<{ value: StoryboardSeedStrategy; label: string; hint: string }> = [
  {
    value: 'auto',
    label: 'Auto seed',
    hint: 'Let each render explore a fresh variation.',
  },
  {
    value: 'lock',
    label: 'Lock seed',
    hint: 'Reuse one exact seed for reproducible rerenders.',
  },
  {
    value: 'inherit-previous',
    label: 'Inherit previous',
    hint: 'Carry the prior shot seed forward for tighter continuity.',
  },
];

const TRANSITION_MODE_OPTIONS: Array<{ value: StoryboardTransitionMode; label: string; hint: string }> = [
  {
    value: 'none',
    label: 'No bridge frame',
    hint: 'Use only the current shot prompt plus character/background references.',
  },
  {
    value: 'previous-shot',
    label: 'Use previous shot anchor',
    hint: 'Reserve one reference slot for the previous shot\'s anchor frame when available.',
  },
  {
    value: 'custom-frame',
    label: 'Use custom frame',
    hint: 'Pick or upload a dedicated transition image for this beat.',
  },
];

type SceneStoryboardShot = NonNullable<Scene['storyboardShots']>[number];
type StoryboardFrameUploadTarget = { shotId: string; assignment: 'board' | 'transition' } | null;
type MobileWorkspaceView = 'atmosphere' | 'storyboard' | 'dialogue';

function getSeedStrategySummary(
  shot: SceneStoryboardShot,
  index: number,
  previousShot: SceneStoryboardShot | undefined,
) {
  if (shot.seedStrategy === 'lock') {
    return shot.lockedSeed
      ? `Shot ${index + 1} is pinned to seed ${shot.lockedSeed.toLocaleString()} for deterministic rerenders.`
      : 'Lock seed keeps this shot reproducible once you enter a positive integer seed.';
  }

  if (shot.seedStrategy === 'inherit-previous') {
    if (previousShot?.lastRenderSeed) {
      return `This shot will inherit Shot ${index}'s last render seed (${previousShot.lastRenderSeed.toLocaleString()}) to reduce visual drift.`;
    }

    if (index === 0) {
      return 'The first shot has no prior shot to inherit from yet, so it will fall back to an auto-generated seed on render.';
    }

    return `This shot is queued to inherit the previous shot seed after Shot ${index} has been rendered at least once.`;
  }

  if (shot.lastRenderSeed) {
    return `Auto seed mode will generate a fresh seed next time. The most recent render used ${shot.lastRenderSeed.toLocaleString()}.`;
  }

  return 'Auto seed mode leaves this beat free to explore a new variation every render while preserving your storyboard prompt and references.';
}

function getTransitionSummary(
  scene: Scene,
  shot: SceneStoryboardShot,
  index: number,
  storyboardFrameAssets: ReferenceAsset[],
) {
  const previousShot = index > 0 ? scene.storyboardShots?.[index - 1] : undefined;
  const previousShotAnchor = previousShot ? storyboardFrameAssets.find(asset => asset.id === previousShot.boardImageId) : undefined;
  const customBridgeAsset = storyboardFrameAssets.find(asset => asset.id === shot.transitionInAssetId);

  if (shot.transitionInMode === 'custom-frame') {
    return customBridgeAsset
      ? `One of the 3 Veo reference slots will be reserved for the custom continuity frame “${customBridgeAsset.label}” before character/background references are added.`
      : 'Choose or upload a custom continuity frame to reserve one Veo reference slot for the bridge-in image.';
  }

  if (shot.transitionInMode === 'previous-shot') {
    if (index === 0) {
      return 'Opening shots normally do not need a transition bridge, so this beat will still fall back to the current shot references only.';
    }

    return previousShotAnchor
      ? `Shot ${index + 1} will reserve one Veo reference slot for Shot ${index}\'s anchor frame “${previousShotAnchor.label}”, then fill the remaining slots with lead character/background continuity.`
      : `Shot ${index} does not have an anchor frame yet. Upload one on the previous card or switch this beat to a custom bridge frame.`;
  }

  return 'No transition bridge frame will be injected, so all reference slots remain available for character and background continuity.';
}

export function ScenesView({ scenes, characters, camera, onSaveScenes }: ScenesViewProps) {
  const [selectedScene, setSelectedScene] = useState<Scene>(() => normalizeScene(scenes[0] || {
    id: '1',
    title: 'Act I: The Rendezvous',
    description: 'A shadowy confrontation outside the neon-lit terminal.',
    lighting: 'cyberpunk-dusk',
    dialogues: [],
  }));

  const [activeDialogueInput, setActiveDialogueInput] = useState('');
  const [selectedCharId, setSelectedCharId] = useState(characters[0]?.id || '');
  const [selectedSentiment, setSelectedSentiment] = useState<'neutral' | 'tense' | 'playful' | 'mysterious' | 'determined'>('neutral');
  const [isSuggesting, setIsSuggesting] = useState(false);
  const [isUploadingBackground, setIsUploadingBackground] = useState(false);
  const [isUploadingStoryboardFrame, setIsUploadingStoryboardFrame] = useState(false);
  const [isGeneratingStoryboard, setIsGeneratingStoryboard] = useState(false);
  const [storyboardFrameUploadTarget, setStoryboardFrameUploadTarget] = useState<StoryboardFrameUploadTarget>(null);
  const [mobileWorkspaceView, setMobileWorkspaceView] = useState<MobileWorkspaceView>(() => ((selectedScene.storyboardShots?.length || 0) > 0 ? 'storyboard' : 'atmosphere'));
  const [expandedMobileShotId, setExpandedMobileShotId] = useState<string | null>(() => selectedScene.storyboardShots?.[0]?.id || null);

  const [editingDialogueId, setEditingDialogueId] = useState<string | null>(null);
  const [editingText, setEditingText] = useState('');

  const backgroundUploadInputRef = useRef<HTMLInputElement>(null);
  const storyboardFrameUploadInputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    const refreshedScene = scenes.find(scene => scene.id === selectedScene.id);
    if (refreshedScene) {
      setSelectedScene(refreshedScene);
    } else if (scenes[0]) {
      setSelectedScene(scenes[0]);
    }
  }, [scenes, selectedScene.id]);

  useEffect(() => {
    if (selectedCharId && characters.some(character => character.id === selectedCharId)) {
      return;
    }

    setSelectedCharId(characters[0]?.id || '');
  }, [characters, selectedCharId]);

  useEffect(() => {
    if (mobileWorkspaceView === 'storyboard' && (selectedScene.storyboardShots?.length || 0) === 0) {
      setMobileWorkspaceView('atmosphere');
    }
  }, [mobileWorkspaceView, selectedScene.id, selectedScene.storyboardShots]);

  useEffect(() => {
    const shots = selectedScene.storyboardShots || [];
    if (!shots.length) {
      setExpandedMobileShotId(null);
      return;
    }

    if (!expandedMobileShotId || !shots.some(shot => shot.id === expandedMobileShotId)) {
      setExpandedMobileShotId(shots[0].id);
    }
  }, [expandedMobileShotId, selectedScene.id, selectedScene.storyboardShots]);

  const activeBackground = getSceneDisplayBackground(selectedScene);
  const backgroundAssets = getSceneBackgroundAssets(selectedScene);
  const storyboardFrameAssets = getSceneStoryboardFrameAssets(selectedScene);
  const storyboardShots = selectedScene.storyboardShots || [];
  const continuityStats = getStoryboardContinuityStats(selectedScene);

  const commitScene = (updatedScene: Scene) => {
    setSelectedScene(updatedScene);
    if (scenes.some(scene => scene.id === updatedScene.id)) {
      onSaveScenes(scenes.map(scene => scene.id === updatedScene.id ? updatedScene : scene));
      return;
    }

    onSaveScenes([...scenes, updatedScene]);
  };

  const handleAISuggest = async () => {
    if (isSuggesting) return;
    setIsSuggesting(true);
    try {
      const response = await fetch('/api/generate-dialogue', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({
          scene: {
            title: selectedScene.title,
            description: selectedScene.description,
            lighting: selectedScene.lighting,
            atmosphereNotes: selectedScene.atmosphereNotes,
          },
          characters,
          currentDialogues: selectedScene.dialogues,
          speakerId: selectedCharId,
          sentiment: selectedSentiment
        })
      });

      if (!response.ok) {
        throw new Error('AI Dialogue generation response negative');
      }

      const data = await response.json();
      if (data && data.text) {
        setActiveDialogueInput(data.text);
      }
    } catch (error) {
      console.warn('AI suggest failed, invoking robust local fallback templates:', error);
      const fallbacks: Record<string, string[]> = {
        tense: [
          "We don't have much time. Secure the subnet now.",
          'I hear footsteps. Put the backup transmitter away.',
          'That was too close. The anomalies are spreading.'
        ],
        playful: [
          "Oh, relax. It's just a little bit of high-level code tampering.",
          'Who designed this system anyway? Looks like 20th-century spaghetti.',
          "Well, aren't you mister sunshine today?"
        ],
        mysterious: [
          "The cloud wasn't built by humans... We only discovered it.",
          'There are secrets inside these files that can turn down the sun.',
          'Listen carefully. Do you hear the code humming?'
        ],
        determined: [
          'I will synchronize this database block even if it is the last thing I do.',
          'We started this job, and we are going to finish it. Synchronizing nodes now.',
          "Don't worry, Lyra. The data pipeline is secure in my hands."
        ],
        neutral: [
          'Ready for telemetry update. Let me inspect the interface.',
          'The connection is stable for now.',
          'Sequence numbers are adjusting correctly.'
        ]
      };
      const matching = fallbacks[selectedSentiment] || fallbacks.neutral;
      const randomLine = matching[Math.floor(Math.random() * matching.length)];
      setActiveDialogueInput(randomLine);
    } finally {
      setIsSuggesting(false);
    }
  };

  const updateSceneLighting = (lighting: Scene['lighting']) => {
    commitScene({ ...selectedScene, lighting });
  };

  const handleAddDialogue = (e: React.FormEvent) => {
    e.preventDefault();
    if (!activeDialogueInput.trim()) return;

    const newLine: DialogueLine = {
      id: Date.now().toString(),
      characterId: selectedCharId,
      text: activeDialogueInput,
      sentiment: selectedSentiment
    };

    commitScene({
      ...selectedScene,
      dialogues: [...selectedScene.dialogues, newLine]
    });
    setActiveDialogueInput('');
  };

  const handleDeleteDialogue = (id: string) => {
    commitScene({
      ...selectedScene,
      dialogues: selectedScene.dialogues.filter(item => item.id !== id)
    });
  };

  const handleStartEditDialogue = (item: DialogueLine) => {
    setEditingDialogueId(item.id);
    setEditingText(item.text);
  };

  const handleSaveEditDialogue = (id: string) => {
    if (!editingText.trim()) return;
    commitScene({
      ...selectedScene,
      dialogues: selectedScene.dialogues.map(dialogue => dialogue.id === id ? { ...dialogue, text: editingText } : dialogue)
    });
    setEditingDialogueId(null);
    setEditingText('');
  };

  const handleAddNewScene = () => {
    const selectedSceneIndex = scenes.findIndex(scene => scene.id === selectedScene.id);
    const insertionIndex = selectedSceneIndex >= 0 ? selectedSceneIndex + 1 : scenes.length;
    const newScene: Scene = normalizeScene({
      id: Date.now().toString(),
      title: `Untitled Act ${scenes.length + 1}`,
      description: `Continue the story after ${selectedScene.title} without compressing every beat into the same act.`,
      lighting: selectedScene.lighting,
      atmosphereNotes: selectedScene.atmosphereNotes || 'Carry the established mood forward while introducing the next dramatic turn.',
      backgroundAssets: getSceneBackgroundAssets(selectedScene),
      activeBackgroundImageId: selectedScene.activeBackgroundImageId || null,
      storyboardFrameAssets: [],
      storyboardShots: [],
      dialogues: []
    });
    const nextList = [...scenes];
    nextList.splice(insertionIndex, 0, newScene);
    setSelectedScene(newScene);
    setExpandedMobileShotId(null);
    setMobileWorkspaceView('atmosphere');
    onSaveScenes(nextList);
  };

  const handleUploadBackgroundReference = async (event: React.ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    if (!file) return;

    setIsUploadingBackground(true);
    try {
      const formData = new FormData();
      formData.append('file', file);
      formData.append('kind', 'scene-background');
      formData.append('label', file.name);

      const response = await fetch('/api/upload-reference', {
        method: 'POST',
        body: formData,
      });

      if (!response.ok) {
        throw new Error('Scene background reference upload failed.');
      }

      const data = await response.json();
      if (data?.asset?.url) {
        commitScene(upsertSceneBackgroundAsset(selectedScene, data.asset, true));
      }
    } catch (error) {
      console.warn('Scene background reference upload failed:', error);
    } finally {
      setIsUploadingBackground(false);
      event.target.value = '';
    }
  };

  const openStoryboardFrameUpload = (shotId: string, assignment: 'board' | 'transition') => {
    setStoryboardFrameUploadTarget({ shotId, assignment });
    storyboardFrameUploadInputRef.current?.click();
  };

  const handleUploadStoryboardFrame = async (event: React.ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    if (!file || !storyboardFrameUploadTarget) return;

    setIsUploadingStoryboardFrame(true);
    try {
      const formData = new FormData();
      formData.append('file', file);
      formData.append('kind', 'storyboard-frame');
      formData.append('label', file.name);

      const response = await fetch('/api/upload-reference', {
        method: 'POST',
        body: formData,
      });

      if (!response.ok) {
        throw new Error('Storyboard continuity frame upload failed.');
      }

      const data = await response.json();
      if (data?.asset?.url) {
        const nextSceneWithAsset = upsertSceneStoryboardFrameAsset(selectedScene, data.asset);
        const nextShots = (nextSceneWithAsset.storyboardShots || []).map((shot, index) => (
          shot.id === storyboardFrameUploadTarget.shotId
            ? normalizeStoryboardShot({
                ...shot,
                boardImageId: storyboardFrameUploadTarget.assignment === 'board' ? data.asset.id : shot.boardImageId,
                transitionInMode: storyboardFrameUploadTarget.assignment === 'transition' ? 'custom-frame' : shot.transitionInMode,
                transitionInAssetId: storyboardFrameUploadTarget.assignment === 'transition' ? data.asset.id : shot.transitionInAssetId,
              }, index)
            : normalizeStoryboardShot(shot, index)
        ));

        const nextScene = {
          ...nextSceneWithAsset,
          storyboardShots: nextShots,
        };

        commitScene(
          storyboardFrameUploadTarget.assignment === 'board'
            ? primeNextStoryboardShotContinuity(nextScene, storyboardFrameUploadTarget.shotId)
            : nextScene
        );
      }
    } catch (error) {
      console.warn('Storyboard continuity frame upload failed:', error);
    } finally {
      setIsUploadingStoryboardFrame(false);
      setStoryboardFrameUploadTarget(null);
      event.target.value = '';
    }
  };

  const handleGenerateStoryboard = async () => {
    if (isGeneratingStoryboard) return;
    setIsGeneratingStoryboard(true);
    try {
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
        throw new Error('Storyboard planning request failed.');
      }

      const data = await response.json();
      const shots = Array.isArray(data?.shots)
        ? data.shots.map((shot: any, index: number) => normalizeStoryboardShot(shot, index))
        : [];

      if (shots.length) {
        setMobileWorkspaceView('storyboard');
        setExpandedMobileShotId(shots[0]?.id || null);
        commitScene(applyStoryboardContinuityAutomation({
          ...selectedScene,
          storyboardShots: shots,
        }));
      }
    } catch (error) {
      console.warn('Storyboard generation failed:', error);
    } finally {
      setIsGeneratingStoryboard(false);
    }
  };

  const handleAddStoryboardShot = () => {
    const newShot = createBlankStoryboardShot(storyboardShots.length, camera);
    const nextShots = [...storyboardShots, newShot]
      .map((shot, index) => normalizeStoryboardShot({ ...shot, shotNumber: index + 1 }, index));

    setMobileWorkspaceView('storyboard');
    setExpandedMobileShotId(newShot.id);
    commitScene({
      ...selectedScene,
      storyboardShots: nextShots,
    });
  };

  const handleUpdateStoryboardShot = (shotId: string, updates: Partial<typeof storyboardShots[number]>) => {
    const nextShots = storyboardShots.map((shot, index) => (
      shot.id === shotId ? normalizeStoryboardShot({ ...shot, ...updates }, index) : normalizeStoryboardShot(shot, index)
    ));

    const nextScene = {
      ...selectedScene,
      storyboardShots: nextShots,
    };

    commitScene(
      updates.boardImageId
        ? primeNextStoryboardShotContinuity(nextScene, shotId)
        : nextScene
    );
  };

  const handleDeleteStoryboardShot = (shotId: string) => {
    const nextShots = storyboardShots
      .filter(shot => shot.id !== shotId)
      .map((shot, index) => normalizeStoryboardShot({ ...shot, shotNumber: index + 1 }, index));

    if (expandedMobileShotId === shotId) {
      setExpandedMobileShotId(nextShots[0]?.id || null);
    }

    commitScene({
      ...selectedScene,
      storyboardShots: nextShots,
    });
  };

  const handleAutoChainContinuity = () => {
    if (storyboardShots.length < 2) return;
    commitScene(applyStoryboardContinuityAutomation(selectedScene));
  };

  const getCharName = (id: string) => {
    return characters.find(c => c.id === id)?.name || 'Unknown Actor';
  };

  const getLightingStyle = (mode: Scene['lighting']) => {
    switch (mode) {
      case 'cyberpunk-dusk':
        return 'from-fuchsia-950/40 via-zinc-950 to-zinc-950 border-fuchsia-500/20';
      case 'sunset-warm':
        return 'from-amber-950/40 via-zinc-950 to-zinc-950 border-amber-500/20';
      case 'moonlight-cold':
        return 'from-cyan-950/40 via-zinc-950 to-zinc-950 border-cyan-500/20';
      case 'high-key-studio':
        return 'from-slate-800/40 via-zinc-950 to-zinc-950 border-slate-500/20';
    }
  };

  return (
    <div className="space-y-6 animate-in fade-in duration-300">
      <input
        ref={backgroundUploadInputRef}
        type="file"
        title="Upload background reference image"
        accept="image/png,image/jpeg,image/webp,image/gif"
        className="hidden"
        onChange={handleUploadBackgroundReference}
      />
      <input
        ref={storyboardFrameUploadInputRef}
        type="file"
        title="Upload storyboard continuity frame"
        accept="image/png,image/jpeg,image/webp,image/gif"
        className="hidden"
        onChange={handleUploadStoryboardFrame}
      />

      <div className="flex items-center justify-between">
        <div>
          <h2 className="text-lg font-medium tracking-tight text-white">Scenic Director</h2>
          <p className="text-[11px] text-zinc-500 font-mono mt-0.5" id="scene-counter">Active acts / scenes: {scenes.length}</p>
        </div>
        <button
          onClick={handleAddNewScene}
          className="flex items-center gap-1.5 text-xs font-semibold bg-zinc-800 text-zinc-200 border border-zinc-700 px-3 py-1.5 rounded-full hover:bg-zinc-700 hover:text-white transition-all cursor-pointer"
        >
          <Plus className="w-3.5 h-3.5" />
          <span>New Act</span>
        </button>
      </div>

      <div className="flex gap-3 overflow-x-auto pb-1.5 scrollbar-thin scrollbar-thumb-zinc-800 snap-x snap-mandatory">
        {scenes.map((scene, index) => {
          const shotCount = scene.storyboardShots?.length || 0;
          const dialogueCount = scene.dialogues.length;
          const isSelected = selectedScene.id === scene.id;

          return (
          <button
            key={scene.id}
            data-act-card={scene.id}
            onClick={() => setSelectedScene(scene)}
            className={`min-w-[176px] snap-start rounded-2xl border px-3.5 py-3 text-left transition-all ${
              isSelected
                ? 'bg-indigo-600/10 border-indigo-500 text-indigo-300 shadow-lg shadow-indigo-500/10'
                : 'bg-zinc-900/50 border-zinc-800/80 text-zinc-400 hover:text-zinc-200 hover:border-zinc-700'
            }`}
          >
            <div className="flex items-center justify-between gap-2">
              <span className="text-[9px] font-mono uppercase tracking-[0.24em] text-zinc-500">Act {index + 1}</span>
              {isSelected && (
                <span className="rounded-full border border-indigo-500/30 bg-indigo-500/10 px-1.5 py-0.5 text-[8px] font-mono uppercase tracking-[0.2em] text-indigo-300">
                  Current
                </span>
              )}
            </div>
            <div className="mt-2 text-sm font-semibold text-white leading-snug">{scene.title}</div>
            <div className="mt-2 flex flex-wrap gap-1.5 text-[9px] font-mono uppercase tracking-wider">
              <span className="rounded-full border border-zinc-800 bg-zinc-950/80 px-2 py-1">{dialogueCount} line{dialogueCount === 1 ? '' : 's'}</span>
              <span className="rounded-full border border-zinc-800 bg-zinc-950/80 px-2 py-1">{shotCount} shot{shotCount === 1 ? '' : 's'}</span>
            </div>
          </button>
        );})}

        <button
          type="button"
          data-add-act-card="true"
          onClick={handleAddNewScene}
          className="min-w-[168px] snap-start rounded-2xl border border-dashed border-zinc-800 bg-zinc-950/40 px-3.5 py-3 text-left transition-colors hover:border-indigo-500/40 hover:bg-indigo-500/5"
        >
          <div className="flex items-center gap-2 text-[9px] font-mono uppercase tracking-[0.24em] text-zinc-500">
            <Plus className="w-3.5 h-3.5 text-indigo-400" />
            <span>New act</span>
          </div>
          <div className="mt-2 text-sm font-semibold text-white leading-snug">Continue the story in a fresh act card</div>
          <div className="mt-2 text-[10px] text-zinc-500 leading-relaxed">
            Keeps the current atmosphere and background continuity, but starts with clean dialogue and storyboard beats.
          </div>
        </button>
      </div>

      <div className="lg:hidden rounded-2xl border border-zinc-900 bg-zinc-950/70 p-2">
        <div className="grid grid-cols-3 gap-2">
          {[
            { id: 'atmosphere', label: 'Atmosphere' },
            { id: 'storyboard', label: `Board ${storyboardShots.length ? `(${storyboardShots.length})` : ''}`.trim() },
            { id: 'dialogue', label: `Dialogue ${selectedScene.dialogues.length ? `(${selectedScene.dialogues.length})` : ''}`.trim() },
          ].map(option => {
            const isActive = mobileWorkspaceView === option.id;
            return (
              <button
                key={option.id}
                type="button"
                onClick={() => setMobileWorkspaceView(option.id as MobileWorkspaceView)}
                className={`rounded-xl px-3 py-2 text-[10px] font-semibold uppercase tracking-wider transition-colors ${
                  isActive
                    ? 'bg-indigo-600 text-white shadow-lg shadow-indigo-600/20'
                    : 'bg-zinc-900/80 text-zinc-400 border border-zinc-800'
                }`}
              >
                {option.label}
              </button>
            );
          })}
        </div>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-[minmax(320px,380px)_1fr] gap-6 items-start">
        <div className={`${mobileWorkspaceView !== 'atmosphere' ? 'hidden lg:block ' : ''}p-5 rounded-2xl border bg-gradient-to-b ${getLightingStyle(selectedScene.lighting)} transition-all duration-300 space-y-5 lg:sticky lg:top-24`}>
          <div className="flex items-center justify-between gap-3">
            <span className="text-[10px] font-mono uppercase tracking-wider text-zinc-500">Integrated Atmosphere</span>
            <div className="flex items-center gap-2">
              <span className="flex items-center gap-1 text-[10px] text-indigo-400 bg-indigo-500/10 border border-indigo-500/20 px-2 py-0.5 rounded-full">
                <Volume2 className="w-3 h-3" />
                <span className="font-semibold">Ambience Active</span>
              </span>
              <button
                type="button"
                onClick={() => backgroundUploadInputRef.current?.click()}
                disabled={isUploadingBackground}
                className="text-[10px] font-mono uppercase tracking-wider text-sky-300 bg-sky-500/10 border border-sky-500/20 px-2.5 py-1 rounded-full disabled:opacity-50"
              >
                {isUploadingBackground ? 'Uploading...' : 'Upload BG Ref'}
              </button>
            </div>
          </div>

          {activeBackground && (
            <div className="rounded-2xl overflow-hidden border border-zinc-900/80 bg-zinc-950/60">
              <div className="aspect-[16/7] overflow-hidden bg-zinc-950">
                <img src={activeBackground} alt={`${selectedScene.title} background reference`} className="w-full h-full object-cover" referrerPolicy="no-referrer" />
              </div>
              <div className="px-4 py-2 text-[10px] font-mono text-zinc-400 border-t border-zinc-900/80 bg-zinc-950/90">
                Active background continuity reference
              </div>
            </div>
          )}

          <div className="space-y-1">
            <input
              type="text"
              title="Scene title"
              value={selectedScene.title}
              onChange={e => commitScene({ ...selectedScene, title: e.target.value })}
              className="text-base font-semibold text-white bg-transparent border-b border-transparent focus:border-zinc-800 focus:outline-none w-full"
            />
            <input
              type="text"
              title="Scene description"
              value={selectedScene.description}
              onChange={e => commitScene({ ...selectedScene, description: e.target.value })}
              className="text-xs text-zinc-400 bg-transparent border-b border-transparent focus:border-zinc-800 focus:outline-none w-full"
              placeholder="Describe the emotional and visual arc of the scene."
            />
          </div>

          <textarea
            title="Atmosphere notes"
            value={selectedScene.atmosphereNotes || ''}
            onChange={e => commitScene({ ...selectedScene, atmosphereNotes: e.target.value })}
            className="w-full bg-zinc-950/60 border border-zinc-900 rounded-xl p-3 text-xs text-zinc-200 placeholder-zinc-500 focus:outline-none focus:border-indigo-500 min-h-[84px] resize-none"
            placeholder="Add atmosphere notes that the background reference alone cannot describe: weather, movement, mood, production design, and dynamic set continuity."
          />

          <div className="space-y-2">
            <label className="text-[10px] font-mono text-zinc-500 uppercase tracking-widest block">Background Continuity Library</label>
            {backgroundAssets.length === 0 ? (
              <div className="rounded-xl border border-dashed border-zinc-800 bg-zinc-950/40 px-4 py-5 text-center text-[11px] text-zinc-500">
                Upload a background reference image to anchor atmosphere, production design, and set continuity for this scene.
              </div>
            ) : (
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                {backgroundAssets.map(asset => {
                  const isActive = selectedScene.activeBackgroundImageId === asset.id || (!selectedScene.activeBackgroundImageId && activeBackground === asset.url);
                  return (
                    <button
                      key={asset.id}
                      type="button"
                      onClick={() => commitScene({ ...selectedScene, activeBackgroundImageId: asset.id })}
                      className={`rounded-2xl overflow-hidden border text-left transition-all ${
                        isActive ? 'border-indigo-500 shadow-lg shadow-indigo-500/10' : 'border-zinc-900 hover:border-zinc-700'
                      }`}
                    >
                      <div className="aspect-square overflow-hidden bg-zinc-950 relative">
                        <img src={asset.url} alt={asset.label} className="w-full h-full object-cover" referrerPolicy="no-referrer" />
                        {isActive && (
                          <div className="absolute bottom-2 left-2 text-[8px] font-mono uppercase tracking-wider px-1.5 py-0.5 rounded bg-indigo-500/90 text-white">
                            Active
                          </div>
                        )}
                      </div>
                      <div className="px-2.5 py-2 bg-zinc-950/90 space-y-1">
                        <div className="text-[10px] text-zinc-200 font-medium truncate" title={asset.label}>{asset.label}</div>
                        <div className="text-[9px] font-mono text-zinc-500 uppercase tracking-wider">scene ref</div>
                      </div>
                    </button>
                  );
                })}
              </div>
            )}
          </div>

          <div className="space-y-2">
            <label className="text-[10px] font-mono text-zinc-500 uppercase tracking-widest block">Virtual Lighting Design</label>
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
              {[
                { id: 'cyberpunk-dusk', label: 'Neon Cyberpunk' },
                { id: 'sunset-warm', label: 'Sunset Amber' },
                { id: 'moonlight-cold', label: 'Lunar Frost' },
                { id: 'high-key-studio', label: 'Studio Neutral' }
              ].map((light) => (
                <button
                  key={light.id}
                  onClick={() => updateSceneLighting(light.id as Scene['lighting'])}
                  className={`py-2 px-3 text-[11px] font-medium leading-none rounded-xl text-left border transition-all ${
                    selectedScene.lighting === light.id
                      ? 'border-zinc-100 bg-zinc-900/90 text-white shadow-xl'
                      : 'border-zinc-800 hover:border-zinc-700 bg-zinc-950/60 text-zinc-500 hover:text-zinc-300'
                  }`}
                >
                  <div className="flex items-center gap-1.5">
                    <span className={`w-1.5 h-1.5 rounded-full ${light.id === 'cyberpunk-dusk' ? 'bg-fuchsia-400' : light.id === 'sunset-warm' ? 'bg-amber-400' : light.id === 'moonlight-cold' ? 'bg-cyan-400' : 'bg-slate-400'}`} />
                    <span>{light.label}</span>
                  </div>
                </button>
              ))}
            </div>
          </div>
        </div>

        <div className={`${mobileWorkspaceView !== 'storyboard' ? 'hidden lg:block ' : ''}bg-zinc-900/40 border border-zinc-900 rounded-2xl p-5 space-y-4 min-w-0`}>
        <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
          <div>
            <h3 className="text-sm font-semibold tracking-tight text-white flex items-center gap-2">
              <Clapperboard className="w-4 h-4 text-indigo-400" />
              <span>Scene Storyboard</span>
            </h3>
            <p className="text-[11px] text-zinc-500 font-mono mt-1">
              Break long dialogue into cinematic panels so each shot can render as its own Veo clip instead of being compressed into one video.
            </p>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <button
              type="button"
              onClick={handleGenerateStoryboard}
              disabled={isGeneratingStoryboard}
              className="bg-indigo-600/15 hover:bg-indigo-600/25 text-indigo-300 border border-indigo-500/20 text-xs font-semibold px-3 py-2 rounded-xl flex items-center gap-1.5 disabled:opacity-50"
            >
              <Wand2 className={`w-3.5 h-3.5 ${isGeneratingStoryboard ? 'animate-spin' : ''}`} />
              <span>{isGeneratingStoryboard ? 'Planning...' : 'AI Storyboard'}</span>
            </button>
            <button
              type="button"
              onClick={handleAddNewScene}
              className="bg-zinc-950 border border-zinc-800 text-zinc-200 text-xs font-semibold px-3 py-2 rounded-xl flex items-center gap-1.5"
            >
              <Plus className="w-3.5 h-3.5" />
              <span>Continue as New Act</span>
            </button>
            <button
              type="button"
              onClick={handleAddStoryboardShot}
              className="bg-zinc-950 border border-zinc-800 text-zinc-200 text-xs font-semibold px-3 py-2 rounded-xl flex items-center gap-1.5"
            >
              <Plus className="w-3.5 h-3.5" />
              <span>Add Shot</span>
            </button>
          </div>
        </div>

        <div className="rounded-xl border border-zinc-900 bg-zinc-950/40 px-3 py-2.5 text-[10px] font-mono text-zinc-500 leading-relaxed">
          <span className="text-zinc-300">Add Shot</span> keeps building beats inside the current act. <span className="text-zinc-300">Continue as New Act</span> creates a fresh dialogue + storyboard container when the current act is getting too dense for clean pacing.
        </div>

        {storyboardShots.length > 0 && (
          <div className="rounded-2xl border border-zinc-900 bg-zinc-950/50 p-4 space-y-4">
            <div className="flex flex-col gap-3 lg:flex-row lg:items-start lg:justify-between">
              <div className="space-y-1">
                <div className="text-[10px] font-mono uppercase tracking-widest text-zinc-500">Continuity Assist</div>
                <p className="text-[11px] text-zinc-400 leading-relaxed max-w-2xl">
                  Auto-chain this scene to reserve previous-shot bridge frames downstream and convert unpinned seeds into inherit-previous so continuity improves without overwriting locked seeds or custom bridge frames.
                </p>
              </div>
              <button
                type="button"
                onClick={handleAutoChainContinuity}
                disabled={storyboardShots.length < 2}
                className="bg-indigo-600/15 hover:bg-indigo-600/25 text-indigo-300 border border-indigo-500/20 text-xs font-semibold px-3 py-2 rounded-xl flex items-center justify-center gap-1.5 disabled:opacity-50"
              >
                <Sparkles className="w-3.5 h-3.5" />
                <span>Auto-chain scene</span>
              </button>
            </div>

            <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
              <div className="rounded-xl border border-zinc-900 bg-zinc-900/50 px-3 py-2.5">
                <div className="text-[9px] font-mono uppercase tracking-wider text-zinc-500">Anchors ready</div>
                <div className="mt-1 text-sm font-semibold text-zinc-100">{continuityStats.anchorCount}/{continuityStats.totalShots}</div>
              </div>
              <div className="rounded-xl border border-zinc-900 bg-zinc-900/50 px-3 py-2.5">
                <div className="text-[9px] font-mono uppercase tracking-wider text-zinc-500">Bridge chain</div>
                <div className="mt-1 text-sm font-semibold text-zinc-100">{continuityStats.previousShotBridgeCount}/{continuityStats.downstreamShots}</div>
              </div>
              <div className="rounded-xl border border-zinc-900 bg-zinc-900/50 px-3 py-2.5">
                <div className="text-[9px] font-mono uppercase tracking-wider text-zinc-500">Seed chain</div>
                <div className="mt-1 text-sm font-semibold text-zinc-100">{continuityStats.inheritedSeedCount}/{continuityStats.downstreamShots}</div>
              </div>
              <div className="rounded-xl border border-zinc-900 bg-zinc-900/50 px-3 py-2.5">
                <div className="text-[9px] font-mono uppercase tracking-wider text-zinc-500">Missing bridge source</div>
                <div className={`mt-1 text-sm font-semibold ${continuityStats.missingPreviousAnchorCount ? 'text-amber-300' : 'text-emerald-300'}`}>{continuityStats.missingPreviousAnchorCount}</div>
              </div>
            </div>

            <div className="rounded-xl border border-zinc-900 bg-zinc-900/40 px-3 py-2.5 text-[10px] font-mono text-zinc-500 leading-relaxed">
              {storyboardShots.length < 2
                ? 'Add at least two storyboard shots before automation can build a continuity chain.'
                : continuityStats.missingPreviousAnchorCount > 0
                  ? `${continuityStats.missingPreviousAnchorCount} downstream shot${continuityStats.missingPreviousAnchorCount === 1 ? ' is' : 's are'} waiting on a previous anchor frame. Export mode can now save anchors back into this library.`
                  : continuityStats.previousShotBridgeCount > 0
                    ? 'Downstream bridge frames are already chained. Use render-time anchor saves to keep the chain fresh after each successful shot.'
                    : 'No automatic bridge chain is active yet. Use Auto-chain scene to prime downstream shots for continuity-first rerenders.'}
            </div>
          </div>
        )}

        {storyboardShots.length === 0 ? (
          <div className="rounded-2xl border border-dashed border-zinc-800 bg-zinc-950/40 px-5 py-8 text-center text-zinc-500 text-sm space-y-2">
            <p>No storyboard shots yet.</p>
            <p className="text-[11px] font-mono">Use AI Storyboard to expand this scene into professional shot beats, then refine each card below.</p>
          </div>
        ) : (
          <div className="space-y-4">
            {storyboardShots.map((shot, index) => {
              const previousShot = storyboardShots[index - 1];
              const shotAnchorFrame = getSceneStoryboardFrameAsset(selectedScene, shot.boardImageId);
              const customTransitionFrame = getSceneStoryboardFrameAsset(selectedScene, shot.transitionInAssetId);
              const isMobileExpanded = expandedMobileShotId === shot.id;
              const shotSummary = shot.dialogueExcerpt || getShotDialogueExcerpt(selectedScene, characters, shot) || shot.action;

              return (
              <div key={shot.id} data-shot-card={shot.id} className="rounded-2xl border border-zinc-800 bg-zinc-950/50 overflow-hidden">
                <div className="grid grid-cols-[88px_1fr] gap-3 p-3 sm:grid-cols-[120px_1fr] sm:p-4">
                  <div className="bg-zinc-950 flex items-center justify-center self-start">
                    <div className="w-full min-h-[110px] rounded-xl border border-zinc-800 bg-zinc-900/60 overflow-hidden relative sm:min-h-[150px]">
                      {shotAnchorFrame?.url ? (
                        <img src={shotAnchorFrame.url} alt={`${shot.title} storyboard anchor frame`} className="w-full h-full object-cover" referrerPolicy="no-referrer" />
                      ) : activeBackground ? (
                        <img src={activeBackground} alt={`${shot.title} storyboard atmosphere`} className="w-full h-full object-cover opacity-75" referrerPolicy="no-referrer" />
                      ) : (
                        <div className="w-full h-full flex items-center justify-center text-zinc-600 text-[10px] font-mono uppercase tracking-[0.2em]">
                          Panel
                        </div>
                      )}
                      <div className="absolute top-2 left-2 text-[9px] font-mono uppercase tracking-[0.2em] text-white bg-zinc-950/85 px-2 py-1 rounded-full border border-zinc-700/80">
                        Shot {index + 1}
                      </div>
                      {shotAnchorFrame && (
                        <div className="absolute bottom-2 left-2 text-[8px] font-mono uppercase tracking-wider px-1.5 py-0.5 rounded bg-emerald-500/85 text-white">
                          Anchor
                        </div>
                      )}
                    </div>
                  </div>

                  <div className="min-w-0 space-y-3">
                    <div className="flex items-start justify-between gap-3">
                      <div className="space-y-2 flex-1 min-w-0">
                        <div className="flex flex-wrap items-center gap-1.5 text-[9px] font-mono uppercase tracking-[0.22em] text-zinc-500">
                          <span>Shot {index + 1}</span>
                          <span className="rounded-full border border-zinc-800 bg-zinc-950/80 px-2 py-0.5 text-zinc-300 normal-case tracking-normal">{shot.shotType}</span>
                          <span className="rounded-full border border-zinc-800 bg-zinc-950/80 px-2 py-0.5 text-zinc-300 normal-case tracking-normal">{shot.durationSeconds}s</span>
                          <span className={`rounded-full border px-2 py-0.5 normal-case tracking-normal ${shot.boardImageId ? 'border-emerald-500/20 bg-emerald-500/10 text-emerald-300' : 'border-zinc-800 bg-zinc-950/80 text-zinc-500'}`}>
                            {shot.boardImageId ? 'anchor ready' : 'anchor pending'}
                          </span>
                          {index > 0 && (
                            <span className={`rounded-full border px-2 py-0.5 normal-case tracking-normal ${shot.transitionInMode === 'previous-shot' ? 'border-indigo-500/20 bg-indigo-500/10 text-indigo-300' : 'border-zinc-800 bg-zinc-950/80 text-zinc-500'}`}>
                              {shot.transitionInMode === 'previous-shot' ? 'bridge chained' : 'bridge free'}
                            </span>
                          )}
                        </div>
                        <input
                          type="text"
                          title="Storyboard shot title"
                          value={shot.title}
                          onChange={e => handleUpdateStoryboardShot(shot.id, { title: e.target.value })}
                          className="w-full bg-transparent text-sm font-semibold tracking-tight text-white border-b border-transparent focus:border-zinc-700 focus:outline-none"
                          placeholder={`Shot ${index + 1}`}
                        />
                        <div className="text-[11px] text-zinc-400 leading-relaxed truncate" title={shotSummary}>
                          {shotSummary}
                        </div>
                      </div>

                      <div className="flex items-center gap-1 flex-shrink-0">
                        <button
                          type="button"
                          onClick={() => setExpandedMobileShotId(isMobileExpanded ? null : shot.id)}
                          className="lg:hidden inline-flex items-center gap-1 rounded-lg border border-zinc-800 bg-zinc-950/80 px-2 py-1.5 text-[10px] font-mono uppercase tracking-wider text-zinc-300"
                          title={isMobileExpanded ? 'Collapse shot editor' : 'Expand shot editor'}
                        >
                          {isMobileExpanded ? <ChevronUp className="w-3.5 h-3.5" /> : <ChevronDown className="w-3.5 h-3.5" />}
                          <span>{isMobileExpanded ? 'Hide' : 'Edit'}</span>
                        </button>
                        <button
                          type="button"
                          onClick={() => handleDeleteStoryboardShot(shot.id)}
                          className="p-2 rounded-lg text-zinc-500 hover:text-red-400 hover:bg-red-500/10 transition-colors"
                          title="Delete storyboard shot"
                        >
                          <Trash2 className="w-4 h-4" />
                        </button>
                      </div>
                    </div>

                    <div className={`${isMobileExpanded ? 'block' : 'hidden'} lg:block space-y-4 border-t border-zinc-900/80 pt-4`}>
                    <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                      <div className="space-y-1.5">
                        <label className="text-[10px] font-mono uppercase tracking-widest text-zinc-500">Shot Type</label>
                        <select
                          title="Storyboard shot type"
                          value={shot.shotType}
                          onChange={e => handleUpdateStoryboardShot(shot.id, { shotType: e.target.value as StoryboardShotType })}
                          className="w-full bg-zinc-950 border border-zinc-800 text-zinc-200 rounded-xl py-2 px-3 text-xs focus:outline-none focus:border-indigo-500"
                        >
                          {SHOT_TYPE_OPTIONS.map(option => (
                            <option key={option} value={option}>{option}</option>
                          ))}
                        </select>
                      </div>
                      <div className="space-y-1.5">
                        <label className="text-[10px] font-mono uppercase tracking-widest text-zinc-500">Duration</label>
                        <select
                          title="Storyboard shot duration"
                          value={shot.durationSeconds}
                          onChange={e => handleUpdateStoryboardShot(shot.id, { durationSeconds: Number(e.target.value) as 4 | 6 | 8 })}
                          className="w-full bg-zinc-950 border border-zinc-800 text-zinc-200 rounded-xl py-2 px-3 text-xs focus:outline-none focus:border-indigo-500"
                        >
                          <option value={4}>4 seconds</option>
                          <option value={6}>6 seconds</option>
                          <option value={8}>8 seconds</option>
                        </select>
                      </div>
                    </div>

                    <div className="rounded-2xl border border-zinc-900 bg-zinc-900/40 p-4 space-y-3">
                      <div className="flex flex-wrap items-center justify-between gap-2">
                        <label className="text-[10px] font-mono uppercase tracking-widest text-zinc-500">Continuity / Seed Control</label>
                        <span className="text-[10px] font-mono text-zinc-500">
                          {index === 0 ? 'Lead continuity anchor' : `Follows Shot ${index}`}
                        </span>
                      </div>

                      <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
                        <div className="rounded-xl border border-zinc-900 bg-zinc-950/60 p-3 space-y-3">
                          <div className="flex items-center justify-between gap-2">
                            <label className="text-[10px] font-mono uppercase tracking-widest text-zinc-500">Shot Anchor Frame</label>
                            <span className="text-[10px] font-mono text-zinc-500">{storyboardFrameAssets.length} in library</span>
                          </div>

                          {shotAnchorFrame ? (
                            <div className="flex items-center gap-3 rounded-xl border border-zinc-800 bg-zinc-950 p-2.5">
                              <img src={shotAnchorFrame.url} alt={shotAnchorFrame.label} className="w-14 h-14 rounded-lg object-cover border border-zinc-800" referrerPolicy="no-referrer" />
                              <div className="min-w-0">
                                <div className="text-[11px] text-zinc-200 font-medium truncate" title={shotAnchorFrame.label}>{shotAnchorFrame.label}</div>
                                <div className="text-[10px] font-mono text-zinc-500 uppercase tracking-wider">Anchor source for downstream shots</div>
                              </div>
                            </div>
                          ) : (
                            <div className="rounded-xl border border-dashed border-zinc-800 bg-zinc-950/40 px-3 py-4 text-center text-[10px] text-zinc-500">
                              Upload or pick a frame that represents this shot's final look so later beats can bridge from it.
                            </div>
                          )}

                          <select
                            title="Storyboard shot anchor frame"
                            value={shot.boardImageId || ''}
                            onChange={e => handleUpdateStoryboardShot(shot.id, { boardImageId: e.target.value || null })}
                            className="w-full bg-zinc-950 border border-zinc-800 text-zinc-200 rounded-xl py-2 px-3 text-xs focus:outline-none focus:border-indigo-500"
                          >
                            <option value="">No anchor frame selected</option>
                            {storyboardFrameAssets.map(asset => (
                              <option key={asset.id} value={asset.id}>{asset.label}</option>
                            ))}
                          </select>

                          <div className="flex flex-wrap gap-2">
                            <button
                              type="button"
                              onClick={() => openStoryboardFrameUpload(shot.id, 'board')}
                              disabled={isUploadingStoryboardFrame}
                              className="text-[10px] font-mono uppercase tracking-wider text-emerald-300 bg-emerald-500/10 border border-emerald-500/20 px-2.5 py-1 rounded-full disabled:opacity-50"
                            >
                              {isUploadingStoryboardFrame && storyboardFrameUploadTarget?.shotId === shot.id && storyboardFrameUploadTarget?.assignment === 'board' ? 'Uploading...' : 'Upload anchor'}
                            </button>
                            {shot.boardImageId && (
                              <button
                                type="button"
                                onClick={() => handleUpdateStoryboardShot(shot.id, { boardImageId: null })}
                                className="text-[10px] font-mono uppercase tracking-wider text-zinc-300 bg-zinc-900 border border-zinc-800 px-2.5 py-1 rounded-full"
                              >
                                Clear anchor
                              </button>
                            )}
                          </div>
                        </div>

                        <div className="rounded-xl border border-zinc-900 bg-zinc-950/60 p-3 space-y-3">
                          <div className="flex items-center justify-between gap-2">
                            <label className="text-[10px] font-mono uppercase tracking-widest text-zinc-500">Transition Bridge</label>
                            <span className="text-[10px] font-mono text-zinc-500">1 slot reserved max</span>
                          </div>

                          <select
                            title="Storyboard transition bridge mode"
                            value={shot.transitionInMode || 'none'}
                            onChange={e => handleUpdateStoryboardShot(shot.id, {
                              transitionInMode: e.target.value as StoryboardTransitionMode,
                              transitionInAssetId: e.target.value === 'custom-frame' ? shot.transitionInAssetId : null,
                            })}
                            className="w-full bg-zinc-950 border border-zinc-800 text-zinc-200 rounded-xl py-2 px-3 text-xs focus:outline-none focus:border-indigo-500"
                          >
                            {TRANSITION_MODE_OPTIONS.map(option => (
                              <option key={option.value} value={option.value}>{option.label}</option>
                            ))}
                          </select>

                          <div className="text-[10px] text-zinc-500 leading-relaxed">
                            {TRANSITION_MODE_OPTIONS.find(option => option.value === (shot.transitionInMode || 'none'))?.hint}
                          </div>

                          {shot.transitionInMode === 'custom-frame' && (
                            <>
                              <select
                                title="Storyboard custom transition frame"
                                value={shot.transitionInAssetId || ''}
                                onChange={e => handleUpdateStoryboardShot(shot.id, { transitionInAssetId: e.target.value || null })}
                                className="w-full bg-zinc-950 border border-zinc-800 text-zinc-200 rounded-xl py-2 px-3 text-xs focus:outline-none focus:border-indigo-500"
                              >
                                <option value="">Select a custom continuity frame</option>
                                {storyboardFrameAssets.map(asset => (
                                  <option key={asset.id} value={asset.id}>{asset.label}</option>
                                ))}
                              </select>

                              {customTransitionFrame && (
                                <div className="flex items-center gap-3 rounded-xl border border-zinc-800 bg-zinc-950 p-2.5">
                                  <img src={customTransitionFrame.url} alt={customTransitionFrame.label} className="w-14 h-14 rounded-lg object-cover border border-zinc-800" referrerPolicy="no-referrer" />
                                  <div className="min-w-0">
                                    <div className="text-[11px] text-zinc-200 font-medium truncate" title={customTransitionFrame.label}>{customTransitionFrame.label}</div>
                                    <div className="text-[10px] font-mono text-zinc-500 uppercase tracking-wider">Custom bridge frame</div>
                                  </div>
                                </div>
                              )}
                            </>
                          )}

                          {shot.transitionInMode === 'previous-shot' && previousShot && (
                            <div className="rounded-xl border border-zinc-800 bg-zinc-950 px-3 py-2 text-[10px] font-mono text-zinc-500 leading-relaxed">
                              {previousShot.boardImageId
                                ? `Pulling from Shot ${index}'s anchor frame when this shot renders.`
                                : `Shot ${index} does not have an anchor frame yet.`}
                            </div>
                          )}

                          <div className="flex flex-wrap gap-2">
                            <button
                              type="button"
                              onClick={() => openStoryboardFrameUpload(shot.id, 'transition')}
                              disabled={isUploadingStoryboardFrame}
                              className="text-[10px] font-mono uppercase tracking-wider text-sky-300 bg-sky-500/10 border border-sky-500/20 px-2.5 py-1 rounded-full disabled:opacity-50"
                            >
                              {isUploadingStoryboardFrame && storyboardFrameUploadTarget?.shotId === shot.id && storyboardFrameUploadTarget?.assignment === 'transition' ? 'Uploading...' : 'Upload bridge frame'}
                            </button>
                            {shot.transitionInMode === 'custom-frame' && shot.transitionInAssetId && (
                              <button
                                type="button"
                                onClick={() => handleUpdateStoryboardShot(shot.id, { transitionInAssetId: null })}
                                className="text-[10px] font-mono uppercase tracking-wider text-zinc-300 bg-zinc-900 border border-zinc-800 px-2.5 py-1 rounded-full"
                              >
                                Clear bridge
                              </button>
                            )}
                          </div>

                          <div className="rounded-xl border border-zinc-900 bg-zinc-950/60 px-3 py-2.5 text-[10px] font-mono text-zinc-500 leading-relaxed">
                            {getTransitionSummary(selectedScene, shot, index, storyboardFrameAssets)}
                          </div>
                        </div>
                      </div>

                      <div className="grid grid-cols-1 gap-3 lg:grid-cols-3">
                        <div className="space-y-1.5">
                          <label className="text-[10px] font-mono uppercase tracking-widest text-zinc-500">Seed Strategy</label>
                          <select
                            title="Storyboard shot seed strategy"
                            value={shot.seedStrategy || 'auto'}
                            onChange={e => handleUpdateStoryboardShot(shot.id, { seedStrategy: e.target.value as StoryboardSeedStrategy })}
                            className="w-full bg-zinc-950 border border-zinc-800 text-zinc-200 rounded-xl py-2 px-3 text-xs focus:outline-none focus:border-indigo-500"
                          >
                            {SEED_STRATEGY_OPTIONS.map(option => (
                              <option key={option.value} value={option.value}>{option.label}</option>
                            ))}
                          </select>
                          <div className="text-[10px] text-zinc-500 leading-relaxed">
                            {SEED_STRATEGY_OPTIONS.find(option => option.value === (shot.seedStrategy || 'auto'))?.hint}
                          </div>
                        </div>

                        <div className="space-y-1.5">
                          <label className="text-[10px] font-mono uppercase tracking-widest text-zinc-500">Locked Seed</label>
                          <input
                            type="number"
                            min={1}
                            step={1}
                            inputMode="numeric"
                            title="Locked storyboard seed"
                            value={shot.lockedSeed ?? ''}
                            disabled={shot.seedStrategy !== 'lock'}
                            onChange={e => handleUpdateStoryboardShot(shot.id, { lockedSeed: sanitizeStoryboardSeed(e.target.value) })}
                            className="w-full bg-zinc-950 border border-zinc-800 text-zinc-200 rounded-xl py-2 px-3 text-xs focus:outline-none focus:border-indigo-500 disabled:opacity-50 disabled:cursor-not-allowed"
                            placeholder="e.g. 481516234"
                          />
                          <div className="text-[10px] text-zinc-500 leading-relaxed">
                            Save a known-good seed here when you want this panel to be reproducible across reruns.
                          </div>
                        </div>

                        <div className="space-y-1.5">
                          <label className="text-[10px] font-mono uppercase tracking-widest text-zinc-500">Last Render Seed</label>
                          <div className="w-full min-h-[40px] rounded-xl border border-zinc-800 bg-zinc-950 px-3 py-2 flex items-center text-xs text-zinc-200">
                            {shot.lastRenderSeed ? shot.lastRenderSeed.toLocaleString() : 'Pending first render'}
                          </div>
                          <div className="text-[10px] text-zinc-500 leading-relaxed">
                            Export mode stores the applied render seed here so retries can preserve or intentionally vary lineage.
                          </div>
                        </div>
                      </div>

                      <div className="rounded-xl border border-zinc-900 bg-zinc-950/60 px-3 py-2.5 text-[10px] font-mono text-zinc-500 leading-relaxed">
                        {getSeedStrategySummary(shot, index, storyboardShots[index - 1])}
                      </div>
                    </div>

                    <div className="grid grid-cols-1 gap-3 lg:grid-cols-2">
                      <div className="space-y-1.5">
                        <label className="text-[10px] font-mono uppercase tracking-widest text-zinc-500">Composition</label>
                        <textarea
                          title="Storyboard composition"
                          value={shot.composition}
                          onChange={e => handleUpdateStoryboardShot(shot.id, { composition: e.target.value })}
                          className="w-full bg-zinc-950 border border-zinc-800 rounded-xl p-3 text-xs text-zinc-200 placeholder-zinc-600 focus:outline-none focus:border-indigo-500 min-h-[86px] resize-none"
                          placeholder="Describe framing, composition, and lens emphasis."
                        />
                      </div>
                      <div className="space-y-1.5">
                        <label className="text-[10px] font-mono uppercase tracking-widest text-zinc-500">Action</label>
                        <textarea
                          title="Storyboard shot action"
                          value={shot.action}
                          onChange={e => handleUpdateStoryboardShot(shot.id, { action: e.target.value })}
                          className="w-full bg-zinc-950 border border-zinc-800 rounded-xl p-3 text-xs text-zinc-200 placeholder-zinc-600 focus:outline-none focus:border-indigo-500 min-h-[86px] resize-none"
                          placeholder="Describe actor blocking, movement, and cinematic action."
                        />
                      </div>
                    </div>

                    <div className="space-y-1.5">
                      <label className="text-[10px] font-mono uppercase tracking-widest text-zinc-500">Dialogue / Audio Beat</label>
                      <textarea
                        title="Storyboard dialogue excerpt"
                        value={shot.dialogueExcerpt || getShotDialogueExcerpt(selectedScene, characters, shot)}
                        onChange={e => handleUpdateStoryboardShot(shot.id, { dialogueExcerpt: e.target.value })}
                        className="w-full bg-zinc-950 border border-zinc-800 rounded-xl p-3 text-xs text-zinc-200 placeholder-zinc-600 focus:outline-none focus:border-indigo-500 min-h-[72px] resize-none"
                        placeholder="Quoted dialogue, ambient sound, or performance beat for this shot."
                      />
                      {shot.dialogueLineIds.length > 0 && (
                        <div className="text-[10px] font-mono text-zinc-500">
                          Covers {shot.dialogueLineIds.length} scripted line{shot.dialogueLineIds.length === 1 ? '' : 's'} from the scene timeline.
                        </div>
                      )}
                    </div>

                    <div className="space-y-1.5">
                      <label className="text-[10px] font-mono uppercase tracking-widest text-zinc-500">Continuity Notes</label>
                      <textarea
                        title="Storyboard continuity notes"
                        value={shot.continuityNotes}
                        onChange={e => handleUpdateStoryboardShot(shot.id, { continuityNotes: e.target.value })}
                        className="w-full bg-zinc-950 border border-zinc-800 rounded-xl p-3 text-xs text-zinc-200 placeholder-zinc-600 focus:outline-none focus:border-indigo-500 min-h-[72px] resize-none"
                        placeholder="Preserve costume, emotional continuity, geography, and background behavior across this shot."
                      />
                    </div>
                    </div>
                  </div>
                </div>
              </div>
            );
            })}
          </div>
        )}
        </div>
      </div>

      <div className={`${mobileWorkspaceView !== 'dialogue' ? 'hidden lg:block ' : ''}space-y-4`}>
        <h3 className="text-sm font-semibold tracking-tight text-white flex items-center justify-between">
          <span>Dialogue Sequences</span>
          <span className="text-[10px] font-mono text-zinc-500 uppercase">Interactive Timeline</span>
        </h3>

        {selectedScene.dialogues.length === 0 ? (
          <div className="bg-zinc-900/30 border border-zinc-900 rounded-2xl p-8 text-center text-zinc-600">
            <Volume2 className="w-8 h-8 mx-auto stroke-1 mb-2 opacity-30" />
            <p className="text-xs">No dialogues added. Use the form below to record action beats and dialogue before storyboarding.</p>
          </div>
        ) : (
          <div className="space-y-3">
            {selectedScene.dialogues.map((item, index) => (
              <div
                key={item.id}
                className="bg-zinc-900/60 border border-zinc-800/80 rounded-2xl p-4 flex gap-3 items-center justify-between relative group animate-in slide-in-from-bottom-2 duration-200"
              >
                {editingDialogueId === item.id ? (
                  <div className="flex-1 space-y-2">
                    <div className="flex items-center gap-2 mb-1">
                      <span className="text-xs font-semibold text-white tracking-tight">{getCharName(item.characterId)}</span>
                      <span className="text-[9px] font-mono text-indigo-400 bg-indigo-500/10 px-1.5 py-0.5 rounded leading-none">Editing Dialogue</span>
                    </div>
                    <div className="flex gap-2">
                      <input
                        type="text"
                        title="Edit dialogue text"
                        value={editingText}
                        onChange={e => setEditingText(e.target.value)}
                        className="flex-1 bg-zinc-950 border border-zinc-800 rounded-lg p-2 text-xs text-zinc-200 placeholder-zinc-650 focus:outline-none focus:border-indigo-500"
                        placeholder="Type dialogue text..."
                        autoFocus
                        onKeyDown={e => {
                          if (e.key === 'Enter') {
                            e.preventDefault();
                            handleSaveEditDialogue(item.id);
                          } else if (e.key === 'Escape') {
                            setEditingDialogueId(null);
                          }
                        }}
                      />
                      <button
                        type="button"
                        onClick={() => handleSaveEditDialogue(item.id)}
                        className="bg-emerald-600/20 hover:bg-emerald-600/35 border border-emerald-500/20 p-2 text-emerald-300 rounded-lg transition-colors cursor-pointer"
                        title="Save dialogue changes"
                      >
                        <Check className="w-3.5 h-3.5" />
                      </button>
                      <button
                        type="button"
                        onClick={() => setEditingDialogueId(null)}
                        className="bg-zinc-800 hover:bg-zinc-700 border border-zinc-700 p-2 text-zinc-400 rounded-lg transition-colors cursor-pointer"
                        title="Cancel dialogue edit"
                      >
                        <X className="w-3.5 h-3.5" />
                      </button>
                    </div>
                  </div>
                ) : (
                  <>
                    <div className="flex-1">
                      <div className="flex items-center gap-2 mb-1.5">
                        <span className="text-[9px] font-mono uppercase tracking-widest text-zinc-500">#{index + 1}</span>
                        <span className="text-xs font-semibold text-white tracking-tight">{getCharName(item.characterId)}</span>
                        <span className={`text-[9px] font-mono font-medium tracking-tight uppercase px-2 py-0.5 rounded-full ${
                          item.sentiment === 'tense' ? 'bg-rose-500/10 text-rose-400 border border-rose-500/20' :
                          item.sentiment === 'playful' ? 'bg-emerald-500/10 text-emerald-400 border border-emerald-500/20' :
                          item.sentiment === 'mysterious' ? 'bg-fuchsia-500/10 text-fuchsia-400 border border-fuchsia-500/20' :
                          item.sentiment === 'determined' ? 'bg-indigo-500/10 text-indigo-400 border border-indigo-500/20' :
                          'bg-zinc-800 text-zinc-400'
                        }`}>
                          {item.sentiment}
                        </span>
                      </div>
                      <p className="text-xs text-zinc-300 leading-relaxed font-sans mt-1">“{item.text}”</p>
                    </div>
                    <div className="flex items-center gap-1.5 ml-3 flex-shrink-0">
                      <button
                        type="button"
                        onClick={() => handleStartEditDialogue(item)}
                        className="p-1.5 rounded-lg text-zinc-400 hover:text-indigo-400 hover:bg-indigo-400/10 transition-colors cursor-pointer"
                        title="Edit dialogue"
                      >
                        <Edit className="w-3.5 h-3.5" />
                      </button>
                      <button
                        type="button"
                        onClick={() => handleDeleteDialogue(item.id)}
                        className="p-1.5 rounded-lg text-zinc-400 hover:text-red-400 hover:bg-red-400/10 transition-colors cursor-pointer"
                        title="Delete dialogue"
                      >
                        <Trash2 className="w-3.5 h-3.5" />
                      </button>
                    </div>
                  </>
                )}
              </div>
            ))}
          </div>
        )}
      </div>

      <form onSubmit={handleAddDialogue} className={`${mobileWorkspaceView !== 'dialogue' ? 'hidden lg:block ' : ''}bg-zinc-900/50 p-4 rounded-2xl border border-zinc-800 space-y-3`}>
        <label className="text-[10px] font-mono text-zinc-400 uppercase tracking-widest block">Append Act Sequence</label>

        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
          <div className="space-y-1">
            <span className="text-[10px] font-medium text-zinc-500">Character</span>
            <select
              title="Dialogue speaker"
              value={selectedCharId}
              onChange={e => setSelectedCharId(e.target.value)}
              className="w-full bg-zinc-950 border border-zinc-800 text-zinc-100 rounded-lg py-2 px-2.5 text-xs focus:outline-none focus:border-indigo-500 focus:ring-0 appearance-none h-[36px]"
            >
              {characters.map(character => (
                <option key={character.id} value={character.id}>{character.name}</option>
              ))}
            </select>
          </div>

          <div className="space-y-1">
            <span className="text-[10px] font-medium text-zinc-500">Sentiment Delivery</span>
            <select
              title="Dialogue sentiment"
              value={selectedSentiment}
              onChange={e => setSelectedSentiment(e.target.value as typeof selectedSentiment)}
              className="w-full bg-zinc-950 border border-zinc-800 text-zinc-100 rounded-lg py-2 px-2.5 text-xs focus:outline-none focus:border-indigo-500 focus:ring-0 appearance-none h-[36px]"
            >
              <option value="neutral">Neutral Plain</option>
              <option value="tense">Tense / Conflict</option>
              <option value="playful">Playful / Witty</option>
              <option value="mysterious">Mysterious / Quiet</option>
              <option value="determined">Determined / Heroic</option>
            </select>
          </div>
        </div>

        <div className="flex flex-col gap-2 sm:flex-row sm:gap-2">
          <input
            type="text"
            title="Dialogue line"
            value={activeDialogueInput}
            onChange={e => setActiveDialogueInput(e.target.value)}
            className="flex-1 bg-zinc-950 border border-zinc-800 rounded-lg p-2 px-3 text-xs text-zinc-200 placeholder-zinc-600 focus:outline-none focus:border-indigo-500 min-w-0"
            placeholder="Type speech line or performance beat..."
          />
          <button
            type="button"
            onClick={handleAISuggest}
            disabled={isSuggesting}
            className="bg-indigo-600/20 hover:bg-indigo-600/30 text-indigo-300 border border-indigo-500/25 text-xs font-semibold px-3 py-2 rounded-lg flex items-center justify-center gap-1.5 cursor-pointer disabled:opacity-50 transition-colors sm:justify-start"
            title="Auto-suggest dialogue using Gemini AI"
          >
            <Sparkles className={`w-3.5 h-3.5 ${isSuggesting ? 'animate-spin' : ''}`} />
            <span className="hidden sm:inline">{isSuggesting ? 'Drafting...' : 'AI Suggest'}</span>
            <span className="sm:hidden">{isSuggesting ? 'Drafting...' : 'Suggest'}</span>
          </button>
          <button
            type="submit"
            className="bg-zinc-100 hover:bg-white text-zinc-900 text-xs font-semibold px-4 py-2 rounded-lg flex items-center justify-center gap-1 cursor-pointer transition-colors sm:justify-start"
          >
            <Play className="w-3 h-3 fill-current" />
            <span>Cast</span>
          </button>
        </div>
      </form>
    </div>
  );
}
