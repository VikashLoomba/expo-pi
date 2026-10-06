import {
  createAssistantMessageEventStream,
  type Api, type AssistantMessage, type AssistantMessageEventStream, type Context, type Model, type StreamOptions,
} from '@earendil-works/pi-ai';

import { NativeResponseArchive } from './archive';
import { normalizeNativeResponse } from './normalization';
import { isObject, type NativeWebSearchIntegration } from './types';

const includes = ['reasoning.encrypted_content', 'web_search_call.action.sources', 'web_search_call.results'];

/** Native hosted tools belong on the Responses request, outside Pi's function-tool registry. */
export function streamNativeOpenAI<TOptions extends StreamOptions>(
  model: Model<Api>,
  context: Context,
  options: TOptions | undefined,
  integration: NativeWebSearchIntegration,
  delegate: (options: TOptions) => AssistantMessageEventStream,
): AssistantMessageEventStream {
  const target = createAssistantMessageEventStream();
  const archive = new NativeResponseArchive(integration.record);
  let partial: AssistantMessage | undefined;
  let persistenceError: unknown;
  let normalizedContent = integration.record.normalizedContent;
  const save = async () => {
    try {
      await integration.save({ ...archive.snapshot(),
        ...(normalizedContent === undefined ? {} : { normalizedContent }),
      });
    }
    catch (error) { persistenceError = error; throw error; }
  };
  const finish = async (message: AssistantMessage) => {
    const normalized = await normalizeNativeResponse(model, context, message, archive.snapshot());
    const status = normalized.stopReason === 'aborted' ? 'interrupted'
      : normalized.stopReason === 'error' ? 'failed' : normalized.stopReason === 'length' ? 'incomplete' : 'completed';
    archive.finish(status, normalized.errorMessage);
    normalizedContent = JSON.stringify(normalized.content);
    await save();
    return normalized;
  };
  void (async () => {
    try {
      const source = delegate({
        ...options,
        async onPayload(payload: unknown, requestModel: Model<Api>) {
          if (!isObject(payload)) throw new Error('OpenAI Responses requires an object request.');
          const tools = Array.isArray(payload.tools) ? [...payload.tools] : [];
          if (!tools.some((tool) => isObject(tool) && (tool.type === 'web_search' || tool.type === 'web_search_preview'))) {
            tools.push({ type: 'web_search' });
          }
          const request = {
            ...payload,
            tools,
            include: [...new Set([...(Array.isArray(payload.include) ? payload.include : []), ...includes])],
          };
          // Pi owns input conversion, including encrypted reasoning and local
          // tool pairing. Callers retain its last-word payload hook semantics.
          const replacement = await options?.onPayload?.(request, requestModel);
          return replacement === undefined ? request : replacement;
        },
        async onProviderStreamEvent(event: unknown, requestModel: Model<Api>) {
          if (archive.accept(event)) await save();
          await options?.onProviderStreamEvent?.(event, requestModel);
        },
      } as TOptions);
      for await (const event of source) {
        if (event.type === 'done' || event.type === 'error') {
          const message = event.type === 'done' ? event.message : event.error;
          if (persistenceError) throw persistenceError;
          const normalized = await finish(message);
          if (event.type === 'done') {
            const reason = normalized.stopReason;
            if (reason !== 'stop' && reason !== 'length' && reason !== 'toolUse' && reason !== 'deferred') {
              throw new Error('OpenAI terminal normalization did not produce a successful stop reason.');
            }
            target.push({ type: 'done', reason, message: normalized });
          } else target.push({ ...event, error: normalized });
          target.end(normalized);
          return;
        }
        partial = event.partial;
        target.push(event);
      }
      throw new Error('OpenAI Responses stream ended without a terminal message.');
    } catch (error) {
      const aborted = options?.signal?.aborted === true;
      const text = persistenceError ? 'Could not save the native search response. Please try again.'
        : error instanceof Error ? error.message : String(error);
      archive.finish(aborted ? 'interrupted' : 'failed', text);
      // A close seals the Harness before cancelling its providers. Meaningful
      // native events were already committed; never conceal the original error
      // or leave the output stream pending if a final save cannot be admitted.
      if (!persistenceError) { try { await save(); } catch { /* Report via the terminal message below. */ } }
      const message: AssistantMessage = {
        role: 'assistant', content: [], api: model.api, provider: model.provider, model: model.id,
        timestamp: Date.now(),
        usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0,
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
        ...partial,
        ...(archive.responseId ? { responseId: archive.responseId } : {}),
        stopReason: aborted ? 'aborted' : 'error', errorMessage: text,
      };
      target.push({ type: 'error', reason: aborted ? 'aborted' : 'error', error: message });
      target.end(message);
    }
  })();
  return target;
}
