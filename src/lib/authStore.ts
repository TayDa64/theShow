import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import type { NextFunction, Request, Response } from 'express';
import { CodeChallengeMethod, OAuth2Client } from 'google-auth-library';
import { generateSecret, generateURI, verifySync } from 'otplib';
import QRCode from 'qrcode';
import { v4 as uuidv4 } from 'uuid';
import type {
  AuthAuditEvent,
  AuthIdentitySummary,
  AuthSessionSummary,
  AuthStatus,
  TwoFactorChallenge,
  TwoFactorSetup,
  AuthUser,
  GenerationProviderMode,
  ProviderConnectionSummary,
} from '../types';

type StoredProjectState = {
  characters?: unknown;
  scenes?: unknown;
  camera?: unknown;
  exportSettings?: unknown;
  updatedAt?: string;
};

type StoredUser = {
  id: string;
  email: string;
  name: string;
  passwordHash: string | null;
  passwordSalt: string | null;
  googleSub?: string | null;
  avatarUrl?: string | null;
  twoFactorEnabled?: boolean;
  twoFactorSecretEncrypted?: string | null;
  pendingTwoFactorSecretEncrypted?: string | null;
  createdAt: string;
  updatedAt: string;
};

type StoredSession = {
  id: string;
  userId: string;
  csrfToken: string;
  createdAt: string;
  lastSeenAt: string;
  expiresAt: string;
  userAgent: string | null;
  ipHash: string | null;
  revokedAt?: string | null;
};

type StoredProviderConnection = {
  id: string;
  userId: string;
  type: 'gemini-api-key';
  label: string;
  encryptedApiKey: string;
  maskedApiKey: string;
  dailyVideoLimit: number | null;
  connectedAt: string;
  disconnectedAt?: string | null;
};

type StoredUsageEvent = {
  id: string;
  userId: string;
  type: 'video-operation';
  providerMode: GenerationProviderMode;
  model: string;
  operationName: string;
  createdAt: string;
  countsTowardDailyLimit: boolean;
};

type StoredAuditEvent = {
  id: string;
  userId: string;
  type: string;
  detail: string;
  createdAt: string;
};

type StoredOauthState = {
  id: string;
  state: string;
  codeVerifier: string;
  mode: 'login' | 'link';
  userId?: string | null;
  createdAt: string;
  expiresAt: string;
};

type StoredTwoFactorChallenge = {
  id: string;
  userId: string;
  createdAt: string;
  expiresAt: string;
  userAgent: string | null;
  ipHash: string | null;
};

type AuthStoreShape = {
  users: StoredUser[];
  sessions: StoredSession[];
  providers: StoredProviderConnection[];
  usageEvents: StoredUsageEvent[];
  auditEvents: StoredAuditEvent[];
  oauthStates: StoredOauthState[];
  twoFactorChallenges: StoredTwoFactorChallenge[];
};

type ProjectStoreShape = {
  projects: Record<string, StoredProjectState>;
};

export type RequestAuthContext = {
  user: AuthUser;
  session: StoredSession;
};

export type AuthenticatedRequest = Request & {
  auth?: RequestAuthContext | null;
};

export type UserConnectionInput = {
  apiKey: string;
  label?: string;
  dailyVideoLimit?: number | null;
};

export type VideoGenerationAccess = {
  apiKey: string | null;
  provider: ProviderConnectionSummary;
};

const DATA_DIR = path.join(process.cwd(), '.storyforge');
const AUTH_STORE_PATH = path.join(DATA_DIR, 'auth-store.json');
const PROJECT_STORE_PATH = path.join(DATA_DIR, 'project-states.json');
const LEGACY_STATE_FILE_PATH = path.join(process.cwd(), 'sandbox-state.json');
const SESSION_COOKIE_NAME = 'storyforge_session';
const SESSION_TTL_MS = 1000 * 60 * 60 * 24 * 30;
const SESSION_TOUCH_THRESHOLD_MS = 1000 * 30;
const OAUTH_STATE_TTL_MS = 1000 * 60 * 10;
const TWO_FACTOR_CHALLENGE_TTL_MS = 1000 * 60 * 10;
const DEFAULT_PERSONAL_VIDEO_DAILY_LIMIT = 3;
const MAX_AUDIT_EVENTS_PER_USER = 24;
const MAX_USAGE_EVENTS_PER_USER = 64;
const TWO_FACTOR_ISSUER = 'StoryForge Studio';

let warnedAboutFallbackEncryptionKey = false;

function ensureDataDir() {
  fs.mkdirSync(DATA_DIR, { recursive: true });
}

function readJsonFile<T>(filePath: string, fallback: T): T {
  ensureDataDir();

  if (!fs.existsSync(filePath)) {
    return fallback;
  }

  try {
    const raw = fs.readFileSync(filePath, 'utf-8');
    return JSON.parse(raw) as T;
  } catch {
    return fallback;
  }
}

function writeJsonFile(filePath: string, data: unknown) {
  ensureDataDir();
  fs.writeFileSync(filePath, JSON.stringify(data, null, 2), 'utf-8');
}

const authStore: AuthStoreShape = readJsonFile<AuthStoreShape>(AUTH_STORE_PATH, {
  users: [],
  sessions: [],
  providers: [],
  usageEvents: [],
  auditEvents: [],
  oauthStates: [],
  twoFactorChallenges: [],
});

const projectStore: ProjectStoreShape = readJsonFile<ProjectStoreShape>(PROJECT_STORE_PATH, {
  projects: {},
});

export function __resetAuthStoreForTests() {
  authStore.users = [];
  authStore.sessions = [];
  authStore.providers = [];
  authStore.usageEvents = [];
  authStore.auditEvents = [];
  authStore.oauthStates = [];
  authStore.twoFactorChallenges = [];
  projectStore.projects = {};
  persistAuthStore();
  persistProjectStore();
}

