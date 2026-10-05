import type { Api, Context, Message, Model, OpenAIResponsesCompat, TextContent } from '@earendil-works/pi-ai';
import { createGrammarToolInputProperties } from '@earendil-works/pi-ai/api/constrained-sampling';
import { convertResponsesMessages } from '@earendil-works/pi-ai/api/openai-responses-shared';
import { getDeclaredTools, normalizeContext, resolveTranscript } from '@earendil-works/pi-ai/utils/transcript';
import { toResponseInputItems, type ResponseInputItemLike } from 'openai/lib/responses/ResponseInputItems';
import type { ResponseInput } from 'openai/resources/responses/responses';

import { copyJson, type NativeResponseRecord } from './types';

const toolProviders = new Set(['openai', 'openai-codex', 'opencode']);

/**
 * Reuse Pi's own transcript conversion, tool pairing, and cross-provider rules.
 * Temporary text-signature boundaries identify each native assistant's exact
 * span, even when Pi normalized zero content for it. These exist only in the
 * conversion input; every boundary is removed before returning a wire request.
 */
export function replayNativeResponses(
  model: Model<Api>,
  context: Context,
  history: readonly NativeResponseRecord[],
  requestId: string,
): ResponseInput | undefined {
  const records = new Map(history.filter((record) => record.responseId && record.model === model.id &&
    record.provider === model.provider && (record.status === 'completed' || record.status === 'incomplete'))
    .map((record) => [record.responseId!, record]));
  if (!records.size) return undefined;
  const boundaries = new Map<string, { end: string; record: NativeResponseRecord }>();
  let ordinal = 0;
  const marker = (id: string): TextContent => ({ type: 'text', text: '', textSignature: JSON.stringify({ v: 1, id }) });
  const transcript = normalizeContext(context);
  const messages: Message[] = transcript.messages.map((message) => {
    if (message.role !== 'assistant' || message.provider !== model.provider || message.api !== model.api ||
        message.model !== model.id || message.stopReason === 'aborted' || message.stopReason === 'error') return message;
    const record = message.responseId ? records.get(message.responseId) : undefined;
    if (!record) return message;
    // Context edits and hooks may replace an assistant while retaining its
    // provider identity. Never restore native output removed by such an edit.
    if (record.normalizedContent === undefined || record.normalizedContent !== JSON.stringify(message.content)) return message;
    const prefix = `msg_native_${requestId.replace(/[^a-zA-Z0-9]/g, '').slice(0, 32)}_${ordinal++}`;
    const start = `${prefix}_s`;
    const end = `${prefix}_e`;
    boundaries.set(start, { end, record });
    return { ...message, content: [marker(start), ...message.content, marker(end)] };
  });
  if (!boundaries.size) return undefined;
  const compat = model.compat as OpenAIResponsesCompat | undefined;
  const normalized = resolveTranscript(normalizeContext({ messages }), compat?.supportsMidConvoSystemMessages ?? false);
  const converted = convertResponsesMessages(model, normalized, toolProviders, {
    supportsMidConvoSystemMessages: compat?.supportsMidConvoSystemMessages ?? false,
    supportsAdditionalTools: compat?.supportsAdditionalTools ?? false,
    supportsToolSearch: compat?.supportsToolSearch ?? false,
    grammarToolInputProperties: createGrammarToolInputProperties(
      getDeclaredTools(normalized.messages), compat?.supportsOpenAIGrammarTools ?? false,
    ),
    toolOptions: {
      supportsStrictMode: compat?.supportsStrictMode ?? false,
      supportsOpenAIGrammarTools: compat?.supportsOpenAIGrammarTools ?? false,
    },
  });
  const result: ResponseInput = [];
  const consumed = new Set<string>();
  for (let index = 0; index < converted.length; index++) {
    const item = converted[index];
    const id = 'id' in item ? item.id : undefined;
    const boundary = typeof id === 'string' ? boundaries.get(id) : undefined;
    if (!boundary) { result.push(item); continue; }
    if (consumed.has(id!)) throw new Error('Duplicate native response replay boundary.');
    let end = index + 1;
    while (end < converted.length) {
      const candidate = converted[end];
      if ('id' in candidate && candidate.id === boundary.end) break;
      end++;
    }
    if (end === converted.length) throw new Error('Native response replay boundary is incomplete.');
    // The official SDK removes output-only provenance and parsed helper fields.
    // Conversion never modifies the durable archive, including encrypted content.
    result.push(...toResponseInputItems(copyJson(boundary.record.output) as unknown as ResponseInputItemLike[]));
    consumed.add(id!);
    index = end;
  }
  if (consumed.size !== boundaries.size || result.some((item) => 'id' in item && typeof item.id === 'string' &&
      (boundaries.has(item.id) || [...boundaries.values()].some((boundary) => boundary.end === item.id)))) {
    throw new Error('Native response replay could not preserve the conversation boundaries.');
  }
  return result;
}
