import type { AssistantMessage, Message, ToolResultMessage, UserMessage } from '@earendil-works/pi-ai';
import {
  AgentDoc, CompactionEntry, LiveDoc, ResetEntry,
  type AgentState, type ConversationId, type ConversationView, type EntryId, type EntryRecord, type LiveState,
  type SubmissionRecord,
} from '@earendil-works/pi-durable';

import { fileToolPresentation, withFileToolDetails } from '../chat/file-tool-presentation';
import type { ChatControls, ChatMessage, ChatSummary } from '../chat/types';
import type { ChatMetadata } from './chat-metadata';
import { executionSettings, type ExecutionTargetState } from './execution/document';
import type { ChatModelSettings } from './model-catalog';
import type { NativeLiveState, NativeResponsesState } from './native-web-search/durable';
import { isSearchObservationEntry } from './native-web-search/observations';
import { nativeResponseText, projectNativeWebSearch } from './native-web-search/projection';
import type { NativeResponseRecord } from './native-web-search/types';

/** Committed state of one chat: its conversation view, app documents and the record of its latest input. */
export type ChatState = {
  readonly id: ConversationId;
  readonly metadata?: Readonly<ChatMetadata>;
  readonly agent?: Readonly<AgentState>;
  readonly execution?: Readonly<ExecutionTargetState>;
  readonly live?: Readonly<LiveState>;
  readonly native?: Readonly<NativeResponsesState>;
  readonly nativeLive?: Readonly<NativeLiveState>;
  readonly submission?: SubmissionRecord;
};

const SUMMARIZED_NOTICE = 'Earlier messages summarized';

/**
 * The built-in documents of a conversation view, published with its entries in one revision so a row never shows
 * a streamed partial beside its saved entry. The view keys them by kind as JSON whose shapes pi-durable defines.
 */
export function readConversationView(view: ConversationView) {
  // pi-durable reads its view this way in its own example, test/examples/21-late-join.ts.
  return {
    live: view.docs[LiveDoc.definition.kind] as LiveState | undefined,
    agent: view.docs[AgentDoc.definition.kind] as AgentState | undefined,
  };
}

const textOf = (content: Message['content']) => typeof content === 'string' ? content
  : content.flatMap((part) => part.type === 'text' ? [part.text] : []).join('');

/** Collapse whitespace for one-line titles and previews. */
export const oneLine = (text: string, length: number) => text.replace(/\s+/g, ' ').trim().slice(0, length);

export function settingsOf(agent?: Readonly<AgentState> | null): ChatModelSettings {
  // Missing models stay visibly unavailable; never replace a saved choice with
  // another provider. An omitted effort follows the SDK's own default.
  return { model: { provider: agent?.model?.provider ?? '', modelId: agent?.model?.modelId ?? '' },
    thinkingLevel: agent?.thinkingLevel ?? 'off' };
}

export function summarizeChat(id: ConversationId, metadata: Readonly<ChatMetadata>): ChatSummary | undefined {
  if (metadata.deleted) return undefined;
  return { id, title: metadata.title || 'New chat', preview: metadata.preview || 'Start a conversation',
    updatedAt: Math.max(metadata.createdAt, metadata.updatedAt ?? 0) };
}

/**
 * Why the latest input went unanswered, unless the transcript already shows it: a model error's detail is the failed
 * assistant entry's message, and a stop has its own notice.
 */
function submissionError(submission?: SubmissionRecord): string | undefined {
  if (submission?.status !== 'unanswered') return undefined;
  if (submission.reason === 'aborted' || submission.reason === 'model_error') return undefined;
  const { detail } = submission;
  if (typeof detail === 'string' && detail) return detail;
  if (detail && typeof detail === 'object' && !Array.isArray(detail) && typeof detail.message === 'string') {
    return detail.message;
  }
  return `The response could not finish (${submission.reason}). You can send another message to continue.`;
}

export function projectControls(state: ChatState): ChatControls {
  const error = submissionError(state.submission);
  return {
    id: state.id,
    title: state.metadata?.title || 'New chat',
    settings: settingsOf(state.agent),
    execution: executionSettings(state.execution, state.agent),
    busy: state.live?.run !== undefined,
    // pi-durable waits before retrying a failed request; the failed attempt is not an answer.
    retrying: state.live?.generation?.retry !== undefined,
    ...(error ? { error } : {}),
  };
}

function nativeTimestamp(record: NativeResponseRecord, fallback: number): number {
  const createdAt = record.response?.created_at;
  if (typeof createdAt === 'number' && Number.isFinite(createdAt)) return createdAt * 1000;
  // The bridge generates UUIDv7 request IDs before network access; its timestamp
  // keeps interrupted attempts in order even when no response.created arrived.
  return /^[0-9a-f]{8}-[0-9a-f]{4}-7/i.test(record.requestId)
    ? Number.parseInt(record.requestId.replaceAll('-', '').slice(0, 12), 16) : fallback;
}

function userRows(message: UserMessage, key: string): ChatMessage[] {
  const text = textOf(message.content);
  return text ? [{ id: key, role: 'user', text, createdAt: message.timestamp }] : [];
}

