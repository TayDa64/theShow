import React, { useState } from 'react';
import { Play, Plus, Trash2, Video, Volume2, Sparkles, Edit, Check, X } from 'lucide-react';
import type { Scene, Character, DialogueLine } from '../types';

interface ScenesViewProps {
  scenes: Scene[];
  characters: Character[];
  onSaveScenes: (scenes: Scene[]) => void;
}

export function ScenesView({ scenes, characters, onSaveScenes }: ScenesViewProps) {
  const [selectedScene, setSelectedScene] = useState<Scene>(scenes[0] || {
    id: '1',
    title: 'Act I: The Rendezvous',
    description: 'A shadowy confrontation outside the neon-lit terminal.',
    lighting: 'cyberpunk-dusk',
    dialogues: []
  });

  const [activeDialogueInput, setActiveDialogueInput] = useState('');
  const [selectedCharId, setSelectedCharId] = useState(characters[0]?.id || '');
  const [selectedSentiment, setSelectedSentiment] = useState<'neutral' | 'tense' | 'playful' | 'mysterious' | 'determined'>('neutral');
  const [isSuggesting, setIsSuggesting] = useState(false);

  // States for inline dialogue editing
  const [editingDialogueId, setEditingDialogueId] = useState<string | null>(null);
  const [editingText, setEditingText] = useState('');

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
            lighting: selectedScene.lighting
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
      console.warn("AI suggest failed, invoking robust local fallback templates:", error);
      const fallbacks: Record<string, string[]> = {
        tense: [
          "We don't have much time. Secure the subnet now.",
          "I hear footsteps. Put the backup transmitter away.",
          "That was too close. The anomalies are spreading."
        ],
        playful: [
          "Oh, relax. It's just a little bit of high-level code tampering.",
          "Who designed this system anyway? Looks like 20th-century spaghetti.",
          "Well, aren't you mister sunshine today?"
        ],
        mysterious: [
          "The cloud wasn't built by humans... We only discovered it.",
          "There are secrets inside these files that can turn down the sun.",
          "Listen carefully. Do you hear the code humming?"
        ],
        determined: [
          "I will synchronize this database block even if it's the last thing I do.",
          "We started this job, and we are going to finish it. Synchronizing nodes now.",
          "Don't worry, Lyra. The data pipeline is secure in my hands."
        ],
        neutral: [
          "Ready for telemetry update. Let me inspect the interface.",
          "The connection is stable for now.",
          "Sequence numbers are adjusting correctly."
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
    const updated = { ...selectedScene, lighting };
    setSelectedScene(updated);
    onSaveScenes(scenes.map(s => s.id === selectedScene.id ? updated : s));
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

    const updated = {
      ...selectedScene,
      dialogues: [...selectedScene.dialogues, newLine]
    };

    setSelectedScene(updated);
    onSaveScenes(scenes.map(s => s.id === selectedScene.id ? updated : s));
    setActiveDialogueInput('');
  };

  const handleDeleteDialogue = (id: string) => {
    const updated = {
      ...selectedScene,
      dialogues: selectedScene.dialogues.filter(item => item.id !== id)
    };
    setSelectedScene(updated);
    onSaveScenes(scenes.map(s => s.id === selectedScene.id ? updated : s));
  };

  const handleStartEditDialogue = (item: DialogueLine) => {
    setEditingDialogueId(item.id);
    setEditingText(item.text);
  };

  const handleSaveEditDialogue = (id: string) => {
    if (!editingText.trim()) return;
    const updated = {
      ...selectedScene,
      dialogues: selectedScene.dialogues.map(d => d.id === id ? { ...d, text: editingText } : d)
    };
    setSelectedScene(updated);
    onSaveScenes(scenes.map(s => s.id === selectedScene.id ? updated : s));
    setEditingDialogueId(null);
    setEditingText('');
  };

  const handleAddNewScene = () => {
    const newScene: Scene = {
      id: Date.now().toString(),
      title: `Scene ${scenes.length + 1}: Uncharted Sector`,
      description: 'A pivotal meeting to synchronize the main sequence files.',
      lighting: 'sunset-warm',
      dialogues: []
    };
    const nextList = [...scenes, newScene];
    setSelectedScene(newScene);
    onSaveScenes(nextList);
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
      <div className="flex items-center justify-between">
        <div>
          <h2 className="text-lg font-medium tracking-tight text-white">Scenic Director</h2>
          <p className="text-[11px] text-zinc-500 font-mono mt-0.5" id="scene-counter">Active Scenes: {scenes.length}</p>
        </div>
        <button 
          onClick={handleAddNewScene}
          className="flex items-center gap-1.5 text-xs font-semibold bg-zinc-800 text-zinc-200 border border-zinc-700 px-3 py-1.5 rounded-full hover:bg-zinc-700 hover:text-white transition-all cursor-pointer"
        >
          <Plus className="w-3.5 h-3.5" />
          <span>Add Scene</span>
        </button>
      </div>

      {/* Scene Selectors */}
      <div className="flex gap-2 overflow-x-auto pb-1.5 scrollbar-thin scrollbar-thumb-zinc-800">
        {scenes.map((sc) => (
          <button
            key={sc.id}
            onClick={() => setSelectedScene(sc)}
            className={`px-4 py-2 rounded-xl text-xs font-medium space-y-0.5 whitespace-nowrap border cursor-pointer transition-all ${
              selectedScene.id === sc.id 
                ? 'bg-indigo-600/10 border-indigo-500 text-indigo-300' 
                : 'bg-zinc-900/50 border-zinc-800/80 text-zinc-400 hover:text-zinc-200 hover:border-zinc-700'
            }`}
          >
            <div>{sc.title}</div>
          </button>
        ))}
      </div>

      {/* Visual Ambient Atmosphere Settings */}
      <div className={`p-5 rounded-2xl border bg-gradient-to-b ${getLightingStyle(selectedScene.lighting)} transition-all duration-300`}>
        <div className="flex items-center justify-between mb-4">
          <span className="text-[10px] font-mono uppercase tracking-wider text-zinc-500">Integrated Atmosphere</span>
          <span className="flex items-center gap-1 text-[10px] text-indigo-400 bg-indigo-500/10 border border-indigo-500/20 px-2 py-0.5 rounded-full">
            <Volume2 className="w-3 h-3" />
            <span className="font-semibold">Ambience Active</span>
          </span>
        </div>

        <div className="space-y-1">
          <input 
            type="text" 
            value={selectedScene.title} 
            onChange={e => {
              const updated = { ...selectedScene, title: e.target.value };
              setSelectedScene(updated);
              onSaveScenes(scenes.map(s => s.id === selectedScene.id ? updated : s));
            }}
            className="text-base font-semibold text-white bg-transparent border-b border-transparent focus:border-zinc-800 focus:outline-none w-full"
          />
          <input 
            type="text" 
            value={selectedScene.description} 
            onChange={e => {
              const updated = { ...selectedScene, description: e.target.value };
              setSelectedScene(updated);
              onSaveScenes(scenes.map(s => s.id === selectedScene.id ? updated : s));
            }}
            className="text-xs text-zinc-400 bg-transparent border-b border-transparent focus:border-zinc-800 focus:outline-none w-full"
          />
        </div>

        {/* Lighting Selector Badges */}
        <div className="mt-5 space-y-2">
          <label className="text-[10px] font-mono text-zinc-500 uppercase tracking-widest block">Virtual Lighting Design</label>
          <div className="grid grid-cols-2 gap-2">
            {[
              { id: 'cyberpunk-dusk', label: 'Neon Cyberpunk', color: 'bg-fuchsia-500/20 text-fuchsia-300' },
              { id: 'sunset-warm', label: 'Sunset Amber', color: 'bg-amber-500/20 text-amber-300' },
              { id: 'moonlight-cold', label: 'Lunar Frost', color: 'bg-cyan-500/20 text-cyan-300' },
              { id: 'high-key-studio', label: 'Studio Neutral', color: 'bg-slate-500/20 text-slate-300' }
            ].map((light) => (
              <button
                key={light.id}
                onClick={() => updateSceneLighting(light.id as any)}
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

      {/* Script & Dialogue Area */}
      <div className="space-y-4">
        <h3 className="text-sm font-semibold tracking-tight text-white flex items-center justify-between">
          <span>Dialogue Sequences</span>
          <span className="text-[10px] font-mono text-zinc-500 uppercase">Interactive Timeline</span>
        </h3>

        {selectedScene.dialogues.length === 0 ? (
          <div className="bg-zinc-900/30 border border-zinc-900 rounded-2xl p-8 text-center text-zinc-600">
            <Volume2 className="w-8 h-8 mx-auto stroke-1 mb-2 opacity-30" />
            <p className="text-xs">No dialogues added. Use form below to record action beats.</p>
          </div>
        ) : (
          <div className="space-y-3">
            {selectedScene.dialogues.map((item) => (
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
                        title="Save Changes"
                      >
                        <Check className="w-3.5 h-3.5" />
                      </button>
                      <button 
                        type="button"
                        onClick={() => setEditingDialogueId(null)}
                        className="bg-zinc-800 hover:bg-zinc-750 border border-zinc-700 p-2 text-zinc-400 rounded-lg transition-colors cursor-pointer"
                        title="Cancel"
                      >
                        <X className="w-3.5 h-3.5" />
                      </button>
                    </div>
                  </div>
                ) : (
                  <>
                    <div className="flex-1">
                      <div className="flex items-center gap-2 mb-1.5">
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
                        title="Edit Dialogue File"
                        id={`edit-dialogue-${item.id}`}
                      >
                        <Edit className="w-3.5 h-3.5" />
                      </button>
                      <button 
                        type="button"
                        onClick={() => handleDeleteDialogue(item.id)}
                        className="p-1.5 rounded-lg text-zinc-400 hover:text-red-400 hover:bg-red-400/10 transition-colors cursor-pointer"
                        title="Delete Dialogue Sequence"
                        id={`delete-dialogue-${item.id}`}
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

      {/* Narrative Dialogue / Beat Creator */}
      <form onSubmit={handleAddDialogue} className="bg-zinc-900/50 p-4 rounded-2xl border border-zinc-800 space-y-3">
        <label className="text-[10px] font-mono text-zinc-400 uppercase tracking-widest block">Append Act Sequence</label>
        
        <div className="grid grid-cols-2 gap-3">
          <div className="space-y-1">
            <span className="text-[10px] font-medium text-zinc-500">Character</span>
            <select
              value={selectedCharId}
              onChange={e => setSelectedCharId(e.target.value)}
              className="w-full bg-zinc-950 border border-zinc-800 text-zinc-100 rounded-lg py-2 px-2.5 text-xs focus:outline-none focus:border-indigo-500 focus:ring-0 appearance-none h-[36px]"
            >
              {characters.map(c => (
                <option key={c.id} value={c.id}>{c.name}</option>
              ))}
            </select>
          </div>

          <div className="space-y-1">
            <span className="text-[10px] font-medium text-zinc-500">Sentiment Delivery</span>
            <select
              value={selectedSentiment}
              onChange={e => setSelectedSentiment(e.target.value as any)}
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

        <div className="flex gap-1.5 md:gap-2">
          <input 
            type="text"
            value={activeDialogueInput}
            onChange={e => setActiveDialogueInput(e.target.value)}
            className="flex-1 bg-zinc-950 border border-zinc-800 rounded-lg p-2 px-3 text-xs text-zinc-200 placeholder-zinc-600 focus:outline-none focus:border-indigo-500"
            placeholder="Type speech line or performance beat..."
          />
          <button 
            type="button"
            onClick={handleAISuggest}
            disabled={isSuggesting}
            className="bg-indigo-600/20 hover:bg-indigo-600/30 text-indigo-300 border border-indigo-500/25 text-xs font-semibold px-3 rounded-lg flex items-center gap-1.5 cursor-pointer disabled:opacity-50 transition-colors"
            title="Auto-suggest dialogue using Gemini AI"
          >
            <Sparkles className={`w-3.5 h-3.5 ${isSuggesting ? 'animate-spin' : ''}`} />
            <span className="hidden sm:inline">{isSuggesting ? 'Drafting...' : 'AI Suggest'}</span>
          </button>
          <button 
            type="submit"
            className="bg-zinc-100 hover:bg-white text-zinc-900 text-xs font-semibold px-4 rounded-lg flex items-center gap-1 cursor-pointer transition-colors"
          >
            <Play className="w-3 h-3 fill-current" />
            <span>Cast</span>
          </button>
        </div>
      </form>
    </div>
  );
}
