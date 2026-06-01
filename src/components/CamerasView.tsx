import React from 'react';
import { Camera, Eye, Layers, Sliders, Minimize2, Check } from 'lucide-react';
import type { CameraConfig } from '../types';

interface CamerasViewProps {
  config: CameraConfig;
  onUpdateConfig: (cfg: CameraConfig) => void;
}

export function CamerasView({ config, onUpdateConfig }: CamerasViewProps) {
  const handleUpdate = (updates: Partial<CameraConfig>) => {
    onUpdateConfig({ ...config, ...updates });
  };

  // Preview dimensions & composition simulation
  const getFocalLengthDescr = (mm: number) => {
    if (mm <= 28) return 'Ultra-Wide Panoramic';
    if (mm <= 35) return 'Atmospheric Cinematography';
    if (mm <= 50) return 'Standard Human Eye Match';
    if (mm <= 85) return 'Medium Portrait Depth';
    return 'Telephoto Sports / Action';
  };

  // Safe zones description
  const aspectConfig = config.aspectRatio;

  return (
    <div className="space-y-6 animate-in fade-in duration-300">
      <div>
        <h2 className="text-lg font-medium tracking-tight text-white font-sans">Cinematic Camera Layout</h2>
        <p className="text-[11px] text-zinc-500 font-mono mt-0.5">Setup real-time scene viewport & lens composition parameters.</p>
      </div>

      {/* Interactive Frame Viewfinder HUD */}
      <div className="relative aspect-video bg-zinc-950 border border-zinc-800 rounded-2xl flex items-center justify-center overflow-hidden">
        {/* Background Grid Pattern or simulated actor focal ring */}
        <div className="absolute inset-0 bg-[radial-gradient(#1f2937_1px,transparent_1px)] [background-size:16px_16px] opacity-40" />

        {/* Dynamic Aspect Ratio Guide Layer */}
        <div className={`transition-all duration-300 border-2 border-zinc-500/30 flex items-center justify-center relative ${
          aspectConfig === '16:9' 
            ? 'w-[90%] aspect-[16/9]' 
            : 'h-[90%] aspect-[9/16]'
        }`} id="viewfinder-frame">
          {/* Viewfinder Corners */}
          <div className="absolute -top-1.5 -left-1.5 w-3.5 h-3.5 border-t-2 border-l-2 border-indigo-500" />
          <div className="absolute -top-1.5 -right-1.5 w-3.5 h-3.5 border-t-2 border-r-2 border-indigo-500" />
          <div className="absolute -bottom-1.5 -left-1.5 w-3.5 h-3.5 border-b-2 border-l-2 border-indigo-500" />
          <div className="absolute -bottom-1.5 -right-1.5 w-3.5 h-3.5 border-b-2 border-r-2 border-indigo-500" />

          {/* Rule of Thirds Overlays */}
          {config.showRuleOfThirds && (
            <div className="absolute inset-0 grid grid-cols-3 grid-rows-3 pointer-events-none">
              <div className="border-r border-b border-indigo-500/10" />
              <div className="border-r border-b border-indigo-500/10" />
              <div className="border-b border-indigo-500/10" />
              <div className="border-r border-b border-indigo-500/10" />
              <div className="border-r border-b border-indigo-500/10" />
              <div className="border-b border-indigo-500/10" />
              <div className="border-r border-indigo-500/10" />
              <div className="border-r border-indigo-500/10" />
              <div className="bg-transparent" />
            </div>
          )}

          {/* Focal Depth Target Circle Indicator */}
          <div className="w-14 h-14 rounded-full border border-dashed border-indigo-400/40 flex items-center justify-center animate-[pulse_2.5s_infinite]">
            <div className="w-1.5 h-1.5 rounded-full bg-indigo-500" />
          </div>

          {/* Real-time aspect tag label */}
          <span className="absolute bottom-2 left-2 bg-zinc-950/95 border border-zinc-900 text-[9px] font-mono font-bold tracking-widest text-zinc-400 px-1.5 py-0.5 rounded">
            {aspectConfig} FORMAT
          </span>

          {/* Focal info badge */}
          <span className="absolute top-2 right-2 bg-indigo-950/90 border border-indigo-500/30 text-[9px] font-mono text-indigo-300 px-1.5 py-0.5 rounded flex items-center gap-1">
            <Camera className="w-2.5 h-2.5" />
            <span>{config.focalLength}mm</span>
          </span>
        </div>

        {/* Viewfinder Metrics Overlays (Non-fictive utility labels standard to active video systems) */}
        <div className="absolute top-3 left-4 text-[9px] font-mono text-zinc-500 flex items-center gap-1.5 pointer-events-none">
          <span className="w-1.5 h-1.5 rounded-full bg-red-500 animate-ping" />
          <span>REC STDBY</span>
        </div>
        <div className="absolute bottom-3 right-4 text-[9px] font-mono text-zinc-500 pointer-events-none">
          ISO 400 • F/2.8 • 1/48 FPS
        </div>
      </div>

      {/* Control sliders */}
      <div className="bg-zinc-900/40 border border-zinc-900 p-5 rounded-2xl space-y-5">
        <div className="flex items-center gap-2 mb-1.5">
          <Sliders className="w-4 h-4 text-indigo-400" />
          <h3 className="text-xs font-semibold uppercase tracking-wider text-zinc-300">Lens & Frame Controls</h3>
        </div>

        {/* Aspect Ratio choice */}
        <div className="space-y-2">
          <label className="text-xs font-medium text-zinc-400">Cinematic Aspect Frame Override</label>
          <div className="grid grid-cols-2 gap-3">
            {[
              { id: '16:9', title: 'Widescreen (16:9)', desc: 'Landscape / Cinematic TV' },
              { id: '9:16', title: 'Vertical (9:16)', desc: 'Mobile Shorts / Social Story' }
            ].map(item => (
              <button
                key={item.id}
                onClick={() => handleUpdate({ aspectRatio: item.id as any })}
                className={`p-3 text-left rounded-xl border transition-all cursor-pointer ${
                  config.aspectRatio === item.id 
                    ? 'bg-indigo-600/10 border-indigo-500 text-indigo-300' 
                    : 'bg-zinc-950 border-zinc-900 text-zinc-500 hover:text-zinc-300 hover:border-zinc-800'
                }`}
              >
                <div className="font-semibold text-xs text-white">{item.title}</div>
                <div className="text-[10px] text-zinc-500 font-mono mt-0.5">{item.desc}</div>
              </button>
            ))}
          </div>
        </div>

        {/* Focal mm selectors */}
        <div className="space-y-2">
          <div className="flex items-center justify-between text-xs">
            <span className="font-medium text-zinc-400">Lens Focal Length</span>
            <span className="text-indigo-400 font-mono font-semibold">{config.focalLength}mm</span>
          </div>

          <div className="grid grid-cols-5 gap-1.5">
            {[24, 35, 50, 85, 200].map(mm => (
              <button
                key={mm}
                onClick={() => handleUpdate({ focalLength: mm })}
                className={`py-2 text-[10px] font-mono font-semibold rounded-lg border transition-all cursor-pointer ${
                  config.focalLength === mm 
                    ? 'bg-zinc-100 text-zinc-950 border-zinc-200' 
                    : 'bg-zinc-950 text-zinc-500 border-zinc-900 hover:text-zinc-300 hover:border-zinc-800'
                }`}
              >
                {mm}
              </button>
            ))}
          </div>
          <p className="text-[10px] text-zinc-500 font-mono italic mt-1">{getFocalLengthDescr(config.focalLength)} mode</p>
        </div>

        {/* Shot composition parameters */}
        <div className="space-y-2">
          <label className="text-xs font-medium text-zinc-400">Stage Framing Composition</label>
          <div className="relative">
            <select
              value={config.shotType}
              onChange={e => handleUpdate({ shotType: e.target.value as any })}
              className="w-full bg-zinc-950 border border-zinc-900 text-zinc-100 rounded-xl py-2.5 px-3 text-xs focus:outline-none focus:border-indigo-500 appearance-none h-[42px]"
            >
              <option value="close-up">Close-up (Focuses deeply on character facial details)</option>
              <option value="medium-shot">Medium Shot (Waist up view of the protagonist)</option>
              <option value="cowboy-shot">Cowboy Shot (Mid-thigh cinematic framing)</option>
              <option value="wide-landscape">Wide / Panoramic (Showcases scenery backdrops)</option>
            </select>
            <div className="absolute inset-y-0 right-0 flex items-center pr-3 pointer-events-none text-zinc-500">
              <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M19 9l-7 7-7-7"></path></svg>
            </div>
          </div>
        </div>

        {/* Camera Tilt Angle */}
        <div className="space-y-2">
          <label className="text-xs font-medium text-zinc-400">Atmospheric Perspective Angle</label>
          <div className="grid grid-cols-3 gap-2">
            {[
              { id: 'low', label: 'Low Angle', hint: 'Empowers character' },
              { id: 'eye-level', label: 'Eye-Level', hint: 'Realistic gaze' },
              { id: 'high', label: 'High Angle', hint: 'Vulnerable feeling' }
            ].map(angle => (
              <button
                key={angle.id}
                onClick={() => handleUpdate({ tiltAngle: angle.id as any })}
                className={`p-2.5 rounded-xl border text-left transition-all cursor-pointer ${
                  config.tiltAngle === angle.id 
                    ? 'bg-zinc-100 border-zinc-105 text-zinc-950 font-medium' 
                    : 'bg-zinc-950 border-zinc-900 text-zinc-400 hover:text-zinc-200'
                }`}
              >
                <div className="text-xs font-semibold">{angle.label}</div>
                <div className="text-[9px] font-mono text-zinc-500 mt-0.5">{angle.hint}</div>
              </button>
            ))}
          </div>
        </div>

        {/* Rule of thirds selection toggle helper */}
        <div className="flex items-center justify-between pt-3 border-t border-zinc-900">
          <div className="flex items-center gap-2">
            <Minimize2 className="w-4 h-4 text-indigo-400" />
            <span className="text-xs font-medium text-zinc-300">Grid Overlay Guides (Safezones)</span>
          </div>
          <button
            onClick={() => handleUpdate({ showRuleOfThirds: !config.showRuleOfThirds })}
            className={`w-10 h-6 pl-1 rounded-full flex items-center transition-colors cursor-pointer ${
              config.showRuleOfThirds ? 'bg-indigo-600 justify-end pr-1' : 'bg-zinc-850 justify-start'
            }`}
          >
            <span className="w-4 h-4 rounded-full bg-white shadow-md block" />
          </button>
        </div>
      </div>
    </div>
  );
}
