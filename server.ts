import express from 'express';
import path from 'path';
import os from 'os';
import dotenv from 'dotenv';
import fs from 'fs';
import { createServer as createViteServer } from 'vite';
import { GoogleGenAI, Type, GenerateVideosOperation, VideoGenerationReferenceType } from '@google/genai';
import rateLimit from 'express-rate-limit';
import { v4 as uuidv4 } from 'uuid';
import { assembleFilm, extractLastFrame } from './src/lib/ffmpegComposer';
import {
  attachAuthToRequest,
  assertVideoGenerationAllowed,
  authenticateUser,
  buildAuthStatus,
  clearSessionFromResponse,
  disconnectPersonalGeminiProvider,
  getAuthStatusForRequest,
  getOperationApiKeyForUser,
  getRequestUserId,
  getVideoGenerationAccessForUser,
  linkPersonalGeminiProvider,
  loadProjectStateForUser,
  logoutSession,
  recordVideoOperation,
  registerUser,
  requireAuth,
  requireCsrf,
  revokeUserSession,
  saveProjectStateForUser,
  userOwnsOperation,
  writeSessionToResponse,
  type AuthenticatedRequest,
} from './src/lib/authStore';
import { generateCinematicPrompt } from './src/lib/geminiDirector';
import {
  ensureMockVideoAsset,
  normalizeMockVideoAspectRatio,
  normalizeMockVideoDuration,
} from './src/lib/mockVideoAsset';
import {
  cleanupTempClips,
  createUploadMiddleware,
  createUploadedAsset as createStoredAsset,
  getTempClipsDirectory,
  getUploadsRoot,
  saveBufferAsUpload,
} from './src/lib/storageManager';
import type { GenerationProviderMode } from './src/types';
import type { AssembleFilmRequest, ChainedClip, FilmAssemblyJob } from './src/types/pipeline';

dotenv.config();

const app = express();
const PORT = 3000;
const UPLOADS_DIR = getUploadsRoot();
const FILMS_DIR = path.join(UPLOADS_DIR, 'films');
const MOCK_VIDEOS_DIR = path.join(UPLOADS_DIR, 'mock-videos');
const filmAssemblyJobs = new Map<string, FilmAssemblyJob>();
const filmAssemblyOwners = new Map<string, string>();

fs.mkdirSync(UPLOADS_DIR, { recursive: true });
fs.mkdirSync(FILMS_DIR, { recursive: true });
fs.mkdirSync(MOCK_VIDEOS_DIR, { recursive: true });

app.use(express.json({ limit: '2mb' }));
app.use(attachAuthToRequest);
app.use('/uploads', express.static(UPLOADS_DIR));

const aiClients = new Map<string, GoogleGenAI>();
function getAiClientForApiKey(apiKey: string | null | undefined): GoogleGenAI | null {
  const resolvedApiKey = apiKey?.trim();
  if (!resolvedApiKey) {
    return null;
  }

  const existingClient = aiClients.get(resolvedApiKey);
  if (existingClient) {
    return existingClient;
  }

  const nextClient = new GoogleGenAI({
    apiKey: resolvedApiKey,
    httpOptions: {
      headers: {
        'User-Agent': 'aistudio-build',
      },
    },
  });

  aiClients.set(resolvedApiKey, nextClient);
  return nextClient;
}

const upload = createUploadMiddleware(process.cwd(), (req) => {
  const authenticatedReq = req as AuthenticatedRequest;
  const userId = authenticatedReq.auth?.user.id;
  return userId ? `users/${userId}` : 'local';
});
const generationRateLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 10,
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: (req) => `${req.ip}:${req.path}`,
  message: {
    error: 'Too many generation requests. Please wait a minute and try again.',
  },
});
const fileOperationRateLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 30,
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: (req) => `${req.ip}:${req.path}`,
});
const authRateLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 20,
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: (req) => `${req.ip}:${req.path}`,
  message: {
    error: 'Too many account requests. Please wait a few minutes and try again.',
  },
});

app.get('/api/auth/session', (req, res) => {
  return res.json(getAuthStatusForRequest(req));
});

app.post('/api/auth/register', authRateLimiter, (req, res) => {
  try {
    const { user, session } = registerUser(req.body || {}, {
      userAgent: req.get('user-agent') || undefined,
      ip: req.ip,
    });
    writeSessionToResponse(res, session.id);
    return res.status(201).json(buildAuthStatus(user, session));
  } catch (error: any) {
    return res.status(400).json({ error: error?.message || 'Could not create the account.' });
  }
});

app.post('/api/auth/login', authRateLimiter, (req, res) => {
  try {
    const { user, session } = authenticateUser(req.body || {}, {
      userAgent: req.get('user-agent') || undefined,
      ip: req.ip,
    });
    writeSessionToResponse(res, session.id);
    return res.json(buildAuthStatus(user, session));
  } catch (error: any) {
    return res.status(400).json({ error: error?.message || 'Sign-in failed.' });
  }
});

app.post('/api/auth/logout', requireAuth, requireCsrf, (req, res) => {
  const auth = (req as AuthenticatedRequest).auth;
  logoutSession(auth?.session.id);
  clearSessionFromResponse(res);
  return res.json(buildAuthStatus(null, null));
});

app.post('/api/auth/provider/gemini', requireAuth, requireCsrf, (req, res) => {
  try {
    const userId = getRequestUserId(req);
    if (!userId) {
      return res.status(401).json({ error: 'Authentication is required.' });
    }

    linkPersonalGeminiProvider(userId, req.body || {});
    return res.json(getAuthStatusForRequest(req));
  } catch (error: any) {
    return res.status(400).json({ error: error?.message || 'Could not connect Gemini API access.' });
  }
});

app.delete('/api/auth/provider/gemini', requireAuth, requireCsrf, (req, res) => {
  try {
    const userId = getRequestUserId(req);
    if (!userId) {
      return res.status(401).json({ error: 'Authentication is required.' });
    }

    disconnectPersonalGeminiProvider(userId);
    return res.json(getAuthStatusForRequest(req));
  } catch (error: any) {
    return res.status(400).json({ error: error?.message || 'Could not disconnect Gemini API access.' });
  }
});

app.post('/api/auth/sessions/:sessionId/revoke', requireAuth, requireCsrf, (req, res) => {
  try {
    const userId = getRequestUserId(req);
    if (!userId) {
      return res.status(401).json({ error: 'Authentication is required.' });
    }

    revokeUserSession(userId, req.params.sessionId);
    return res.json(getAuthStatusForRequest(req));
  } catch (error: any) {
    return res.status(400).json({ error: error?.message || 'Could not revoke that session.' });
  }
});

function getAuthenticatedUserId(req: express.Request) {
  const userId = getRequestUserId(req);
  if (!userId) {
    throw new Error('Authentication is required.');
  }
  return userId;
}

function getGenerationContextForRequest(req: express.Request) {
  const userId = getAuthenticatedUserId(req);
  const access = getVideoGenerationAccessForUser(userId);
  return {
    userId,
    access,
    ai: getAiClientForApiKey(access.apiKey),
  };
}

function ensureOperationOwnership(userId: string, operationName: string) {
  if (!userOwnsOperation(userId, operationName)) {
    throw new Error('That render operation does not belong to the current account.');
  }
}

