import { BACKGROUND_CONTEXT } from '@earendil-works/chord/context';
import { uuidv7, type Models } from '@earendil-works/pi-ai';
import {
  GenerationTask, defineExtension, hook,
  type ConversationId, type GenerationCheckpoint, type Harness,
} from '@earendil-works/pi-durable';

import { bindNativeWebSearch, nativeWebSearchScope } from './bindings';
import { bindSearchEvidenceBudget, failSearchEvidencePreparation, getSearchEvidenceBudget, withSearchEvidenceBudget } from './budget';
import { NativeLiveDoc, NativeResponsesDoc } from './documents';
import { captureRequestOrigin } from './lifecycle';
import { migrateSearchObservations } from './migration';
import { persistNativeResponse } from './persistence';
import { copyJson, type NativeResponseRecord } from './types';

export { NativeLiveDoc, NativeResponsesDoc } from './documents';
export type { NativeLiveState, NativeResponsesState } from './documents';

type RequestScope = { error: unknown } | {
  conversationId: ConversationId;
  record: NativeResponseRecord;
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
    await harness.commit((tx) => persistNativeResponse(tx, scope.conversationId, value), BACKGROUND_CONTEXT);
  };

  const extension = defineExtension({
    name: 'openai-native-web-search',
    hooks: [hook(GenerationTask, {
      async beforeRequest(request, api, context) {
        const signal = context.abortSignal;
        if (!signal) throw new Error('Durable generation did not supply its cancellation signal.');
        failSearchEvidencePreparation(signal);
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
          // Startup migration normally runs before preparation. Recovery and
          // direct SDK forks can have an older pinned cutoff: forward only
          // canonical evidence associated with that exact request's sources.
          const migration = await migrateSearchObservations(harness, api.conversationId, context, {
            messages: request.messages, cutoff: checkpoint.cutoff,
          });
          const prepared = migration.messages.length ? { messages: [...request.messages, ...migration.messages] } : undefined;
          if (checkpoint.model.provider !== 'openai') {
            bindNativeWebSearch(signal, undefined);
            bindSearchEvidenceBudget(signal);
            return prepared;
          }
          const model = models.getModel('openai', checkpoint.model.modelId);
          if (!model || model.api !== 'openai-responses') {
            bindNativeWebSearch(signal, undefined);
            bindSearchEvidenceBudget(signal);
            return prepared;
          }
          const record: NativeResponseRecord = {
            requestId: uuidv7(), taskId: api.taskId, provider: 'openai', model: model.id,
            cutoff: checkpoint.cutoff,
            evidenceBudgetBytes: getSearchEvidenceBudget(model.contextWindow).maxBytes,
            status: 'in_progress', output: [], events: [],
          };
          const scope = { conversationId: api.conversationId, record };
          await harness.commit(async (tx) => {
            const originEntryId = await captureRequestOrigin(tx, api.conversationId, checkpoint.cutoff);
            if (originEntryId !== undefined) record.originEntryId = originEntryId;
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
          bindNativeWebSearch(signal, { record, save: (value) => save(scope, value) });
          bindSearchEvidenceBudget(signal);
          return prepared;
        } catch (error) {
          failSearchEvidencePreparation(signal);
          bindNativeWebSearch(signal, { error });
          throw error;
        }
      },
      async afterResponse(message, api, context) {
        const scope = nativeWebSearchScope(context.abortSignal);
        if (!scope || 'error' in scope || message.stopReason !== 'error') return;
        const archive = await api.snapshot(NativeResponsesDoc, api.conversationId, context);
        const record = archive?.responses[scope.record.requestId];
        // A local capacity rejection never enters the provider wrapper. Settle
        // its admitted request honestly instead of leaving phantom live work.
        if (record?.status === 'in_progress' && !record.responseId && !record.output.length) {
          await scope.save({ ...record, status: 'failed', error: message.errorMessage });
        }
      },
    })],
  });

  return {
    models: withSearchEvidenceBudget(models), extension,
    attach(value: Harness) {
      if (harness && harness !== value) throw new Error('Native search bridge already belongs to another Harness.');
      harness = value;
    },
  };
}
