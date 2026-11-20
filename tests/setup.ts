import { afterEach, beforeEach, vi } from 'vitest';
import { __resetAuthStoreForTests } from '../src/lib/authStore';

const realFetch = globalThis.fetch.bind(globalThis);
const netAttempts: string[] = [];

globalThis.fetch = (async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
  const raw = typeof input === 'string'
    ? input
    : input instanceof URL
      ? input.href
      : input.url;
  let parsed: URL | undefined;
  try {
    parsed = new URL(raw);
  } catch {
    parsed = undefined;
  }
  const host = parsed?.hostname;
  if (host === 'localhost' || host === '127.0.0.1' || host === '::1') {
    return realFetch(input, init);
  }
  if (parsed) {
    netAttempts.push(`${init?.method ?? 'GET'} ${parsed.href}`);
    throw new Error(`[net-guard] real network call blocked: ${parsed.href}`);
  }
  return realFetch(input, init);
}) as typeof fetch;

afterEach(() => {
  if (!process.env.GROK_AUTH_FILE) {
    process.env.GROK_AUTH_FILE = '/nonexistent/theshow-test-auth.json';
  }
  if (netAttempts.length === 0) return;
  const seen = netAttempts.splice(0, netAttempts.length);
  throw new Error(`[net-guard] ${seen.join(', ')}`);
});

const genaiState = {
  generateContentImpl: vi.fn(async (_args?: unknown) => ({ text: 'mock cinematic prompt' })),
  generateVideosImpl: vi.fn(async (_args?: unknown) => ({ name: 'mock-operation-1' })),
  getVideosOperationImpl: vi.fn(async (_args?: unknown) => ({ done: true, response: { generatedVideos: [{ video: { uri: 'https://example.com/mock.mp4' } }] } })),
};

const googleAuthState = vi.hoisted(() => ({
  generateAuthUrlImpl: vi.fn((options: any) => `https://accounts.google.test/o/oauth2/v2/auth?state=${encodeURIComponent(options.state || '')}`),
  getTokenImpl: vi.fn(async (_options?: unknown) => ({
    tokens: {
      id_token: 'mock-google-id-token',
    },
  })),
  verifyIdTokenImpl: vi.fn(async (_options?: unknown) => ({
    getPayload: () => ({
      sub: 'google-subject-1',
      email: 'google-user@example.com',
      email_verified: true,
      name: 'Google User',
      picture: 'https://example.com/google-user.png',
    }),
  })),
}));

class MockGoogleGenAI {
  config: any;

  constructor(config: any) {
    this.config = config;
  }

  models = {
    generateContent: (args: any) => genaiState.generateContentImpl(args),
    generateVideos: (args: any) => genaiState.generateVideosImpl(args),
  };

  operations = {
    getVideosOperation: (args: any) => genaiState.getVideosOperationImpl(args),
  };
}

class MockGenerateVideosOperation {
  name = '';
}

vi.mock('@google/genai', () => ({
  GoogleGenAI: MockGoogleGenAI,
  GenerateVideosOperation: MockGenerateVideosOperation,
  Type: {
    OBJECT: 'OBJECT',
    ARRAY: 'ARRAY',
    STRING: 'STRING',
    INTEGER: 'INTEGER',
  },
  VideoGenerationReferenceType: {
    ASSET: 'ASSET',
  },
}));

vi.mock('google-auth-library', () => ({
  OAuth2Client: class {
    clientId?: string;
    clientSecret?: string;
    redirectUri?: string;

    constructor(clientId?: string, clientSecret?: string, redirectUri?: string) {
      this.clientId = clientId;
      this.clientSecret = clientSecret;
      this.redirectUri = redirectUri;
    }

    generateAuthUrl(options: any) {
      return googleAuthState.generateAuthUrlImpl(options);
    }

    getToken(options: any) {
      return googleAuthState.getTokenImpl(options);
    }

    verifyIdToken(options: any) {
      return googleAuthState.verifyIdTokenImpl(options);
    }
  },
  CodeChallengeMethod: {
    S256: 'S256',
  },
}));

(globalThis as any).__genaiState = genaiState;
(globalThis as any).__googleAuthState = googleAuthState;

beforeEach(() => {
  __resetAuthStoreForTests();
  genaiState.generateContentImpl.mockClear();
  genaiState.generateContentImpl.mockResolvedValue({ text: 'mock cinematic prompt' });
  genaiState.generateVideosImpl.mockClear();
  genaiState.generateVideosImpl.mockResolvedValue({ name: 'mock-operation-1' });
  genaiState.getVideosOperationImpl.mockClear();
  genaiState.getVideosOperationImpl.mockResolvedValue({
    done: true,
    response: { generatedVideos: [{ video: { uri: 'https://example.com/mock.mp4' } }] },
  });
  googleAuthState.generateAuthUrlImpl.mockClear();
  googleAuthState.generateAuthUrlImpl.mockImplementation((options: any) => `https://accounts.google.test/o/oauth2/v2/auth?state=${encodeURIComponent(options.state || '')}`);
  googleAuthState.getTokenImpl.mockClear();
  googleAuthState.getTokenImpl.mockResolvedValue({
    tokens: {
      id_token: 'mock-google-id-token',
    },
  });
  googleAuthState.verifyIdTokenImpl.mockClear();
  googleAuthState.verifyIdTokenImpl.mockResolvedValue({
    getPayload: () => ({
      sub: 'google-subject-1',
      email: 'google-user@example.com',
      email_verified: true,
      name: 'Google User',
      picture: 'https://example.com/google-user.png',
    }),
  });
  delete process.env.GOOGLE_OIDC_CLIENT_ID;
  delete process.env.GOOGLE_OIDC_CLIENT_SECRET;
  delete process.env.GOOGLE_OIDC_REDIRECT_URI;
});
