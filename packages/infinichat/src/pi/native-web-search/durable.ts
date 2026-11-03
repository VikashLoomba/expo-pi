import { BACKGROUND_CONTEXT, withAbortSignal } from '@earendil-works/chord/context';
import {
  GenerationTask, defineExtension, hook, type ConversationId, type Harness,
} from '@earendil-works/pi-durable';

import { bindNativeWebSearch, type NativeWebSearchWriter } from './bindings';
import { withWebSearchTool } from './provider';

export { SearchPresentationsDoc } from './documents';
export type {
  SearchCallPresentation, SearchPresentation, SearchPresentationsState, SearchSource,
} from './documents';

/**
 * Adds OpenAI's hosted search to each generation request's body, and binds the request's own signal to its
 * conversation, so the OpenAI provider decorator knows which chat a stream's searches belong to. Only generation
 * requests do: compaction runs a CompactionTask, which neither hook reaches, and every other Models call carries an
 * unbound signal, so only chat requests get the hosted tool.
 */
export function createNativeWebSearchBridge(report: (error: unknown) => void, current: () => Harness | undefined) {
  /** The Harness running the request: a hook fires only inside it, so it is open whenever a writer is used. */
  const opened = () => {
    const harness = current();
    if (!harness) throw new Error('Native search persistence has no open Harness.');
    return harness;
  };
  const writerFor = (conversationId: ConversationId): NativeWebSearchWriter => ({
    async commit(change, signal) {
      await opened().commit(change, withAbortSignal(signal, BACKGROUND_CONTEXT));
    },
    async submit(entry, requestId, signal) {
      const context = withAbortSignal(signal, BACKGROUND_CONTEXT);
      const conversation = await opened().conversation(conversationId, context);
      if (!conversation) throw new Error('Conversation not found.');
      await conversation.submit({ type: 'write', entry, requestId }, context);
    },
  });

  const extension = defineExtension({
    name: 'openai-native-web-search',
    hooks: [hook(GenerationTask, {
      beforeRequest(_request, api, context) {
        if (context.abortSignal) {
          bindNativeWebSearch(context.abortSignal, { conversationId: api.conversationId, taskId: api.taskId,
            write: writerFor(api.conversationId), report });
        }
      },
      // pi-durable's hook for a provider-specific field (README "Hooks"); the body is in the model's API's format.
      beforeProviderRequest({ model, payload }) {
        if (model.provider !== 'openai' || model.api !== 'openai-responses') return undefined;
        return { payload: withWebSearchTool(payload) };
      },
    })],
  });

  return extension;
}