function persistAuthStore() {
  writeJsonFile(AUTH_STORE_PATH, authStore);
}

function persistProjectStore() {
  writeJsonFile(PROJECT_STORE_PATH, projectStore);
}

function normalizeEmail(value: string) {
  return value.trim().toLowerCase();
}

function trimName(value: string) {
  return value.trim().replace(/\s+/g, ' ').slice(0, 120);
}

function parsePositiveInt(value: unknown, fallback: number | null = null) {
  if (value === null || value === undefined || value === '') {
    return fallback;
  }

  const parsed = typeof value === 'number' ? value : Number(String(value).trim());
  if (!Number.isFinite(parsed) || parsed <= 0) {
    return fallback;
  }

  return Math.min(Math.round(parsed), 365);
}

function getNowIso() {
  return new Date().toISOString();
}

function getGoogleOidcConfig() {
  const clientId = process.env.GOOGLE_OIDC_CLIENT_ID?.trim() || '';
  const clientSecret = process.env.GOOGLE_OIDC_CLIENT_SECRET?.trim() || '';
  const redirectUri = process.env.GOOGLE_OIDC_REDIRECT_URI?.trim() || 'http://localhost:3000/api/auth/google/callback';

  if (!clientId || !clientSecret) {
    return null;
  }

  return {
    clientId,
    clientSecret,
    redirectUri,
  };
}

function isGoogleOidcConfigured() {
  return !!getGoogleOidcConfig();
}

function createGoogleOAuthClient() {
  const config = getGoogleOidcConfig();
  if (!config) {
    throw new Error('Google OAuth is not configured. Set GOOGLE_OIDC_CLIENT_ID and GOOGLE_OIDC_CLIENT_SECRET.');
  }

  return new OAuth2Client(config.clientId, config.clientSecret, config.redirectUri);
}

function encodeBase64Url(input: Buffer) {
  return input.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
}

function sha256Base64Url(value: string) {
  return encodeBase64Url(crypto.createHash('sha256').update(value).digest());
}

function buildCodeVerifier() {
  return encodeBase64Url(crypto.randomBytes(32));
}

function maskEmail(value: string) {
  const [name, domain] = value.split('@');
  if (!name || !domain) {
    return value;
  }

  return `${name.slice(0, 2)}•••@${domain}`;
}

function samePacificDay(leftIso: string, rightIso: string) {
  const left = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'America/Los_Angeles',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(new Date(leftIso));
  const right = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'America/Los_Angeles',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(new Date(rightIso));

  return left === right;
}

function getWorkspaceApiKey() {
  return process.env.GEMINI_API_KEY?.trim() || null;
}

function getWorkspaceVideoDailyLimit() {
  return parsePositiveInt(process.env.WORKSPACE_VIDEO_DAILY_LIMIT, null);
}

function getEncryptionSecretMaterial() {
  const material = process.env.STORYFORGE_ENCRYPTION_KEY || process.env.SESSION_SECRET;
  if (material) {
    return material;
  }

  if (!warnedAboutFallbackEncryptionKey) {
    warnedAboutFallbackEncryptionKey = true;
    console.warn('[Auth Store] STORYFORGE_ENCRYPTION_KEY is not set. Falling back to a local-development secret. Set STORYFORGE_ENCRYPTION_KEY in production.');
  }

  return 'storyforge-local-dev-encryption-secret';
}

function getEncryptionKey() {
  return crypto.createHash('sha256').update(getEncryptionSecretMaterial()).digest();
}

function encryptSecret(value: string) {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', getEncryptionKey(), iv);
  const encrypted = Buffer.concat([cipher.update(value, 'utf8'), cipher.final()]);
  const authTag = cipher.getAuthTag();
  return `${iv.toString('base64')}.${authTag.toString('base64')}.${encrypted.toString('base64')}`;
}

function decryptSecret(payload: string) {
  const [ivBase64, authTagBase64, encryptedBase64] = payload.split('.');
  if (!ivBase64 || !authTagBase64 || !encryptedBase64) {
    throw new Error('Encrypted secret payload is invalid.');
  }

  const decipher = crypto.createDecipheriv(
    'aes-256-gcm',
    getEncryptionKey(),
    Buffer.from(ivBase64, 'base64'),
  );
  decipher.setAuthTag(Buffer.from(authTagBase64, 'base64'));
  const decrypted = Buffer.concat([
    decipher.update(Buffer.from(encryptedBase64, 'base64')),
    decipher.final(),
  ]);
  return decrypted.toString('utf8');
}

function hashPassword(password: string, salt = crypto.randomBytes(16).toString('hex')) {
  const hash = crypto.scryptSync(password, salt, 64).toString('hex');
  return { salt, hash };
}

function verifyPassword(password: string, storedUser: StoredUser) {
  if (!storedUser.passwordHash || !storedUser.passwordSalt) {
    return false;
  }
  const candidateHash = crypto.scryptSync(password, storedUser.passwordSalt, 64);
  const actualHash = Buffer.from(storedUser.passwordHash, 'hex');
  return candidateHash.length === actualHash.length && crypto.timingSafeEqual(candidateHash, actualHash);
}

function maskApiKey(value: string) {
  if (value.length <= 8) {
    return `${value.slice(0, 2)}••••`;
  }

  return `${value.slice(0, 4)}••••${value.slice(-4)}`;
}

function hashIpAddress(ip: string | undefined) {
  if (!ip) return null;
  return crypto.createHash('sha256').update(ip).digest('hex');
}

function summarizeIpHash(ipHash: string | null | undefined) {
  if (!ipHash) return null;
  return `ip:${ipHash.slice(0, 8)}`;
}

function findUserByEmail(email: string) {
  return authStore.users.find((user) => user.email === normalizeEmail(email)) || null;
}

function findUserByGoogleSub(googleSub: string) {
  return authStore.users.find((user) => user.googleSub === googleSub) || null;
}

