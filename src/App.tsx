import React, { useState } from 'react';
import { 
  Users, 
  Clapperboard, 
  Video, 
  ArrowUpRight, 
  Cloud,
} from 'lucide-react';
import type { ViewState, Character, Scene, CameraConfig, ExportSettings } from './types';
import { CharactersList } from './components/CharactersList';
import { CharacterEditor } from './components/CharacterEditor';
import { ScenesView } from './components/ScenesView';
import { CamerasView } from './components/CamerasView';
import { ExportView } from './components/ExportView';

// Upgraded Mock Characters to fully fit robust attributes!
const initialCharacters: Character[] = [
  {
    id: '1',
    name: 'Kaelen Thorne',
    role: 'Protagonist, Nomad',
    thumbnail: null,
    properties: {
      age: 28,
      build: 'average',
      gender: 'male',
      hairColor: 'Ash Brown',
      hairStyle: 'Messy undercut',
      eyeColor: 'Hazel',
      outfit: 'Tactical urban wear, dark gray coat.',
      temperament: 'Stoic & Calculated',
      backstory: 'A former database courier who went rogue after finding encrypted sector passkeys in the deep cloud network.',
      stylePreset: 'cinematic-actor'
    },
    updatedAt: new Date().toISOString()
  },
  {
    id: '2',
    name: 'Lyra',
    role: 'Mechanic, Fixer',
    thumbnail: null,
    properties: {
      age: 24,
      build: 'slim',
      gender: 'female',
      hairColor: 'Neon Pink',
      hairStyle: 'Short bob',
      eyeColor: 'Electric Cyan',
      outfit: 'Grease-stained overall jumpsuit with holographic tool belt.',
      temperament: 'Witty & Energetic',
      backstory: 'An expert mechanic specialized in low-level asset updates and real-time engine telemetry.',
      stylePreset: 'cyberpunk-human'
    },
    updatedAt: new Date().toISOString()
  }
];

// Mock Scenes with Dialogues
const initialScenes: Scene[] = [
  {
    id: 's1',
    title: 'Act I: Handshake Protocol',
    description: 'A quiet meeting in the neon rain to establish safe synchronization channels.',
    lighting: 'cyberpunk-dusk',
    dialogues: [
      {
        id: 'd1',
        characterId: '1',
        text: 'The cloud sync node has gone cold. Lyra, do you have the backup transmitter?',
        sentiment: 'tense'
      },
      {
        id: 'd2',
        characterId: '2',
        text: 'Handshake matches, Kaelen. Keep your gear warm, the database sequence is commencing.',
        sentiment: 'determined'
      }
    ]
  },
  {
    id: 's2',
    title: 'Act II: The Sanctum Gateway',
    description: 'Securing structural continuity against network anomalies.',
    lighting: 'moonlight-cold',
    dialogues: []
  }
];

// Main Camera Configurations
const defaultCameraConfig: CameraConfig = {
  shotType: 'close-up',
  focalLength: 50,
  tiltAngle: 'eye-level',
  aspectRatio: '16:9',
  showRuleOfThirds: true
};

// Default Exporter Specifications
const defaultExportSettings: ExportSettings = {
  targetEngine: 'unreal-engine',
  exportFormat: 'fbx',
  includeLiveLink: true,
  meshLevel: 'high'
};

