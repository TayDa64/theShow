import React, { useState } from 'react';
import {
  Users,
  Clapperboard,
  ArrowUpRight,
  Cloud,
  ShieldCheck,
  Film,
  X,
} from 'lucide-react';
import type { AppViewState, Character, Scene, CameraConfig, ExportSettings, WorkspaceSyncState } from './types';
import { CharactersList } from './components/CharactersList';
import { CharacterEditor } from './components/CharacterEditor';
import { ScenesView } from './components/ScenesView';
import { ExportView } from './components/ExportView';
import { TimelineView } from './components/TimelineView';
import { AccountDashboard } from './components/AccountDashboard';
import { AuthGate } from './components/AuthGate';
import { useAuth } from './context/AuthContext';
import { normalizeCharacter, normalizeProjectState, normalizeScene, syncSceneTimeline } from './utils/storyforge';

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

type PopupWorkspaceView = Exclude<AppViewState, 'timeline' | 'cameras'>;

const POPUP_WORKSPACE_ORDER: PopupWorkspaceView[] = ['characters', 'scenes', 'export', 'account'];
const MOBILE_WORKSPACE_ORDER: Array<'timeline' | PopupWorkspaceView> = ['timeline', 'characters', 'scenes', 'export', 'account'];

const WORKSPACE_META: Record<'timeline' | PopupWorkspaceView, {
  label: string;
  shortLabel: string;
  description: string;
  icon: React.ComponentType<{ className?: string }>;
}> = {
  timeline: {
    label: 'Timeline',
    shortLabel: 'Timeline',
    description: 'Primary editing canvas',
    icon: Film,
  },
  characters: {
    label: 'Roster',
    shortLabel: 'Roster',
    description: 'Character continuity and references',
    icon: Users,
  },
  scenes: {
    label: 'Scenes',
    shortLabel: 'Scenes',
    description: 'Acts, dialogue, and backgrounds',
    icon: Clapperboard,
  },
  export: {
    label: 'Pipeline',
    shortLabel: 'Export',
    description: 'Render and assembly workflow',
    icon: ArrowUpRight,
  },
  account: {
    label: 'Account',
    shortLabel: 'Account',
    description: 'Sync, auth, and providers',
    icon: ShieldCheck,
  },
};

function getInitialPopupView(): PopupWorkspaceView | null {
  try {
    const params = new URLSearchParams(window.location.search);
    if (params.get('authResult') || params.get('authError')) {
      return 'account';
    }

    const saved = localStorage.getItem('sf_activePopupView');
    return POPUP_WORKSPACE_ORDER.includes(saved as PopupWorkspaceView) ? saved as PopupWorkspaceView : null;
  } catch {
    return null;
  }
}