function findUserById(userId: string) {
  return authStore.users.find((user) => user.id === userId) || null;
}

function userHasPassword(user: StoredUser) {
  return !!(user.passwordHash && user.passwordSalt);
}

function sanitizeUser(user: StoredUser): AuthUser {
  return {
    id: user.id,
    name: user.name,
    email: user.email,
    createdAt: user.createdAt,
    avatarUrl: user.avatarUrl || null,
    hasPassword: userHasPassword(user),
    googleLinked: !!user.googleSub,
    twoFactorEnabled: !!user.twoFactorEnabled,
  };
}

function pruneSessions() {
  const now = Date.now();
  const nextSessions = authStore.sessions.filter((session) => {
    if (session.revokedAt) return false;
    return new Date(session.expiresAt).getTime() > now;
  });

  if (nextSessions.length !== authStore.sessions.length) {
    authStore.sessions = nextSessions;
    persistAuthStore();
  }
}

function pruneOauthStates() {
  const now = Date.now();
  const nextStates = authStore.oauthStates.filter((entry) => new Date(entry.expiresAt).getTime() > now);
  if (nextStates.length !== authStore.oauthStates.length) {
    authStore.oauthStates = nextStates;
    persistAuthStore();
  }
}

function pruneTwoFactorChallenges() {
  const now = Date.now();
  const nextChallenges = authStore.twoFactorChallenges.filter((challenge) => new Date(challenge.expiresAt).getTime() > now);
  if (nextChallenges.length !== authStore.twoFactorChallenges.length) {
    authStore.twoFactorChallenges = nextChallenges;
    persistAuthStore();
  }
}

function getActiveSessionsForUser(userId: string) {
  pruneSessions();
  return authStore.sessions.filter((session) => session.userId === userId && !session.revokedAt);
}

function createAuditEvent(userId: string, type: string, detail: string) {
  authStore.auditEvents.unshift({
    id: uuidv4(),
    userId,
    type,
    detail,
    createdAt: getNowIso(),
  });

  const perUserEvents = authStore.auditEvents.filter((event) => event.userId === userId);
  if (perUserEvents.length > MAX_AUDIT_EVENTS_PER_USER) {
    const allowedIds = new Set(perUserEvents.slice(0, MAX_AUDIT_EVENTS_PER_USER).map((event) => event.id));
    authStore.auditEvents = authStore.auditEvents.filter((event) => event.userId !== userId || allowedIds.has(event.id));
  }

  persistAuthStore();
}

function createSession(userId: string, metadata: { userAgent?: string; ip?: string }) {
  const now = Date.now();
  const createdAt = new Date(now).toISOString();
  const session: StoredSession = {
    id: uuidv4(),
    userId,
    csrfToken: crypto.randomBytes(24).toString('hex'),
    createdAt,
    lastSeenAt: createdAt,
    expiresAt: new Date(now + SESSION_TTL_MS).toISOString(),
    userAgent: metadata.userAgent?.slice(0, 240) || null,
    ipHash: hashIpAddress(metadata.ip),
    revokedAt: null,
  };

  authStore.sessions.unshift(session);
  persistAuthStore();
  return session;
}

function createOauthState(input: { mode: 'login' | 'link'; userId?: string | null }) {
  pruneOauthStates();
  const stateValue = encodeBase64Url(crypto.randomBytes(24));
  const now = Date.now();
  authStore.oauthStates.unshift({
    id: uuidv4(),
    state: stateValue,
    codeVerifier: buildCodeVerifier(),
    mode: input.mode,
    userId: input.userId || null,
    createdAt: new Date(now).toISOString(),
    expiresAt: new Date(now + OAUTH_STATE_TTL_MS).toISOString(),
  });
  persistAuthStore();
  return authStore.oauthStates[0];
}

function consumeOauthState(stateValue: string) {
  pruneOauthStates();
  const match = authStore.oauthStates.find((entry) => entry.state === stateValue) || null;
  if (!match) {
    return null;
  }

  authStore.oauthStates = authStore.oauthStates.filter((entry) => entry.id !== match.id);
  persistAuthStore();
  return match;
}

function createTwoFactorChallenge(userId: string, metadata: { userAgent?: string; ip?: string }) {
  pruneTwoFactorChallenges();
  authStore.twoFactorChallenges = authStore.twoFactorChallenges.filter((challenge) => challenge.userId !== userId);

  const now = Date.now();
  const challenge: StoredTwoFactorChallenge = {
    id: uuidv4(),
    userId,
    createdAt: new Date(now).toISOString(),
    expiresAt: new Date(now + TWO_FACTOR_CHALLENGE_TTL_MS).toISOString(),
    userAgent: metadata.userAgent?.slice(0, 240) || null,
    ipHash: hashIpAddress(metadata.ip),
  };

  authStore.twoFactorChallenges.unshift(challenge);
  persistAuthStore();
  return challenge;
}

function getTwoFactorChallengeById(challengeId: string) {
  pruneTwoFactorChallenges();
  return authStore.twoFactorChallenges.find((challenge) => challenge.id === challengeId) || null;
}

function consumeTwoFactorChallenge(challengeId: string) {
  const challenge = getTwoFactorChallengeById(challengeId);
  if (!challenge) {
    return null;
  }

  authStore.twoFactorChallenges = authStore.twoFactorChallenges.filter((entry) => entry.id !== challenge.id);
  persistAuthStore();
  return challenge;
}

function buildIdentitySummary(user: StoredUser | null): AuthIdentitySummary {
  return {
    googleOidcConfigured: isGoogleOidcConfigured(),
    googleLinked: !!user?.googleSub,
    passwordLoginEnabled: !!(user && userHasPassword(user)),
    twoFactorEnabled: !!user?.twoFactorEnabled,
  };
}

