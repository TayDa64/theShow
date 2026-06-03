export interface PollUntilCompleteOptions {
  maxRetries?: number;
  intervalMs?: number;
  signal?: AbortSignal;
  onUpdate?: (attempt: number, result: any) => void;
}

function wait(ms: number, signal?: AbortSignal) {
  return new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => {
      cleanup();
      resolve();
    }, ms);

    const onAbort = () => {
      cleanup();
      reject(new Error('Polling cancelled.'));
    };

    const cleanup = () => {
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
    };

    if (signal) {
      signal.addEventListener('abort', onAbort, { once: true });
    }
  });
}

export async function pollUntilComplete<T extends { done?: boolean }>(poller: () => Promise<T>, options: PollUntilCompleteOptions = {}) {
  const maxRetries = options.maxRetries ?? 150;
  const intervalMs = options.intervalMs ?? 2000;

  for (let attempt = 1; attempt <= maxRetries; attempt += 1) {
    if (options.signal?.aborted) {
      throw new Error('Polling cancelled.');
    }

    const result = await poller();
    options.onUpdate?.(attempt, result);

    if (result.done) {
      return result;
    }

    if (attempt === maxRetries) {
      throw new Error(`Polling timed out after ${maxRetries} attempts.`);
    }

    await wait(intervalMs, options.signal);
  }

  throw new Error(`Polling timed out after ${maxRetries} attempts.`);
}

export interface ClipChainRequest {
  prompt: string;
  first_frame?: string | null;
  reference_images?: string[];
}

export async function buildClipChain<T extends { video_to_extend?: string | null }>(
  requests: ClipChainRequest[],
  executor: (request: ClipChainRequest & { video_to_extend?: string | null }, index: number) => Promise<T>,
) {
  const results: T[] = [];
  let previousClip: string | null = null;

  for (let index = 0; index < requests.length; index += 1) {
    const request = requests[index];
    const result = await executor({
      ...request,
      ...(previousClip ? { video_to_extend: previousClip } : {}),
    }, index);
    results.push(result);
    previousClip = result.video_to_extend || previousClip;
  }

  return results;
}