function toolResultRow(message: ToolResultMessage, key: string, call: ChatMessage | undefined): ChatMessage {
  const output = textOf(message.content);
  const status = message.isError ? 'error' : 'completed';
  if (!call?.tool) {
    return { id: key, role: 'tool', text: output, createdAt: message.timestamp,
      tool: { name: message.toolName, args: '', output, status } };
  }
  return { ...call, text: output,
    tool: { ...call.tool, output, status, file: withFileToolDetails(call.tool.file, message.details) } };
}

/** An assistant row (when it has anything to show) followed by one row per tool call. */
function assistantRows(message: AssistantMessage, key: string, streaming: boolean,
  native: NativeResponseRecord | undefined, nativeInterrupted: boolean): ChatMessage[] {
  const rows: ChatMessage[] = [];
  const nativeText = native ? nativeResponseText(native) : '';
  // A terminal envelope can contain message items absent from Pi's deltas. Use that complete native text for
  // citation offsets, but keep Pi's partial after cancellation or failure when native snapshots are sparse.
  const ownText = message.content.flatMap((part) => part.type === 'text' ? [part.text] : []).join('');
  const text = nativeText && (native?.status === 'completed' || native?.status === 'incomplete')
    ? nativeText : ownText || nativeText;
  const webSearch = native
    ? projectNativeWebSearch(native, text, nativeInterrupted || message.stopReason === 'aborted') : undefined;
  const thinking = message.content.flatMap((part) => part.type === 'thinking' ? [part.thinking] : []).join('');
  const failed = message.stopReason === 'error';
  if (text || thinking || webSearch || failed || (streaming && message.content.length === 0)) {
    rows.push({ id: key, role: 'assistant', text, createdAt: message.timestamp, streaming,
      ...(thinking ? { thinking } : {}),
      ...(webSearch ? { webSearch } : {}),
      ...(!streaming && message.stopReason === 'aborted' ? { interrupted: true } : {}),
      ...(failed ? { error: message.errorMessage || 'Response failed.' } : {}),
    });
  }
  for (const part of message.content) {
    if (part.type !== 'toolCall') continue;
    const file = fileToolPresentation(part.name, part.arguments);
    const args = file ? '' : JSON.stringify(part.arguments, null, 2);
    rows.push({ id: `${key}-tool-${part.id}`, role: 'tool', text: '', createdAt: message.timestamp,
      tool: { name: part.name, args, output: '', status: 'running', ...(file ? { file } : {}) } });
  }
  return rows;
}

function nativeRows(record: NativeResponseRecord, key: string, interrupted: boolean, streaming: boolean,
  fallbackTime: number): ChatMessage[] {
  const text = nativeResponseText(record);
  const webSearch = projectNativeWebSearch(record, text, interrupted);
  if (!text && !webSearch) return [];
  return [{ id: key, role: 'assistant', text, createdAt: nativeTimestamp(record, fallbackTime),
    streaming: streaming && !interrupted,
    ...(webSearch ? { webSearch } : {}), ...(interrupted ? { interrupted: true } : {}),
    ...(record.status === 'failed' ? { error: record.error || 'Response failed.' } : {}),
  }];
}

/**
 * Derive transcript rows from committed entries (ascending IDs) and live documents. Row IDs stay stable as a
 * streamed partial becomes a saved entry: assistants are numbered in order, and the partial takes the next number.
 */
