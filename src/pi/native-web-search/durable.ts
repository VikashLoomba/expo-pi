import { BACKGROUND_CONTEXT } from '@earendil-works/chord/context';
import { uuidv7, type Models } from '@earendil-works/pi-ai';
import {
  GenerationTask, defineDoc, defineExtension, hook,
  type ConversationId, type GenerationCheckpoint, type Harness,
} from '@earendil-works/pi-durable';

import { bindNativeWebSearch } from './bindings';
import { copyJson, type NativeResponseRecord } from './types';

export type NativeResponsesState = { responses: Record<string, NativeResponseRecord> };
export type NativeLiveState = { requestId?: string; taskId?: number };

/** Native output is durable application data, separate from Pi's normalized messages. */
export const NativeResponsesDoc = defineDoc<NativeResponsesState>({
  kind: 'app.openai.responses', version: 1, scope: 'conversation', history: 'rewindable', fork: 'asOf',
  initial: () => ({ responses: {} }),
});

/** A fork inherits historical responses, but never its parent's in-flight presentation. */
export const NativeLiveDoc = defineDoc<NativeLiveState>({
  kind: 'app.openai.live', version: 1, scope: 'conversation', history: 'latest', fork: 'initial',
  initial: () => ({}),
});

type RequestScope = { error: unknown } | {
  conversationId: ConversationId;
  record: NativeResponseRecord;
  history: NativeResponseRecord[];
};

/**
 * Public Generation hooks supply identity; the OpenAI provider wrapper supplies callbacks.
 * No callbacks enter durable checkpoints and no native data is hidden on Pi messages.
 */
export function createNativeWebSearchBridge(models: Models) {
  let harness: Harness | undefined;

  const save = async (scope: Extract<RequestScope, { record: NativeResponseRecord }>, record: NativeResponseRecord) => {
    if (!harness) throw new Error('Native search persistence has not been attached.');
    if (record.requestId !== scope.record.requestId || record.taskId !== scope.record.taskId ||
        record.provider !== 'openai' || record.model !== scope.record.model) {
      throw new Error('Native response does not belong to this generation.');
    }
    // The provider awaits this commit before exposing a corresponding normalized event.
    // Mandatory persistence of a received event survives user cancellation. Harness.close
    // still seals admission and drains commits already admitted on its mutation line.
    const value = copyJson(record);
    await harness.commit(async (tx) => {
      const archive = await tx.doc(NativeResponsesDoc, scope.conversationId);
      const previous = archive.responses[record.requestId];
      if (previous?.responseId && record.responseId && previous.responseId !== record.responseId) {
        throw new Error('A native request cannot change its response identity.');
      }
      archive.responses[record.requestId] = value;
      const live = await tx.doc(NativeLiveDoc, scope.conversationId);
      if (live.requestId === undefined || live.requestId === record.requestId) {
        live.requestId = record.requestId;
        live.taskId = record.taskId;
      }
    }, BACKGROUND_CONTEXT);
  };

  const extension = defineExtension({
    name: 'openai-native-web-search',
    hooks: [hook(GenerationTask, {
      async beforeRequest(request, api, context) {
        const signal = context.abortSignal;
        if (!signal) throw new Error('Durable generation did not supply its cancellation signal.');
        // Hook errors are reported by Pi, so bind failure first and make the provider
        // boundary fail closed if any subsequent preparation operation fails.
        bindNativeWebSearch(signal, { error: new Error('Native search request preparation did not complete.') });
        try {
          if (!harness) throw new Error('Native search persistence has not been attached.');
          // Pi pins the model when preparation commits. Configuration may change
          // before a recovered request runs, so read that exact public checkpoint.
          const task = await harness.getTask(api.taskId, context);
          if (!task || task.kind !== GenerationTask.definition.name || task.state.status !== 'running') {
            throw new Error('Native search requires an active generation task.');
          }
          const checkpoint = task.state.checkpoint as GenerationCheckpoint;
          if (checkpoint.phase !== 'request') throw new Error('Native search requires a generation request checkpoint.');
          if (checkpoint.model.provider !== 'openai') {
            bindNativeWebSearch(signal, undefined);
            return;
          }
          const model = models.getModel('openai', checkpoint.model.modelId);
          if (!model || model.api !== 'openai-responses') {
            bindNativeWebSearch(signal, undefined);
            return;
          }
          const archive = await api.snapshot(NativeResponsesDoc, api.conversationId, context);
          const byResponse = new Map(Object.values(archive?.responses ?? {})
            .filter((record) => record.responseId && record.provider === 'openai' && record.model === model.id)
            .map((record) => [record.responseId, record]));
          const history: NativeResponseRecord[] = [];
          for (const message of request.messages) {
            if (message.role !== 'assistant' || message.provider !== 'openai' || message.model !== model.id || !message.responseId) continue;
            const record = byResponse.get(message.responseId);
            if (record && (record.status === 'completed' || record.status === 'incomplete')) history.push(copyJson(record));
          }
          const record: NativeResponseRecord = {
            requestId: uuidv7(), taskId: api.taskId, provider: 'openai', model: model.id,
            status: 'in_progress', output: [], events: [],
          };
          const scope = { conversationId: api.conversationId, record, history };
          await harness.commit(async (tx) => {
            const archive = await tx.doc(NativeResponsesDoc, api.conversationId);
            // An invocation recovered after process shutdown gets a new request ID.
            // Preserve its predecessor and mark its unfinished transport honestly.
            for (const previous of Object.values(archive.responses)) {
              if (previous.taskId === api.taskId && previous.status === 'in_progress') previous.status = 'interrupted';
            }
            archive.responses[record.requestId] = copyJson(record);
            const live = await tx.doc(NativeLiveDoc, api.conversationId);
            live.requestId = record.requestId;
            live.taskId = record.taskId;
          }, context);
          bindNativeWebSearch(signal, { record, history, save: (value) => save(scope, value) });
        } catch (error) {
          bindNativeWebSearch(signal, { error });
          throw error;
        }
      },
    })],
  });

  return {
    models, extension,
    attach(value: Harness) {
      if (harness && harness !== value) throw new Error('Native search bridge already belongs to another Harness.');
      harness = value;
    },
  };
}