// 1. POST /api/generate-character
app.post('/api/generate-character', requireAuth, requireCsrf, async (req, res) => {
  try {
    const { ai } = getGenerationContextForRequest(req);
    if (!ai) {
      throw new Error('No live Gemini provider configured. Falling back to local character generation.');
    }
    const { name, role, properties } = req.body || {};

    const prompt = `Create a highly compelling, multi-dimensional story character profile. 
The genre is immersive futuristic sci-fi/cyberpunk dramatic fiction.

Existing details provided by local script writer (use them if provided, or invent/expand them creatively if missing or generic):
- Primary Designation/Name: ${name || 'None given'}
- Class / Narrative Archetype: ${role || 'None given'}
- Specified apparent age: ${properties?.age || 'None given'}
- Specified Gender Identity: ${properties?.gender || 'None given'}
- Specified physical build: ${properties?.build || 'None given'}
- Hair Style: ${properties?.hairStyle || 'None given'}
- Hair Color: ${properties?.hairColor || 'None given'}
- Eye Accent: ${properties?.eyeColor || 'None given'}
- Outfit Profile: ${properties?.outfit || 'None given'}
- Behavior Temperament: ${properties?.temperament || 'None given'}
- Base Lore Backstory: ${properties?.backstory || 'None given'}

Expand these parameters into a professional screenplay character profile with excellent, rich lore, immersive fashion descriptions, and cohesive personality traits. Avoid lazy AI platitudes and clichés; give them a distinct grit and edge.`;

    const response = await ai.models.generateContent({
      model: 'gemini-3.5-flash',
      contents: prompt,
      config: {
        systemInstruction: "You are a professional character artist, narrative director, and Lead Writer for high-tier interactive screenplays. You output detailed character sheets strictly matching the JSON schema provided.",
        responseMimeType: 'application/json',
        responseSchema: {
          type: Type.OBJECT,
          properties: {
            name: { type: Type.STRING, description: "Unique and evocative sci-fi/cyberpunk character name" },
            role: { type: Type.STRING, description: "Grit-infused narrative role or class designation" },
            properties: {
              type: Type.OBJECT,
              properties: {
                age: { type: Type.INTEGER, description: "Apparent physical age, integer between 16 and 75" },
                gender: { type: Type.STRING, description: "MUST be one of: male, female, non-binary" },
                build: { type: Type.STRING, description: "MUST be one of: slim, average, muscular, heavy" },
                hairStyle: { type: Type.STRING, description: "Tense or tactical style description of hair" },
                hairColor: { type: Type.STRING, description: "Vivid, stylish hair color accent" },
                eyeColor: { type: Type.STRING, description: "Cybernetic, natural, or augmented iris color" },
                outfit: { type: Type.STRING, description: "Ultra-detailed description of clothing style, texture, gear, and aesthetic indicators." },
                temperament: { type: Type.STRING, description: "Behavioral psychology summary (e.g. Cynically stoic, Hyper-focused)" },
                backstory: { type: Type.STRING, description: "An engaging, deep background story (motivation, dark past or secret files)." }
              },
              required: ["age", "gender", "build", "hairStyle", "hairColor", "eyeColor", "outfit", "temperament", "backstory"]
            }
          },
          required: ["name", "role", "properties"]
        }
      }
    });

    const responseText = response.text;
    if (!responseText) {
      throw new Error("No text response received from Gemini engine.");
    }

    const characterData = JSON.parse(responseText.trim());
    return res.json(characterData);
  } catch (error: any) {
    console.warn("AI Character Generation Error, falling back to local procedural generator:", error);
    
    const { name, role, properties } = req.body || {};
    const finalName = name || "Kaelen Mercer";
    const finalRole = role || "Tactical Cyberware Interceptor";
    const age = properties?.age || Math.floor(Math.random() * 25) + 22;
    const gender = properties?.gender || "non-binary";
    const build = properties?.build || "slim";
    
    const hairStyles = [
      "A sleek cyber-enhanced asymmetrical undercut",
      "A close-shaved military buzzcut with neon accent lines",
      "A swept-back platinum fringe with embedded micro-beads",
      "A messy, windblown corporate crop style",
      "High-density dreadlocks bound by metallic rings"
    ];
    
    const hairColors = [
      "Cobalt Teal",
      "Liquid Chrome Steel",
      "Vivid Electric Violet",
      "Matte Charcoal Black",
      "Fluorescent Acid Yellow"
    ];
    
    const eyeColors = [
      "Luminescent synthetic gold",
      "Deep crimson thermal optic iris",
      "Chrome cybernetic camera aperture",
      "Emerald green augmented optic",
      "Reflective ice gray"
    ];
    
    const outfits = [
      "A high-collar weatherworn tactical duster fitted with carbon-fiber impact plates, a padded kevlar harness, and quick-access cargo pouches.",
      "A sharp, tailored neoprene corporate vest integrated with glowing fiber-optic trim and matching dark armored trousers.",
      "A rugged utility flight jacket decorated with grease-stained engineer patches, heavy protective canvas overalls, and high-traction magnetized boots.",
      "Lightweight stealth mesh suit shielded by heat-dispersing ceramic shoulders and sleek polarized goggles."
    ];
    
    const temperaments = [
      "Cynically pragmatic but fiercely protective of their close contacts. They speak only with calculated precision.",
      "Hyper-focused, analytical, and cold. They operate with robotic efficiency when dealing with code or combat.",
      "Quietly observant, extremely resourceful, and harboring a dry, cynical wit even in life-or-death scrambles.",
      "Highly professional yet highly independent, distrusting major corporate networks while relying solely on local grid rules."
    ];
    
    const backstories = [
      `${finalName} started their career as an elite database engineer within the secure vault of Sector 9. After discovering a covert deep-network logging trace that recorded encrypted brainwave patterns across the colony, they defected with the master decrypters installed on their deck. They now survive in the dark, neon-lit alleyways of the lower districts, taking high-stakes extraction jobs while staying ahead of tracker sweeps.`,
      `Growing up in the sprawling industrial wastes of the lower-grid sectors, ${finalName} quickly learned to scavenge cybernetic salvage to stay alive. After accidentally hotwiring a classified military-grade scout drone, they unlocked forbidden blueprints that the defense corporation would kill to erase. They now live on the move, selling tactical recon data to trustworthy resistance cells.`,
      `Once a senior field investigator for the corporate security division, ${finalName} chose to break contract after refusing an order to purge a colony sector of dissident citizens. Terminated from system payroll and placed on the global wanted registries, they use their tactical insight to help ordinary outcasts evade capture, operating under deep-cover signals.`
    ];

    const fallbackChar = {
      name: finalName,
      role: finalRole,
      properties: {
        age: Number(age),
        gender,
        build,
        hairStyle: properties?.hairStyle || hairStyles[Math.floor(Math.random() * hairStyles.length)],
        hairColor: properties?.hairColor || hairColors[Math.floor(Math.random() * hairColors.length)],
        eyeColor: properties?.eyeColor || eyeColors[Math.floor(Math.random() * eyeColors.length)],
        outfit: properties?.outfit || outfits[Math.floor(Math.random() * outfits.length)],
        temperament: properties?.temperament || temperaments[Math.floor(Math.random() * temperaments.length)],
        backstory: properties?.backstory || backstories[Math.floor(Math.random() * backstories.length)]
      }
    };

    return res.json(fallbackChar);
  }
});

// 2. POST /api/generate-dialogue
app.post('/api/generate-dialogue', requireAuth, requireCsrf, async (req, res) => {
  try {
    const { ai } = getGenerationContextForRequest(req);
    if (!ai) {
      throw new Error('No live Gemini provider configured. Falling back to local dialogue generation.');
    }
    const { scene, characters, currentDialogues, speakerId, sentiment } = req.body || {};

    const activeSpeaker = characters.find((c: any) => c.id === speakerId);
    if (!activeSpeaker) {
      return res.status(400).json({ error: "Active character/actor profile not found." });
    }

    const otherActorsContext = characters
      .filter((c: any) => c.id !== speakerId)
      .map((c: any) => `${c.name} (${c.role}): ${c.properties.temperament}. Backstory: ${c.properties.backstory}`)
      .join('\n');

    const timelineText = currentDialogues && currentDialogues.length > 0
      ? currentDialogues.map((d: any) => {
          const author = characters.find((c: any) => c.id === d.characterId)?.name || 'Unknown';
          return `${author} (Delivered ${d.sentiment || 'neutral'}): "${d.text}"`;
        }).join('\n')
      : "No preceding dialogue. This is the opening line of the scene.";

    const prompt = `Write the next highly engaging screenplay line of dialogue.

Scene Setting:
- Title: ${scene?.title || 'Act Outline'}
- Description: ${scene?.description || 'No visual description'}
- Lighting Atmosphere: ${scene?.lighting || 'Standard Default'}

The Active Speaker Profile:
- Name: ${activeSpeaker.name}
- Archetype Designation: ${activeSpeaker.role}
- Temperament Behavior: ${activeSpeaker.properties.temperament}
- Historical Continuity Lore: ${activeSpeaker.properties.backstory}

Immediate Emotional Context:
- Target Sentiment Delivery: ${sentiment || 'neutral'}

Other Present Characters Context:
${otherActorsContext}

Timeline Transcript (Preceding lines):
${timelineText}

Draft one impactful, authentic line spoken by ${activeSpeaker.name}. It must lock onto their temperament and backstory. Rely on subtlety, subtext, tension, and atmospheric realism. Do not output anything other than the raw spoken phrase itself (no quotation marks, no screen directions, no prefix).`;

    const response = await ai.models.generateContent({
      model: 'gemini-3.5-flash',
      contents: prompt,
      config: {
        systemInstruction: "You are an award-winning screenplay dialogue writer for premium dark drama and intelligent neon sci-fi series. You write gripping, short lines with profound subtext.",
        temperature: 1.0
      }
    });

    const responseText = response.text;
    if (!responseText) {
      throw new Error("No dialogue line received from Gemini engine.");
    }

    // Clean up response string
    let cleanedText = responseText.trim();
    if (cleanedText.startsWith('"') && cleanedText.endsWith('"')) {
      cleanedText = cleanedText.slice(1, -1);
    } else if (cleanedText.startsWith('“') && cleanedText.endsWith('”')) {
      cleanedText = cleanedText.slice(1, -1);
    }
    cleanedText = cleanedText.trim();

    return res.json({ text: cleanedText });
  } catch (error: any) {
    console.warn("AI Dialogue Line Error, falling back to dynamic local generator:", error);
    
    const { scene, characters, currentDialogues, speakerId, sentiment } = req.body || {};
    const activeSpeaker = characters?.find((c: any) => c.id === speakerId) || { name: "System Speaker", role: "Actor", properties: { temperament: "Focused" } };
    const speakerName = activeSpeaker?.name || "The Speaker";
    const activeSentiment = sentiment || "neutral";

    // Find other characters' names
    const otherNames = characters
      ?.filter((c: any) => c.id !== speakerId)
      ?.map((c: any) => c.name) || [];
    const targetName = otherNames.length > 0 ? otherNames[Math.floor(Math.random() * otherNames.length)] : "Vance";

    // Dynamic dialogue generator dictionary
    const dialoguePool: Record<string, string[]> = {
      tense: [
        `We don't have much time, ${targetName}. Secure the subnet before the sweep begins.`,
        "I hear security locks cyclic-clicking. Put that transmitter away right now.",
        `That energy pulse was too close. The network anomalies are starting to cascade across the grid.`,
        `If we stay here any longer, we'll be scanning static. We need to override the primary gate immediately.`,
        `Don't look at me like that, ${targetName}. We both knew this signal trace could lead them right to us.`
      ],
      playful: [
        `Oh, relax, ${targetName}. It's just a little bit of high-level code tampering. No one's getting spaced.`,
        "Who designed this mainframe structure anyway? Looks like twentieth-century spaghetti.",
        `Well, aren't you mister sunshine today? I thought you liked high-voltage challenges.`,
        `Let me guess—you forgot to copy the primary decrypt keys again, didn't you?`,
        `Care to make a friendly wager on whether those guard drones are still patrolling Sector 9?`
      ],
      mysterious: [
        `The global link wasn't built by humans... We only stumbled upon its leftover structures.`,
        "There are encrypted shadows inside these data blocks that can literally turn the daylight off.",
        `Listen to the frequency spectrum, ${targetName}. Do you hear the source code humming?`,
        `I found an uncharted datastream buried in this terminal's deep cache. It's been active since before the colony was chartered.`,
        "Some files are locked from the inside. They don't want us looking, but they aren't deleted."
      ],
      determined: [
        `I will synchronize this database block even if it's the absolute last trace I upload.`,
        `We started this run together, ${targetName}, and we are going to see it through to the end node.`,
        "Don't worry, the signal pipeline is fully secure in my hands. Powering up the mainframe now.",
        `They think they can freeze our terminals, but they forget who built their entire kernel database.`,
        `I'm taking direct manual control of this reactor burn. No more compromises.`
      ],
      neutral: [
        "Initializing the telemetry diagnostic loop. Let me scan the interface logs first.",
        `The data link is steady for now, ${targetName}. Let's monitor the sector gateway.`,
        "Mainframe packet sequences are adjusting correctly to the safety margin.",
        `The relay hasn't detected any sweep activities yet. Keep the line quiet.`,
        `We are ready to retrieve the logs. Stand by for decrypt authorization.`
      ]
    };

    const matchingLines = dialoguePool[activeSentiment] || dialoguePool.neutral;
    const chosenLine = matchingLines[Math.floor(Math.random() * matchingLines.length)];

    return res.json({ text: chosenLine, fallback: true, isQuotaExhausted: true });
  }
});