export function projectMessages(state: ChatState, entries: readonly EntryRecord[]): ChatMessage[] {
  const messages: ChatMessage[] = [];
  const calls = new Map<string, number>();
  let assistantCount = 0;
  const createdAt = state.metadata?.createdAt ?? 0;
  const responses = state.native?.responses ?? {};
  const nativeRecords = Object.values(responses);
  const nativeByResponse = new Map(nativeRecords.flatMap((record) =>
    record.responseId ? [[record.responseId, record] as const] : []));
  const liveRequest = state.nativeLive?.requestId;
  const runTask = state.live?.run?.taskId;
  const currentNative = liveRequest !== undefined && state.nativeLive?.taskId === runTask
    ? responses[liveRequest] : undefined;
  // A native response still marked in progress is interrupted unless it is the live request.
  const nativeInterrupted = (record: NativeResponseRecord) =>
    record.status === 'in_progress' && record.requestId !== currentNative?.requestId;
  const pushAssistant = (rows: readonly ChatMessage[], key: string, message: AssistantMessage) => {
    const start = messages.length;
    messages.push(...rows);
    for (const part of message.content) {
      if (part.type !== 'toolCall') continue;
      const offset = rows.findIndex((row) => row.id === `${key}-tool-${part.id}`);
      if (offset >= 0) calls.set(part.id, start + offset);
    }
  };
  const appendNative = (record: NativeResponseRecord) => {
    const key = `assistant-${assistantCount++}`;
    const interrupted = nativeInterrupted(record) || record.status === 'interrupted';
    messages.push(...nativeRows(record, key, interrupted, false, createdAt));
  };

  // Observation model messages are external evidence for the model. Native
  // response metadata already supplies their visible activity and sources.
  const visible = entries.filter((entry) => !isSearchObservationEntry(entry));
  const represented = new Set(visible.flatMap((entry) => entry.model?.flatMap((message) =>
    message.role === 'assistant' && message.responseId ? [message.responseId] : []) ?? []));
  const orphaned = nativeRecords.filter((record) => record.requestId !== currentNative?.requestId
    && (!record.responseId || !represented.has(record.responseId)))
    .sort((a, b) => a.taskId - b.taskId || a.requestId.localeCompare(b.requestId));
  // pi-durable saves each failed attempt before retrying it. The attempt is not an answer while its generation
  // still runs, or once that generation saved a later response.
  const lastAssistant = new Map<number, number>();
  for (const entry of visible) {
    if (entry.byTaskId !== undefined && entry.model?.some((message) => message.role === 'assistant')) {
      lastAssistant.set(entry.byTaskId, entry.id);
    }
  }
  const retried = (entry: EntryRecord) => entry.byTaskId !== undefined
    && (entry.byTaskId === runTask || (lastAssistant.get(entry.byTaskId) ?? entry.id) > entry.id);
  // A summary replaces what came before its head, so its notice marks that boundary. Its model message is the
  // summary for the model, never something the user said.
  const summaries = new Map<EntryId, EntryRecord[]>();
  const present = new Set(visible.map((entry) => entry.id));
  for (const entry of visible) {
    if (!CompactionEntry.is(entry) && !ResetEntry.is(entry)) continue;
    const at = entry.head !== undefined && present.has(entry.head) ? entry.head : entry.id;
    summaries.set(at, [...summaries.get(at) ?? [], entry]);
  }
  let nativeIndex = 0;
  for (const entry of visible) {
    while (nativeIndex < orphaned.length && orphaned[nativeIndex].taskId < entry.id) {
      appendNative(orphaned[nativeIndex++]);
    }
    for (const summary of summaries.get(entry.id) ?? []) {
      messages.push({ id: `summary-${summary.id}`, role: 'notice', text: SUMMARIZED_NOTICE, createdAt: 0 });
    }
    if (CompactionEntry.is(entry) || ResetEntry.is(entry)) continue;
    entry.model?.forEach((message, index) => {
      const entryKey = `${entry.id}-${index}`;
      if (message.role === 'user') messages.push(...userRows(message, entryKey));
      if (message.role === 'toolResult') {
        const callIndex = calls.get(message.toolCallId);
        const call = callIndex === undefined ? undefined : messages[callIndex];
        const row = toolResultRow(message, entryKey, call);
        if (call?.tool && callIndex !== undefined) messages[callIndex] = row;
        else messages.push(row);
      }
      if (message.role !== 'assistant') return;
      // Entries are append-only, so the next assistant's ordinal is known before its entry exists. Count every
      // assistant, including tool-only responses and hidden attempts, so a partial and its entry share a row ID.
      const key = `assistant-${assistantCount++}`;
      if (message.stopReason === 'error' && retried(entry)) return;
      const native = message.responseId ? nativeByResponse.get(message.responseId) : undefined;
      const interrupted = native ? nativeInterrupted(native) : false;
      pushAssistant(assistantRows(message, key, false, native, interrupted), key, message);
    });
  }
  while (nativeIndex < orphaned.length) appendNative(orphaned[nativeIndex++]);

  const partial = state.live?.generation?.message;
  if (partial) {
    const key = `assistant-${assistantCount++}`;
    const native = partial.responseId ? nativeByResponse.get(partial.responseId) : undefined;
    pushAssistant(assistantRows(partial, key, true, native, native ? nativeInterrupted(native) : false), key, partial);
  }
  if (currentNative && (!currentNative.responseId || partial?.responseId !== currentNative.responseId)
      && !(currentNative.responseId && represented.has(currentNative.responseId))) {
    const key = `assistant-${assistantCount++}`;
    messages.push(...nativeRows(currentNative, key, nativeInterrupted(currentNative), true, createdAt));
  }
  for (const slot of state.live?.tools ?? []) {
    const index = calls.get(slot.callId);
    const message = index === undefined ? undefined : messages[index];
    if (message?.tool && index !== undefined && slot.status !== 'done') {
      messages[index] = { ...message, tool: { ...message.tool, output: slot.output ?? '', status: 'running',
        file: withFileToolDetails(message.tool.file, slot.details) } };
    }
  }
  // A stopped run saves its partial answer as an interrupted entry, which already shows the stop.
  const last = state.submission;
  const placed = last?.entry;
  const partialSaved = placed !== undefined && visible.some((entry) => entry.id > placed
    && entry.model?.some((message) => message.role === 'assistant' && message.stopReason === 'aborted'));
  if (last?.status === 'unanswered' && last.reason === 'aborted' && !partialSaved) {
    messages.push({ id: `submission-${last.id}`, role: 'notice', text: 'Response stopped', createdAt: 0 });
  }
  return messages;
}
