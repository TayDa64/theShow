import React, { useState } from 'react';
import { 
  Users, 
  Clapperboard, 
  Video, 
  ArrowUpRight, 
  Cloud,
  ShieldCheck,
} from 'lucide-react';
import type { AppViewState, Character, Scene, CameraConfig, ExportSettings, WorkspaceSyncState } from './types';
import { CharactersList } from './components/CharactersList';
import { CharacterEditor } from './components/CharacterEditor';
import { ScenesView } from './components/ScenesView';
import { CamerasView } from './components/CamerasView';
import { ExportView } from './components/ExportView';
import { AccountDashboard } from './components/AccountDashboard';
import { AuthGate } from './components/AuthGate';
import { useAuth } from './context/AuthContext';
import { normalizeCharacter, normalizeProjectState, normalizeScene } from './utils/storyforge';

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
  includeLiveLink: false,
  meshLevel: 'high'
};

export default function App() {
  const { authFetch, isAuthenticated, isLoading: isAuthLoading, user, provider } = useAuth();
  const [activeView, setActiveView] = useState<AppViewState>('characters');
  const [syncState, setSyncState] = useState<WorkspaceSyncState>('LOCAL');
  const [lastUpdatedAt, setLastUpdatedAt] = useState(() => {
    try {
      return localStorage.getItem('sf_updatedAt') || new Date().toISOString();
    } catch {
      return new Date().toISOString();
    }
  });
  
  // Initialize state synchronously with localStorage fallbacks to avoid layout shifts or blinking
  const [characters, setCharacters] = useState<Character[]>(() => {
    try {
      const saved = localStorage.getItem('sf_characters');
      const parsed = saved ? JSON.parse(saved) : initialCharacters;
      return normalizeProjectState({ characters: parsed }).characters || initialCharacters.map(normalizeCharacter);
    } catch {
      return initialCharacters.map(normalizeCharacter);
    }
  });
  const [editingCharacter, setEditingCharacter] = useState<Character | null>(null);
  
  const [scenes, setScenes] = useState<Scene[]>(() => {
    try {
      const saved = localStorage.getItem('sf_scenes');
      const parsed = saved ? JSON.parse(saved) : initialScenes;
      return normalizeProjectState({ scenes: parsed }).scenes || initialScenes.map(normalizeScene);
    } catch {
      return initialScenes.map(normalizeScene);
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
  const [hasLoadedCloud, setHasLoadedCloud] = useState(false);

  React.useEffect(() => {
    if (isAuthLoading) {
      return;
    }

    if (!isAuthenticated || !user) {
      setIsCloudLoading(false);
      setHasLoadedCloud(true);
      setSyncState('LOCAL');
      return;
    }

    const fetchCloudState = async () => {
      try {
        setHasLoadedCloud(false);
        setIsCloudLoading(true);
        const response = await authFetch('/api/load-sandbox-state');
        if (response.ok) {
          const data = await response.json();
          if (data && !data.error) {
            const cloudUpdatedAt = typeof data.updatedAt === 'string' ? data.updatedAt : '';
            const localUpdatedAt = localStorage.getItem('sf_updatedAt') || lastUpdatedAt;
            const localTime = Date.parse(localUpdatedAt || '');
            const cloudTime = Date.parse(cloudUpdatedAt || '');

            if (cloudTime > localTime) {
              const normalized = normalizeProjectState(data);
              if (normalized.characters) setCharacters(normalized.characters);
              if (normalized.scenes) setScenes(normalized.scenes);
              if (data.camera) setCamera(data.camera);
              if (data.exportSettings) setExportSettings(data.exportSettings);
              setLastUpdatedAt(cloudUpdatedAt);
              localStorage.setItem('sf_updatedAt', cloudUpdatedAt);
            }
          }
          setSyncState('SYNCED');
        } else if (response.status === 401) {
          setSyncState('LOCAL');
        }
      } catch (err) {
        console.warn("[Storage Bridge] Offline mode active or network interrupted:", err);
        setSyncState('LOCAL');
      } finally {
        setIsCloudLoading(false);
        setHasLoadedCloud(true);
      }
    };
    void fetchCloudState();
  }, [authFetch, isAuthLoading, isAuthenticated, user]);

  React.useEffect(() => {
    if (isAuthLoading || !hasLoadedCloud) {
      return;
    }

    const updatedAt = new Date().toISOString();
    setLastUpdatedAt(updatedAt);

    if (characters) {
      localStorage.setItem('sf_characters', JSON.stringify(characters));
    }
    if (scenes) {
      localStorage.setItem('sf_scenes', JSON.stringify(scenes));
    }
    localStorage.setItem('sf_camera', JSON.stringify(camera));
    localStorage.setItem('sf_exportSettings', JSON.stringify(exportSettings));
    localStorage.setItem('sf_updatedAt', updatedAt);

    if (!isAuthenticated) {
      setSyncState('LOCAL');
      return;
    }

    setSyncState('SYNCING');

    const saveTimeout = setTimeout(async () => {
      try {
        await authFetch('/api/save-sandbox-state', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ characters, scenes, camera, exportSettings, updatedAt })
        });
        setSyncState('SYNCED');
      } catch (err) {
        console.warn("[Storage Bridge] Deferred cloud save:", err);
        setSyncState('LOCAL');
      }
    }, 1000); // Debounce to allow seamless sliding or typing parameters without overloading request streams

    return () => clearTimeout(saveTimeout);
  }, [authFetch, camera, characters, exportSettings, hasLoadedCloud, isAuthLoading, isAuthenticated, scenes]);

  const handleCreateNew = () => {
    const newChar: Character = normalizeCharacter({
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
    });
    setEditingCharacter(newChar);
  };

  const handleSaveCharacter = (char: Character) => {
    setCharacters(prev => {
      const normalized = normalizeCharacter(char);
      const idx = prev.findIndex(c => c.id === normalized.id);
      if (idx >= 0) {
        const next = [...prev];
        next[idx] = { ...normalized, updatedAt: new Date().toISOString() };
        return next;
      }
      return [...prev, normalized];
    });
    setEditingCharacter(null);
  };

  const syncBadgeTone = syncState === 'SYNCING'
    ? 'text-amber-300 bg-amber-400/10 border-amber-400/20 shadow-amber-400/5'
    : syncState === 'LOCAL'
      ? 'text-zinc-300 bg-zinc-900/80 border-zinc-800 shadow-zinc-900/20'
      : 'text-emerald-400/90 bg-emerald-400/10 border-emerald-400/20 shadow-emerald-400/5';

  const syncBadgeLabel = isCloudLoading || syncState === 'SYNCING'
    ? 'SYNCING'
    : syncState;

  return (
    <AuthGate>
      <div className="min-h-screen bg-zinc-950 text-zinc-50 flex justify-center font-sans select-none">
        <div className="w-full max-w-md md:max-w-5xl xl:max-w-6xl bg-zinc-950 min-h-screen flex flex-col relative overflow-hidden border-x md:border-x lg:border border-zinc-900 shadow-2xl">
          <header className="flex items-center justify-between px-6 py-4 md:px-8 lg:px-10 border-b border-zinc-900 bg-zinc-950/80 backdrop-blur-md sticky top-0 z-20">
            <div className="flex items-center gap-2">
              <div className="w-6 h-6 rounded bg-indigo-500/20 flex items-center justify-center border border-indigo-500/50">
                <span className="text-indigo-400 font-bold text-xs uppercase">SF</span>
              </div>
              <div>
                <h1 className="font-semibold tracking-tight text-zinc-100 text-sm md:text-base">StoryForge Studio</h1>
                <p className="text-[10px] font-mono text-zinc-500 hidden md:block">
                  {isAuthenticated
                    ? `${provider.mode === 'personal' ? 'Personal provider' : provider.mode === 'workspace' ? 'Workspace provider' : 'Sandbox mode'} • ${user?.email}`
                    : 'Local draft mode • Sign in from Account for secure sync and AI routes'}
                </p>
              </div>
            </div>
            <div className="flex items-center gap-2">
              <div className={`flex items-center gap-2 text-xs font-semibold px-3 py-1 rounded-full border shadow-sm ${syncBadgeTone}`}>
                <Cloud className="w-3.5 h-3.5" />
                <span className="font-mono text-[10px]">{syncBadgeLabel}</span>
              </div>
              <button
                type="button"
                onClick={() => {
                  setActiveView('account');
                  setEditingCharacter(null);
                }}
                className={`flex items-center gap-2 px-3 py-1.5 rounded-full border text-xs font-semibold transition-colors ${activeView === 'account'
                  ? 'bg-indigo-600/15 border-indigo-500/30 text-indigo-300'
                  : 'bg-zinc-900/80 border-zinc-800 text-zinc-300 hover:text-zinc-100'}`}
              >
                <ShieldCheck className="w-3.5 h-3.5" />
                <span className="hidden sm:inline">{isAuthenticated ? (user?.name.split(' ')[0] || 'Account') : 'Account'}</span>
              </button>
            </div>
          </header>

          <main className="flex-1 overflow-y-auto px-6 py-6 pb-24 md:px-8 md:py-8 md:pb-28 lg:px-10 relative">
            {!isAuthenticated && activeView !== 'account' && (
              <div className="mb-6 rounded-2xl border border-amber-500/10 bg-amber-500/5 px-4 py-3 text-[12px] text-zinc-300 leading-relaxed">
                <span className="font-semibold text-amber-300">Local mode active.</span>{' '}
                Sign in from the <button type="button" onClick={() => setActiveView('account')} className="underline underline-offset-2 text-indigo-300">Account</button> dashboard to enable secure cloud sync, authenticated AI routes, and isolated Gemini provider access.
              </div>
            )}

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

            {activeView === 'scenes' && (
              <ScenesView 
                scenes={scenes}
                characters={characters}
                camera={camera}
                onSaveScenes={setScenes}
              />
            )}

            {activeView === 'cameras' && (
              <CamerasView 
                config={camera}
                onUpdateConfig={setCamera}
              />
            )}

            {activeView === 'export' && (
              <ExportView 
                settings={exportSettings}
                onUpdateSettings={setExportSettings}
                onUpdateScenes={setScenes}
                characters={characters}
                scenes={scenes}
                camera={camera}
              />
            )}

            {activeView === 'account' && <AccountDashboard />}
          </main>

          <nav className="absolute text-xs bottom-0 left-0 right-0 bg-zinc-950/95 backdrop-blur-md border-t border-zinc-900 px-6 py-4 pb-6 md:px-8 lg:px-10 flex items-center justify-between md:justify-center md:gap-14 z-20">
            <NavItem icon={<Users />} label="Roster" active={activeView === 'characters'} onClick={() => { setActiveView('characters'); setEditingCharacter(null); }} />
            <NavItem icon={<Clapperboard />} label="Scenes" active={activeView === 'scenes'} onClick={() => { setActiveView('scenes'); setEditingCharacter(null); }} />
            <NavItem icon={<Video />} label="Cameras" active={activeView === 'cameras'} onClick={() => { setActiveView('cameras'); setEditingCharacter(null); }} />
            <NavItem icon={<ArrowUpRight />} label="Pipeline" active={activeView === 'export'} onClick={() => { setActiveView('export'); setEditingCharacter(null); }} />
            <NavItem icon={<ShieldCheck />} label="Account" active={activeView === 'account'} onClick={() => { setActiveView('account'); setEditingCharacter(null); }} />
          </nav>
        </div>
      </div>
    </AuthGate>
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
      className={`flex flex-col items-center gap-1.5 transition-colors cursor-pointer min-w-[60px] ${
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