function summarizeTwoFactorChallenge(user: StoredUser, challenge: StoredTwoFactorChallenge): TwoFactorChallenge {
  return {
    challengeId: challenge.id,
    email: maskEmail(user.email),
    expiresAt: challenge.expiresAt,
  };
}

function setSessionCookie(res: Response, sessionId: string) {
  res.cookie(SESSION_COOKIE_NAME, sessionId, {
    httpOnly: true,
    secure: process.env.NODE_ENV === 'production',
    sameSite: 'lax',
    maxAge: SESSION_TTL_MS,
    path: '/',
  });
}

function clearSessionCookie(res: Response) {
  res.clearCookie(SESSION_COOKIE_NAME, {
    httpOnly: true,
    secure: process.env.NODE_ENV === 'production',
    sameSite: 'lax',
    path: '/',
  });
}

function parseCookieHeader(cookieHeader: string | undefined) {
  if (!cookieHeader) return {} as Record<string, string>;

  return cookieHeader.split(';').reduce<Record<string, string>>((accumulator, cookiePart) => {
    const [rawName, ...rawValue] = cookiePart.trim().split('=');
    if (!rawName) return accumulator;
    const joinedValue = rawValue.join('=');
    try {
      accumulator[rawName] = decodeURIComponent(joinedValue);
    } catch {
      accumulator[rawName] = joinedValue;
    }
    return accumulator;
  }, {});
}

function findSessionById(sessionId: string | undefined | null) {
  if (!sessionId) return null;
  pruneSessions();
  return authStore.sessions.find((session) => session.id === sessionId && !session.revokedAt) || null;
}

function maybeTouchSession(session: StoredSession) {
  const now = Date.now();
  const lastSeenAt = new Date(session.lastSeenAt).getTime();
  if (now - lastSeenAt < SESSION_TOUCH_THRESHOLD_MS) {
    return;
  }

  session.lastSeenAt = new Date(now).toISOString();
  persistAuthStore();
}

function getActiveProviderRecord(userId: string) {
  return authStore.providers.find((provider) => provider.userId === userId && !provider.disconnectedAt) || null;
}

function getVideoUsageCount(userId: string, providerMode: GenerationProviderMode) {
  const nowIso = getNowIso();
  return authStore.usageEvents.filter((event) => (
    event.userId === userId
    && event.providerMode === providerMode
    && event.countsTowardDailyLimit
    && samePacificDay(event.createdAt, nowIso)
  )).length;
}

function buildGuestProviderSummary(): ProviderConnectionSummary {
  const workspaceKey = getWorkspaceApiKey();
  const workspaceLimit = getWorkspaceVideoDailyLimit();

  if (workspaceKey) {
    return {
      mode: 'workspace',
      status: 'connected',
      providerType: 'workspace-key',
      label: 'Workspace Gemini API access',
      maskedApiKey: maskApiKey(workspaceKey),
      connectedAt: null,
      dailyVideoLimit: workspaceLimit,
      usedToday: 0,
      remainingToday: workspaceLimit,
      liveVideoEnabled: true,
      sandboxFallbackEnabled: true,
      note: 'A workspace Gemini API key is configured. Sign in to use it securely from this app.',
    };
  }

  return {
    mode: 'sandbox',
    status: 'disconnected',
    providerType: 'sandbox',
    label: 'Sandbox fallback only',
    maskedApiKey: null,
    connectedAt: null,
    dailyVideoLimit: null,
    usedToday: 0,
    remainingToday: null,
    liveVideoEnabled: false,
    sandboxFallbackEnabled: true,
    note: 'No live Gemini provider is configured yet. After sign-in, you can connect a personal Gemini API key or keep using sandbox fallbacks.',
  };
}

function buildProviderSummaryForUser(userId: string): ProviderConnectionSummary {
  const activeProvider = getActiveProviderRecord(userId);
  if (activeProvider) {
    const dailyVideoLimit = activeProvider.dailyVideoLimit ?? DEFAULT_PERSONAL_VIDEO_DAILY_LIMIT;
    const usedToday = getVideoUsageCount(userId, 'personal');
    return {
      mode: 'personal',
      status: 'connected',
      providerType: 'gemini-api-key',
      label: activeProvider.label,
      maskedApiKey: activeProvider.maskedApiKey,
      connectedAt: activeProvider.connectedAt,
      dailyVideoLimit,
      usedToday,
      remainingToday: Math.max(dailyVideoLimit - usedToday, 0),
      liveVideoEnabled: true,
      sandboxFallbackEnabled: true,
      note: 'Personal Gemini API access is active for this account and overrides the shared workspace provider.',
    };
  }

  const workspaceKey = getWorkspaceApiKey();
  if (workspaceKey) {
    const workspaceLimit = getWorkspaceVideoDailyLimit();
    const usedToday = getVideoUsageCount(userId, 'workspace');
    return {
      mode: 'workspace',
      status: 'connected',
      providerType: 'workspace-key',
      label: 'Workspace Gemini API access',
      maskedApiKey: maskApiKey(workspaceKey),
      connectedAt: null,
      dailyVideoLimit: workspaceLimit,
      usedToday,
      remainingToday: workspaceLimit === null ? null : Math.max(workspaceLimit - usedToday, 0),
      liveVideoEnabled: true,
      sandboxFallbackEnabled: true,
      note: 'This account is currently using the shared workspace Gemini API key.',
    };
  }

  return {
    mode: 'sandbox',
    status: 'disconnected',
    providerType: 'sandbox',
    label: 'Sandbox fallback only',
    maskedApiKey: null,
    connectedAt: null,
    dailyVideoLimit: null,
    usedToday: 0,
    remainingToday: null,
    liveVideoEnabled: false,
    sandboxFallbackEnabled: true,
    note: 'No live Gemini API key is active for this account. Video routes can still fall back to local sandbox/mock generation.',
  };
}

