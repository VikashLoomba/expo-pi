import type { Message } from '@earendil-works/pi-ai';
import type { EntryRecord, LiveState, SubmissionId, SubmissionRecord } from '@earendil-works/pi-durable';

import { fileToolPresentation, withFileToolDetails } from '../chat/file-tool-presentation';
import type { ChatConversation, ChatMessage, ChatSummary } from '../chat/types';
import type { ChatModelSettings } from './model-catalog';
import type { NativeLiveState, NativeResponsesState } from './native-web-search/durable';
import { isSearchObservationEntry } from './native-web-search/observations';
import { nativeResponseText, projectNativeWebSearch } from './native-web-search/projection';
import type { NativeResponseRecord } from './native-web-search/types';

type ChatMetadata = { title: string; createdAt: number; archived: boolean };

export type CommittedProjection = {
  messages: ChatMessage[];
  calls: Map<string, number>;
  assistantCount: number;
  firstUser?: string;
  preview?: string;
  updatedAt: number;
};

export type ChatProjectionState = {
  metadata: ChatMetadata;
  settings: ChatModelSettings;
  entries: Map<number, EntryRecord>;
  live: LiveState;
  native: NativeResponsesState;
  nativeLive: NativeLiveState;
  submission?: SubmissionRecord;
  unsettled: Set<number>;
  abortRequested: Set<number>;
  committed?: CommittedProjection;
};
const textOf = (content: Message['content']) => typeof content === 'string' ? content
  : content.filter((part) => part.type === 'text').map((part) => part.text).join('');

export function hasPendingWork(cached: ChatProjectionState): boolean {
  const run = cached.live.run;
  const cancelled = !!run && cached.abortRequested.has(run.taskId);
  return (!!run && !cancelled) || [...cached.unsettled].some((id) => !cancelled || !run.inputs.includes(id as SubmissionId)) ||
    !!cached.live.compactions?.some((task) => !cached.abortRequested.has(task.taskId));
}

function sameMessage(left: ChatMessage, right: ChatMessage): boolean {
  return left === right || (left.id === right.id && left.role === right.role && left.text === right.text &&
    left.createdAt === right.createdAt && left.streaming === right.streaming &&
    left.interrupted === right.interrupted && left.thinking === right.thinking && left.error === right.error &&
    JSON.stringify(left.webSearch) === JSON.stringify(right.webSearch) &&
    (left.tool === right.tool || (!!left.tool && !!right.tool && left.tool.name === right.tool.name &&
      left.tool.args === right.tool.args && left.tool.output === right.tool.output && left.tool.status === right.tool.status &&
      JSON.stringify(left.tool.file) === JSON.stringify(right.tool.file))));
}

/** Reuse immutable rows, and the entire list when a publication changed no displayed fields. */
function shareMessages(messages: ChatMessage[], previous?: ChatMessage[]): ChatMessage[] {
  if (!previous) return messages;
  let identical = messages.length === previous.length;
  for (let index = 0; index < messages.length; index++) {
    const old = previous[index];
    if (old && sameMessage(old, messages[index])) messages[index] = old;
    else identical = false;
  }
  return identical ? previous : messages;
}

export function sameSummary(left: ChatSummary | undefined, right: ChatSummary | undefined): boolean {
  return left === right || (!!left && !!right && left.id === right.id && left.title === right.title &&
    left.preview === right.preview && left.updatedAt === right.updatedAt);
}

function nativeTimestamp(record: NativeResponseRecord, fallback: number): number {
  const createdAt = record.response?.created_at;
  if (typeof createdAt === 'number' && Number.isFinite(createdAt)) return createdAt * 1000;
  // The bridge generates UUIDv7 request IDs before network access; its timestamp
  // keeps interrupted attempts in order even when no response.created arrived.
  return /^[0-9a-f]{8}-[0-9a-f]{4}-7/i.test(record.requestId)
    ? Number.parseInt(record.requestId.replaceAll('-', '').slice(0, 12), 16) : fallback;
}