// 3. POST /api/generate-portrait
app.post('/api/generate-portrait', requireAuth, requireCsrf, async (req, res) => {
  try {
    const { ai } = getGenerationContextForRequest(req);
    if (!ai) {
      throw new Error('No live Gemini provider configured. Falling back to local portrait generation.');
    }
    const charName = req.body?.name || '';
    const charRole = req.body?.role || '';
    const charProps = req.body?.properties || {};
    const stylePreset = charProps?.stylePreset || 'cinematic-actor';
    const gender = (charProps?.gender || 'male').toLowerCase();

    // Map stylePreset and gender dynamically to the best photorealistic or stylized portrait IDs
    const PORTRAIT_GRID: Record<string, Record<string, string>> = {
      'cinematic-actor': {
        'male': "1506794778202-cad84cf45f1d", // rugged male action actor portrait close-up
        'female': "1534528741775-53994a69daeb", // crisp studio female portrait
        'non-binary': "1618005182384-a83a8bd57fbe" // digital conceptual humanoid
      },
      'historical-figure': {
        'male': "1489980508314-941910ded1f4", // historical heavy-leather pilot coat portrait
        'female': "1508214751196-bcfd4ca60f91", // historical portrait woman wool coat
        'non-binary': "1579783900882-c0d3dad7b119" // hand-drawn traditional sketch
      },
      'cyberpunk-human': {
        'male': "1507003211169-0a1dd7228f2d", // clean male cyberpunk glow-accent portrait
        'female': "1515886657613-9f3515b0c78f", // cyberpunk fuchsia female character look
        'non-binary': "1601412436009-d964bd02edbc" // augmented cyborg conceptual portrait
      },
      'stylized-3d': {
        'male': "1608889175123-8ec330b86f84", // 3D stylized face render male style
        'female': "1608889175123-8ec330b86f84", // 3D stylized face render female style
        'non-binary': "1608889175123-8ec330b86f84" // 3D stylized face render abstract
      },
      'video-game-cg': {
        'male': "1607990283143-e81e7a2c93ab", // bulky warrior video game render male
        'female': "1531746020798-e6953c6e8e04", // athletic stealth rogue cyber female
        'non-binary': "1618005182384-a83a8bd57fbe" // virtual digitized actor base
      }
    };

    // Helper helper to resolve the Unsplash ID
    const getUnsplashIdForPreset = (preset: string, g: string): string => {
      const presetMap = PORTRAIT_GRID[preset] || PORTRAIT_GRID['cinematic-actor'];
      return presetMap[g] || presetMap['male'];
    };

    // Curated catalog mapping style presets to highly targeted visual matching assets (Unsplash IDs & Dicebear)
    const EST_PROFILES: Record<string, { unsplashId: string, dicebearStyle: string, description: string }> = {
      'cinematic-actor': {
        unsplashId: getUnsplashIdForPreset('cinematic-actor', gender),
        dicebearStyle: 'adventurer',
        description: `High-quality photorealistic cinematic close-up showing physical skin textures and professional camera lens focus representing a ${gender} character.`
      },
      'historical-figure': {
        unsplashId: getUnsplashIdForPreset('historical-figure', gender),
        dicebearStyle: 'adventurer',
        description: `Detailed historical vintage portrait with period-specific heavy texture garments representing a ${gender} historical figure.`
      },
      'cyberpunk-human': {
        unsplashId: getUnsplashIdForPreset('cyberpunk-human', gender),
        dicebearStyle: 'bottts',
        description: `Futuristic advanced human profile with glowing digital optic cybernetic implants on a ${gender} subject.`
      },
      'stylized-3d': {
        unsplashId: getUnsplashIdForPreset('stylized-3d', gender),
        dicebearStyle: 'lorelei',
        description: `Stylized 3D CGI animation style portrait with soft skin rendering and luminous oversized eyes of a ${gender} character.`
      },
      'video-game-cg': {
        unsplashId: getUnsplashIdForPreset('video-game-cg', gender),
        dicebearStyle: 'adventurer',
        description: `High-fidelity cinematic 3D digital art video game character keyframe portrait representing a ${gender} warrior class.`
      },
      'cute-chibi': {
        unsplashId: "1566577134770-3d85bb3a9cc4", // Cute figurine toy
        dicebearStyle: 'lorelei',
        description: `Miniature 3D character with smooth, glossy plastic finishes resembling a chibi collectible toy.`
      },
      'anime-manga': {
        unsplashId: "1607604276583-eef5d076aa5f", // Anime colorful drawing
        dicebearStyle: 'lorelei',
        description: `Japanese Anime cel-shaded screen hand-drawn layout with clean vector ink outlines for a ${gender} description.`
      },
      'retro-comic': {
        unsplashId: "1618336753974-aae8e04506aa", // Retro pop art graphic
        dicebearStyle: 'pixel-art',
        description: `Retro classic comic book page layout print with distinct cross-hatching and halftone grids representing a ${gender} character.`
      },
      'pencil-sketch': {
        unsplashId: "1579783900882-c0d3dad7b119", // Charcoal pencil sketch
        dicebearStyle: 'open-peeps',
        description: `Graphite pencil portrait drawing on highly textured rough physical paper representing a ${gender} subject.`
      },
      'claymation': {
        unsplashId: "1584438784894-089d6a128f3e", // Sculpted molded clay
        dicebearStyle: 'lorelei',
        description: `Tactile modeling clay character sculpted detailing thumbprint tracks representing a ${gender} puppet.`
      },
      'felt-puppet': {
        unsplashId: "1614850523459-c2f4c699c52e", // Soft fuzzy needle felt texture
        dicebearStyle: 'lorelei',
        description: `Fuzzy soft needle-felted woolen puppet with visible fibers catching studio rim lighting.`
      },
      'wooden-figurine': {
        unsplashId: "1620121692029-d088224ddc74", // Geometrical wood design
        dicebearStyle: 'bottts',
        description: `Geometric carved wooden figurine toy depicting grain lines and physical joints.`
      },
      'mythological-beast': {
        unsplashId: "1601412436009-d964bd02edbc", // Cyborg / exotic portrait
        dicebearStyle: 'adventurer',
        description: `Mythical organic-tech hybrid blending a ${gender} humanoid interface structure with feathers or iridescent scales.`
      },
      'sentient-object': {
        unsplashId: "1561037404-61cd46aa615b", // Adorable cute mascot toy
        dicebearStyle: 'fun-emoji',
        description: `Living artificial object mascot integrated custom mechanical characteristics.`
      }
    };

    const targetProfile = EST_PROFILES[stylePreset] || EST_PROFILES['cinematic-actor'];

    const prompt = `Choose the absolute best visual style representation for this screenplay character.
    
    Character Info:
    - Name: ${charName || 'Unnamed Actor'}
    - Specified Gender Identity: ${gender}
    - Role Description: ${charRole || 'General Operator'}
    - Requested Style Preset Category: ${stylePreset}
    - Stylization Description Goal: ${targetProfile.description}
    - Hair Style: ${charProps?.hairStyle || 'None'}
    - Hair Color: ${charProps?.hairColor || 'None'}
    - Eye Color: ${charProps?.eyeColor || 'None'}
    - Outfit Style: ${charProps?.outfit || 'None'}
    - Temperament: ${charProps?.temperament || 'None'}
    - Backstory Context: ${charProps?.backstory || 'None'}
    
    Determine two choices of visual portrait formats matching the requested style preset category:
    1. A stylized high-quality Unsplash portrait ID that matches their profile. The recommended ID for this category and gender combination is "${targetProfile.unsplashId}" which yields a brilliant visual representation matching your aesthetic boundaries and specified gender perfectly. You MUST return an ID from our allowed portfolio matching the requested gender ("${gender}").
    2. A procedural Dicebear vector avatar config. Set the category to "${targetProfile.dicebearStyle}" to perfectly match the requested style form structure.
    
    Output your decisions as a verified JSON response.`;

    const response = await ai.models.generateContent({
      model: 'gemini-3.5-flash',
      contents: prompt,
      config: {
        systemInstruction: `You are an expert character visualizer and concept artist. You classify characters and recommend high-quality matching portrait options strictly matching the JSON schema. You MUST respect the requested Style Preset and Gender. Make sure the returned unsplashId absolutely corresponds to the specified gender: only use ${targetProfile.unsplashId} or equivalent allowed portfolio IDs. Always output portraitType: 'photo' unless the user specifically prefers vector style.`,
        responseMimeType: 'application/json',
        responseSchema: {
          type: Type.OBJECT,
          properties: {
            portraitType: { type: Type.STRING, description: "MUST be one of: 'photo' or 'vector'. Prefer 'photo' for photorealistic and high-fidelity CGI types, and 'vector' for simple illustrative or stylized types." },
            unsplashId: { type: Type.STRING, description: "Recommended Unsplash ID selected for this category state matching the subject's gender and style" },
            dicebearStyle: { type: Type.STRING, description: "Dicebear category matching the theme" },
            dicebearSeed: { type: Type.STRING, description: "Sleek seed based on role name for procedural generation" }
          },
          required: ["portraitType", "unsplashId", "dicebearStyle", "dicebearSeed"]
        }
      }
    });

    const responseText = response.text;
    if (!responseText) {
      throw new Error("No response from portrait assistant engine.");
    }

    const assessment = JSON.parse(responseText.trim());
    let portraitUrl = '';

    const dynamicPropertiesSeed = `${assessment.dicebearSeed || charName || 'avatar'}-${gender}-${charProps?.hairColor || ''}-${charProps?.hairStyle || ''}-${charProps?.eyeColor || ''}-${charProps?.build || ''}`;

    if (assessment.portraitType === 'photo') {
      // Programmatically enforce the correct gender-targeted portrait ID to guarantee finding 1 and 2 are robustly satisfied!
      let selectedId = assessment.unsplashId;
      const allowedPortraits = Object.values(PORTRAIT_GRID).map(m => m[gender]).filter(Boolean);
      
      if (!selectedId || !allowedPortraits.includes(selectedId)) {
        selectedId = targetProfile.unsplashId;
      }
      portraitUrl = `https://images.unsplash.com/photo-${selectedId}?auto=format&fit=crop&w=400&h=400&q=80`;
    } else {
      const selectedStyle = assessment.dicebearStyle || targetProfile.dicebearStyle;
      portraitUrl = `https://api.dicebear.com/7.x/${selectedStyle}/svg?seed=${encodeURIComponent(dynamicPropertiesSeed)}&backgroundColor=09090b`;
    }

    return res.json({ url: portraitUrl, format: assessment.portraitType });
  } catch (error: any) {
    console.error("AI Portrait Generation Error:", error);
    // Dynamic custom fallback based directly on selected style and gender
    const charProps = req.body?.properties || {};
    const stylePreset = charProps?.stylePreset || 'cinematic-actor';
    const gender = (charProps?.gender || 'male').toLowerCase();
    
    // Fallback dictionary
    const fallbackIds: Record<string, string> = {
      'cinematic-actor': gender === 'female' ? "1534528741775-53994a69daeb" : gender === 'non-binary' ? "1618005182384-a83a8bd57fbe" : "1506794778202-cad84cf45f1d",
      'historical-figure': gender === 'female' ? "1508214751196-bcfd4ca60f91" : gender === 'non-binary' ? "1579783900882-c0d3dad7b119" : "1489980508314-941910ded1f4",
      'cyberpunk-human': gender === 'female' ? "1515886657613-9f3515b0c78f" : gender === 'non-binary' ? "1601412436009-d964bd02edbc" : "1507003211169-0a1dd7228f2d",
      'stylized-3d': "1608889175123-8ec330b86f84",
      'video-game-cg': gender === 'female' ? "1531746020798-e6953c6e8e04" : gender === 'non-binary' ? "1618005182384-a83a8bd57fbe" : "1607990283143-e81e7a2c93ab",
      'cute-chibi': "1566577134770-3d85bb3a9cc4",
      'anime-manga': "1607604276583-eef5d076aa5f",
      'retro-comic': "1618336753974-aae8e04506aa",
      'pencil-sketch': "1579783900882-c0d3dad7b119",
      'claymation': "1584438784894-089d6a128f3e",
      'felt-puppet': "1614850523459-c2f4c699c52e",
      'wooden-figurine': "1620121692029-d088224ddc74",
      'mythological-beast': "1601412436009-d964bd02edbc",
      'sentient-object': "1561037404-61cd46aa615b"
    };

    const chosenId = fallbackIds[stylePreset] || fallbackIds['cinematic-actor'];
    const fallbackUrl = `https://images.unsplash.com/photo-${chosenId}?auto=format&fit=crop&w=400&h=400&q=80`;
    return res.json({ url: fallbackUrl, format: 'photo', fallback: true });
  }
});