function buildSessionSummaries(userId: string, currentSessionId: string | null): AuthSessionSummary[] {
  return getActiveSessionsForUser(userId)
    .slice(0, 8)
    .map((session) => ({
      id: session.id,
      createdAt: session.createdAt,
      lastSeenAt: session.lastSeenAt,
      expiresAt: session.expiresAt,
      isCurrent: session.id === currentSessionId,
      userAgent: session.userAgent,
      ipPreview: summarizeIpHash(session.ipHash),
    }));
}

function buildAuditEvents(userId: string): AuthAuditEvent[] {
  return authStore.auditEvents
    .filter((event) => event.userId === userId)
    .slice(0, 8)
    .map((event) => ({
      id: event.id,
      type: event.type,
      detail: event.detail,
      createdAt: event.createdAt,
    }));
}

function buildCapabilities(isAuthenticated: boolean, providerSummary: ProviderConnectionSummary) {
  return {
    cloudSync: isAuthenticated,
    aiTools: isAuthenticated,
    liveVideo: isAuthenticated && providerSummary.liveVideoEnabled,
    sandboxFallback: isAuthenticated && providerSummary.sandboxFallbackEnabled,
    googleOidc: isGoogleOidcConfigured(),
    localTwoFactor: isAuthenticated,
  };
}

export function buildAuthStatus(user: AuthUser | null, session: StoredSession | null): AuthStatus {
  const storedUser = user ? findUserById(user.id) : null;
  const resolvedUser = storedUser ? sanitizeUser(storedUser) : user;
  const provider = resolvedUser ? buildProviderSummaryForUser(resolvedUser.id) : buildGuestProviderSummary();
  return {
    isAuthenticated: !!resolvedUser,
    user: resolvedUser,
    csrfToken: session?.csrfToken || null,
    provider,
    sessions: resolvedUser ? buildSessionSummaries(resolvedUser.id, session?.id || null) : [],
    auditEvents: resolvedUser ? buildAuditEvents(resolvedUser.id) : [],
    capabilities: buildCapabilities(!!resolvedUser, provider),
    identity: buildIdentitySummary(storedUser),
  };
}

function normalizeGoogleIdentityPayload(payload: Record<string, unknown>) {
  const email = typeof payload.email === 'string' ? normalizeEmail(payload.email) : '';
  const sub = typeof payload.sub === 'string' ? payload.sub : '';
  const name = trimName(typeof payload.name === 'string' ? payload.name : (email.split('@')[0] || 'Google User'));
  const picture = typeof payload.picture === 'string' ? payload.picture : null;
  const emailVerified = payload.email_verified === true;

  if (!sub || !email || !emailVerified) {
    throw new Error('Google did not return a verified email address for this account.');
  }

  return {
    sub,
    email,
    name: name || email.split('@')[0] || 'Google User',
    picture,
  };
}

function syncUserProfileFromGoogle(user: StoredUser, profile: ReturnType<typeof normalizeGoogleIdentityPayload>) {
  user.googleSub = profile.sub;
  user.email = profile.email;
  user.name = profile.name || user.name;
  user.avatarUrl = profile.picture;
  user.updatedAt = getNowIso();
}

function createGoogleUser(profile: ReturnType<typeof normalizeGoogleIdentityPayload>) {
  const now = getNowIso();
  const user: StoredUser = {
    id: uuidv4(),
    email: profile.email,
    name: profile.name,
    passwordHash: null,
    passwordSalt: null,
    googleSub: profile.sub,
    avatarUrl: profile.picture,
    twoFactorEnabled: false,
    twoFactorSecretEncrypted: null,
    pendingTwoFactorSecretEncrypted: null,
    createdAt: now,
    updatedAt: now,
  };

  authStore.users.unshift(user);
  persistAuthStore();
  createAuditEvent(user.id, 'account.created.google', 'Created a StoryForge account with Google sign-in.');
  return user;
}

export function getGoogleAuthenticationUrl(input: { mode: 'login' | 'link'; userId?: string | null }) {
  const config = getGoogleOidcConfig();
  if (!config) {
    throw new Error('Google OAuth is not configured for this workspace.');
  }

  const client = createGoogleOAuthClient();
  const oauthState = createOauthState({
    mode: input.mode,
    userId: input.userId || null,
  });

  return client.generateAuthUrl({
    access_type: 'offline',
    prompt: input.mode === 'login' ? 'select_account' : 'consent',
    scope: ['openid', 'email', 'profile'],
    state: oauthState.state,
    code_challenge: sha256Base64Url(oauthState.codeVerifier),
    code_challenge_method: CodeChallengeMethod.S256,
  });
}

