import {
  createAssistantMessageEventStream,
  type Api, type AssistantMessage, type Context, type Model, type OpenAIResponsesCompat,
} from '@earendil-works/pi-ai';
import { createGrammarToolInputProperties } from '@earendil-works/pi-ai/api/constrained-sampling';
import { processResponsesStream } from '@earendil-works/pi-ai/api/openai-responses-shared';
import { getDeclaredTools, normalizeContext } from '@earendil-works/pi-ai/utils/transcript';
import type { ResponseStreamEvent } from 'openai/resources/responses/responses';
import { toResponseInputItems, type ResponseInputItemLike } from 'openai/lib/responses/ResponseInputItems';

import { copyJson, type NativeResponseRecord } from './types';

const normalizedItemTypes = new Set(['reasoning', 'message', 'function_call', 'custom_tool_call']);

/**
 * Complete native item snapshots can arrive only in the terminal envelope. Feed
 * those snapshots through Pi's public parser so its ordinary message signatures,
 * phase handling, and local tool arguments remain the single encoding contract.
 * This is terminal reconciliation, not another transport or wire-history store.
 */
export async function normalizeNativeResponse(
  model: Model<Api>,
  context: Context,
  message: AssistantMessage,
  record: NativeResponseRecord,
): Promise<AssistantMessage> {
  if (message.stopReason === 'aborted' || message.stopReason === 'error' ||
      (record.status !== 'completed' && record.status !== 'incomplete') || !record.response) return message;

  const supported = record.output.filter((item) => normalizedItemTypes.has(String(item.type)));
  // A malformed/partial terminal envelope must not erase the text Pi received
  // in deltas, or promote an unfinished local call to a completed one.
  if (!supported.length || supported.some((item) => item.status === 'in_progress')) return message;

  const normalized: AssistantMessage = { ...copyJson(message), content: [], stopReason: 'pending' };
  // The original stream already supplied live events. Reconciliation produces
  // only the final message; replaying its deltas would duplicate visible output.
  const sink = createAssistantMessageEventStream();
  sink.end(message);
  // Provider output-only provenance and parsed helper fields are not replayable.
  // Normalize the copy before Pi encodes its durable opaque signatures.
  const items = toResponseInputItems(copyJson(record.output) as unknown as ResponseInputItemLike[]);
  const response = { ...copyJson(record.response), output: items };
  async function* completedItems(): AsyncIterable<ResponseStreamEvent> {
    for (const [outputIndex, item] of items.entries()) {
      yield { type: 'response.output_item.done', output_index: outputIndex,
        sequence_number: outputIndex, item } as unknown as ResponseStreamEvent;
    }
    yield { type: record.status === 'incomplete' ? 'response.incomplete' : 'response.completed',
      sequence_number: items.length, response } as unknown as ResponseStreamEvent;
  }

  const compat = model.compat as OpenAIResponsesCompat | undefined;
  await processResponsesStream(completedItems(), normalized, sink, model, {
    grammarToolInputProperties: createGrammarToolInputProperties(
      getDeclaredTools(normalizeContext(context).messages), compat?.supportsOpenAIGrammarTools ?? false,
    ),
  });
  // Pi's transport already applied billing/service-tier policy. The normalized
  // content must not recalculate or otherwise change the recorded token usage.
  return { ...message, content: normalized.content, stopReason: normalized.stopReason };
}