/** Derive UI rows from immutable durable revisions; never read or write storage. */
export function projectChat(id: string, cached: ChatProjectionState, previous: ChatConversation | undefined, scheduling: boolean) {
  let committed = cached.committed;
  // Most publications contain only a streaming partial. Keep immutable
  // committed rows and their tool indexes until an entry actually changes.
  const messages: ChatMessage[] = committed?.messages.slice() ?? [];
  const calls = new Map(committed?.calls);
  let assistantCount = committed?.assistantCount ?? 0;
  const cancelled = !!cached.live.run && cached.abortRequested.has(cached.live.run.taskId);
  const nativeRecords = Object.values(cached.native.responses);
  const nativeByResponse = new Map(nativeRecords.filter((record) => record.responseId)
    .map((record) => [record.responseId!, record]));
  const currentNative = cached.nativeLive.requestId && cached.nativeLive.taskId === cached.live.run?.taskId
    ? cached.native.responses[cached.nativeLive.requestId] : undefined;
  const nativeInterrupted = (record: NativeResponseRecord) => record.status === 'in_progress' &&
    (!scheduling || record.requestId !== currentNative?.requestId || cancelled);
  const appendNative = (record: NativeResponseRecord, streaming: boolean) => {
    const text = nativeResponseText(record);
    const interrupted = nativeInterrupted(record) || record.status === 'interrupted';
    const webSearch = projectNativeWebSearch(record, text, interrupted);
    if (!text && !webSearch) return;
    messages.push({ id: `assistant-${assistantCount++}`, role: 'assistant', text,
      createdAt: nativeTimestamp(record, cached.metadata.createdAt), streaming: streaming && !interrupted,
      ...(webSearch ? { webSearch } : {}), ...(interrupted ? { interrupted: true } : {}),
      ...(record.status === 'failed' ? { error: record.error || 'Response failed.' } : {}),
    });
  };
  const append = (message: Message, key: string, streaming = false) => {
    if (message.role === 'system') return;
    // Entries are append-only. The next assistant's ordinal is known before
    // its entry ID exists, and remains the same when a partial is committed
    // or interrupted. Count every assistant, including tool-only responses.
    if (message.role === 'assistant') key = `assistant-${assistantCount++}`;
    if (message.role === 'toolResult') {
      const index = calls.get(message.toolCallId);
      const existing = index === undefined ? undefined : messages[index];
      const output = textOf(message.content);
      if (existing?.tool && index !== undefined) {
        messages[index] = { ...existing, text: output,
          tool: { ...existing.tool, output, status: message.isError ? 'error' : 'completed',
            file: withFileToolDetails(existing.tool.file, message.details) } };
      } else messages.push({ id: key, role: 'tool', text: output, createdAt: message.timestamp,
        tool: { name: message.toolName, args: '', output, status: message.isError ? 'error' : 'completed' } });
      return;
    }
    const native = message.role === 'assistant' && message.responseId ? nativeByResponse.get(message.responseId) : undefined;
    const nativeText = native ? nativeResponseText(native) : '';
    // A terminal envelope can contain message items absent from Pi's deltas.
    // Use that complete native text for citation offsets, but retain Pi's live
    // partial after cancellation or failure when native item snapshots are sparse.
    const text = nativeText && (native?.status === 'completed' || native?.status === 'incomplete')
      ? nativeText : textOf(message.content) || nativeText;
    const webSearch = native ? projectNativeWebSearch(native, text,
      nativeInterrupted(native) || (message.role === 'assistant' && message.stopReason === 'aborted')) : undefined;
    const thinking = message.role === 'assistant' ? message.content.filter((part) => part.type === 'thinking').map((part) => part.thinking).join('') : undefined;
    if (text || thinking || webSearch || (message.role === 'assistant' && (message.stopReason === 'error' || (streaming && message.content.length === 0)))) {
      messages.push({ id: key, role: message.role, text, createdAt: message.timestamp, streaming,
        ...(thinking ? { thinking } : {}),
        ...(webSearch ? { webSearch } : {}),
        ...(!streaming && message.role === 'assistant' && message.stopReason === 'aborted' ? { interrupted: true } : {}),
        ...(message.role === 'assistant' && message.stopReason === 'error' ? { error: message.errorMessage || 'Response failed.' } : {}),
      });
    }
    if (message.role === 'assistant') {
      for (const part of message.content) if (part.type === 'toolCall') {
        const file = fileToolPresentation(part.name, part.arguments);
        const tool: ChatMessage = { id: `${key}-tool-${part.id}`, role: 'tool', text: '', createdAt: message.timestamp,
          tool: { name: part.name, args: file ? '' : JSON.stringify(part.arguments, null, 2), output: '', status: 'running', ...(file ? { file } : {}) } };
        calls.set(part.id, messages.length);
        messages.push(tool);
      }
    }
  };
  if (!committed) {
    // Observation model messages are external evidence for the model. Native
    // response metadata already supplies their visible activity and sources.
    const entries = [...cached.entries.values()].filter((entry) => !isSearchObservationEntry(entry))
      .sort((a, b) => a.id - b.id);
    const represented = new Set(entries.flatMap((entry) => entry.model?.flatMap((message) =>
      message.role === 'assistant' && message.responseId ? [message.responseId] : []) ?? []));
    const orphaned = nativeRecords.filter((record) => record.requestId !== currentNative?.requestId &&
      (!record.responseId || !represented.has(record.responseId))).sort((a, b) => a.taskId - b.taskId || a.requestId.localeCompare(b.requestId));
    let nativeIndex = 0;
    for (const entry of entries) {
      while (nativeIndex < orphaned.length && orphaned[nativeIndex].taskId < entry.id) appendNative(orphaned[nativeIndex++], false);
      entry.model?.forEach((message, index) => append(message, `${entry.id}-${index}`));
    }
    while (nativeIndex < orphaned.length) appendNative(orphaned[nativeIndex++], false);
    shareMessages(messages, previous?.messages);
    const transcript = messages.filter((message) => message.role === 'user' || message.role === 'assistant');
    committed = { messages: messages.slice(), calls: new Map(calls), assistantCount,
      firstUser: transcript.find((message) => message.role === 'user')?.text,
      preview: transcript.at(-1)?.text.replace(/\s+/g, ' ').slice(0, 120),
      updatedAt: transcript.reduce((latest, message) => Math.max(latest, message.createdAt), 0),
    };
  }
  if (cached.live.generation?.message) append(cancelled
    ? { ...cached.live.generation.message, stopReason: 'aborted' } as Message
    : cached.live.generation.message as Message, 'streaming', !cancelled);
  if (currentNative && (!currentNative.responseId || cached.live.generation?.message?.responseId !== currentNative.responseId) &&
      ![...cached.entries.values()].some((entry) => entry.model?.some((message) =>
        message.role === 'assistant' && !!message.responseId && message.responseId === currentNative.responseId))) {
    appendNative(currentNative, scheduling && !cancelled);
  }
  for (const slot of cached.live.tools ?? []) {
    const index = calls.get(slot.callId);
    const message = index === undefined ? undefined : messages[index];
    if (message?.tool && index !== undefined && slot.status !== 'done') {
      messages[index] = { ...message, tool: { ...message.tool, output: slot.output ?? '', status: cancelled ? 'error' : 'running',
        file: withFileToolDetails(message.tool.file, slot.details) } };
    }
  }
  const firstUser = committed.firstUser;
  const title = cached.metadata.title || firstUser?.replace(/\s+/g, ' ').slice(0, 64) || 'New chat';
  const last = cached.submission;
  let error: string | undefined;
  if (last?.status === 'unanswered') {
    if (last.reason === 'aborted') messages.push({ id: `submission-${last.id}`, role: 'notice', text: 'Response stopped', createdAt: 0 });
    else {
      const detail = last.detail && typeof last.detail === 'object' && !Array.isArray(last.detail) ? last.detail : undefined;
      error = typeof last.detail === 'string' && last.detail ? last.detail
        : typeof detail?.message === 'string' ? detail.message
          : `The response could not finish (${last.reason}). You can send another message to continue.`;
    }
  }
  if (cancelled && last?.status !== 'unanswered') messages.push({ id: `submission-${last?.id}`, role: 'notice', text: 'Response stopped', createdAt: 0 });
  const unfinished = hasPendingWork(cached);
  const sharedMessages = shareMessages(messages, previous?.messages);
  const busy = unfinished && scheduling;
  const pending = unfinished && !scheduling;
  let conversation = previous;
  if (!previous || previous.title !== title || previous.messages !== sharedMessages ||
      previous.settings !== cached.settings || previous.busy !== busy || previous.pending !== pending || previous.error !== error) {
    conversation = { id, title, settings: cached.settings, messages: sharedMessages, busy, pending, ...(error ? { error } : {}) };
  }
  const summary = cached.metadata.archived ? undefined : { id, title,
    preview: committed.preview || 'Start a conversation',
    updatedAt: Math.max(cached.metadata.createdAt, committed.updatedAt) };
  return { conversation: conversation!, summary, committed };
}