export async function completeGoogleAuthentication(input: {
  state: string;
  code: string;
  metadata: { userAgent?: string; ip?: string };
}) {
  const config = getGoogleOidcConfig();
  if (!config) {
    throw new Error('Google OAuth is not configured for this workspace.');
  }

  const oauthState = consumeOauthState(input.state);
  if (!oauthState) {
    throw new Error('The Google sign-in request is invalid or has expired. Please try again.');
  }

  const client = createGoogleOAuthClient();
  const tokenResponse = await client.getToken({
    code: input.code,
    codeVerifier: oauthState.codeVerifier,
    redirect_uri: config.redirectUri,
  });
  const idToken = tokenResponse.tokens.id_token;
  if (!idToken) {
    throw new Error('Google did not return an ID token for this login.');
  }

  const ticket = await client.verifyIdToken({
    idToken,
    audience: config.clientId,
  });
  const payload = ticket.getPayload();
  if (!payload) {
    throw new Error('Google did not return a usable identity payload.');
  }
  const profile = normalizeGoogleIdentityPayload(payload as unknown as Record<string, unknown>);

  let user = findUserByGoogleSub(profile.sub);
  if (oauthState.mode === 'link') {
    if (!oauthState.userId) {
      throw new Error('A signed-in account is required to link Google.');
    }

    user = findUserById(oauthState.userId);
    if (!user) {
      throw new Error('The account to link could not be found.');
    }

    const existingGoogleUser = findUserByGoogleSub(profile.sub);
    if (existingGoogleUser && existingGoogleUser.id !== user.id) {
      throw new Error('That Google account is already linked to a different StoryForge account.');
    }

    syncUserProfileFromGoogle(user, profile);
    persistAuthStore();
    createAuditEvent(user.id, 'account.google.linked', 'Linked Google sign-in to the current account.');
  } else if (!user) {
    const existingEmailUser = findUserByEmail(profile.email);
    if (existingEmailUser) {
      const existingGoogleUser = findUserByGoogleSub(profile.sub);
      if (existingGoogleUser && existingGoogleUser.id !== existingEmailUser.id) {
        throw new Error('That Google account is already linked to another StoryForge account.');
      }

      syncUserProfileFromGoogle(existingEmailUser, profile);
      persistAuthStore();
      createAuditEvent(existingEmailUser.id, 'account.google.linked', 'Linked Google sign-in to an existing account.');
      user = existingEmailUser;
    } else {
      user = createGoogleUser(profile);
    }
  } else {
    syncUserProfileFromGoogle(user, profile);
    persistAuthStore();
  }

  const session = createSession(user.id, input.metadata);
  createAuditEvent(user.id, 'account.login.google', 'Signed in with Google OIDC.');

  return {
    user: sanitizeUser(user),
    session,
    mode: oauthState.mode,
  };
}

export function disconnectGoogleIdentity(userId: string) {
  const user = findUserById(userId);
  if (!user) {
    throw new Error('Account could not be found.');
  }
  if (!user.googleSub) {
    throw new Error('No Google sign-in is currently linked to this account.');
  }
  if (!userHasPassword(user)) {
    throw new Error('Add a password login before unlinking Google so the account does not lose its only sign-in method.');
  }

  user.googleSub = null;
  user.updatedAt = getNowIso();
  persistAuthStore();
  createAuditEvent(user.id, 'account.google.unlinked', 'Removed Google sign-in from the account.');
}

function getPendingTwoFactorSecret(user: StoredUser) {
  if (!user.pendingTwoFactorSecretEncrypted) {
    return null;
  }

  return decryptSecret(user.pendingTwoFactorSecretEncrypted);
}

function getActiveTwoFactorSecret(user: StoredUser) {
  if (!user.twoFactorSecretEncrypted) {
    return null;
  }

  return decryptSecret(user.twoFactorSecretEncrypted);
}

function normalizeTotpToken(value: string) {
  return value.replace(/\s+/g, '').trim();
}

function verifyTotpToken(secret: string, token: string) {
  return verifySync({
    secret,
    token: normalizeTotpToken(token),
    epochTolerance: 30,
  }).valid;
}

export async function beginTwoFactorSetup(userId: string): Promise<TwoFactorSetup> {
  const user = findUserById(userId);
  if (!user) {
    throw new Error('Account could not be found.');
  }
  if (!userHasPassword(user)) {
    throw new Error('Two-factor authentication is only available for local password sign-in.');
  }

  const secret = generateSecret();
  const otpAuthUrl = generateURI({
    issuer: TWO_FACTOR_ISSUER,
    label: user.email,
    secret,
  });
  const qrCodeDataUrl = await QRCode.toDataURL(otpAuthUrl);

  user.pendingTwoFactorSecretEncrypted = encryptSecret(secret);
  user.updatedAt = getNowIso();
  persistAuthStore();

  return {
    issuer: TWO_FACTOR_ISSUER,
    accountName: user.email,
    manualEntryKey: secret,
    otpAuthUrl,
    qrCodeDataUrl,
  };
}

export function confirmTwoFactorSetup(userId: string, token: string) {
  const user = findUserById(userId);
  if (!user) {
    throw new Error('Account could not be found.');
  }

  const pendingSecret = getPendingTwoFactorSecret(user);
  if (!pendingSecret) {
    throw new Error('Start 2FA setup before confirming it.');
  }
  if (!verifyTotpToken(pendingSecret, token)) {
    throw new Error('The 2FA code was invalid. Check your authenticator app and try again.');
  }

  user.twoFactorEnabled = true;
  user.twoFactorSecretEncrypted = encryptSecret(pendingSecret);
  user.pendingTwoFactorSecretEncrypted = null;
  user.updatedAt = getNowIso();
  persistAuthStore();
  createAuditEvent(user.id, 'account.2fa.enabled', 'Enabled TOTP-based two-factor authentication.');

  return sanitizeUser(user);
}

export function disableTwoFactor(userId: string, token: string) {
  const user = findUserById(userId);
  if (!user) {
    throw new Error('Account could not be found.');
  }

  const secret = getActiveTwoFactorSecret(user);
  if (!secret || !user.twoFactorEnabled) {
    throw new Error('Two-factor authentication is not enabled on this account.');
  }
  if (!verifyTotpToken(secret, token)) {
    throw new Error('The 2FA code was invalid. Check your authenticator app and try again.');
  }

  user.twoFactorEnabled = false;
  user.twoFactorSecretEncrypted = null;
  user.pendingTwoFactorSecretEncrypted = null;
  user.updatedAt = getNowIso();
  persistAuthStore();
  createAuditEvent(user.id, 'account.2fa.disabled', 'Disabled TOTP-based two-factor authentication.');

  return sanitizeUser(user);
}

