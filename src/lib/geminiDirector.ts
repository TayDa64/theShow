import type { GoogleGenAI } from '@google/genai';

interface PromptContext {
  scene?: any;
  shot?: any;
  camera?: any;
  characters?: any[];
}

function buildFallbackPrompt(context: PromptContext) {
  const characterNames = (context.characters || []).map((character) => character?.name).filter(Boolean).join(', ') || 'the lead performer';
  return [
    `Create a cinematic feature-film shot for ${characterNames}.`,
    `Scene: ${context.scene?.title || 'Untitled scene'} — ${context.scene?.description || 'No scene description provided.'}`,
    `Shot: ${context.shot?.title || 'Untitled shot'} — ${context.shot?.action || context.shot?.composition || 'Advance the story visually.'}`,
    `Camera: ${context.camera?.shotType || 'medium-shot'}, ${context.camera?.focalLength || 50}mm, ${context.camera?.tiltAngle || 'eye-level'}.`,
    `Continuity notes: ${context.shot?.continuityNotes || 'Preserve wardrobe, identity, and environment continuity.'}`,
  ].join('\n');
}

export async function generateCinematicPrompt(ai: GoogleGenAI | null, context: PromptContext) {
  const fallbackPrompt = buildFallbackPrompt(context);

  if (!ai) {
    return fallbackPrompt;
  }

  try {
    const response = await ai.models.generateContent({
      model: 'gemini-2.0-flash',
      contents: [
        'You are a world-class film director writing a concise shot-generation prompt for a cinematic AI pipeline.',
        fallbackPrompt,
      ].join('\n\n'),
    });

    return response.text?.trim() || fallbackPrompt;
  } catch {
    return fallbackPrompt;
  }
}
