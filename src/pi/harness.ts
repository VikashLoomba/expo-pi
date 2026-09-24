import {
  AgentHarness,
  BACKGROUND_CONTEXT,
  MemorySessionRepo,
  type AgentHarnessTool,
} from '@earendil-works/pi-agent-core';
import { Type, type Models } from '@earendil-works/pi-ai';
import { Platform } from 'react-native';
import { CODEX_PROVIDER_ID, MODEL_ID } from './codex-auth';

export const DEFAULT_PROMPT = 'Use add_numbers to add 19 and 23. Then tell me the result in a short sentence.';

export function runtimeCapabilities() {
  return {
    platform: Platform.OS,
    hermes: 'HermesInternal' in globalThis,
    fetch: typeof fetch === 'function',
    ReadableStream: typeof ReadableStream === 'function',
    TextEncoder: typeof TextEncoder === 'function',
    TextDecoder: typeof TextDecoder === 'function',
    AbortController: typeof AbortController === 'function',
    structuredClone: typeof structuredClone === 'function',
    BigInt: typeof BigInt === 'function',
    crypto: typeof globalThis.crypto !== 'undefined',
    getRandomValues: typeof globalThis.crypto?.getRandomValues === 'function',
  };
}

export interface RunProgress {
  status: string;
  text: string;
  events: string[];
  deltas: number;
  tools: number;
  toolResult?: string;
  error?: string;
}
export const emptyProgress = (): RunProgress => ({ status: 'Ready', text: '', events: [], deltas: 0, tools: 0 });

const parameters = Type.Object({ a: Type.Number(), b: Type.Number() });
const addNumbers: AgentHarnessTool<undefined, typeof parameters> = {
  name: 'add_numbers',
  label: 'Add numbers on device',
  description: 'Add two numbers locally on this device and report the sum and platform.',
  parameters,
  async execute(_id, { a, b }, _onUpdate, _toolContext, _invocation, context) {
    context.abortSignal?.throwIfAborted();
    const result = { sum: a + b, platform: Platform.OS, runtime: 'on-device' };
    return { content: [{ type: 'text', text: JSON.stringify(result) }], details: result };
  },
};

/** A fresh in-memory session per run keeps the compatibility check reproducible. */
export async function runHarness(options: {
  models: Models;
  prompt: string;
  signal: AbortSignal;
  onProgress: (progress: RunProgress) => void;
}): Promise<RunProgress> {
  const { signal, onProgress } = options;
  let progress = { ...emptyProgress(), status: 'Creating harness' };
  const publish = (patch: Partial<RunProgress>, event?: string) => {
    progress = { ...progress, ...patch, events: event ? [...progress.events, event].slice(-80) : progress.events };
    onProgress(progress);
  };
  publish({});
  signal.throwIfAborted();
  const { models } = options;
  if (!await models.checkAuth(CODEX_PROVIDER_ID)) throw new Error('Sign in with ChatGPT first.');
  const model = models.getModel(CODEX_PROVIDER_ID, MODEL_ID);
  if (!model) throw new Error(`Model ${MODEL_ID} is not in the pinned Pi catalog.`);
  const repo = new MemorySessionRepo();
  let harness: Awaited<ReturnType<typeof AgentHarness.create>>['harness'] | undefined;
  let removeAbort = () => {};
  const unsubscribe: (() => void)[] = [];
  try {
    const session = await repo.create({}, BACKGROUND_CONTEXT);
    ({ harness } = await AgentHarness.create({
      session, models, model, tools: [addNumbers], thinkingLevel: 'off',
      systemPrompt: 'You are a concise assistant. Use the provided tool when asked to add numbers.',
      // Pi's WebSocket constructor uses Node-style header options. Expo's native
      // streaming fetch supports the provider's SSE path directly.
      streamOptions: { transport: 'sse', maxRetries: 0, timeoutMs: 60000 },
      retry: { enabled: false, maxRetries: 0, baseDelayMs: 1000 },
    }, BACKGROUND_CONTEXT));
    const lane = await harness.lane('main', BACKGROUND_CONTEXT);
    unsubscribe.push(
      harness.events.on('message_update', ({ event }) => {
        if (event.type === 'text_delta') publish({ text: progress.text + event.delta, deltas: progress.deltas + 1 }, 'text_delta');
        else if (event.type === 'toolcall_delta') publish({}, 'toolcall_delta');
      }),
      harness.events.on('tool_start', ({ toolName }) => publish({ status: 'Running tool on device' }, `tool_start: ${toolName}`)),
      harness.events.on('tool_end', ({ result, isError }) => publish({
        tools: progress.tools + 1,
        toolResult: result.content.map((item) => item.type === 'text' ? item.text : '').join(''),
        ...(isError ? { error: 'Tool execution failed' } : {}),
      }, 'tool_end')),
      harness.events.on('turn_start', () => publish({ status: 'Streaming' }, 'turn_start')),
      harness.events.on('turn_end', () => publish({}, 'turn_end')),
      harness.events.on('run_end', ({ status }) => publish({}, `run_end: ${status}`)),
      harness.events.on('handler_error', ({ error }) => publish({ error }, 'handler_error')),
    );
    signal.throwIfAborted();
    const admission = await lane.accept({ kind: 'prompt', prompt: options.prompt }, BACKGROUND_CONTEXT);
    if (!admission.ok) throw admission.error;
    // Context cancellation only cancels observation in Pi 0.87.1. Explicitly
    // request durable operation cancellation so the provider's signal aborts too.
    let aborting: Promise<void> | undefined;
    const abort = () => {
      aborting ??= lane.requestAbort(admission.value.operationId, BACKGROUND_CONTEXT).then((result) => {
        if (!result.ok && result.error._tag !== 'OperationMismatch') throw result.error;
      });
      // Observe immediately; the same promise is awaited below.
      void aborting.catch(() => {});
    };
    signal.addEventListener('abort', abort, { once: true });
    removeAbort = () => signal.removeEventListener('abort', abort);
    if (signal.aborted) abort();
    const result = await lane.drive({ operationId: admission.value.operationId }, BACKGROUND_CONTEXT);
    await aborting;
    if (!result.ok) throw result.error;
    if (result.value.kind !== 'settled') throw new Error(`Unexpected waiting operation: ${result.value.reason}`);
    const outcome = result.value.outcome;
    if (outcome.status === 'failed') throw new Error(JSON.stringify(outcome.error));
    publish({ status: outcome.status === 'aborted' ? 'Cancelled' : 'Completed' });
    return progress;
  } finally {
    removeAbort();
    unsubscribe.forEach((stop) => stop());
    try { await harness?.close(BACKGROUND_CONTEXT); }
    finally {
      await repo.close(BACKGROUND_CONTEXT);
    }
  }
}
