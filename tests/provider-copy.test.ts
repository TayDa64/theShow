import { describe, expect, it } from 'vitest';
import {
  contractCaptionsNote,
  contractQuoteBasis,
  contractSeedNote,
  noVideoBackendAction,
  providerKeyConnectError,
  engineName,
  exportCustomBridgeSummary,
  exportPreviousAnchorSummary,
  providerCopy,
  quotaCapacityBadge,
  quotaExhaustedShotNote,
  quotaExplainer,
  renderAccessMessage,
  renderStatusLabel,
  resultNamesGemini,
  scenesCustomBridgeSummary,
  scenesPreviousAnchorSummary,
  textUsesGemini,
  videoUsesGemini,
} from '../src/lib/providerCopy';

const BRAND = /\bVeo\b|Gemini/;

describe('engineName', () => {
  it('names each video backend', () => {
    expect(engineName('sandbox')).toBe('Sandbox preview');
    expect(engineName('gemini')).toBe('Gemini Veo');
    expect(engineName('grok')).toBe('Grok Imagine Video');
  });
});

describe('providerCopy', () => {
  it('keeps Veo and Gemini off sandbox video copy, including when a key exists but video is pinned to sandbox', () => {
    for (const mode of ['none', 'sandbox', 'personal', 'workspace'] as const) {
      const copy = providerCopy({ videoBackend: 'sandbox', mode });
      expect(copy.quickPreviewTitle).toBe('Sandbox quick preview');
      expect(copy.storyboardTitle).toBe('Sandbox storyboard renderer');
      expect(copy.storyboardBlurb).toBe('Sandbox storyboard renderer: each storyboard shot becomes its own clip.');
      expect(copy.storyboardBlurb).not.toMatch(BRAND);
      expect(copy.filmSheetNote).not.toMatch(BRAND);
      expect(copy.characterStyleLabel).toBe('Character style');
      expect(copy.compilingLabel).not.toMatch(BRAND);
      expect(copy.sceneStoryboardIntro).not.toMatch(BRAND);
      expect(videoUsesGemini('sandbox')).toBe(false);
      expect(renderStatusLabel({ isAuthenticated: true, videoBackend: 'sandbox', mode })).toBe('Sandbox-only render mode');
      expect(renderStatusLabel({ isAuthenticated: true, videoBackend: 'sandbox', mode })).not.toMatch(BRAND);
      expect(renderAccessMessage({
        isAuthenticated: true,
        videoBackend: 'sandbox',
        mode,
        remainingToday: 2,
        dailyVideoLimit: 3,
      })).not.toMatch(BRAND);
    }
  });

  it('names Gemini Veo only when that engine is the active video backend', () => {
    const copy = providerCopy({ videoBackend: 'gemini', mode: 'workspace' });
    expect(copy.engineName).toBe('Gemini Veo');
    expect(copy.quickPreviewTitle).toBe('Veo quick preview');
    expect(copy.storyboardTitle).toBe('Veo storyboard renderer');
    expect(copy.storyboardBlurb).toMatch(/Veo 3\.1/);
    expect(copy.characterStyleLabel).toBe('Google Veo Character Style');
    expect(copy.compilingLabel).toBe('Veo Sequence compiling...');
    expect(videoUsesGemini('gemini')).toBe(true);
    expect(renderStatusLabel({ isAuthenticated: true, videoBackend: 'gemini', mode: 'workspace' })).toBe('Workspace Gemini provider active');
    expect(renderStatusLabel({ isAuthenticated: true, videoBackend: 'gemini', mode: 'personal' })).toBe('Personal Gemini provider active');
    expect(renderAccessMessage({
      isAuthenticated: true,
      videoBackend: 'gemini',
      mode: 'workspace',
    })).toMatch(/Gemini/);
  });

  it('keeps the existing Grok labels', () => {
    const copy = providerCopy({ videoBackend: 'grok', mode: 'workspace', videoBilling: 'Grok subscription' });
    expect(copy.engineName).toBe('Grok Imagine Video');
    expect(copy.quickPreviewTitle).toBe('Grok quick preview');
    expect(copy.storyboardTitle).toBe('Grok storyboard renderer');
    expect(copy.storyboardBlurb).toContain('Grok clip');
    expect(renderStatusLabel({
      isAuthenticated: true,
      videoBackend: 'grok',
      mode: 'personal',
      videoBilling: 'Grok subscription',
    })).toBe('Grok Imagine Video active — billed to Grok subscription');
    const access = renderAccessMessage({
      isAuthenticated: true,
      videoBackend: 'grok',
      mode: 'personal',
      videoBilling: 'Grok subscription',
    });
    expect(access).toContain('Rendering with Grok Imagine Video, billed to your Grok subscription.');
    expect(access).not.toMatch(BRAND);
    expect(contractSeedNote('grok')).toBe('Grok does not receive the seed. The seed stays on this card.');
    expect(contractSeedNote('grok')).not.toMatch(BRAND);
  });

  it('keeps Veo and Gemini out of every Grok and sandbox video string, even when a text key exists', () => {
    const brand = /\bVeo\b|Gemini/;
    for (const backend of ['grok', 'sandbox'] as const) {
      for (const mode of ['none', 'sandbox', 'personal', 'workspace'] as const) {
        const copy = providerCopy({ videoBackend: backend, mode, videoBilling: 'Grok subscription' });
        const videoStrings = [
          copy.engineName,
          copy.quickPreviewTitle,
          copy.storyboardTitle,
          copy.storyboardBlurb,
          copy.filmSheetNote,
          copy.characterStyleLabel,
          copy.sceneStoryboardIntro,
          copy.compilingLabel,
          copy.handoffError,
          contractSeedNote(backend),
          contractQuoteBasis(backend),
          renderStatusLabel({ isAuthenticated: true, videoBackend: backend, mode, videoBilling: 'Grok subscription' }),
          renderAccessMessage({
            isAuthenticated: true,
            videoBackend: backend,
            mode,
            videoBilling: 'Grok subscription',
            remainingToday: 1,
            dailyVideoLimit: 3,
          }),
          exportCustomBridgeSummary(backend, 'Bridge'),
          exportPreviousAnchorSummary(backend, 2, 'Anchor'),
          scenesCustomBridgeSummary(backend, 'Bridge'),
          scenesCustomBridgeSummary(backend, undefined),
          scenesPreviousAnchorSummary(backend, 2, 1, 'Anchor'),
          quotaExhaustedShotNote(backend),
          quotaCapacityBadge(backend),
          quotaExplainer(backend),
        ];
        for (const line of videoStrings) {
          expect(line, `${backend}/${mode}: ${line}`).not.toMatch(brand);
        }
        if (mode === 'personal' || mode === 'workspace') {
          expect(copy.aiSuggestTitle).toBe('Auto-suggest dialogue using Gemini AI');
        } else {
          expect(copy.aiSuggestTitle).not.toMatch(brand);
        }
      }
    }
  });

  it('names Gemini on AI text only when a personal or workspace key exists, and on a result only when it is not a fallback', () => {
    expect(textUsesGemini('none')).toBe(false);
    expect(textUsesGemini('sandbox')).toBe(false);
    expect(textUsesGemini('personal')).toBe(true);
    expect(textUsesGemini('workspace')).toBe(true);
    expect(providerCopy({ videoBackend: 'sandbox', mode: 'none' }).aiSuggestTitle).toBe('Auto-suggest dialogue');
    expect(providerCopy({ videoBackend: 'sandbox', mode: 'sandbox' }).aiSuggestTitle).toBe('Auto-suggest dialogue');
    expect(providerCopy({ videoBackend: 'sandbox', mode: 'workspace' }).aiSuggestTitle).toBe('Auto-suggest dialogue using Gemini AI');
    expect(providerCopy({ videoBackend: 'sandbox', mode: 'personal' }).aiSuggestTitle).toBe('Auto-suggest dialogue using Gemini AI');
    expect(resultNamesGemini('workspace', { fallback: true })).toBe(false);
    expect(resultNamesGemini('workspace', { fallback: false })).toBe(true);
    expect(resultNamesGemini('workspace', {})).toBe(true);
    expect(resultNamesGemini('personal', {})).toBe(true);
    expect(resultNamesGemini('sandbox', {})).toBe(false);
    expect(resultNamesGemini('none', {})).toBe(false);
  });

  it('uses neutral reference-slot and contract copy in sandbox, and Veo copy when Gemini renders', () => {
    expect(exportCustomBridgeSummary('sandbox', 'Bridge')).not.toMatch(BRAND);
    expect(exportPreviousAnchorSummary('sandbox', 2, 'Anchor')).not.toMatch(BRAND);
    expect(scenesCustomBridgeSummary('sandbox', 'Bridge')).not.toMatch(/\bVeo\b|3 Veo/);
    expect(scenesPreviousAnchorSummary('sandbox', 2, 1, 'Anchor')).not.toMatch(BRAND);
    expect(exportCustomBridgeSummary('gemini', 'Bridge')).toMatch(/Veo reference slot/);
    expect(scenesCustomBridgeSummary('gemini', 'Bridge')).toMatch(/3 Veo reference slots/);
    expect(contractSeedNote('sandbox')).not.toMatch(BRAND);
    expect(contractQuoteBasis('sandbox')).toBe('Sandbox preview. Nothing is billed.');
    expect(contractSeedNote('gemini')).toBe('Veo receives the seed on this card.');
    expect(contractQuoteBasis('gemini')).toMatch(/uses Veo/);
    expect(contractSeedNote('grok')).not.toMatch(BRAND);
    expect(contractCaptionsNote()).toBe('Player captions are drawn in the app. They are not burned into the video.');
    expect(contractCaptionsNote()).not.toMatch(BRAND);
    expect(noVideoBackendAction()).toContain('grok login');
    expect(noVideoBackendAction()).not.toMatch(BRAND);
    expect(providerKeyConnectError()).toBe('Could not connect API access.');
    expect(providerKeyConnectError()).not.toMatch(BRAND);
    expect(quotaExhaustedShotNote('sandbox')).not.toMatch(BRAND);
    expect(quotaExhaustedShotNote('gemini')).toMatch(/Veo quota/);
  });
});
