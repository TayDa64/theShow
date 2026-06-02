import React, { useState, useEffect, useRef } from 'react';
import { ChevronLeft, Sparkles, Image as ImageIcon, Check, RefreshCw, Upload } from 'lucide-react';
import type { Character } from '../types';
import {
  createReferenceAsset,
  getCharacterDisplayImage,
  getCharacterReferenceAssets,
  syncCharacterImageState,
  upsertCharacterAsset,
} from '../utils/storyforge';

type BiometricTone = 'rose' | 'cyan' | 'amber' | 'emerald' | 'violet' | 'white' | 'gold' | 'zinc';

// Map textual color entries to named visual tones so the HUD can stay CSS-driven.
const resolveBiometricTone = (colorStr: string): BiometricTone => {
  const norm = (colorStr || '').toLowerCase();
  if (norm.includes('pink') || norm.includes('fuchsia') || norm.includes('magenta')) return 'rose';
  if (norm.includes('blue') || norm.includes('cyan') || norm.includes('teal') || norm.includes('electric') || norm.includes('azure')) return 'cyan';
  if (norm.includes('crimson') || norm.includes('red') || norm.includes('scarlet') || norm.includes('fire')) return 'rose';
  if (norm.includes('amber') || norm.includes('yellow') || norm.includes('orange')) return 'amber';
  if (norm.includes('green') || norm.includes('emerald') || norm.includes('mint')) return 'emerald';
  if (norm.includes('purple') || norm.includes('violet') || norm.includes('indigo') || norm.includes('grape')) return 'violet';
  if (norm.includes('white') || norm.includes('ash') || norm.includes('platinum')) return 'white';
  if (norm.includes('brown') || norm.includes('hazel') || norm.includes('gold')) return 'gold';
  return 'zinc';
};

const resolveBuildIndex = (build: string) => {
  const norm = (build || '').toLowerCase();
  if (norm === 'slim') return 40;
  if (norm === 'average') return 65;
  if (norm === 'muscular') return 95;
  return 80;
};

const resolveGenderIndex = (gender: string) => {
  const norm = (gender || '').toLowerCase();
  if (norm === 'male' || norm === 'female') return 100;
  return 70;
};

export const STYLE_PRESETS = [
  // 1. Photorealistic & Cinematic Humans
  { id: 'cinematic-actor', name: 'Cinematic Actor', group: 'Photorealistic Humans', description: 'Lifelike skin micro-textures, expressions & hair physics.' },
  { id: 'historical-figure', name: 'Historical Figure', group: 'Photorealistic Humans', description: 'Period apparel textures like wool garments and leather coats.' },
  { id: 'cyberpunk-human', name: 'Futuristic / Cyberpunk', group: 'Photorealistic Humans', description: 'Glowing neon implants and reflective hard-surface visors.' },
  
  // 2. 3D Digital Animation Styles
  { id: 'stylized-3d', name: 'Stylized 3D (Pixar Style)', group: '3D Digital Animation', description: 'Soft skin sub-scattering and oversized expressive eyes.' },
  { id: 'video-game-cg', name: 'Video Game CG (Unreal)', group: '3D Digital Animation', description: 'Gritty, cinematic character with high-contrast key lights.' },
  { id: 'cute-chibi', name: 'Cute Chibi / Vinyl Toy', group: '3D Digital Animation', description: 'Delightful miniatures with smooth, glossy plastic finishes.' },

  // 3. Traditional & Non-Photorealistic Animation
  { id: 'anime-manga', name: 'Anime & Manga cel-shaded', group: 'Traditional & NPR', description: 'Cel-shaded render with clean ink outlines and bold hair.' },
  { id: 'retro-comic', name: 'Retro Comic / Graphic Novel', group: 'Traditional & NPR', description: 'Ink cross-hatching, heavy borders and print halftone dots.' },
  { id: 'pencil-sketch', name: 'Hand-Drawn Pencil Jitter', group: 'Traditional & NPR', description: 'Textured graphite sketches with frame-by-frame outline jitter.' },

  // 4. Tactile & Physical Mediums (Stop-Motion)
  { id: 'claymation', name: 'Claymation (Aardman Style)', group: 'Tactile Stop-Motion', description: 'Tactile modeling clay skins with subtle fingerprint tracks.' },
  { id: 'felt-puppet', name: 'Felt / Needle-Felted Puppet', group: 'Tactile Stop-Motion', description: 'Fuzzy soft materials that catch beautiful fuzzy rim-lighting.' },
  { id: 'wooden-figurine', name: 'Rigid Origami / Carved Wood', group: 'Tactile Stop-Motion', description: 'Geometric folded paper or carved wood with rigid joints.' },

  // 5. Anthropomorphic & Fantasy Creatures
  { id: 'mythological-beast', name: 'Mythological Beast Hybrid', group: 'Fantasy & Entities', description: 'Fusions of human traits with fur, feathers, and organic scales.' },
  { id: 'sentient-object', name: 'Sentient Object / Mascot', group: 'Fantasy & Entities', description: 'Everyday objects brought to life with fluid visual physics.' },
];

