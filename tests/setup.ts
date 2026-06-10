import fs from 'fs';
import path from 'path';
import { vi } from 'vitest';
import { __resetAuthStoreForTests } from '../src/lib/authStore';

const ffmpegState = {
  setPath: '',
  commands: [] as any[],
};

function createFfmpegCommand(initialInput?: string) {
  const state = {
    inputs: initialInput ? [initialInput] : [],
    inputOptions: [] as string[],
    outputOptions: [] as string[],
    filterComplex: '' as string | string[],
    savedTo: '',
    events: {} as Record<string, (...args: any[]) => void>,
  };

  const command = {
    input(value: string) {
      state.inputs.push(value);
      return command;
    },
    inputOptions(value: string[]) {
      state.inputOptions = value;
      return command;
    },
    outputOptions(value: string[]) {
      state.outputOptions = value;
      return command;
    },
    complexFilter(value: string | string[]) {
      state.filterComplex = value;
      return command;
    },
    on(event: string, handler: (...args: any[]) => void) {
      state.events[event] = handler;
      return command;
    },
    save(destination: string) {
      state.savedTo = destination;
      fs.mkdirSync(path.dirname(destination), { recursive: true });
      fs.writeFileSync(destination, Buffer.from('mock-media'));
      queueMicrotask(() => state.events.end?.());
      return command;
    },
  };

  ffmpegState.commands.push(state);
  return command;
}

const ffmpegMock = Object.assign(
  (input?: string) => createFfmpegCommand(input),
  {
    setFfmpegPath: (value: string) => {
      ffmpegState.setPath = value;
    },
    __state: ffmpegState,
  },
);

const genaiState = {
  generateContentImpl: vi.fn(async () => ({ text: 'mock cinematic prompt' })),
  generateVideosImpl: vi.fn(async () => ({ name: 'mock-operation-1' })),
  getVideosOperationImpl: vi.fn(async () => ({ done: true, response: { generatedVideos: [{ video: { uri: 'https://example.com/mock.mp4' } }] } })),
};

const googleAuthState = vi.hoisted(() => ({
  generateAuthUrlImpl: vi.fn((options: any) => `https://accounts.google.test/o/oauth2/v2/auth?state=${encodeURIComponent(options.state || '')}`),
  getTokenImpl: vi.fn(async () => ({
    tokens: {
      id_token: 'mock-google-id-token',
    },
  })),
  verifyIdTokenImpl: vi.fn(async () => ({
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

vi.mock('fluent-ffmpeg', () => ({
  default: ffmpegMock,
}));

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

(globalThis as any).__ffmpegState = ffmpegState;
(globalThis as any).__genaiState = genaiState;
(globalThis as any).__googleAuthState = googleAuthState;

beforeEach(() => {
  __resetAuthStoreForTests();
  ffmpegState.commands.length = 0;
  ffmpegState.setPath = '';
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