const inferMimeTypeFromPath = (value: string) => {
  const normalized = value.toLowerCase();
  if (normalized.endsWith('.png')) return 'image/png';
  if (normalized.endsWith('.webp')) return 'image/webp';
  if (normalized.endsWith('.jpeg') || normalized.endsWith('.jpg')) return 'image/jpeg';
  if (normalized.endsWith('.gif')) return 'image/gif';
  if (normalized.endsWith('.svg')) return 'image/svg+xml';
  return 'application/octet-stream';
};

const isQuotaExhaustedError = (error: any) => !!(
  error?.status === 'RESOURCE_EXHAUSTED' ||
  error?.message?.includes('RESOURCE_EXHAUSTED') ||
  error?.message?.includes('429') ||
  error?.message?.toLowerCase?.().includes('quota')
);

const STORYBOARD_NEGATIVE_PROMPT = 'Avoid subtitles, text overlays, logos, watermarks, costume drift, face drift, duplicated limbs, abrupt environment changes, or extra unnamed characters.';

const startMockVideoOperation = (
  prompt: string,
  options: {
    aspectRatio?: '16:9' | '9:16';
    durationSeconds?: number;
    userId?: string | null;
  } = {},
) => {
  const mockId = `mock-operation-veo-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
  mockOperations.set(mockId, {
    createdAt: Date.now(),
    prompt,
    aspectRatio: normalizeMockVideoAspectRatio(options.aspectRatio),
    durationSeconds: normalizeMockVideoDuration(options.durationSeconds, 8),
    userId: options.userId || null,
  });
  return mockId;
};

const getCharacterActiveImageUrl = (character: any): string | null => {
  const assets = Array.isArray(character?.referenceAssets) ? character.referenceAssets : [];
  const activeAsset = assets.find((asset: any) => asset.id === character?.activeImageId) || assets[0];
  return activeAsset?.url || character?.thumbnail || null;
};

const getSceneActiveBackgroundUrl = (scene: any): string | null => {
  const assets = Array.isArray(scene?.backgroundAssets) ? scene.backgroundAssets : [];
  const activeAsset = assets.find((asset: any) => asset.id === scene?.activeBackgroundImageId) || assets[0];
  return activeAsset?.url || null;
};

const getSceneStoryboardFrameAsset = (scene: any, assetId: string | null | undefined) => {
  if (!assetId) return null;
  const assets = Array.isArray(scene?.storyboardFrameAssets) ? scene.storyboardFrameAssets : [];
  return assets.find((asset: any) => asset.id === assetId) || null;
};

const getShotAnchorFrameUrl = (scene: any, shot: any): string | null => {
  const asset = getSceneStoryboardFrameAsset(scene, shot?.boardImageId);
  return asset?.url || null;
};

const sanitizeStoryboardSeed = (value: unknown): number | null => {
  if (value === null || value === undefined || value === '') return null;

  const parsed = typeof value === 'string'
    ? Number(value.trim())
    : typeof value === 'number'
      ? value
      : Number.NaN;

  if (!Number.isFinite(parsed)) return null;

  const rounded = Math.round(parsed);
  if (rounded <= 0) return null;

  return Math.min(rounded, 2147483647);
};

const createRenderSeed = () => Math.floor(Math.random() * 2147483646) + 1;

const resolveStoryboardSeedForShot = (scene: any, shot: any, explicitSeed?: unknown) => {
  const requestSeed = sanitizeStoryboardSeed(explicitSeed);
  if (requestSeed) {
    return {
      resolvedSeed: requestSeed,
      seedSource: 'request',
    };
  }

  const shots = Array.isArray(scene?.storyboardShots) ? scene.storyboardShots : [];
  const shotIndex = shots.findIndex((candidate: any) => candidate?.id === shot?.id);
  const previousShot = shotIndex > 0 ? shots[shotIndex - 1] : null;
  const previousSeed = sanitizeStoryboardSeed(previousShot?.lastRenderSeed);
  const lockedSeed = sanitizeStoryboardSeed(shot?.lockedSeed);

  if (shot?.seedStrategy === 'lock' && lockedSeed) {
    return {
      resolvedSeed: lockedSeed,
      seedSource: 'lock',
    };
  }

  if (shot?.seedStrategy === 'inherit-previous' && previousSeed) {
    return {
      resolvedSeed: previousSeed,
      seedSource: 'inherit-previous',
    };
  }

  return {
    resolvedSeed: createRenderSeed(),
    seedSource: 'auto',
  };
};

const getShotDialogueLines = (scene: any, shot: any) => {
  const dialogueIds = Array.isArray(shot?.dialogueLineIds) ? shot.dialogueLineIds : [];
  if (!dialogueIds.length) return [];
  return (Array.isArray(scene?.dialogues) ? scene.dialogues : []).filter((dialogue: any) => dialogueIds.includes(dialogue.id));
};

const getShotDialogueExcerpt = (scene: any, characters: any[], shot: any) => {
  if (typeof shot?.dialogueExcerpt === 'string' && shot.dialogueExcerpt.trim()) {
    return shot.dialogueExcerpt.trim();
  }

  const lines = getShotDialogueLines(scene, shot);
  return lines
    .map((dialogue: any) => {
      const speaker = characters.find((character: any) => character.id === dialogue.characterId)?.name || 'Unknown Actor';
      return `${speaker}: ${dialogue.text}`;
    })
    .join(' ')
    .trim();
};

const getShotCharacters = (characters: any[], scene: any, shot: any) => {
  const shotDialogueLines = getShotDialogueLines(scene, shot);
  const featuredIds = new Set(shotDialogueLines.map((dialogue: any) => dialogue.characterId));
  const featuredCharacters = characters.filter((character: any) => featuredIds.has(character.id));
  return featuredCharacters.length ? featuredCharacters : characters.slice(0, 2);
};

const resolveContinuityReferenceForShot = (scene: any, shot: any) => {
  const shots = Array.isArray(scene?.storyboardShots) ? scene.storyboardShots : [];
  const shotIndex = shots.findIndex((candidate: any) => candidate?.id === shot?.id);
  const previousShot = shotIndex > 0 ? shots[shotIndex - 1] : null;

  if (shot?.transitionInMode === 'custom-frame') {
    const asset = getSceneStoryboardFrameAsset(scene, shot?.transitionInAssetId);
    return {
      url: asset?.url || null,
      sourceLabel: asset ? `custom bridge frame "${asset.label}"` : 'custom bridge frame',
      mode: 'custom-frame',
    };
  }

  if (shot?.transitionInMode === 'previous-shot') {
    const anchorUrl = previousShot ? getShotAnchorFrameUrl(scene, previousShot) : null;
    return {
      url: anchorUrl,
      sourceLabel: previousShot ? `Shot ${shotIndex} anchor frame` : 'opening shot',
      mode: 'previous-shot',
    };
  }

  return {
    url: null,
    sourceLabel: null,
    mode: 'none',
  };
};

const buildIdentityAnchor = (character: any) => {
  if (!character) return 'Preserve the same on-screen performer across all storyboard shots.';

  return `${character.name} is a ${character.role}. Preserve age ${character.properties?.age}, ${character.properties?.build} physique, ${character.properties?.hairStyle} hair (${character.properties?.hairColor}), ${character.properties?.eyeColor} eyes, and wardrobe continuity: ${character.properties?.outfit}. Temperament: ${character.properties?.temperament}.`;
};

const buildQuickPreviewPrompt = (characters: any[], scene: any, camera: any) => {
  const primaryChar = characters?.find((character: any) =>
    Array.isArray(scene?.dialogues) && scene.dialogues.some((dialogue: any) => dialogue.characterId === character.id)
  ) || characters?.[0];

  const stylePreset = primaryChar?.properties?.stylePreset || 'cinematic-actor';
  const styleDescription = VEO_AESTHETIC_MAP[stylePreset] || VEO_AESTHETIC_MAP['cinematic-actor'];
  const activeBackground = getSceneActiveBackgroundUrl(scene);

  let videoPrompt = '';
  videoPrompt += `[AESTHETIC STYLIZATION ANCHOR]: ${styleDescription}\n\n`;

  if (primaryChar) {
    videoPrompt += `[IDENTITY ANCHOR PARAMETERS]: ${buildIdentityAnchor(primaryChar)}\n\n`;
  }

  if (scene) {
    videoPrompt += `[SCENE ACTION & ENVIRONMENT SETTING]: The active scene is "${scene.title}". Incident actions: ${scene.description}. Ambient lighting mood: ${scene.lighting}. Atmospheric notes: ${scene.atmosphereNotes || 'None provided'}. ${activeBackground ? 'Respect the uploaded environment reference as the primary set continuity anchor.' : ''}\n\n`;
  }

  if (camera) {
    videoPrompt += `[CAMERA DIRECTION]: Frame shot captured using ${camera.shotType || 'medium-shot'} positioning, tracked with virtual ${camera.focalLength || 50}mm prime lens at ${camera.tiltAngle || 'eye-level'} tilt angle. Aspect ratio: ${camera.aspectRatio || '16:9'}.\n\n`;
  }

  videoPrompt += '[PROMPT EXECUTION CONTRACT]: Render with physical space understanding, high structural continuity, lifelike human motion kinetics, organic micro-textures, and temporal character consistency across frames.';
  return videoPrompt;
};

const buildLocalStoryboard = (scene: any, characters: any[], camera: any) => {
  const dialogues = Array.isArray(scene?.dialogues) ? scene.dialogues : [];
  const chunkSize = dialogues.length > 5 ? 2 : 1;
  const chunks = dialogues.length
    ? dialogues.reduce((groups: any[][], dialogue: any) => {
        const currentGroup = groups[groups.length - 1];
        if (!currentGroup || currentGroup.length >= chunkSize) {
          groups.push([dialogue]);
        } else {
          currentGroup.push(dialogue);
        }
        return groups;
      }, [] as any[][])
    : [[]];

  return chunks.map((chunk, index) => {
    const leadDialogue = chunk[0];
    const leadCharacter = characters.find((character: any) => character.id === leadDialogue?.characterId) || characters[0];
    const shotType = ['wide-landscape', 'medium-shot', 'close-up', 'over-the-shoulder', 'two-shot', 'tracking'][index % 6];
    const dialogueExcerpt = chunk
      .map((dialogue: any) => {
        const speaker = characters.find((character: any) => character.id === dialogue.characterId)?.name || 'Unknown Actor';
        return `${speaker}: ${dialogue.text}`;
      })
      .join(' ')
      .trim();

    return {
      id: `shot-${Date.now()}-${index}`,
      shotNumber: index + 1,
      title: `${scene?.title || 'Scene'} — Beat ${index + 1}`,
      shotType,
      durationSeconds: 8,
      focalLength: camera?.focalLength || 50,
      cameraAngle: camera?.tiltAngle || 'eye-level',
      composition: shotType === 'wide-landscape'
        ? 'Establish the geography of the scene and the environmental mood before tightening coverage.'
        : shotType === 'close-up'
          ? 'Emphasize emotional detail and continuity in the performer’s face.'
          : 'Frame the active performer clearly with readable screen direction and continuity.',
      action: chunk.length
        ? `${leadCharacter?.name || 'The lead'} advances the scene beat while the environment remains consistent with the scene atmosphere.`
        : `Establish the atmosphere of ${scene?.title || 'the scene'} before dialogue begins.`,
      dialogueLineIds: chunk.map((dialogue: any) => dialogue.id),
      dialogueExcerpt,
      continuityNotes: `Preserve wardrobe, identity, blocking direction, and the scene atmosphere (${scene?.lighting || 'default lighting'}) from beat to beat.`,
      boardImageId: null,
      transitionInMode: index === 0 ? 'none' : 'previous-shot',
      transitionInAssetId: null,
    };
  });
};

const normalizeReferenceUrl = (rawUrl: string) => {
  if (!rawUrl) return rawUrl;

  if (rawUrl.startsWith('/uploads/')) {
    return rawUrl;
  }

  try {
    const parsed = new URL(rawUrl);
    if (parsed.pathname.startsWith('/uploads/')) {
      return parsed.pathname;
    }
  } catch {
    return rawUrl;
  }

  return rawUrl;
};

const isSupportedReferenceMime = (mimeType: string) => ['image/png', 'image/jpeg', 'image/webp'].includes(mimeType);

const assetUrlToInlineImage = async (assetUrl: string): Promise<{ imageBytes: string; mimeType: string } | null> => {
  const normalizedUrl = normalizeReferenceUrl(assetUrl);

  if (normalizedUrl.startsWith('/uploads/')) {
    const assetPath = path.join(UPLOADS_DIR, normalizedUrl.replace('/uploads/', ''));
    if (!fs.existsSync(assetPath)) {
      return null;
    }

    const mimeType = inferMimeTypeFromPath(assetPath);
    if (!isSupportedReferenceMime(mimeType)) {
      return null;
    }

    const imageBytes = fs.readFileSync(assetPath).toString('base64');
    return { imageBytes, mimeType };
  }

  if (normalizedUrl.startsWith('http://') || normalizedUrl.startsWith('https://')) {
    const response = await fetch(normalizedUrl);
    if (!response.ok) {
      return null;
    }

    const mimeType = (response.headers.get('content-type') || inferMimeTypeFromPath(normalizedUrl)).split(';')[0].trim();
    if (!isSupportedReferenceMime(mimeType)) {
      return null;
    }

    const buffer = Buffer.from(await response.arrayBuffer());
    return { imageBytes: buffer.toString('base64'), mimeType };
  }

  return null;
};

const pickReferenceUrlsForShot = (characters: any[], scene: any, shot: any) => {
  const featuredCharacters = getShotCharacters(characters, scene, shot);
  const continuityReference = resolveContinuityReferenceForShot(scene, shot);
  const leadCharacterUrl = featuredCharacters[0] ? getCharacterActiveImageUrl(featuredCharacters[0]) : null;
  const secondaryCharacterUrls = featuredCharacters.slice(1).map((character: any) => getCharacterActiveImageUrl(character));
  const candidateUrls = [
    continuityReference.url,
    leadCharacterUrl,
    getSceneActiveBackgroundUrl(scene),
    ...secondaryCharacterUrls,
  ].filter(Boolean) as string[];

  return {
    referenceUrls: [...new Set(candidateUrls)].slice(0, 3),
    continuityReference,
  };
};

const buildReferenceImages = async (referenceUrls: string[]) => {
  const referenceImages: Array<{ image: { imageBytes: string; mimeType: string }; referenceType: VideoGenerationReferenceType }> = [];

  for (const referenceUrl of referenceUrls) {
    const inlineImage = await assetUrlToInlineImage(referenceUrl);
    if (!inlineImage) continue;
    referenceImages.push({
      image: inlineImage,
      referenceType: VideoGenerationReferenceType.ASSET,
    });
  }

  return referenceImages;
};

const buildShotPrompt = (characters: any[], scene: any, shot: any, camera: any, continuityReference?: { url: string | null; sourceLabel: string | null; mode: string }) => {
  const featuredCharacters = getShotCharacters(characters, scene, shot);
  const leadCharacter = featuredCharacters[0] || characters?.[0];
  const stylePreset = leadCharacter?.properties?.stylePreset || 'cinematic-actor';
  const styleDescription = VEO_AESTHETIC_MAP[stylePreset] || VEO_AESTHETIC_MAP['cinematic-actor'];
  const dialogueExcerpt = getShotDialogueExcerpt(scene, characters, shot);

  return [
    `Create a cinematic storyboard shot for a premium sci-fi feature film.`,
    `Style: ${styleDescription}`,
    `Subject: ${featuredCharacters.map((character: any) => buildIdentityAnchor(character)).join(' ') || 'Preserve the lead performer with continuity.'}`,
    `Action: ${shot?.action || scene?.description || 'Advance the scene visually.'}`,
    `Composition: ${shot?.shotType || camera?.shotType || 'medium-shot'}. ${shot?.composition || 'Compose the frame for clear dramatic readability.'}`,
    `Camera positioning and motion: ${shot?.cameraAngle || camera?.tiltAngle || 'eye-level'} angle, ${shot?.focalLength || camera?.focalLength || 50}mm lens, ${camera?.aspectRatio || '16:9'} aspect ratio.`,
    `Ambiance: ${scene?.lighting || 'cinematic neutral'}, ${scene?.description || 'no scene description provided'}. Atmospheric continuity notes: ${scene?.atmosphereNotes || 'Keep the environmental mood cohesive and dynamic.'}`,
    `Continuity: ${shot?.continuityNotes || 'Preserve wardrobe, facial identity, blocking, and environmental continuity.'}`,
    continuityReference?.url
      ? `Continuity bridge frame: Use the supplied ${continuityReference.sourceLabel || 'transition frame'} as the handoff image before introducing new motion in this beat.`
      : 'Continuity bridge frame: No dedicated bridge frame is supplied for this beat, so maintain continuity through subject identity, blocking, and the remaining references only.',
    dialogueExcerpt
      ? `Dialogue and audio: Deliver this spoken beat naturally with synchronized production audio and ambience: "${dialogueExcerpt}"`
      : 'Dialogue and audio: Use environmental sound design, room tone, and subtle performance audio without on-screen subtitles.',
    'Do not include subtitles or any visible text in frame.',
  ].join('\n');
};

// In-memory registry to simulate Veo video rendering pipeline status for local dev fallback
const mockOperations = new Map<string, {
  createdAt: number;
  prompt: string;
  aspectRatio: '16:9' | '9:16';
  durationSeconds: number;
  userId?: string | null;
}>();

app.post('/api/upload-reference', (req, res) => {
  upload.single('file')(req, res, (error: any) => {
    if (error) {
      return res.status(400).json({ error: error.message || 'Reference upload failed.' });
    }

    const file = (req as any).file as Express.Multer.File | undefined;
    if (!file) {
      return res.status(400).json({ error: 'No image file was uploaded.' });
    }

    const kind = typeof req.body?.kind === 'string' ? req.body.kind : 'character-upload';
    const label = typeof req.body?.label === 'string' ? req.body.label : undefined;

    return res.json({
      asset: createStoredAsset(file, kind, label),
    });
  });
});

app.post('/api/generate-storyboard', requireAuth, requireCsrf, async (req, res) => {
  const { scene, characters, camera } = req.body || {};
  const fallbackShots = buildLocalStoryboard(scene, Array.isArray(characters) ? characters : [], camera);

  try {
    if (!scene) {
      return res.status(400).json({ error: 'Scene data is required to plan a storyboard.' });
    }

    const { ai } = getGenerationContextForRequest(req);
    if (!ai) {
      throw new Error('No live Gemini provider configured. Falling back to local storyboard planning.');
    }

    const desiredShotCount = Math.max(1, Math.min(fallbackShots.length || 1, 8));
    const dialogueContext = (Array.isArray(scene?.dialogues) ? scene.dialogues : [])
      .map((dialogue: any, index: number) => {
        const speaker = characters?.find((character: any) => character.id === dialogue.characterId)?.name || 'Unknown Actor';
        return `${index + 1}. [${dialogue.id}] ${speaker} (${dialogue.sentiment}): ${dialogue.text}`;
      })
      .join('\n') || 'No dialogue yet. Plan a visual storyboard from the scene description and atmosphere only.';

    const prompt = `You are planning a professional film storyboard for an AI movie pipeline with Veo 3.1 limitations.

Scene title: ${scene?.title || 'Untitled Scene'}
Scene description: ${scene?.description || 'No description provided'}
Lighting: ${scene?.lighting || 'No lighting specified'}
Atmosphere notes: ${scene?.atmosphereNotes || 'No atmosphere notes provided'}
Global camera profile: ${camera?.shotType || 'medium-shot'}, ${camera?.focalLength || 50}mm, ${camera?.tiltAngle || 'eye-level'}, ${camera?.aspectRatio || '16:9'}.
Desired storyboard shot count: ${desiredShotCount}

Dialogue timeline:
${dialogueContext}

Break the scene into professional storyboard shots that preserve continuity and prevent dialogue compression. Each shot should represent a playable cinematic beat, not a whole scene summary. Prefer 8-second shots when dialogue or reference-image continuity is important. Keep dialogueLineIds aligned to the provided IDs when possible.`;

    const response = await ai.models.generateContent({
      model: 'gemini-3.5-flash',
      contents: prompt,
      config: {
        systemInstruction: 'You are a world-class film storyboard artist and previsualization director. Return only valid JSON matching the provided schema. Build practical, shot-level boards for AI video generation with continuity in mind.',
        responseMimeType: 'application/json',
        responseSchema: {
          type: Type.OBJECT,
          properties: {
            shots: {
              type: Type.ARRAY,
              items: {
                type: Type.OBJECT,
                properties: {
                  title: { type: Type.STRING },
                  shotType: { type: Type.STRING },
                  durationSeconds: { type: Type.INTEGER },
                  focalLength: { type: Type.INTEGER },
                  cameraAngle: { type: Type.STRING },
                  composition: { type: Type.STRING },
                  action: { type: Type.STRING },
                  dialogueLineIds: {
                    type: Type.ARRAY,
                    items: { type: Type.STRING },
                  },
                  dialogueExcerpt: { type: Type.STRING },
                  continuityNotes: { type: Type.STRING },
                },
                required: ['title', 'shotType', 'durationSeconds', 'composition', 'action', 'dialogueLineIds', 'continuityNotes'],
              },
            },
          },
          required: ['shots'],
        },
      },
    });

    const responseText = response.text;
    if (!responseText) {
      throw new Error('No storyboard response received from Gemini.');
    }

    const parsed = JSON.parse(responseText.trim());
    return res.json({
      shots: Array.isArray(parsed?.shots) && parsed.shots.length ? parsed.shots : fallbackShots,
    });
  } catch (error: any) {
    console.warn('[Storyboard Planner] Falling back to local shot planning:', error?.message || error);
    return res.json({ shots: fallbackShots, fallback: true, isQuotaExhausted: isQuotaExhaustedError(error) });
  }
});

app.post('/api/generate-shot-prompt', generationRateLimiter, requireAuth, requireCsrf, async (req, res) => {
  const { characters = [], scene, shot, camera } = req.body || {};
  if (!scene || !shot) {
    return res.status(400).json({ error: 'Scene and shot data are required to generate a film prompt.' });
  }

  const { ai } = getGenerationContextForRequest(req);
  const prompt = await generateCinematicPrompt(ai, {
    characters,
    scene,
    shot,
    camera,
  });

  return res.json({ prompt });
});

app.post('/api/generate-shot-video', generationRateLimiter, requireAuth, requireCsrf, async (req, res) => {
  let userId: string | null = null;
  let providerMode: GenerationProviderMode = 'sandbox';

  try {
    const generationContext = getGenerationContextForRequest(req);
    userId = generationContext.userId;
    providerMode = generationContext.access.provider.mode;
    const { ai, access } = generationContext;
    const { characters = [], scene, shot, camera, resolvedSeed } = req.body || {};

    if (!scene || !shot) {
      return res.status(400).json({ error: 'Scene and shot data are required to render a storyboard clip.' });
    }

    assertVideoGenerationAllowed(userId);

    const { referenceUrls, continuityReference } = pickReferenceUrlsForShot(characters, scene, shot);
    const referenceImages = await buildReferenceImages(referenceUrls);
    const usingReferenceImages = referenceImages.length > 0;
    const durationSeconds = usingReferenceImages ? 8 : ([4, 6, 8].includes(Number(shot?.durationSeconds)) ? Number(shot.durationSeconds) : 6);
    const videoPrompt = buildShotPrompt(characters, scene, shot, camera, continuityReference);
    const aspect = camera?.aspectRatio === '9:16' ? '9:16' : '16:9';
    const seedResolution = resolveStoryboardSeedForShot(scene, shot, resolvedSeed);

    if (!ai) {
      throw new Error('No live Gemini provider configured. Emulating storyboard shot rendering pipeline.');
    }

    const operation = await ai.models.generateVideos({
      model: 'veo-3.1-generate-preview',
      prompt: videoPrompt,
      config: {
        numberOfVideos: 1,
        resolution: '720p',
        aspectRatio: aspect,
        durationSeconds,
        seed: seedResolution.resolvedSeed,
        negativePrompt: STORYBOARD_NEGATIVE_PROMPT,
        ...(usingReferenceImages
          ? {
              personGeneration: 'allow_adult',
              referenceImages,
            }
          : {}),
      }
    });

    recordVideoOperation(userId, {
      operationName: operation.name,
      model: 'veo-3.1-generate-preview',
      providerMode,
      countsTowardDailyLimit: providerMode === 'personal' || (providerMode === 'workspace' && access.provider.dailyVideoLimit !== null),
    });

    return res.json({
      operationName: operation.name,
      isFallback: false,
      usingReferenceImages,
      durationSeconds,
      resolvedSeed: seedResolution.resolvedSeed,
      seedSource: seedResolution.seedSource,
      usingContinuityFrame: !!continuityReference?.url,
      continuitySource: continuityReference?.sourceLabel || null,
      providerMode,
    });
  } catch (error: any) {
    if (error?.message?.includes('Daily video generation quota reached')) {
      return res.status(429).json({ error: error.message, isQuotaExceeded: true, providerMode });
    }

    const isQuotaExhausted = isQuotaExhaustedError(error);
    if (isQuotaExhausted) {
      console.log('[Veo Storyboard Emulator] Active 429 quota exhaustion fallback for storyboard shot render.');
    } else {
      console.log(`[Veo Storyboard Emulator] Falling back to storyboard shot pre-visualization: ${error?.message || 'Standard sandbox build.'}`);
    }

    const seedResolution = resolveStoryboardSeedForShot(req.body?.scene, req.body?.shot, req.body?.resolvedSeed);
    const requestedDurationSeconds = normalizeMockVideoDuration(req.body?.shot?.durationSeconds, 6);
    const requestedAspectRatio = normalizeMockVideoAspectRatio(req.body?.camera?.aspectRatio);
    const mockId = startMockVideoOperation(
      req.body?.shot?.action || req.body?.scene?.description || 'Storyboard Shot',
      {
        aspectRatio: requestedAspectRatio,
        durationSeconds: requestedDurationSeconds,
        userId,
      },
    );
    if (userId) {
      recordVideoOperation(userId, {
        operationName: mockId,
        model: 'veo-3.1-generate-preview',
        providerMode: 'sandbox',
        countsTowardDailyLimit: false,
      });
    }
    const continuityReference = resolveContinuityReferenceForShot(req.body?.scene, req.body?.shot);
    return res.json({
      operationName: mockId,
      isFallback: true,
      isQuotaExhausted,
      usingReferenceImages: false,
      durationSeconds: requestedDurationSeconds,
      resolvedSeed: seedResolution.resolvedSeed,
      seedSource: seedResolution.seedSource,
      usingContinuityFrame: !!continuityReference?.url,
      continuitySource: continuityReference?.sourceLabel || null,
      providerMode: 'sandbox',
    });
  }
});

function isSafeFilmId(value: string) {
  return /^[a-f0-9-]{36}$/i.test(value);
}

async function downloadOperationToTempFile(operationName: string, userId: string) {
  ensureOperationOwnership(userId, operationName);

  if (operationName.startsWith('mock-operation-')) {
    const mockOp = mockOperations.get(operationName);
    if (!mockOp || (mockOp.userId && mockOp.userId !== userId)) {
      throw new Error(`Could not access clip source: ${operationName}`);
    }
    return ensureMockVideoAsset({
      cacheDir: MOCK_VIDEOS_DIR,
      operationName,
      aspectRatio: mockOp?.aspectRatio,
      durationSeconds: mockOp?.durationSeconds,
    });
  }

  const operationApiKey = getOperationApiKeyForUser(userId, operationName);
  const ai = getAiClientForApiKey(operationApiKey);
  if (!ai || !operationApiKey) {
    throw new Error(`Could not download clip source: ${operationName}`);
  }

  const op = new GenerateVideosOperation();
  op.name = operationName;
  const updated = await ai.operations.getVideosOperation({ operation: op });
  const uri = updated.response?.generatedVideos?.[0]?.video?.uri;
  if (!uri) {
    throw new Error(`Could not download clip source: ${operationName}`);
  }

  const response = await fetch(uri, {
    headers: { 'x-goog-api-key': operationApiKey },
  });
  if (!response.ok) {
    throw new Error(`Could not download clip source: ${operationName}`);
  }

  const tempFilePath = path.join(getTempClipsDirectory(), `${uuidv4()}.mp4`);
  const arrayBuffer = await response.arrayBuffer();
  await fs.promises.writeFile(tempFilePath, Buffer.from(arrayBuffer));
  return tempFilePath;
}

async function safeRemoveTempFile(filePath: string | null | undefined) {
  if (!filePath) {
    return;
  }

  const resolved = path.resolve(filePath);
  const tempRoot = path.resolve(getTempClipsDirectory());
  if (resolved === tempRoot || !resolved.startsWith(`${tempRoot}${path.sep}`)) {
    return;
  }

  if (fs.existsSync(resolved)) {
    await fs.promises.rm(resolved, { force: true });
  }
}

app.post('/api/extend-clip', generationRateLimiter, requireAuth, requireCsrf, async (req, res) => {
  let userId: string | null = null;
  let providerMode: GenerationProviderMode = 'sandbox';

  try {
    const generationContext = getGenerationContextForRequest(req);
    userId = generationContext.userId;
    providerMode = generationContext.access.provider.mode;
    const { ai, access } = generationContext;
    const { prompt, videoToExtend, firstFrame, aspectRatio = '16:9', durationSeconds = 8, seed, referenceImages = [] } = req.body || {};
    const normalizedDurationSeconds = normalizeMockVideoDuration(durationSeconds, 8);
    const normalizedAspectRatio = normalizeMockVideoAspectRatio(aspectRatio);

    if (!prompt || !videoToExtend) {
      return res.status(400).json({ error: 'prompt and videoToExtend are required.' });
    }

    assertVideoGenerationAllowed(userId);

    if (!ai) {
      const mockId = startMockVideoOperation(prompt, {
        aspectRatio: normalizedAspectRatio,
        durationSeconds: normalizedDurationSeconds,
        userId,
      });
      recordVideoOperation(userId, {
        operationName: mockId,
        model: 'veo-3.1-generate-preview',
        providerMode: 'sandbox',
        countsTowardDailyLimit: false,
      });
      return res.json({
        operationName: mockId,
        isFallback: true,
        usingContinuityFrame: !!firstFrame,
        durationSeconds: normalizedDurationSeconds,
        providerMode: 'sandbox',
      });
    }

    const operation = await (ai.models as any).generateVideos({
      model: 'veo-3.1-generate-preview',
      prompt,
      config: {
        numberOfVideos: 1,
        resolution: '720p',
        aspectRatio: normalizedAspectRatio,
        durationSeconds: normalizedDurationSeconds,
        ...(seed ? { seed } : {}),
        video_to_extend: videoToExtend,
        ...(firstFrame ? { first_frame: firstFrame } : {}),
        ...(referenceImages.length ? { reference_images: referenceImages } : {}),
      },
    });

    recordVideoOperation(userId, {
      operationName: operation.name,
      model: 'veo-3.1-generate-preview',
      providerMode,
      countsTowardDailyLimit: providerMode === 'personal' || (providerMode === 'workspace' && access.provider.dailyVideoLimit !== null),
    });

    return res.json({
      operationName: operation.name,
      usingContinuityFrame: !!firstFrame,
      isFallback: false,
      durationSeconds: normalizedDurationSeconds,
      providerMode,
    });
  } catch (error: any) {
    if (error?.message?.includes('Daily video generation quota reached')) {
      return res.status(429).json({ error: error.message, isQuotaExceeded: true, providerMode });
    }

    const normalizedDurationSeconds = normalizeMockVideoDuration(req.body?.durationSeconds, 8);
    const mockId = startMockVideoOperation(req.body?.prompt || 'Extended Clip', {
      aspectRatio: normalizeMockVideoAspectRatio(req.body?.aspectRatio),
      durationSeconds: normalizedDurationSeconds,
      userId,
    });
    if (userId) {
      recordVideoOperation(userId, {
        operationName: mockId,
        model: 'veo-3.1-generate-preview',
        providerMode: 'sandbox',
        countsTowardDailyLimit: false,
      });
    }
    return res.json({
      operationName: mockId,
      isFallback: true,
      usingContinuityFrame: !!req.body?.firstFrame,
      durationSeconds: normalizedDurationSeconds,
      error: error?.message || 'Extension fallback enabled.',
      providerMode: 'sandbox',
    });
  }
});

app.post('/api/extract-frame', fileOperationRateLimiter, requireAuth, requireCsrf, async (req, res) => {
  let localClipPath: string | null = null;
  let extractedFramePath: string | null = null;

  try {
    const userId = getAuthenticatedUserId(req);
    const { operationName, label } = req.body || {};
    const sourcePath = operationName
      ? await downloadOperationToTempFile(operationName, userId)
      : null;

    if (!sourcePath) {
      return res.status(400).json({ error: 'operationName is required.' });
    }

    localClipPath = sourcePath;
    extractedFramePath = await extractLastFrame(localClipPath, path.join(getTempClipsDirectory(), `${uuidv4()}.png`));
    const buffer = await fs.promises.readFile(extractedFramePath);
    const uploaded = await saveBufferAsUpload(buffer, 'image/png', { label, scope: `users/${userId}` });

    return res.json({
      asset: {
        id: `asset-${uuidv4()}`,
        kind: 'storyboard-frame',
        origin: 'generated',
        label: label || 'Extracted bridge frame',
        url: uploaded.url,
        mimeType: 'image/png',
        createdAt: new Date().toISOString(),
      },
    });
  } catch (error: any) {
    console.error('Frame extraction failed:', error);
    return res.status(500).json({ error: error?.message || 'Could not extract a bridge frame.' });
  } finally {
    await safeRemoveTempFile(extractedFramePath);
    await safeRemoveTempFile(localClipPath);
  }
});

app.post('/api/assemble-film', fileOperationRateLimiter, requireAuth, requireCsrf, async (req, res) => {
  const userId = getAuthenticatedUserId(req);
  const filmId = uuidv4();
  const body = (req.body || {}) as AssembleFilmRequest;
  const clips = Array.isArray(body.clips) ? body.clips : [];

  if (clips.length < 1) {
    return res.status(400).json({ error: 'At least one clip is required to assemble a film.' });
  }

  filmAssemblyJobs.set(filmId, {
    filmId,
    clipCount: clips.length,
    status: 'processing',
  });
  filmAssemblyOwners.set(filmId, userId);

  const tempFiles: string[] = [];

  try {
    const normalizedClips: Array<ChainedClip & { filePath: string }> = [];

    for (const clip of clips) {
      const filePath = clip.operationName
        ? await downloadOperationToTempFile(clip.operationName, userId)
        : null;
      if (!filePath) {
        throw new Error(`Clip ${clip.title || clip.shotId} is missing a file source.`);
      }
      if (filePath.includes(`${path.sep}temp-clips${path.sep}`)) {
        tempFiles.push(filePath);
      }
      normalizedClips.push({
        ...clip,
        durationSeconds: normalizeMockVideoDuration(clip.durationSeconds, 8),
        filePath,
      });
    }

    const assembled = await assembleFilm(normalizedClips, FILMS_DIR, filmId);
    const job: FilmAssemblyJob = {
      filmId,
      clipCount: clips.length,
      status: 'completed',
      outputPath: assembled.outputPath,
      downloadUrl: `/api/download-film/${filmId}`,
    };
    filmAssemblyJobs.set(filmId, job);
    await cleanupTempClips();
    return res.json(job);
  } catch (error: any) {
    console.error('Film assembly failed:', error);
    filmAssemblyJobs.set(filmId, {
      filmId,
      clipCount: clips.length,
      status: 'failed',
      error: error?.message || 'Film assembly failed.',
    });
    return res.status(500).json({ error: error?.message || 'Film assembly failed.' });
  } finally {
    await Promise.all(tempFiles.map((file) => safeRemoveTempFile(file)));
  }
});

app.get('/api/download-film/:filmId', fileOperationRateLimiter, requireAuth, async (req, res) => {
  const userId = getAuthenticatedUserId(req);
  const filmId = req.params.filmId;
  if (!isSafeFilmId(filmId)) {
    return res.status(400).json({ error: 'Invalid film id.' });
  }
  if (filmAssemblyOwners.get(filmId) !== userId) {
    return res.status(403).json({ error: 'This film export does not belong to the current account.' });
  }
  const job = filmAssemblyJobs.get(filmId);
  if (!job?.outputPath) {
    return res.status(404).json({ error: 'Film export not found.' });
  }
  const fileName = `${job.filmId}.mp4`;
  const outputPath = path.join(FILMS_DIR, fileName);
  if (!fs.existsSync(outputPath)) {
    return res.status(404).json({ error: 'Film export not found.' });
  }

  return res.sendFile(fileName, {
    root: FILMS_DIR,
    headers: {
      'Content-Type': 'video/mp4',
    },
  });
});

const VEO_AESTHETIC_MAP: Record<string, string> = {
  'cinematic-actor': 'Cinematic actor style rendering. Real lifelike human character styling, rich skin micro-textures, complex lifelike dynamic facial expressions (smiling/focus/thought), highly realistic soft hair physics simulation.',
  'historical-figure': 'Detailed historical aesthetic period-specific character styling. Accurately matching garment textures, heavy draped wool apparel garments, worked leather plates, intricate vintage ornaments, high-contrast period portrait drama.',
  'cyberpunk-human': 'Futuristic cyberpunk human styling. High-tech organic-mechanic integration including flush glowing cybernetic pathways on natural skin, matte-plastic protective tactical goggles, cyber-sensors, and chrome metallic limbs reflecting ambient neon color casting.',
  'stylized-3d': 'Stylized 3D Animation character rendering. Intentionally exaggerated expressive facial proportions, smooth sub-surface scattering skin textures, large glowing luminescent eyes, and clean vibrant fabrics inspired by contemporary digital animation studios.',
  'video-game-cg': 'High-fidelity cinematic video game engine trailer render (Unreal Engine fidelity). Gritty textured armor and clothing surfaces, micro-scopic dust on skin pore elements, dynamic wind-blown hair, and high-contrast dramatic key-lighting.',
  'cute-chibi': 'Cute collectible Chibi Vinyl aesthetic. Smooth stylized proportions, glossy shiny vinyl toy finish, flawless plastic reflections mimicking collector designer figurines or pop toy statues.',
  'anime-manga': 'Elegant modern Japanese anime hand-drawn cel-shaded rendering style. Strong dark clean character line-art boundaries, vibrant high-saturation tinted hair, smooth flat shadow zones, fluid athletic animation vectors.',
  'retro-comic': 'Retro graphic comic book page print. Dense cross-hatch ink shadows, bold outline strokes, retro CMYK halftone color screening patterns, moving like a living printed comic strip page.',
  'pencil-sketch': 'Hand-drawn graphite pencil sketch. Organic charcoal textured overlays, cross-hatched lines on real coarse sketch paper with delightful procedural outline jitter between keyframes.',
  'claymation': 'Tactile clay stop-motion character design. Sculpted colorful modeling clay skin-surfaces showing microscopic thumbprints, hand-craft creases, paired with stylized staggered traditional stop-motion physics.',
  'felt-puppet': 'Indie felt needle-woven soft puppet setting. Fuzzy material texture skin with stray fibers capturing dramatic rim lighting, cozy crafted stop-motion tactile warmth.',
  'wooden-figurine': 'Rigid origami folded paper or detailed carved wood figurine structure. Organic carved wood grain lines, segmented moving joints, restricted artistic mechanical articulation paths.',
  'mythological-beast': 'Mythological humanoid beast hybrid. Merges complex human facial expressiveness with animalistic textures (coarse fur follicles, colored feathers, iridescent polished scales) for a mythic creature character.',
  'sentient-object': 'Expressive sentient object mascot. Everyday organic items or rigid objects engineered with fluid physical materials, blending glass/ceramic surfaces with soft cartoon organic face muscles.'
};

// 1. POST /api/generate-video - Start Veo video generation
app.post('/api/generate-video', generationRateLimiter, requireAuth, requireCsrf, async (req, res) => {
  let userId: string | null = null;
  let providerMode: GenerationProviderMode = 'sandbox';

  try {
    const generationContext = getGenerationContextForRequest(req);
    userId = generationContext.userId;
    providerMode = generationContext.access.provider.mode;
    const { ai, access } = generationContext;
    const { characters, scenes, camera } = req.body || {};
    const firstScene = scenes?.[0];
    const videoPrompt = buildQuickPreviewPrompt(Array.isArray(characters) ? characters : [], firstScene, camera);

    let aspect: '16:9' | '9:16' = '16:9';
    if (camera?.aspectRatio === '9:16') {
      aspect = '9:16';
    }

    assertVideoGenerationAllowed(userId);

    if (!ai) {
      throw new Error('No live Gemini provider configured. Emulating Veo Sandbox rendering pipeline.');
    }

    console.log(`[Veo Video Engine] Triggering request with prompt: "${videoPrompt.substring(0, 110)}..."`);
    const operation = await ai.models.generateVideos({
      model: 'veo-3.1-lite-generate-preview',
      prompt: videoPrompt,
      config: {
        numberOfVideos: 1,
        resolution: '720p',
        aspectRatio: aspect
      }
    });

    recordVideoOperation(userId, {
      operationName: operation.name,
      model: 'veo-3.1-lite-generate-preview',
      providerMode,
      countsTowardDailyLimit: providerMode === 'personal' || (providerMode === 'workspace' && access.provider.dailyVideoLimit !== null),
    });

    return res.json({ operationName: operation.name, isFallback: false, providerMode });
  } catch (error: any) {
    if (error?.message?.includes('Daily video generation quota reached')) {
      return res.status(429).json({ error: error.message, isQuotaExceeded: true, providerMode });
    }

    const isQuotaExhausted = isQuotaExhaustedError(error);
                             
    // Graceful fallback to sandbox pre-visualization without printing standard error warnings to console
    if (isQuotaExhausted) {
      console.log("[Veo Video Emulator] Active 429 quota exhaustion fallback. Returning simulated pre-visualization.");
    } else {
      console.log(`[Veo Video Emulator] Generating high-quality storyboard pre-visualization fallback: ${error?.message || 'Standard sandbox build.'}`);
    }

    const mockId = startMockVideoOperation(req.body?.scenes?.[0]?.description || 'Storyboard Concept', {
      aspectRatio: normalizeMockVideoAspectRatio(req.body?.camera?.aspectRatio),
      durationSeconds: 8,
      userId,
    });
    if (userId) {
      recordVideoOperation(userId, {
        operationName: mockId,
        model: 'veo-3.1-lite-generate-preview',
        providerMode: 'sandbox',
        countsTowardDailyLimit: false,
      });
    }
    return res.json({ operationName: mockId, isFallback: true, isQuotaExhausted, providerMode: 'sandbox' });
  }
});

// 2. POST /api/video-status - Poll video generation
app.post('/api/video-status', requireAuth, requireCsrf, async (req, res) => {
  try {
    const userId = getAuthenticatedUserId(req);
    const { operationName } = req.body || {};
    if (!operationName) {
      return res.status(400).json({ error: "Missing operation name identifier." });
    }

    ensureOperationOwnership(userId, operationName);

    if (operationName.startsWith('mock-operation-')) {
      const mockOp = mockOperations.get(operationName);
      if (!mockOp || (mockOp.userId && mockOp.userId !== userId)) {
        return res.json({ done: true, error: "Mock operation expired or key mismatch." });
      }
      // Simulate rendering duration of 6 seconds for rich visual feedback of compilation steps
      const elapsed = Date.now() - mockOp.createdAt;
      const progress = Math.min(Math.floor((elapsed / 6000) * 100), 100);
      const isDone = elapsed >= 6000;
      return res.json({ 
        done: isDone, 
        progress,
        status: isDone ? "Finished" : `Compiling story frames (${progress}%)` 
      });
    }

    const operationApiKey = getOperationApiKeyForUser(userId, operationName);
    const ai = getAiClientForApiKey(operationApiKey);
    if (!ai) {
      throw new Error('The live provider required for this render operation is no longer available.');
    }
    const op = new GenerateVideosOperation();
    op.name = operationName;
    const updated = await ai.operations.getVideosOperation({ operation: op });

    return res.json({ done: !!updated.done, response: updated.response });
  } catch (error: any) {
    console.error("Polling error, returning finished with error state for fallback:", error);
    return res.json({ done: true, error: error.message });
  }
});

// 3. GET/POST /api/video-download - Streaming video download proxy
app.all('/api/video-download', requireAuth, async (req, res) => {
  try {
    const userId = getAuthenticatedUserId(req);
    const operationName = (req.body?.operationName || req.query?.operationName) as string;
    if (!operationName) {
      return res.status(400).json({ error: "Operation name parameter is required." });
    }

    ensureOperationOwnership(userId, operationName);

    if (operationName.startsWith('mock-operation-')) {
      const mockOp = mockOperations.get(operationName);
      if (!mockOp || (mockOp.userId && mockOp.userId !== userId)) {
        return res.status(403).json({ error: 'This render operation does not belong to the current account.' });
      }
      const mockVideoPath = await ensureMockVideoAsset({
        cacheDir: MOCK_VIDEOS_DIR,
        operationName,
        aspectRatio: mockOp?.aspectRatio,
        durationSeconds: mockOp?.durationSeconds,
      });

      return res.sendFile(mockVideoPath);
    }

    const operationApiKey = getOperationApiKeyForUser(userId, operationName);
    const ai = getAiClientForApiKey(operationApiKey);
    if (!ai || !operationApiKey) {
      return res.status(404).json({ error: 'The live provider required for this render operation is no longer available.' });
    }
    const op = new GenerateVideosOperation();
    op.name = operationName;
    const updated = await ai.operations.getVideosOperation({ operation: op });

    const uri = updated.response?.generatedVideos?.[0]?.video?.uri;
    if (!uri) {
      return res.status(404).json({ error: "Generated video URI coordinates not resolved in completed operation." });
    }

    console.log(`[Veo Video engine] Accessing completed storage bucket at ${uri}`);
    const videoRes = await fetch(uri, {
      headers: { 'x-goog-api-key': operationApiKey },
    });

    if (!videoRes.ok) {
      return res.status(502).json({ error: 'Generated video storage download failed.' });
    }

    res.setHeader('Content-Type', 'video/mp4');
    if (videoRes.body) {
      const reader = videoRes.body.getReader();
      while (true) {
        const { done, value } = await reader.read();
         if (done) break;
        res.write(value);
      }
      return res.end();
    } else {
      return res.status(500).json({ error: "Failed to read binary video stream from remote cloud storage bucket." });
    }
  } catch (error: any) {
    console.error("Video proxy download failed:", error);
    return res.status(500).json({ error: "Failed to download and stream videography concept asset.", details: error.message });
  }
});

// Get persisted screenplay state from the authenticated user store
app.get('/api/load-sandbox-state', requireAuth, (req, res) => {
  try {
    const userId = getAuthenticatedUserId(req);
    return res.json(loadProjectStateForUser(userId));
  } catch (error: any) {
    console.error("[State DB] Failed to read state file:", error);
    return res.json({ error: error.message });
  }
});

// Save persisted screenplay state to the authenticated user store
app.post('/api/save-sandbox-state', requireAuth, requireCsrf, (req, res) => {
  try {
    const userId = getAuthenticatedUserId(req);
    const { characters, scenes, camera, exportSettings, updatedAt } = req.body || {};
    saveProjectStateForUser(userId, { characters, scenes, camera, exportSettings, updatedAt });
    return res.json({ success: true, timestamp: Date.now() });
  } catch (error: any) {
    console.error("[State DB] Failed to save state file:", error);
    return res.status(500).json({ error: "Failed to persist screenplay state on server." });
  }
});

// Setup Vite & Static Files according to env
async function setupServer() {
  if (process.env.NODE_ENV !== 'production') {
    const vite = await createViteServer({
      server: { middlewareMode: true },
      appType: 'spa'
    });
    app.use(vite.middlewares);
  } else {
    const distPath = path.join(process.cwd(), 'dist');
    app.use(express.static(distPath));
    app.get('*', (req, res) => {
      res.sendFile(path.join(distPath, 'index.html'));
    });
  }

  app.listen(PORT, '0.0.0.0', () => {
    console.log(`[StoryForge Dev] Server listening at http://localhost:${PORT}`);
  });
}

if (process.env.NODE_ENV !== 'test') {
  setupServer();
}

export { app };