export function registerUser(input: { name: string; email: string; password: string }, metadata: { userAgent?: string; ip?: string }) {
  const name = trimName(input.name);
  const email = normalizeEmail(input.email);
  const password = input.password || '';

  if (!name) {
    throw new Error('Name is required.');
  }
  if (!/^\S+@\S+\.\S+$/.test(email)) {
    throw new Error('A valid email address is required.');
  }
  if (password.length < 8) {
    throw new Error('Password must be at least 8 characters long.');
  }
  if (findUserByEmail(email)) {
    throw new Error('An account with that email already exists.');
  }

  const now = getNowIso();
  const { salt, hash } = hashPassword(password);
  const user: StoredUser = {
    id: uuidv4(),
    name,
    email,
    passwordHash: hash,
    passwordSalt: salt,
    googleSub: null,
    avatarUrl: null,
    twoFactorEnabled: false,
    twoFactorSecretEncrypted: null,
    pendingTwoFactorSecretEncrypted: null,
    createdAt: now,
    updatedAt: now,
  };

  authStore.users.unshift(user);
  persistAuthStore();
  createAuditEvent(user.id, 'account.created', 'Created a new StoryForge account.');

  const session = createSession(user.id, metadata);
  createAuditEvent(user.id, 'account.login', 'Signed in after account creation.');

  return {
    user: sanitizeUser(user),
    session,
  };
}

export function authenticateUser(input: { email: string; password: string }, metadata: { userAgent?: string; ip?: string }) {
  const email = normalizeEmail(input.email);
  const password = input.password || '';
  const user = findUserByEmail(email);
  if (!user) {
    throw new Error('Invalid email or password.');
  }
  if (!userHasPassword(user)) {
    throw new Error('This account uses Google sign-in. Continue with Google or link a password-based login first.');
  }
  if (!verifyPassword(password, user)) {
    throw new Error('Invalid email or password.');
  }

  if (user.twoFactorEnabled) {
    const challenge = createTwoFactorChallenge(user.id, metadata);
    createAuditEvent(user.id, 'account.login.password.challenge', 'Password verified. Waiting for a 2FA code.');
    return {
      user: sanitizeUser(user),
      session: null,
      twoFactorChallenge: summarizeTwoFactorChallenge(user, challenge),
    };
  }

  const session = createSession(user.id, metadata);
  createAuditEvent(user.id, 'account.login.password', 'Signed in to StoryForge with password authentication.');

  return {
    user: sanitizeUser(user),
    session,
    twoFactorChallenge: null,
  };
}

export function verifyTwoFactorChallenge(input: {
  challengeId: string;
  token: string;
  metadata: { userAgent?: string; ip?: string };
}) {
  const challenge = consumeTwoFactorChallenge(input.challengeId);
  if (!challenge) {
    throw new Error('The 2FA challenge has expired. Start sign-in again.');
  }

  if (challenge.ipHash && challenge.ipHash !== hashIpAddress(input.metadata.ip)) {
    throw new Error('The 2FA challenge must be completed from the same device.');
  }

  const user = findUserById(challenge.userId);
  if (!user) {
    throw new Error('The account for this 2FA challenge could not be found.');
  }

  const secret = getActiveTwoFactorSecret(user);
  if (!secret || !user.twoFactorEnabled) {
    throw new Error('Two-factor authentication is not enabled for this account.');
  }
  if (!verifyTotpToken(secret, input.token)) {
    throw new Error('The 2FA code was invalid. Check your authenticator app and try again.');
  }

  const session = createSession(user.id, input.metadata);
  createAuditEvent(user.id, 'account.login.password.2fa', 'Completed sign-in with password and 2FA.');

  return {
    user: sanitizeUser(user),
    session,
  };
}

export function logoutSession(sessionId: string | null | undefined) {
  if (!sessionId) return;

  const session = findSessionById(sessionId);
  if (!session) return;

  session.revokedAt = getNowIso();
  persistAuthStore();
  createAuditEvent(session.userId, 'account.logout', 'Signed out of StoryForge.');
}

export function revokeUserSession(userId: string, sessionId: string) {
  const session = findSessionById(sessionId);
  if (!session || session.userId !== userId) {
    throw new Error('Session could not be found.');
  }

  session.revokedAt = getNowIso();
  persistAuthStore();
  createAuditEvent(userId, 'session.revoked', 'Revoked an active session from the account dashboard.');
}

export function saveProjectStateForUser(userId: string, state: StoredProjectState) {
  projectStore.projects[userId] = {
    characters: state.characters ?? null,
    scenes: state.scenes ?? null,
    camera: state.camera ?? null,
    exportSettings: state.exportSettings ?? null,
    updatedAt: typeof state.updatedAt === 'string' ? state.updatedAt : getNowIso(),
  };
  persistProjectStore();
}

export function loadProjectStateForUser(userId: string): StoredProjectState {
  const existing = projectStore.projects[userId];
  if (existing) {
    return existing;
  }

  if (fs.existsSync(LEGACY_STATE_FILE_PATH)) {
    try {
      const raw = fs.readFileSync(LEGACY_STATE_FILE_PATH, 'utf-8');
      const parsed = JSON.parse(raw);
      return {
        characters: parsed.characters ?? null,
        scenes: parsed.scenes ?? null,
        camera: parsed.camera ?? null,
        exportSettings: parsed.exportSettings ?? null,
        updatedAt: parsed.updatedAt || null,
      };
    } catch {
      return { characters: null, scenes: null, camera: null, exportSettings: null, updatedAt: null };
    }
  }

  return { characters: null, scenes: null, camera: null, exportSettings: null, updatedAt: null };
}

export function linkPersonalGeminiProvider(userId: string, input: UserConnectionInput) {
  const apiKey = input.apiKey.trim();
  if (!apiKey) {
    throw new Error('A Gemini API key is required.');
  }

  const label = trimName(input.label || 'Personal Gemini API key');
  const dailyVideoLimit = parsePositiveInt(input.dailyVideoLimit, DEFAULT_PERSONAL_VIDEO_DAILY_LIMIT);
  const currentProvider = getActiveProviderRecord(userId);
  if (currentProvider) {
    currentProvider.disconnectedAt = getNowIso();
  }

  authStore.providers.unshift({
    id: uuidv4(),
    userId,
    type: 'gemini-api-key',
    label: label || 'Personal Gemini API key',
    encryptedApiKey: encryptSecret(apiKey),
    maskedApiKey: maskApiKey(apiKey),
    dailyVideoLimit,
    connectedAt: getNowIso(),
    disconnectedAt: null,
  });

  persistAuthStore();
  createAuditEvent(userId, 'provider.connected', `Connected personal Gemini API access${label ? ` (${label})` : ''}.`);
}