interface CharacterEditorProps {
  character: Character;
  onClose: () => void;
  onSave: (char: Character) => void;
}

export function CharacterEditor({ character, onClose, onSave }: CharacterEditorProps) {
  const [editedChar, setEditedChar] = useState<Character>(character);
  const [activeTab, setActiveTab] = useState<'appearance' | 'identity'>('appearance');
  const [isGenerating, setIsGenerating] = useState(false);
  const [isGeneratingPortrait, setIsGeneratingPortrait] = useState(false);
  const [isUploadingReference, setIsUploadingReference] = useState(false);
  const [genMessage, setGenMessage] = useState('');
  const uploadInputRef = useRef<HTMLInputElement>(null);

  const activeDisplayImage = getCharacterDisplayImage(editedChar);
  const referenceAssets = getCharacterReferenceAssets(editedChar);
  const hairTone = resolveBiometricTone(editedChar.properties.hairColor);
  const eyeTone = resolveBiometricTone(editedChar.properties.eyeColor);

  useEffect(() => {
    setEditedChar(syncCharacterImageState(character));
  }, [character]);

  const activateReferenceAsset = (assetId: string) => {
    setEditedChar(prev => syncCharacterImageState({ ...prev, activeImageId: assetId }));
  };

  const addGeneratedPortraitAsset = (url: string) => {
    const asset = createReferenceAsset({
      kind: 'character-generated',
      origin: 'generated',
      label: `${editedChar.name || 'Character'} AI portrait`,
      url,
    });

    setEditedChar(prev => upsertCharacterAsset(prev, asset, true));
  };

  const handleUploadReference = async (event: React.ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    if (!file) return;

    setIsUploadingReference(true);
    setGenMessage('Uploading continuity reference...');

    try {
      const formData = new FormData();
      formData.append('file', file);
      formData.append('kind', 'character-upload');
      formData.append('label', file.name);

      const response = await fetch('/api/upload-reference', {
        method: 'POST',
        body: formData,
      });

      if (!response.ok) {
        throw new Error('Character reference upload failed.');
      }

      const data = await response.json();
      if (data?.asset?.url) {
        setEditedChar(prev => upsertCharacterAsset(prev, data.asset, true));
      }
    } catch (error) {
      console.warn('Character reference upload failed:', error);
    } finally {
      setIsUploadingReference(false);
      setGenMessage('');
      event.target.value = '';
    }
  };

  const triggerAIPortrait = async () => {
    if (isGeneratingPortrait) return;
    setIsGeneratingPortrait(true);
    setGenMessage('Conceiving neural concept sketch...');

    try {
      const response = await fetch('/api/generate-portrait', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({
          name: editedChar.name,
          role: editedChar.role,
          properties: editedChar.properties
        })
      });

      if (!response.ok) {
        throw new Error('Portrait assistant service returned negative');
      }

      const data = await response.json();
      if (data && data.url) {
        addGeneratedPortraitAsset(data.url);
      }
    } catch (error) {
      console.warn("AI portrait custom generation error, triggering robust fallback styling:", error);
      const seed = encodeURIComponent(editedChar.name || 'avatar-backup');
      addGeneratedPortraitAsset(`https://api.dicebear.com/7.x/adventurer/svg?seed=${seed}&backgroundColor=09090b`);
    } finally {
      setIsGeneratingPortrait(false);
      setGenMessage('');
    }
  };

  const handlePropChange = (key: keyof typeof editedChar.properties, value: string | number) => {
    setEditedChar(prev => ({
      ...prev,
      properties: {
        ...prev.properties,
        [key]: value
      }
    }));
  };

  // Automated/AI Character Backstory & Aesthetic Generator
  const triggerAIGenerator = async () => {
    setIsGenerating(true);
    setGenMessage('Analyzing character outline...');
    
    try {
      const response = await fetch('/api/generate-character', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({
          name: editedChar.name,
          role: editedChar.role,
          properties: editedChar.properties
        })
      });

      if (!response.ok) {
        throw new Error('AI service error');
      }

      setGenMessage('Crystallizing identity profile...');
      const aiData = await response.json();
      
      setEditedChar(prev => ({
        ...prev,
        name: aiData.name || prev.name,
        role: aiData.role || prev.role,
        properties: {
          ...prev.properties,
          ...aiData.properties
        }
      }));
    } catch (error) {
      console.warn("AI Character generation server call failed. Invoking responsive fallback...", error);
      setGenMessage('Invoking local generation fallback...');
      await new Promise(resolve => setTimeout(resolve, 800));

      const bios = [
        "A former tech courier from the glowing sectors who became an outlaw after discovering an encrypted datashall.",
        "An enigmatic wanderer who holds ancient keycodes to the cloud sanctum. Quiet but fiercely determined.",
        "An rogue mechanical engineer haunted by her past creations, constantly tuning her cyberware.",
        "A street-savvy fixer specialized in neon-grid telemetry, known to both megacorps and insurgent cells."
      ];
      const outfits = [
        "Heavy carbonweight protective duster with reactive neon linings and boots designed for quiet steps.",
        "Oil-stained utility vest fitted with holographic tools, high-density gloves, and cybernetic lens overlays.",
        "Matte-black dynamic mesh tactical coat with integrated cooling grills and high-collar safety armor.",
        "Retro-futuristic bomber jacket printed with local block code, accompanied by custom smart-goggles."
      ];
      const temps = ["Stoic", "Rebellious", "Calculated", "Witty", "Volatile"];
      const hairs = ["Cyber Hawk", "Neon Buzzcut", "Messy Braid", "Sleek Side-part", "Shaved Undercut"];
      const colors = ["Cyberpunk Pink", "Ash White", "Jet Black", "Electric Teal", "Volcano Amber"];

      const randomBio = bios[Math.floor(Math.random() * bios.length)];
      const randomOutfit = outfits[Math.floor(Math.random() * outfits.length)];
      const randomTemp = temps[Math.floor(Math.random() * temps.length)];
      const randomHair = hairs[Math.floor(Math.random() * hairs.length)];
      const randomColor = colors[Math.floor(Math.random() * colors.length)];

      setEditedChar(prev => ({
        ...prev,
        name: prev.name === 'New Subject' || !prev.name ? `Subject #${Math.floor(100 + Math.random() * 900)}` : prev.name,
        properties: {
          ...prev.properties,
          backstory: randomBio,
          outfit: randomOutfit,
          temperament: randomTemp,
          hairStyle: randomHair,
          hairColor: randomColor,
          eyeColor: ["Crimson", "Emerald", "Cyan", "Amber", "Deep Violet"][Math.floor(Math.random() * 5)]
        }
      }));
    } finally {
      setIsGenerating(false);
      setGenMessage('');
    }
  };

  return (
    <div className="absolute inset-0 z-30 bg-zinc-950 flex flex-col overflow-hidden animate-in fade-in zoom-in-95 duration-200">
      {/* Editor Header */}
      <header className="flex items-center justify-between px-5 py-4 border-b border-zinc-900 bg-zinc-950/90 backdrop-blur-md sticky top-0 z-40">
        <button onClick={onClose} title="Close character editor" className="p-2 -ml-2 text-zinc-400 hover:text-white transition-colors">
          <ChevronLeft className="w-5 h-5" />
        </button>
        <div className="text-sm font-medium tracking-tight font-sans text-zinc-200">Character Builder</div>
        <button 
          onClick={() => onSave(syncCharacterImageState(editedChar))} 
          className="bg-indigo-600 hover:bg-indigo-500 text-white text-xs font-semibold px-4 py-1.5 rounded-full shadow-lg hover:shadow-indigo-500/20 transition-all flex items-center gap-1"
        >
          <Check className="w-3.5 h-3.5" />
          <span>Save</span>
        </button>
      </header>

      <div className="flex-1 overflow-y-auto pb-24">
        <input
          ref={uploadInputRef}
          type="file"
          title="Upload character reference image"
          accept="image/png,image/jpeg,image/webp,image/gif"
          className="hidden"
          onChange={handleUploadReference}
        />

        {/* Character Portrait Simulator */}
        <div className="relative aspect-[4/3] bg-gradient-to-b from-zinc-900 to-zinc-950 flex flex-col items-center justify-center border-b border-zinc-900 p-8 pb-28 sm:pb-24">
          <div 
            onClick={triggerAIPortrait}
            title="Click to generate dynamic character portrait"
            className="w-24 h-24 rounded-2xl bg-zinc-900/80 border border-zinc-800 flex items-center justify-center shadow-inner relative overflow-hidden group cursor-pointer hover:border-indigo-500 transition-all"
          >
            {activeDisplayImage ? (
              <img 
                src={activeDisplayImage} 
                alt={editedChar.name} 
                className="w-full h-full object-cover group-hover:scale-105 transition-transform duration-300" 
                referrerPolicy="no-referrer"
              />
            ) : (
              <div className="text-zinc-600 flex flex-col items-center">
                <span className="text-2xl font-bold text-zinc-400 font-mono">
                  {editedChar.name ? editedChar.name[0]?.toUpperCase() : 'S'}
                </span>
                <span className="text-[8px] font-mono text-zinc-500 mt-1 uppercase tracking-wider group-hover:text-indigo-400">Generate</span>
              </div>
            )}
            
            {/* Hover overlay indicator */}
            <div className="absolute inset-0 bg-black/40 opacity-0 group-hover:opacity-100 flex items-center justify-center transition-opacity">
              <ImageIcon className="w-4 h-4 text-white" />
            </div>

            {isGeneratingPortrait && (
              <div className="absolute inset-0 bg-zinc-950/80 flex items-center justify-center">
                <RefreshCw className="w-5 h-5 text-emerald-400 animate-spin" />
              </div>
            )}
            {isUploadingReference && (
              <div className="absolute inset-0 bg-zinc-950/80 flex items-center justify-center">
                <RefreshCw className="w-5 h-5 text-sky-400 animate-spin" />
              </div>
            )}
            {isGenerating && (
              <div className="absolute inset-0 bg-zinc-950/80 flex items-center justify-center">
                <RefreshCw className="w-5 h-5 text-indigo-400 animate-spin" />
              </div>
            )}
          </div>
          
          <div className="mt-4 text-center">
            <h3 className="text-sm font-semibold tracking-tight text-zinc-200">{editedChar.name || 'Unnamed Character'}</h3>
            <p className="text-xs text-zinc-500 font-mono mt-0.5">{editedChar.role || 'No Class Specified'}</p>
            <p className="text-[10px] text-zinc-500 font-mono mt-2">
              {referenceAssets.length} continuity image{referenceAssets.length === 1 ? '' : 's'} available
            </p>
          </div>

          <div className="absolute inset-x-4 bottom-4 flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
            <button 
              type="button"
              onClick={triggerAIPortrait}
              disabled={isGeneratingPortrait || isGenerating}
              className="bg-zinc-900 hover:bg-zinc-800 border border-zinc-800 text-zinc-300 hover:text-white text-xs font-medium px-4 py-2 rounded-full transition-all flex items-center justify-center gap-1.5 cursor-pointer shadow-lg disabled:opacity-50 sm:w-auto sm:justify-start"
            >
              <ImageIcon className="w-3.5 h-3.5 text-emerald-400" />
              <span>{isGeneratingPortrait ? 'Sketching...' : 'Gen Portrait'}</span>
            </button>

            <button
              type="button"
              onClick={() => uploadInputRef.current?.click()}
              disabled={isGeneratingPortrait || isGenerating || isUploadingReference}
              className="bg-sky-500/10 hover:bg-sky-500/20 border border-sky-500/20 text-sky-300 px-4 py-2 rounded-full text-xs font-semibold flex items-center justify-center gap-1.5 shadow-lg cursor-pointer disabled:opacity-50 sm:w-auto"
            >
              <Upload className="w-3.5 h-3.5" />
              <span>{isUploadingReference ? 'Uploading...' : 'Upload Ref'}</span>
            </button>

            <button 
              type="button"
              onClick={triggerAIGenerator}
              disabled={isGenerating || isGeneratingPortrait || isUploadingReference}
              className="bg-zinc-100 hover:bg-white text-zinc-950 text-xs font-semibold px-4 py-2 rounded-full transition-all flex items-center justify-center gap-1.5 cursor-pointer shadow-lg disabled:opacity-50 sm:w-auto sm:justify-start"
            >
              <Sparkles className="w-3.5 h-3.5 text-indigo-500 animate-pulse" />
              <span>{isGenerating ? 'Synthesizing...' : 'AI Autofill'}</span>
            </button>
          </div>

          {(isGenerating || isGeneratingPortrait || isUploadingReference) && (
            <div className="absolute top-4 left-4 right-4 bg-indigo-950/90 border border-indigo-500/25 px-3 py-1.5 rounded-lg text-[10px] font-mono text-indigo-300 flex items-center gap-2 shadow-xl animate-in slide-in-from-top-1">
              <RefreshCw className="w-3 h-3 animate-spin text-indigo-400" />
              <span>{genMessage}</span>
            </div>
          )}
        </div>

        {/* Real-time Biometric Wireframe HUD Scanner */}
        <div className="mx-6 mt-4 p-4 rounded-xl border border-zinc-900 bg-zinc-950/60 flex flex-col gap-3 font-mono">
          <div className="flex items-center justify-between text-[10px] text-zinc-500 uppercase tracking-widest leading-none">
            <span>Biometric Wireframe Index</span>
            <span className="text-zinc-650 flex items-center gap-1">
              <span className="w-1.5 h-1.5 rounded-full bg-emerald-500 animate-pulse" />
              <span>Active telemetry</span>
            </span>
          </div>
          
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
            <div className="space-y-1.5">
              <span className="text-[9px] text-zinc-500 uppercase leading-none">Mass Index</span>
              <div className="flex items-center gap-1.5 mt-1">
                <progress
                  className="storyforge-progress storyforge-progress--indigo flex-1 h-1.5"
                  value={resolveBuildIndex(editedChar.properties.build)}
                  max={100}
                />
                <span className="text-[10px] text-indigo-400 capitalize font-semibold leading-none">
                  {editedChar.properties.build}
                </span>
              </div>
            </div>

            <div className="space-y-1.5">
              <span className="text-[9px] text-zinc-500 uppercase leading-none">Anatomy Mode</span>
              <div className="flex items-center gap-1.5 mt-1">
                <progress
                  className="storyforge-progress storyforge-progress--teal flex-1 h-1.5"
                  value={resolveGenderIndex(editedChar.properties.gender)}
                  max={100}
                />
                <span className="text-[10px] text-teal-400 capitalize font-semibold leading-none">
                  {editedChar.properties.gender || 'male'}
                </span>
              </div>
            </div>

            <div className="space-y-1.5">
              <span className="text-[9px] text-zinc-500 uppercase leading-none">Age factor</span>
              <div className="flex items-center gap-1.5 mt-1">
                <progress
                  className="storyforge-progress storyforge-progress--emerald flex-1 h-1.5"
                  value={editedChar.properties.age}
                  max={75}
                />
                <span className="text-[10px] text-emerald-400 font-semibold leading-none">
                  {editedChar.properties.age}y
                </span>
              </div>
            </div>
          </div>

          <div className="flex gap-4 pt-1.5 border-t border-zinc-900/60">
            <div className="flex-1 flex gap-2 items-center">
              <span className={`storyforge-biometric-chip storyforge-biometric-chip--${hairTone}`} />
              <div className="flex flex-col">
                <span className="text-[8px] text-zinc-500 uppercase leading-none">Hair Segment</span>
                <span className="text-[10px] text-zinc-300 font-medium leading-normal mt-0.5 max-w-[120px] truncate" title={editedChar.properties.hairColor}>
                  {editedChar.properties.hairColor || 'None'}
                </span>
              </div>
            </div>

            <div className="flex-1 flex gap-2 items-center">
              <span className={`storyforge-biometric-chip storyforge-biometric-chip--${eyeTone}`} />
              <div className="flex flex-col">
                <span className="text-[8px] text-zinc-500 uppercase leading-none">Eye Focal</span>
                <span className="text-[10px] text-zinc-300 font-medium leading-normal mt-0.5 max-w-[120px] truncate" title={editedChar.properties.eyeColor}>
                  {editedChar.properties.eyeColor || 'None'}
                </span>
              </div>
            </div>
          </div>
        </div>

        {/* Custom Navigation Tab bar */}
        <div className="flex border-b border-zinc-900 sticky top-0 z-10 bg-zinc-950/90 backdrop-blur-sm">
          <button 
            type="button"
            className={`flex-1 py-3 text-xs font-medium uppercase tracking-wider transition-colors border-b ${activeTab === 'appearance' ? 'text-indigo-400 border-indigo-500 font-semibold' : 'text-zinc-500 border-transparent hover:text-zinc-400'}`}
            onClick={() => setActiveTab('appearance')}
          >
            Appearance
          </button>
          <button 
            type="button"
            className={`flex-1 py-3 text-xs font-medium uppercase tracking-wider transition-colors border-b ${activeTab === 'identity' ? 'text-indigo-400 border-indigo-500 font-semibold' : 'text-zinc-500 border-transparent hover:text-zinc-400'}`}
            onClick={() => setActiveTab('identity')}
          >
            Identity & Bio
          </button>
        </div>

        {/* Input Controls */}
        <div className="p-6 space-y-6">
          {activeTab === 'appearance' && (
            <div className="space-y-6 animate-in fade-in duration-200">
              <div className="space-y-3">
                <div className="flex items-center justify-between">
                  <label className="text-xs font-medium text-zinc-400">Continuity Reference Library</label>
                  <button
                    type="button"
                    onClick={() => uploadInputRef.current?.click()}
                    disabled={isUploadingReference}
                    className="text-[10px] font-mono uppercase tracking-wider text-sky-300 bg-sky-500/10 border border-sky-500/20 px-2.5 py-1 rounded-full disabled:opacity-50"
                  >
                    Upload Reference
                  </button>
                </div>
                <p className="text-[10px] font-mono text-zinc-500 leading-relaxed">
                  Uploaded references can become the roster image while AI-generated portraits remain available as alternates.
                </p>

                {referenceAssets.length === 0 ? (
                  <div className="rounded-xl border border-dashed border-zinc-800 bg-zinc-950/40 px-4 py-5 text-center text-[11px] text-zinc-500">
                    Upload a character reference to lock continuity across shots while keeping the AI portrait path available.
                  </div>
                ) : (
                  <div className="grid grid-cols-2 gap-3 lg:grid-cols-3">
                    {referenceAssets.map(asset => {
                      const isActive = editedChar.activeImageId === asset.id || (!editedChar.activeImageId && activeDisplayImage === asset.url);
                      return (
                        <button
                          key={asset.id}
                          type="button"
                          onClick={() => activateReferenceAsset(asset.id)}
                          className={`rounded-2xl overflow-hidden border text-left transition-all ${
                            isActive ? 'border-indigo-500 shadow-lg shadow-indigo-500/10' : 'border-zinc-800 hover:border-zinc-700'
                          }`}
                        >
                          <div className="aspect-square bg-zinc-950 overflow-hidden relative">
                            <img src={asset.url} alt={asset.label} className="w-full h-full object-cover" referrerPolicy="no-referrer" />
                            <div className="absolute top-2 left-2 text-[8px] font-mono uppercase tracking-wider px-1.5 py-0.5 rounded bg-zinc-950/85 text-zinc-300 border border-zinc-800/80">
                              {asset.kind === 'character-generated' ? 'AI' : 'REF'}
                            </div>
                            {isActive && (
                              <div className="absolute bottom-2 left-2 text-[8px] font-mono uppercase tracking-wider px-1.5 py-0.5 rounded bg-indigo-500/90 text-white">
                                Active
                              </div>
                            )}
                          </div>
                          <div className="px-2.5 py-2 bg-zinc-950/90 space-y-1">
                            <div className="text-[10px] text-zinc-200 font-medium truncate" title={asset.label}>{asset.label}</div>
                            <div className="text-[9px] font-mono text-zinc-500 uppercase tracking-wider">{asset.origin}</div>
                          </div>
                        </button>
                      );
                    })}
                  </div>
                )}
              </div>

              {/* Style Selector */}
              <div className="space-y-2">
                <label className="text-xs font-medium text-zinc-400 flex items-center justify-between">
                  <span>Google Veo Character Style</span>
                  <span className="text-[10px] text-zinc-500 font-mono">Anchor prompt match</span>
                </label>
                <div className="relative">
                  <select
                    title="Select character style preset"
                    value={editedChar.properties.stylePreset || 'cinematic-actor'}
                    onChange={e => handlePropChange('stylePreset', e.target.value)}
                    className="w-full bg-zinc-900 border border-zinc-800 text-zinc-200 text-xs rounded-lg p-2.5 outline-none focus:border-indigo-500 accent-zinc-900 cursor-pointer"
                  >
                    <optgroup label="Photorealistic Humans">
                      <option value="cinematic-actor">Cinematic Actor</option>
                      <option value="historical-figure">Historical Figure</option>
                      <option value="cyberpunk-human">Futuristic / Cyberpunk Human</option>
                    </optgroup>
                    <optgroup label="3D Digital Animation">
                      <option value="stylized-3d">Stylized 3D (Pixar/Disney Style)</option>
                      <option value="video-game-cg">Video Game CG (Unreal Engine Style)</option>
                      <option value="cute-chibi">Cute Chibi / Vinyl Toy Aesthetic</option>
                    </optgroup>
                    <optgroup label="Traditional & NPR">
                      <option value="anime-manga">Anime & Manga Style</option>
                      <option value="retro-comic">Retro Comic / Graphic Novel</option>
                      <option value="pencil-sketch">Hand-Drawn Pencil / Charcoal</option>
                    </optgroup>
                    <optgroup label="Tactile Stop-Motion">
                      <option value="claymation">Claymation (Aardman Style)</option>
                      <option value="felt-puppet">Felt / Needle-Felted Puppet</option>
                      <option value="wooden-figurine">Wooden or Origami Figurine</option>
                    </optgroup>
                    <optgroup label="Fantasy & Entities">
                      <option value="mythological-beast">Mythological Beast Hybrid</option>
                      <option value="sentient-object">Sentient Object / Mascot</option>
                    </optgroup>
                  </select>
                </div>
                {/* Style prescription details card with clean negative space */}
                {(() => {
                  const currentPreset = STYLE_PRESETS.find(p => p.id === (editedChar.properties.stylePreset || 'cinematic-actor'));
                  if (!currentPreset) return null;
                  return (
                    <div className="p-3 rounded-xl bg-zinc-950/40 border border-zinc-900 text-[10px] text-zinc-400 space-y-1">
                      <div className="flex items-center justify-between font-mono">
                        <span className="text-indigo-400 font-medium uppercase tracking-wider text-[8.5px]">{currentPreset.group}</span>
                        <span className="text-[8px] text-zinc-600 bg-indigo-950 px-1.5 py-0.5 rounded border border-indigo-900/60 font-semibold text-indigo-300">Identity Anchor Active</span>
                      </div>
                      <p className="leading-relaxed">{currentPreset.description}</p>
                    </div>
                  );
                })()}
              </div>

              {/* Age Slider */}
              <div className="space-y-2">
                <div className="flex items-center justify-between text-xs">
                  <span className="font-medium text-zinc-400">Apparent Age</span>
                  <span className="text-indigo-300 font-mono font-medium">{editedChar.properties.age} yrs</span>
                </div>
                <input 
                  type="range" 
                  title="Apparent age"
                  min="16" max="75" 
                  value={editedChar.properties.age} 
                  onChange={e => handlePropChange('age', parseInt(e.target.value))}
                  className="w-full h-1 bg-zinc-800 rounded-lg appearance-none cursor-pointer accent-indigo-500"
                />
              </div>

              {/* Build Selection */}
              <div className="space-y-2">
                <label className="text-xs font-medium text-zinc-400">Physique Profile</label>
                <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
                  {['slim', 'average', 'muscular', 'heavy'].map((b) => (
                    <button
                      key={b}
                      type="button"
                      onClick={() => handlePropChange('build', b)}
                      className={`py-2 text-[11px] font-mono capitalize rounded-lg border transition-all ${
                        editedChar.properties.build === b 
                          ? 'bg-indigo-500/10 border-indigo-500/80 text-indigo-300' 
                          : 'bg-zinc-900/50 border-zinc-800 text-zinc-500 hover:text-zinc-300 hover:border-zinc-700'
                      }`}
                    >
                      {b}
                    </button>
                  ))}
                </div>
              </div>

              {/* Gender Identity Selection */}
              <div className="space-y-2">
                <label className="text-xs font-medium text-zinc-400">Gender Identity / Anatomy</label>
                <div className="grid grid-cols-1 gap-2 sm:grid-cols-3">
                  {['male', 'female', 'non-binary'].map((g) => (
                    <button
                      key={g}
                      type="button"
                      onClick={() => handlePropChange('gender', g)}
                      className={`py-2 text-[11px] font-mono capitalize rounded-lg border transition-all ${
                        (editedChar.properties.gender || 'male') === g 
                          ? 'bg-emerald-500/10 border-emerald-500/80 text-emerald-300' 
                          : 'bg-zinc-900/50 border-zinc-800 text-zinc-500 hover:text-zinc-300 hover:border-zinc-700'
                      }`}
                    >
                      {g}
                    </button>
                  ))}
                </div>
              </div>

              {/* Custom Styles */}
              <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
                <div className="space-y-2">
                  <label className="text-xs font-medium text-zinc-400">Hair Style</label>
                  <input 
                    type="text" 
                    value={editedChar.properties.hairStyle} 
                    onChange={e => handlePropChange('hairStyle', e.target.value)}
                    className="w-full bg-zinc-900 border border-zinc-800 rounded-lg p-2.5 text-xs text-zinc-100 placeholder-zinc-600 focus:outline-none focus:border-indigo-500 transition-colors"
                    placeholder="e.g. Messy Bob"
                  />
                </div>
                <div className="space-y-2">
                  <label className="text-xs font-medium text-zinc-400">Hair Color</label>
                  <input 
                    type="text" 
                    value={editedChar.properties.hairColor} 
                    onChange={e => handlePropChange('hairColor', e.target.value)}
                    className="w-full bg-zinc-900 border border-zinc-800 rounded-lg p-2.5 text-xs text-zinc-100 placeholder-zinc-600 focus:outline-none focus:border-indigo-500 transition-colors"
                    placeholder="e.g. Platinum Blue"
                  />
                </div>
              </div>

              <div className="space-y-2">
                <label className="text-xs font-medium text-zinc-400">Iris / Eye Accent Color</label>
                <input 
                  type="text" 
                  value={editedChar.properties.eyeColor} 
                  onChange={e => handlePropChange('eyeColor', e.target.value)}
                  className="w-full bg-zinc-900 border border-zinc-800 rounded-lg p-2.5 text-xs text-zinc-100 placeholder-zinc-600 focus:outline-none focus:border-indigo-500 transition-colors"
                  placeholder="e.g. Cybernetic Crimson"
                />
              </div>

              {/* Outfit Aesthetic instructions to the engine */}
              <div className="space-y-2">
                <label className="text-xs font-medium text-zinc-400 flex items-center justify-between">
                  <span>Engine Wear Styling Specs</span>
                  <span className="text-[10px] text-zinc-600 font-mono">Generates Mesh Attributes</span>
                </label>
                <textarea 
                  value={editedChar.properties.outfit}
                  onChange={e => handlePropChange('outfit', e.target.value)}
                  className="w-full bg-zinc-900 border border-zinc-800 rounded-lg p-3 text-xs text-zinc-100 placeholder-zinc-600 focus:outline-none focus:border-indigo-500 transition-colors min-h-[80px] resize-none"
                  placeholder="Describe jacket, colors, tech attributes..."
                />
              </div>
            </div>
          )}

          {activeTab === 'identity' && (
            <div className="space-y-6 animate-in fade-in duration-200">
              <div className="space-y-2">
                <label className="text-xs font-medium text-zinc-400">Designation / Name</label>
                <input 
                  type="text" 
                  value={editedChar.name} 
                  onChange={e => setEditedChar({...editedChar, name: e.target.value})}
                  className="w-full bg-zinc-900 border border-zinc-800 rounded-lg p-2.5 text-xs text-zinc-100 placeholder-zinc-600 focus:outline-none focus:border-indigo-500 transition-colors"
                  placeholder="Kaelen Thorne"
                />
              </div>

              <div className="space-y-2">
                <label className="text-xs font-medium text-zinc-400">Narrative Archetype</label>
                <input 
                  type="text" 
                  value={editedChar.role} 
                  onChange={e => setEditedChar({...editedChar, role: e.target.value})}
                  className="w-full bg-zinc-900 border border-zinc-800 rounded-lg p-2.5 text-xs text-zinc-100 placeholder-zinc-600 focus:outline-none focus:border-indigo-500 transition-colors"
                  placeholder="e.g. Rogue Mechanic, Cynical Leader"
                />
              </div>

              <div className="space-y-2">
                <label className="text-xs font-medium text-zinc-400">Behavioral Temperament</label>
                <input 
                  type="text" 
                  value={editedChar.properties.temperament} 
                  onChange={e => handlePropChange('temperament', e.target.value)}
                  className="w-full bg-zinc-900 border border-zinc-800 rounded-lg p-2.5 text-xs text-zinc-100 placeholder-zinc-600 focus:outline-none focus:border-indigo-500 transition-colors"
                  placeholder="e.g. Stoic, Hot-headed, Analytical"
                />
              </div>

              <div className="space-y-2">
                <label className="text-xs font-medium text-zinc-400">Character Continuity / Backstory</label>
                <textarea 
                  value={editedChar.properties.backstory}
                  onChange={e => handlePropChange('backstory', e.target.value)}
                  className="w-full bg-zinc-900 border border-zinc-800 rounded-lg p-3 text-xs text-zinc-100 placeholder-zinc-500 focus:outline-none focus:border-indigo-500 transition-colors min-h-[140px] leading-relaxed"
                  placeholder="Enter detailed history. This backstory profile generates contextual dialogue and scene actions with automatic story continuity across the story modules..."
                />
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