export default function App() {
  const [activeView, setActiveView] = useState<ViewState>('characters');
  
  // Initialize state synchronously with localStorage fallbacks to avoid layout shifts or blinking
  const [characters, setCharacters] = useState<Character[]>(() => {
    try {
      const saved = localStorage.getItem('sf_characters');
      return saved ? JSON.parse(saved) : initialCharacters;
    } catch {
      return initialCharacters;
    }
  });
  const [editingCharacter, setEditingCharacter] = useState<Character | null>(null);
  
  const [scenes, setScenes] = useState<Scene[]>(() => {
    try {
      const saved = localStorage.getItem('sf_scenes');
      return saved ? JSON.parse(saved) : initialScenes;
    } catch {
      return initialScenes;
    }
  });
  const [camera, setCamera] = useState<CameraConfig>(() => {
    try {
      const saved = localStorage.getItem('sf_camera');
      return saved ? JSON.parse(saved) : defaultCameraConfig;
    } catch {
      return defaultCameraConfig;
    }
  });
  const [exportSettings, setExportSettings] = useState<ExportSettings>(() => {
    try {
      const saved = localStorage.getItem('sf_exportSettings');
      return saved ? JSON.parse(saved) : defaultExportSettings;
    } catch {
      return defaultExportSettings;
    }
  });

  const [isCloudLoading, setIsCloudLoading] = useState(false);

  // Load cloud state on mounting
  React.useEffect(() => {
    const fetchCloudState = async () => {
      try {
        setIsCloudLoading(true);
        const response = await fetch('/api/load-sandbox-state');
        if (response.ok) {
          const data = await response.json();
          if (data && !data.error) {
            if (data.characters) setCharacters(data.characters);
            if (data.scenes) setScenes(data.scenes);
            if (data.camera) setCamera(data.camera);
            if (data.exportSettings) setExportSettings(data.exportSettings);
          }
        }
      } catch (err) {
        console.warn("[Storage Bridge] Offline mode active or network interrupted:", err);
      } finally {
        setIsCloudLoading(false);
      }
    };
    fetchCloudState();
  }, []);

  // Sync any updates immediately to localStorage and debounced to the server API file backup
  React.useEffect(() => {
    if (characters && characters.length > 0) {
      localStorage.setItem('sf_characters', JSON.stringify(characters));
    }
    if (scenes && scenes.length > 0) {
      localStorage.setItem('sf_scenes', JSON.stringify(scenes));
    }
    localStorage.setItem('sf_camera', JSON.stringify(camera));
    localStorage.setItem('sf_exportSettings', JSON.stringify(exportSettings));

    const saveTimeout = setTimeout(async () => {
      try {
        await fetch('/api/save-sandbox-state', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ characters, scenes, camera, exportSettings })
        });
      } catch (err) {
        console.warn("[Storage Bridge] Deferred cloud save:", err);
      }
    }, 1000); // Debounce to allow seamless sliding or typing parameters without overloading request streams

    return () => clearTimeout(saveTimeout);
  }, [characters, scenes, camera, exportSettings]);

  const handleCreateNew = () => {
    const newChar: Character = {
      id: Date.now().toString(),
      name: 'New Subject',
      role: 'Archetype',
      thumbnail: null,
      properties: {
        age: 25,
        build: 'average',
        gender: 'male',
        hairColor: 'Jet Black',
        hairStyle: 'Standard Crop',
        eyeColor: 'Hazel',
        outfit: 'Sleek dark flight jumpsuit with tactical straps.',
        temperament: 'Stoic',
        backstory: 'Synthesized clone designed for sector continuity storytelling.',
        stylePreset: 'cinematic-actor'
      },
      updatedAt: new Date().toISOString()
    };
    setEditingCharacter(newChar);
  };

  const handleSaveCharacter = (char: Character) => {
    setCharacters(prev => {
      const idx = prev.findIndex(c => c.id === char.id);
      if (idx >= 0) {
        const next = [...prev];
        next[idx] = { ...char, updatedAt: new Date().toISOString() };
        return next;
      }
      return [...prev, char];
    });
    setEditingCharacter(null);
  };

  return (
    <div className="min-h-screen bg-zinc-950 text-zinc-50 flex justify-center font-sans select-none">
      {/* Mobile Constraint Container for Pro-App Look & Feel */}
      <div className="w-full max-w-md bg-zinc-950 min-h-screen flex flex-col relative overflow-hidden border-x border-zinc-900 shadow-2xl">
        
        {/* App Header */}
        <header className="flex items-center justify-between px-6 py-4 border-b border-zinc-900 bg-zinc-950/80 backdrop-blur-md sticky top-0 z-20">
          <div className="flex items-center gap-2">
            <div className="w-6 h-6 rounded bg-indigo-500/20 flex items-center justify-center border border-indigo-500/50">
              <span className="text-indigo-400 font-bold text-xs uppercase">SF</span>
            </div>
            <h1 className="font-semibold tracking-tight text-zinc-100 text-sm">StoryForge Mobile</h1>
          </div>
          <div className="flex items-center gap-2 text-xs font-semibold text-emerald-400/90 bg-emerald-400/10 px-3 py-1 rounded-full border border-emerald-400/20 shadow-sm shadow-emerald-400/5">
            <Cloud className="w-3.5 h-3.5" />
            <span className="font-mono text-[10px]">LIVELINK</span>
          </div>
        </header>

        {/* Main Content Area */}
        <main className="flex-1 overflow-y-auto p-6 pb-24 relative">
          
          {/* Character Module */}
          {activeView === 'characters' && (
            <CharactersList 
              characters={characters} 
              onSelect={setEditingCharacter}
              onCreateNew={handleCreateNew}
            />
          )}
          
          {editingCharacter && activeView === 'characters' && (
             <CharacterEditor 
                character={editingCharacter}
                onClose={() => setEditingCharacter(null)}
                onSave={handleSaveCharacter}
             />
          )}

          {/* Scenic Director Module */}
          {activeView === 'scenes' && (
            <ScenesView 
              scenes={scenes}
              characters={characters}
              onSaveScenes={setScenes}
            />
          )}

          {/* Cameras Perspective Module */}
          {activeView === 'cameras' && (
            <CamerasView 
              config={camera}
              onUpdateConfig={setCamera}
            />
          )}

          {/* Pipelines & Exports Module */}
          {activeView === 'export' && (
            <ExportView 
              settings={exportSettings}
              onUpdateSettings={setExportSettings}
              characters={characters}
              scenes={scenes}
              camera={camera}
            />
          )}
        </main>

        {/* Bottom Navigation Menu */}
        <nav className="absolute text-xs bottom-0 left-0 right-0 bg-zinc-950/95 backdrop-blur-md border-t border-zinc-900 px-6 py-4 pb-6 flex items-center justify-between z-20">
          <NavItem icon={<Users />} label="Roster" active={activeView === 'characters'} onClick={() => { setActiveView('characters'); setEditingCharacter(null); }} />
          <NavItem icon={<Clapperboard />} label="Scenes" active={activeView === 'scenes'} onClick={() => { setActiveView('scenes'); setEditingCharacter(null); }} />
          <NavItem icon={<Video />} label="Cameras" active={activeView === 'cameras'} onClick={() => { setActiveView('cameras'); setEditingCharacter(null); }} />
          <NavItem icon={<ArrowUpRight />} label="Pipeline" active={activeView === 'export'} onClick={() => { setActiveView('export'); setEditingCharacter(null); }} />
        </nav>
      </div>
    </div>
  );
}

function NavItem({ 
  icon, 
  label, 
  active, 
  onClick 
}: { 
  icon: React.ReactNode; 
  label: string; 
  active: boolean; 
  onClick: () => void;
}) {
  return (
    <button 
      onClick={onClick}
      className={`flex flex-col items-center gap-1.5 transition-colors cursor-pointer ${
        active ? 'text-indigo-400' : 'text-zinc-500 hover:text-zinc-300'
      }`}
    >
      <div className={`[&>svg]:w-5 [&>svg]:h-5 ${active ? 'scale-110 text-indigo-400 transition-all' : ''}`}>
        {icon}
      </div>
      <span className="font-semibold text-[10px] tracking-wide font-sans">{label}</span>
    </button>
  );
}