export function disconnectPersonalGeminiProvider(userId: string) {
  const provider = getActiveProviderRecord(userId);
  if (!provider) {
    throw new Error('No personal Gemini provider is currently linked.');
  }

  provider.disconnectedAt = getNowIso();
  persistAuthStore();
  createAuditEvent(userId, 'provider.disconnected', 'Disconnected personal Gemini API access.');
}

export function getVideoGenerationAccessForUser(userId: string): VideoGenerationAccess {
  const provider = buildProviderSummaryForUser(userId);
  if (provider.mode === 'personal') {
    const personalProvider = getActiveProviderRecord(userId);
    return {
      apiKey: personalProvider ? decryptSecret(personalProvider.encryptedApiKey) : null,
      provider,
    };
  }

  if (provider.mode === 'workspace') {
    return {
      apiKey: getWorkspaceApiKey(),
      provider,
    };
  }

  return {
    apiKey: null,
    provider,
  };
}

export function assertVideoGenerationAllowed(userId: string) {
  const provider = buildProviderSummaryForUser(userId);
  if (provider.dailyVideoLimit !== null && provider.remainingToday !== null && provider.remainingToday <= 0) {
    throw new Error(`Daily video generation quota reached for ${provider.label}. Try again after midnight Pacific or switch providers.`);
  }
  return provider;
}

export function recordVideoOperation(userId: string, input: {
  operationName: string;
  model: string;
  providerMode: GenerationProviderMode;
  countsTowardDailyLimit: boolean;
}) {
  authStore.usageEvents.unshift({
    id: uuidv4(),
    userId,
    type: 'video-operation',
    providerMode: input.providerMode,
    model: input.model,
    operationName: input.operationName,
    createdAt: getNowIso(),
    countsTowardDailyLimit: input.countsTowardDailyLimit,
  });

  const perUserUsage = authStore.usageEvents.filter((event) => event.userId === userId);
  if (perUserUsage.length > MAX_USAGE_EVENTS_PER_USER) {
    const allowedIds = new Set(perUserUsage.slice(0, MAX_USAGE_EVENTS_PER_USER).map((event) => event.id));
    authStore.usageEvents = authStore.usageEvents.filter((event) => event.userId !== userId || allowedIds.has(event.id));
  }

  persistAuthStore();

  if (input.countsTowardDailyLimit) {
    createAuditEvent(userId, 'video.generated', `Started a ${input.model} render using ${input.providerMode} provider access.`);
  } else {
    createAuditEvent(userId, 'video.sandbox', `Started a sandbox/mock render flow (${input.model}).`);
  }
}

function findVideoOperationEvent(userId: string, operationName: string) {
  return authStore.usageEvents.find((event) => event.userId === userId && event.operationName === operationName) || null;
}

export function userOwnsOperation(userId: string, operationName: string) {
  return !!findVideoOperationEvent(userId, operationName);
}

export function getOperationApiKeyForUser(userId: string, operationName: string) {
  const event = findVideoOperationEvent(userId, operationName);
  if (!event) {
    throw new Error('That render operation does not belong to the current account.');
  }

  if (event.providerMode === 'workspace') {
    return getWorkspaceApiKey();
  }

  if (event.providerMode === 'personal') {
    const provider = getActiveProviderRecord(userId);
    return provider ? decryptSecret(provider.encryptedApiKey) : null;
  }

  return null;
}

export function getRequestUser(req: Request | AuthenticatedRequest) {
  return (req as AuthenticatedRequest).auth?.user || null;
}

export function getRequestUserId(req: Request | AuthenticatedRequest) {
  return getRequestUser(req)?.id || null;
}

export function attachAuthToRequest(req: Request, _res: Response, next: NextFunction) {
  const cookies = parseCookieHeader(req.headers.cookie);
  const session = findSessionById(cookies[SESSION_COOKIE_NAME]);
  if (!session) {
    (req as AuthenticatedRequest).auth = null;
    next();
    return;
  }

  const user = findUserById(session.userId);
  if (!user) {
    (req as AuthenticatedRequest).auth = null;
    next();
    return;
  }

  maybeTouchSession(session);
  (req as AuthenticatedRequest).auth = {
    user: sanitizeUser(user),
    session,
  };
  next();
}

export function requireAuth(req: Request, res: Response, next: NextFunction) {
  const auth = (req as AuthenticatedRequest).auth;
  if (!auth?.user) {
    res.status(401).json({ error: 'Sign in from the Account dashboard to use this feature securely.' });
    return;
  }

  next();
}

export function requireCsrf(req: Request, res: Response, next: NextFunction) {
  const method = req.method.toUpperCase();
  if (method === 'GET' || method === 'HEAD' || method === 'OPTIONS') {
    next();
    return;
  }

  const session = (req as AuthenticatedRequest).auth?.session;
  if (!session) {
    res.status(401).json({ error: 'Authentication is required.' });
    return;
  }

  const csrfToken = req.header('x-csrf-token');
  if (!csrfToken || csrfToken !== session.csrfToken) {
    res.status(403).json({ error: 'The request could not be verified. Refresh the page and try again.' });
    return;
  }

  next();
}

export function writeSessionToResponse(res: Response, sessionId: string) {
  setSessionCookie(res, sessionId);
}

export function clearSessionFromResponse(res: Response) {
  clearSessionCookie(res);
}

export function getAuthStatusForRequest(req: Request | AuthenticatedRequest) {
  const auth = (req as AuthenticatedRequest).auth;
  return buildAuthStatus(auth?.user || null, auth?.session || null);
}