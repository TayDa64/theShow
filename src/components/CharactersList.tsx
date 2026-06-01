import React from 'react';
import { Plus, User, ShieldAlert } from 'lucide-react';
import type { Character } from '../types';

interface CharactersListProps {
  characters: Character[];
  onSelect: (char: Character) => void;
  onCreateNew: () => void;
}

// Map textual color entries to exact glowing CSS hexadecimal hues for cyberpunk biometrics
const resolveBiometricColor = (colorStr: string) => {
  const norm = (colorStr || '').toLowerCase();
  if (norm.includes('pink') || norm.includes('fuchsia') || norm.includes('magenta')) return '#f43f5e';
  if (norm.includes('blue') || norm.includes('cyan') || norm.includes('teal') || norm.includes('electric') || norm.includes('azure')) return '#06b6d4';
  if (norm.includes('crimson') || norm.includes('red') || norm.includes('scarlet') || norm.includes('fire')) return '#f43f5e';
  if (norm.includes('amber') || norm.includes('gold') || norm.includes('yellow') || norm.includes('orange')) return '#f59e0b';
  if (norm.includes('green') || norm.includes('emerald') || norm.includes('mint')) return '#10b981';
  if (norm.includes('purple') || norm.includes('violet') || norm.includes('indigo') || norm.includes('grape')) return '#a855f7';
  if (norm.includes('white') || norm.includes('ash') || norm.includes('platinum')) return '#f4f4f5';
  if (norm.includes('brown') || norm.includes('hazel')) return '#ca8a04';
  return '#71717a'; // neutral zinc
};

const resolveStylePresetName = (presetId?: string) => {
  const norm = presetId || 'cinematic-actor';
  if (norm === 'cinematic-actor') return 'Cinematic';
  if (norm === 'historical-figure') return 'Historical';
  if (norm === 'cyberpunk-human') return 'Cyberpunk';
  if (norm === 'stylized-3d') return 'Stylized 3D';
  if (norm === 'video-game-cg') return 'Game CG';
  if (norm === 'cute-chibi') return 'Chibi';
  if (norm === 'anime-manga') return 'Anime';
  if (norm === 'retro-comic') return 'Comic';
  if (norm === 'pencil-sketch') return 'Sketch';
  if (norm === 'claymation') return 'Claymation';
  if (norm === 'felt-puppet') return 'Felt Puppet';
  if (norm === 'wooden-figurine') return 'Wood/Origami';
  if (norm === 'mythological-beast') return 'Beast';
  if (norm === 'sentient-object') return 'Sentient Obj';
  return 'Cinematic';
};

export function CharactersList({ characters, onSelect, onCreateNew }: CharactersListProps) {
  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <h2 className="text-lg font-medium tracking-tight text-white">Roster</h2>
        <button 
          onClick={onCreateNew}
          className="flex items-center gap-1.5 text-xs font-medium bg-zinc-100 text-zinc-900 px-3 py-1.5 rounded-full hover:bg-white transition-colors cursor-pointer"
        >
          <Plus className="w-3.5 h-3.5" />
          <span>New Character</span>
        </button>
      </div>

      <div className="grid grid-cols-2 gap-4">
        {characters.map((char) => {
          const hairHex = resolveBiometricColor(char.properties.hairColor);
          const eyeHex = resolveBiometricColor(char.properties.eyeColor);

          return (
            <div 
              key={char.id} 
              onClick={() => onSelect(char)}
              className="group relative aspect-[3/4.2] bg-zinc-900 rounded-xl overflow-hidden border border-zinc-800 hover:border-indigo-500/50 transition-all cursor-pointer flex flex-col shadow-lg"
            >
              {/* Dynamic Aura glow overlay based on hair signature */}
              <div 
                className="absolute inset-x-0 top-0 h-16 opacity-10 blur-xl transition-opacity duration-300 pointer-events-none group-hover:opacity-20"
                style={{ backgroundColor: hairHex }}
              />

              {/* Roster Character Portrait or Placeholder */}
              <div className="flex-1 relative overflow-hidden bg-zinc-950">
                {char.thumbnail ? (
                  <img src={char.thumbnail} alt={char.name} className="w-full h-full object-cover select-none" referrerPolicy="no-referrer" />
                ) : (
                  <div className="w-full h-full flex flex-col items-center justify-center text-zinc-700 bg-zinc-950">
                    <User className="w-8 h-8 mb-2 stroke-[1.5]" />
                    <span className="text-[9px] font-mono tracking-widest text-zinc-600 uppercase">Awaiting portrait</span>
                  </div>
                )}

                {/* Cybernetic telemetry biometric nodes */}
                <div className="absolute top-2.5 right-2.5 z-20 flex gap-1.5 bg-zinc-950/80 backdrop-blur border border-zinc-800/80 px-2 py-1 rounded-full text-[8px] font-mono items-center">
                  <span className="text-zinc-500 mr-0.5">BIO</span>
                  <span 
                    className="w-1.5 h-1.5 rounded-full ring-2 ring-zinc-950" 
                    style={{ backgroundColor: hairHex, boxShadow: `0 0 6px ${hairHex}` }}
                    title={`Hair segment: ${char.properties.hairColor}`}
                  />
                  <span 
                    className="w-1.5 h-1.5 rounded-full ring-2 ring-zinc-950" 
                    style={{ backgroundColor: eyeHex, boxShadow: `0 0 6px ${eyeHex}` }}
                    title={`Eye sensor: ${char.properties.eyeColor}`}
                  />
                </div>
              </div>

              {/* Gradient card wash overlay */}
              <div className="absolute inset-0 bg-gradient-to-t from-zinc-950 via-zinc-950/10 to-transparent z-10 pointer-events-none" />

              {/* Roster description overlay with extensive physical specs */}
              <div className="p-3 bg-zinc-950 border-t border-zinc-900/60 z-20 space-y-1.5">
                <div className="flex flex-col">
                  <span className="text-sm font-semibold truncate text-white leading-tight">{char.name}</span>
                  <span className="text-[10px] text-indigo-400 font-mono truncate tracking-wide mt-0.5">{char.role || 'General Staff'}</span>
                </div>

                {/* Mini Attribute Matrix Stack */}
                <div className="flex flex-wrap gap-1 pt-0.5">
                  <span className="text-[8.5px] font-mono bg-zinc-900 text-zinc-300 border border-zinc-850 px-1.5 py-0.5 rounded leading-none">
                    {char.properties.age} yrs
                  </span>
                  {char.properties.gender && (
                    <span className="text-[8.5px] font-mono bg-zinc-900 text-teal-300 font-medium border border-zinc-850 px-1.5 py-0.5 rounded leading-none capitalize">
                      {char.properties.gender}
                    </span>
                  )}
                  <span className="text-[8.5px] font-mono bg-zinc-900 text-indigo-300 font-medium border border-indigo-950 px-1.5 py-0.5 rounded leading-none capitalize">
                    {char.properties.build}
                  </span>
                  <span className="text-[8.5px] font-mono bg-indigo-950 text-indigo-300 font-semibold border border-indigo-900/60 px-1.5 py-0.5 rounded leading-none capitalize">
                    {resolveStylePresetName(char.properties.stylePreset)}
                  </span>
                  <span className="text-[8.5px] font-mono text-zinc-400 truncate bg-zinc-900 px-1.5 py-0.5 rounded leading-none max-w-[85px]" title={char.properties.hairStyle}>
                    {char.properties.hairStyle}
                  </span>
                </div>
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}
