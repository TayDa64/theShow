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

(globalThis as any).__ffmpegState = ffmpegState;
(globalThis as any).__genaiState = genaiState;

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
});
