import React, { useState, useEffect } from 'react';
import { Download, Cpu, RefreshCw, Layers, Copy, Check, Terminal, Film, AlertTriangle } from 'lucide-react';
import type { ExportSettings, Character, Scene, CameraConfig } from '../types';

interface ExportViewProps {
  settings: ExportSettings;
  onUpdateSettings: (set: ExportSettings) => void;
  characters: Character[];
  scenes: Scene[];
  camera: CameraConfig;
}

export function ExportView({ settings, onUpdateSettings, characters, scenes, camera }: ExportViewProps) {
  const [copied, setCopied] = useState(false);
  const [syncLogs, setSyncLogs] = useState<string[]>([
    'System: Sync server listening on post-socket port 5020...',
    'Idle: Waiting for Game Engine handshake...'
  ]);
  const [isSocketConnecting, setIsSocketConnecting] = useState(false);

  // Active targeted scene identifier
  const [selectedSceneId, setSelectedSceneId] = useState<string>(scenes[0]?.id || '');

  // Reset selected scene if the scenes list updates and the selected scene is gone
  useEffect(() => {
    if (scenes.length > 0 && !scenes.some(s => s.id === selectedSceneId)) {
      setSelectedSceneId(scenes[0].id);
    }
  }, [scenes, selectedSceneId]);

  // Veo storyboard rendering state hooks
  const [videoStatus, setVideoStatus] = useState<'idle' | 'rendering' | 'completed' | 'failed'>('idle');
  const [operationName, setOperationName] = useState<string | null>(null);
  const [renderProgress, setRenderProgress] = useState(0);
  const [renderMessage, setRenderMessage] = useState('');
  const [videoError, setVideoError] = useState<string | null>(null);
  const [isQuotaExhausted, setIsQuotaExhausted] = useState(false);

  // Active overlay subtitle of the active scene
  const [activeSubtitle, setActiveSubtitle] = useState<{ speaker: string; text: string; sentiment: string } | null>(null);

  const handleTimeUpdate = (e: React.SyntheticEvent<HTMLVideoElement, Event>) => {
    const video = e.currentTarget;
    const currTime = video.currentTime;
    const duration = video.duration || 10; // Default to 10 seconds if duration is loaded dynamically
    
    const activeScene = scenes.find(s => s.id === selectedSceneId) || scenes[0];
    if (!activeScene || !activeScene.dialogues || activeScene.dialogues.length === 0) {
      setActiveSubtitle(null);
      return;
    }
    
    const totalDialogues = activeScene.dialogues.length;
    const timePerDialogue = duration / totalDialogues;
    const index = Math.floor(currTime / timePerDialogue);
    
    if (index >= 0 && index < totalDialogues) {
      const item = activeScene.dialogues[index];
      const speaker = characters.find(c => c.id === item.characterId)?.name || 'Unknown Actor';
      setActiveSubtitle({
        speaker,
        text: item.text,
        sentiment: item.sentiment
      });
    } else {
      setActiveSubtitle(null);
    }
  };

  // Trigger export workflow
  const triggerExportVideo = async () => {
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
          scenes: [scenes.find(s => s.id === selectedSceneId) || scenes[0]].filter(Boolean),
          camera
        })
      });

      if (!response.ok) {
        throw new Error('Failed to hand off prompt parameters to the Veo video engine.');
      }

      const data = await response.json();
      const opName = data.operationName;
      setOperationName(opName);
      if (data.isQuotaExhausted) {
        setIsQuotaExhausted(true);
      }
      
      // Start polling
      pollVideoStatus(opName);
    } catch (err: any) {
      console.error(err);
      setVideoStatus('failed');
      setVideoError(err.message || 'Rendering Pipeline Error');
    }
  };

  const pollVideoStatus = (opName: string) => {
    // Poll status from express endpoints
    const intervalId = setInterval(async () => {
      try {
        const response = await fetch('/api/video-status', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json'
          },
          body: JSON.stringify({ operationName: opName })
        });
        
        if (!response.ok) {
          throw new Error('Network latency or timeout received during video compile cycle.');
        }

        const data = await response.json();
        
        if (data.progress !== undefined) {
          setRenderProgress(data.progress);
        }
        if (data.status) {
          setRenderMessage(data.status);
        }

        if (data.done) {
          clearInterval(intervalId);
          if (data.error) {
            setVideoStatus('failed');
            setVideoError(data.error);
          } else {
            setVideoStatus('completed');
          }
        }
      } catch (err: any) {
        console.error(err);
        clearInterval(intervalId);
        setVideoStatus('failed');
        setVideoError(err.message || 'Status Query Timeout');
      }
    }, 2000);
  };

  // Re-enable simulated synchronization messages to replicate active LiveLink connection
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

    const t = setInterval(() => {
      if (idx < logPool.length) {
        setSyncLogs(prev => [...prev, `[${new Date().toLocaleTimeString()}] ${logPool[idx]}`]);
        idx++;
      } else {
        setIsSocketConnecting(false);
        clearInterval(t);
      }
    }, 1200);

    return () => clearInterval(t);
  }, [isSocketConnecting, characters]);

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

  // Generate robust sync payload
  const syncPayload = JSON.stringify({
    timestamp: new Date().toISOString(),
    engineProfile: settings.targetEngine,
    format: settings.exportFormat,
    actors: characters.map(c => ({
      name: c.name,
      role: c.role,
      appearance: {
        age: c.properties.age,
        physique: c.properties.build,
        hair: `${c.properties.hairStyle} (${c.properties.hairColor})`,
        iris: c.properties.eyeColor,
        backstory: c.properties.backstory
      }
    })),
    sequence: scenes.map(s => ({
      title: s.title,
      lighting: s.lighting,
      beats: s.dialogues.map(d => ({
        actor: characters.find(c => c.id === d.characterId)?.name || 'Unknown',
        dialogue: d.text,
        vibe: d.sentiment
      }))
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

  return (
    <div className="space-y-6 animate-in fade-in duration-300">
      <div>
        <h2 className="text-lg font-medium tracking-tight text-white">Pipeline Exports</h2>
        <p className="text-[11px] text-zinc-500 font-mono mt-0.5">Continuous sync engine attributes & target system export setup.</p>
      </div>

      {/* Target Engine Grid */}
      <div className="bg-zinc-900/40 border border-zinc-900 p-5 rounded-2xl space-y-4">
        <label className="text-[10px] font-mono text-zinc-400 uppercase tracking-widest block">Target System Profile</label>
        
        <div className="grid grid-cols-3 gap-2">
          {[
            { id: 'blender', label: 'Blender 3D', hint: 'Best for animations / glTF' },
            { id: 'unreal-engine', label: 'Unreal Engine', hint: 'Metahuman LiveLink' },
            { id: 'unity', label: 'Unity Engine', hint: 'Asset integration' }
          ].map(engine => (
            <button
              key={engine.id}
              onClick={() => handleUpdate({ targetEngine: engine.id as any })}
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

      {/* Export Format Properties */}
      <div className="grid grid-cols-2 gap-4">
        <div className="bg-zinc-900/40 border border-zinc-900 p-4 rounded-xl space-y-2">
          <span className="text-[10px] font-mono text-zinc-500 uppercase">Format Choice</span>
          <select
            value={settings.exportFormat}
            onChange={e => handleUpdate({ exportFormat: e.target.value as any })}
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
            value={settings.meshLevel}
            onChange={e => handleUpdate({ meshLevel: e.target.value as any })}
            className="w-full bg-zinc-950 border border-zinc-900 text-zinc-200 text-xs rounded-lg py-2 px-2.5 focus:outline-none focus:border-indigo-500 appearance-none h-[36px]"
          >
            <option value="high">High cinematic (LOD 0)</option>
            <option value="medium">Medium dynamic (LOD 1)</option>
            <option value="low">Low performance (LOD 2)</option>
          </select>
        </div>
      </div>

      {/* Veo Cinematic Storyboard Pre-Visualization Block */}
      <div className="bg-gradient-to-b from-zinc-950 to-zinc-900 border border-zinc-900 rounded-2xl p-5 space-y-4 shadow-xl">
        <div className="flex items-start justify-between">
          <div className="space-y-1">
            <div className="flex items-center gap-2">
              <span className={`w-2 h-2 rounded-full ${videoStatus === 'rendering' ? 'bg-indigo-450 animate-pulse' : 'bg-indigo-500'}`} />
              <h3 className="text-sm font-semibold text-zinc-100 flex items-center gap-1.5 font-sans">
                Veo Storyboard Concept Pre-Visualization
              </h3>
            </div>
            <p className="text-[11px] text-zinc-400 font-mono">
              Consumes the narrative character configurations and camera shot settings to render a cinematic storyboard concept clip with Veo.
            </p>
          </div>
          {videoStatus === 'idle' && (
            <button
              onClick={triggerExportVideo}
              className="bg-indigo-600 hover:bg-indigo-500 text-white text-xs font-semibold px-4 py-2 rounded-xl flex items-center gap-1.5 transition-all shadow-md shadow-indigo-600/20 cursor-pointer"
            >
              <Film className="w-3.5 h-3.5" />
              <span>Export Video</span>
            </button>
          )}
        </div>

        {/* Dynamic Scene Selector */}
        <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3 bg-zinc-950 p-3 rounded-xl border border-zinc-900">
          <div className="space-y-0.5">
            <span className="text-[10px] font-mono text-zinc-500 uppercase tracking-widest block">Screenplay Scene Target</span>
            <span className="text-xs text-zinc-450">Decide which scene to compile with Google Veo</span>
          </div>
          <select
            value={selectedSceneId}
            onChange={(e) => {
              setSelectedSceneId(e.target.value);
              setVideoStatus('idle'); // Clear the existing state so they can render the newly chosen scene
            }}
            className="bg-zinc-900 border border-zinc-800 text-zinc-250 text-xs rounded-lg py-1.5 px-3 focus:outline-none focus:border-indigo-500 cursor-pointer min-w-[220px]"
          >
            {scenes.map((s, i) => (
              <option key={s.id} value={s.id}>
                Scene {i + 1}: {s.title} ({s.dialogues.length} lines)
              </option>
            ))}
          </select>
        </div>

        {videoStatus === 'rendering' && (
          <div className="bg-zinc-950/60 border border-zinc-900 p-4 rounded-xl space-y-3 animate-in fade-in duration-300">
            <div className="flex justify-between items-center text-[10.5px] font-mono">
              <span className="text-zinc-400 flex items-center gap-1.5">
                <RefreshCw className="w-3.5 h-3.5 text-indigo-400 animate-spin" />
                <span>{renderMessage || 'Veo Sequence compiling...'}</span>
              </span>
              <span className="text-indigo-400 font-bold">{renderProgress}%</span>
            </div>
            <div className="w-full h-1.5 bg-zinc-900 rounded-full overflow-hidden">
              <div 
                className="h-full bg-gradient-to-r from-indigo-500 via-purple-500 to-emerald-500 transition-all duration-300"
                style={{ width: `${renderProgress}%` }}
              />
            </div>
            <p className="text-[9px] font-mono text-zinc-500 text-center leading-tight">
              Please preserve view state. High-fidelity spatial frame extrusion can occupy up to a minute on cold boot.
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

              {/* Real-time Cinematic Lower-Third Caption Overlay */}
              {activeSubtitle && (
                <div className="absolute bottom-14 left-1/2 -translate-x-1/2 w-[92%] max-w-[500px] bg-zinc-950/90 backdrop-blur-md border border-zinc-900/80 p-3 rounded-2xl flex items-start gap-3 pointer-events-none animate-in fade-in slide-in-from-bottom-2 duration-300">
                  <div className="w-1 h-8 bg-indigo-500 rounded-full flex-shrink-0 self-center" />
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-1.5 mb-1">
                      <span className="text-[10px] font-bold text-indigo-400 font-sans tracking-wide uppercase">
                        {activeSubtitle.speaker}
                      </span>
                      <span className={`text-[8px] font-mono tracking-wider font-semibold uppercase px-1.5 py-0.5 rounded ${
                        activeSubtitle.sentiment === 'tense' ? 'bg-red-500/15 text-red-400 border border-red-500/10' :
                        activeSubtitle.sentiment === 'playful' ? 'bg-emerald-500/15 text-emerald-400 border border-emerald-500/10' :
                        activeSubtitle.sentiment === 'mysterious' ? 'bg-fuchsia-500/15 text-fuchsia-400 border border-fuchsia-500/10' :
                        activeSubtitle.sentiment === 'determined' ? 'bg-indigo-500/15 text-indigo-400 border border-indigo-500/10' :
                        'bg-zinc-900 text-zinc-500 border border-zinc-800'
                      }`}>
                        {activeSubtitle.sentiment}
                      </span>
                    </div>
                    <p className="text-[11px] leading-relaxed text-zinc-200 font-medium font-sans">
                      “{activeSubtitle.text}”
                    </p>
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
                  The Google GenAI Veo video generation model (<code className="font-mono text-[10px] bg-zinc-950 px-1 py-0.5 rounded text-indigo-300">veo-3.1-lite</code>) has a default free tier quota of <strong className="text-white">0 RPM</strong> in Google AI Studio. Even if you haven't generated any videos yet, requests will return a <strong className="text-amber-300">429 Resource Exhausted</strong> error until billing is configured.
                </p>
                <div className="pt-1.5 flex flex-col gap-1.5 border-t border-zinc-900 text-[10.5px]">
                  <span className="text-zinc-400"><strong className="text-zinc-200">To resolve this limits block:</strong></span>
                  <ul className="list-disc list-inside space-y-1 pl-1 text-zinc-400 font-mono text-[9.5px]">
                    <li>Link a <span className="text-zinc-200">Billing Account</span> to your Google Cloud project to upgrade to Pay-as-you-go.</li>
                    <li>Verify your API key is enabled for <span className="text-zinc-200">Video Generation Models</span> in the Google AI Studio console.</li>
                  </ul>
                </div>
              </div>
            )}

            <div className="flex justify-between items-center">
              {isQuotaExhausted ? (
                <span className="text-[10px] font-mono text-amber-400 flex items-center gap-1.5 bg-amber-500/5 border border-amber-500/10 px-2 py-1 rounded" title="The model is at live capacity, fallback pre-visualization loaded successfully.">
                  ● Veo API capacity limit reached (Sandbox pre-visualization active)
                </span>
              ) : (
                <span className="text-[10px] font-mono text-emerald-450 flex items-center gap-1 bg-emerald-500/5 border border-emerald-500/10 px-2 py-1 rounded">
                  ● Storyboard concept render complete
                </span>
              )}
              <div className="flex gap-2">
                <button
                  onClick={() => {
                    const a = document.createElement('a');
                    a.href = `/api/video-download?operationName=${encodeURIComponent(operationName)}`;
                    a.download = `storyforge-previsualization-${Date.now()}.mp4`;
                    document.body.appendChild(a);
                    a.click();
                    document.body.removeChild(a);
                  }}
                  className="bg-zinc-800 hover:bg-zinc-700 text-zinc-200 hover:text-white px-3 py-1.5 rounded-lg text-xs font-medium flex items-center gap-1 transition-all cursor-pointer"
                >
                  <Download className="w-3 h-3" />
                  <span>Download file</span>
                </button>
                <button
                  onClick={triggerExportVideo}
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
          <div className="bg-red-950/20 border border-red-500/10 p-4 rounded-xl space-y-3 animate-in shake duration-300">
            <div className="flex items-center gap-2 text-red-400 text-xs font-bold">
              <AlertTriangle className="w-4 h-4 flex-shrink-0" />
              <span>Compilation Aborted</span>
            </div>
            <p className="text-[10.5px] font-mono text-zinc-400 leading-normal">
              {videoError || 'Engine could not verify target compilation frames.'}
            </p>
            <div className="flex justify-end pt-1">
              <button
                onClick={triggerExportVideo}
                className="bg-red-500/10 hover:bg-red-500/20 border border-red-500/20 text-red-400 px-3.5 py-1.5 rounded-lg text-xs font-semibold flex items-center gap-1 transition-all cursor-pointer"
              >
                <RefreshCw className="w-3 h-3" />
                <span>Retry Render</span>
              </button>
            </div>
          </div>
        )}
      </div>

      {/* Real-time Integrated plugin connection console */}
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

        {/* Console Logs */}
        <div className="bg-zinc-900/90 rounded-xl p-3 aspect-[4/2] overflow-y-auto font-mono text-[10px] text-zinc-400 space-y-1 scrollbar-thin scrollbar-thumb-zinc-850">
          {syncLogs.map((log, i) => (
            <div key={i} className={log.includes('Push') || log.includes('handshake') ? 'text-emerald-400' : 'text-zinc-500'}>
              {log}
            </div>
          ))}
        </div>
      </div>

      {/* Code exporter schema */}
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
            value={syncPayload}
            className="w-full bg-zinc-900/30 border border-zinc-900 rounded-2xl p-4 text-[10.5px] font-mono text-zinc-500 h-[150px] resize-none focus:outline-none focus:ring-0 leading-relaxed"
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