export default function App() {
  const { authFetch, isAuthenticated, isLoading: isAuthLoading, user, provider } = useAuth();
  const [activePopupView, setActivePopupView] = useState<PopupWorkspaceView | null>(() => getInitialPopupView());
  const [syncState, setSyncState] = useState<WorkspaceSyncState>('LOCAL');
  const [lastUpdatedAt, setLastUpdatedAt] = useState(() => {
    try {
      return localStorage.getItem('sf_updatedAt') || new Date().toISOString();
    } catch {
      return new Date().toISOString();
    }
  });
  
  const prepareScenesForWorkspace = React.useCallback((inputScenes: Array<Partial<Scene> | Scene> | null | undefined) => {
    if (!Array.isArray(inputScenes)) {
      return [] as Scene[];
    }

    return inputScenes.map((scene) => syncSceneTimeline(normalizeScene(scene)));
  }, []);

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
      return prepareScenesForWorkspace(normalizeProjectState({ scenes: parsed }).scenes || initialScenes.map(normalizeScene));
    } catch {
      return prepareScenesForWorkspace(initialScenes.map(normalizeScene));
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
              if (normalized.scenes) setScenes(prepareScenesForWorkspace(normalized.scenes));
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

  const handleSaveScenes = React.useCallback((nextScenes: Scene[]) => {
    setScenes(prepareScenesForWorkspace(nextScenes));
  }, [prepareScenesForWorkspace]);

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

  React.useEffect(() => {
    try {
      if (activePopupView) {
        localStorage.setItem('sf_activePopupView', activePopupView);
      } else {
        localStorage.removeItem('sf_activePopupView');
      }
    } catch {
      // ignore local persistence failures
    }
  }, [activePopupView]);

  const openWorkspace = React.useCallback((view: AppViewState) => {
    if (view === 'timeline' || view === 'cameras') {
      setActivePopupView(null);
      return;
    }

    setActivePopupView(view);
    if (view !== 'characters') {
      setEditingCharacter(null);
    }
  }, []);

  const closePopup = React.useCallback(() => {
    setActivePopupView(null);
    setEditingCharacter(null);
  }, []);

  const handleSaveAndClosePopup = React.useCallback(() => {
    closePopup();
  }, [closePopup]);

  const syncBadgeTone = syncState === 'SYNCING'
    ? 'text-amber-300 bg-amber-400/10 border-amber-400/20 shadow-amber-400/5'
    : syncState === 'LOCAL'
      ? 'text-zinc-300 bg-zinc-900/80 border-zinc-800 shadow-zinc-900/20'
      : 'text-emerald-400/90 bg-emerald-400/10 border-emerald-400/20 shadow-emerald-400/5';

  const syncBadgeLabel = isCloudLoading || syncState === 'SYNCING'
    ? 'SYNCING'
    : syncState;

  const popupMeta = activePopupView ? WORKSPACE_META[activePopupView] : null;
  const showPopupSaveAction = activePopupView !== null && activePopupView !== 'account' && !(activePopupView === 'characters' && editingCharacter);
  const popupSaveLabel = activePopupView === 'export' ? 'Save & Close' : 'Save & Close';

  const renderPopupBody = () => {
    switch (activePopupView) {
      case 'characters':
        return editingCharacter ? (
          <CharacterEditor
            character={editingCharacter}
            onClose={() => setEditingCharacter(null)}
            onSave={handleSaveCharacter}
            presentation="embedded"
            closeOnSave
          />
        ) : (
          <div className="space-y-5">
            <CharactersList
              characters={characters}
              onSelect={setEditingCharacter}
              onCreateNew={handleCreateNew}
            />
          </div>
        );
      case 'scenes':
        return (
          <ScenesView
            scenes={scenes}
            characters={characters}
            camera={camera}
            onSaveScenes={handleSaveScenes}
          />
        );
      case 'export':
        return (
          <ExportView
            settings={exportSettings}
            onUpdateSettings={setExportSettings}
            onUpdateScenes={handleSaveScenes}
            characters={characters}
            scenes={scenes}
            camera={camera}
          />
        );
      case 'account':
        return <AccountDashboard />;
      default:
        return null;
    }
  };

  return (
    <AuthGate>
      <div className="min-h-screen bg-zinc-950 text-zinc-50 flex justify-center font-sans select-none">
        <div className="w-full max-w-[1680px] bg-zinc-950 min-h-screen flex flex-col relative overflow-hidden border-x md:border-x lg:border border-zinc-900 shadow-2xl">
          <header className="flex items-center justify-between px-4 py-3 md:px-6 lg:px-8 border-b border-zinc-900 bg-zinc-950/80 backdrop-blur-md sticky top-0 z-20">
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
                onClick={() => openWorkspace('account')}
                data-testid="account-workspace-trigger"
                className={`flex items-center gap-2 px-3 py-1.5 rounded-full border text-xs font-semibold transition-colors ${activePopupView === 'account'
                  ? 'bg-indigo-600/15 border-indigo-500/30 text-indigo-300'
                  : 'bg-zinc-900/80 border-zinc-800 text-zinc-300 hover:text-zinc-100'}`}
              >
                <ShieldCheck className="w-3.5 h-3.5" />
                <span className="hidden sm:inline">{isAuthenticated ? (user?.name.split(' ')[0] || 'Account') : 'Account'}</span>
              </button>
            </div>
          </header>

          <main className="flex-1 overflow-y-auto px-3 py-3 pb-20 md:px-4 md:py-4 md:pb-24 lg:px-6 lg:py-5 relative">
            {!isAuthenticated && activePopupView !== 'account' && (
              <div className="mb-4 rounded-2xl border border-amber-500/10 bg-amber-500/5 px-4 py-2.5 text-[12px] text-zinc-300 leading-relaxed">
                <span className="font-semibold text-amber-300">Local mode active.</span>{' '}
                Sign in from the <button type="button" onClick={() => openWorkspace('account')} className="underline underline-offset-2 text-indigo-300">Account</button> panel to enable secure cloud sync, authenticated AI routes, and isolated Gemini provider access.
              </div>
            )}

            <TimelineView
              scenes={scenes}
              characters={characters}
              camera={camera}
              onSaveScenes={handleSaveScenes}
              onUpdateCamera={setCamera}
              onOpenWorkspace={openWorkspace}
              activeWorkspace={activePopupView}
            />

            {activePopupView && (
              <div className="absolute inset-0 z-30 flex items-start justify-center bg-black/55 px-3 py-3 md:px-6 md:py-5">
                <div
                  className="flex max-h-[calc(100vh-120px)] w-full max-w-6xl flex-col overflow-hidden rounded-[24px] border border-zinc-800 bg-zinc-950 shadow-2xl shadow-black/40"
                  data-testid="workspace-popup"
                >
                  <div className="flex items-start justify-between gap-4 border-b border-zinc-900 px-4 py-3 md:px-5">
                    <div>
                      <div className="text-[10px] font-mono uppercase tracking-[0.24em] text-zinc-500">Workspace popup</div>
                      <div className="mt-1 text-base font-semibold text-white" data-testid="workspace-popup-title">{popupMeta?.label}</div>
                      <div className="mt-1 text-[11px] leading-relaxed text-zinc-500">{popupMeta?.description}</div>
                    </div>
                    <button
                      type="button"
                      onClick={closePopup}
                      className="inline-flex h-9 w-9 items-center justify-center rounded-full border border-zinc-800 bg-zinc-900 text-zinc-400 transition-colors hover:bg-zinc-800 hover:text-zinc-100"
                      title="Close workspace popup"
                      data-testid="popup-close-icon"
                    >
                      <X className="h-4 w-4" />
                    </button>
                  </div>

                  <div className="flex-1 overflow-y-auto px-4 py-4 md:px-5">
                    {renderPopupBody()}
                  </div>

                  <div className="flex items-center justify-between gap-3 border-t border-zinc-900 bg-zinc-950/90 px-4 py-3 md:px-5">
                    <div className="text-[11px] text-zinc-500">
                      {activePopupView === 'characters' && editingCharacter
                        ? 'Use the editor Save button to persist this character, or close the popup to keep browsing the roster.'
                        : 'Workspace changes persist to local and cloud state automatically as you edit.'}
                    </div>
                    <div className="flex flex-wrap items-center gap-2">
                      <button
                        type="button"
                        onClick={closePopup}
                        className="rounded-xl border border-zinc-800 bg-zinc-900 px-3 py-2 text-xs font-semibold text-zinc-200 transition-colors hover:bg-zinc-800"
                        data-testid="popup-close-button"
                      >
                        Close
                      </button>
                      {showPopupSaveAction && (
                        <button
                          type="button"
                          onClick={handleSaveAndClosePopup}
                          className="rounded-xl border border-indigo-500/20 bg-indigo-600/15 px-3 py-2 text-xs font-semibold text-indigo-300 transition-colors hover:bg-indigo-600/25"
                          data-testid="popup-save-close"
                        >
                          {popupSaveLabel}
                        </button>
                      )}
                    </div>
                  </div>
                </div>
              </div>
            )}
          </main>

          <nav className="absolute text-xs bottom-0 left-0 right-0 bg-zinc-950/95 backdrop-blur-md border-t border-zinc-900 px-4 py-3 pb-5 md:px-6 lg:hidden flex items-center justify-between md:justify-center md:gap-10 z-20">
            {MOBILE_WORKSPACE_ORDER.map((view) => {
              const meta = WORKSPACE_META[view];
              const Icon = meta.icon;
              return (
                <React.Fragment key={view}>
                  <NavItem
                    icon={<Icon />}
                    label={meta.shortLabel}
                    active={view === 'timeline' ? activePopupView === null : activePopupView === view}
                    onClick={() => openWorkspace(view)}
                  />
                </React.Fragment>
              );
            })}
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
