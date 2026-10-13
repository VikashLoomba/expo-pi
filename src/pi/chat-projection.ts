import type { AssistantMessage, Message, ToolResultMessage, UserMessage } from '@earendil-works/pi-ai';
import {
  AgentDoc, CompactionEntry, InboxDoc, LiveDoc, ResetEntry,
  type AgentState, type ConversationId, type ConversationView, type EntryId, type EntryRecord,
  type InboxState, type LiveState, type SubmissionRecord,
} from '@earendil-works/pi-durable';

import { fileToolPresentation, withFileToolDetails } from '../chat/file-tool-presentation';
import type { ChatControls, ChatMessage, ChatSummary } from '../chat/types';
import type { WebSearchPresentation } from '../chat/web-search-types';
import type { ChatMetadata } from './chat-metadata';
import { executionSettings, type ExecutionTargetState } from './execution/document';
import type { ChatModelSettings } from './model-catalog';
import type { SearchPresentationsState } from './native-web-search/documents';
import { isSearchObservationEntry } from './native-web-search/entries';
import { hasSearchActivity, toWebSearchPresentation } from './native-web-search/presentation';

/** Committed state of one chat: its conversation view, app documents and the record of its latest input. */
export type ChatState = {
  readonly id: ConversationId;
  readonly metadata?: Readonly<ChatMetadata>;
  readonly agent?: Readonly<AgentState>;
  readonly execution?: Readonly<ExecutionTargetState>;
  readonly live?: Readonly<LiveState>;
  readonly inbox?: Readonly<InboxState>;
  readonly search?: Readonly<SearchPresentationsState>;
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
    inbox: view.docs[InboxDoc.definition.kind] as InboxState | undefined,
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

/** Why the latest input went unanswered, unless a saved assistant entry or stop notice already shows it. */
function submissionError(submission: SubmissionRecord | undefined, entries: readonly EntryRecord[]): string | undefined {
  if (submission?.status !== 'unanswered' || submission.reason === 'aborted') return undefined;
  const { detail, entry: placed } = submission;
  let error = `The response could not finish (${submission.reason}). You can send another message to continue.`;
  if (typeof detail === 'string' && detail) error = detail;
  else if (detail && typeof detail === 'object' && !Array.isArray(detail) && typeof detail.message === 'string') {
    error = detail.message;
  }
  // A blocking compaction can fail without an assistant entry, so model_error alone cannot hide an error.
  const represented = submission.reason === 'model_error' && placed !== undefined && entries.some((entry) =>
    entry.id > placed && entry.model?.some((message) => message.role === 'assistant' && message.stopReason === 'error'
      && (!message.errorMessage || message.errorMessage === error)));
  return represented ? undefined : error;
}

export function projectControls(state: ChatState, entries: readonly EntryRecord[]): ChatControls {
  const failure = state.live?.compactionFailure;
  const error = submissionError(state.submission, entries)
    ?? (failure ? `Could not summarize earlier messages: ${failure.error}` : undefined);
  return {
    id: state.id,
    title: state.metadata?.title || 'New chat',
    settings: settingsOf(state.agent),
    execution: executionSettings(state.execution, state.agent),
    busy: state.live?.run !== undefined,
    compacting: (state.live?.compactions?.length ?? 0) > 0,
    // pi-durable waits before retrying a failed request; the failed attempt is not an answer.
    retrying: state.live?.generation?.retry !== undefined,
    ...(error ? { error } : {}),
  };
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
  webSearch?: WebSearchPresentation): ChatMessage[] {
  const rows: ChatMessage[] = [];
  const text = message.content.flatMap((part) => part.type === 'text' ? [part.text] : []).join('');
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

/**
 * Derive transcript rows from committed entries (ascending IDs) and live documents. Row IDs stay stable as a
 * streamed partial becomes a saved entry: assistants are numbered in order, and the partial takes the next number.
 */
export function projectMessages(state: ChatState, entries: readonly EntryRecord[]): ChatMessage[] {
  const messages: ChatMessage[] = [];
  const calls = new Map<string, number>();
  let assistantCount = 0;
  const createdAt = state.metadata?.createdAt ?? 0;
  const presentations = state.search?.responses ?? {};
  const webSearchFor = (responseId: string | undefined): WebSearchPresentation | undefined => {
    if (responseId === undefined) return undefined;
    const presentation = presentations[responseId];
    return presentation && hasSearchActivity(presentation)
      ? toWebSearchPresentation(presentation) : undefined;
  };

  // Search observation entries are evidence for the model, never transcript rows.
  const visible = entries.filter((entry) => !isSearchObservationEntry(entry));
  const represented = new Set(visible.flatMap((entry) => entry.model?.flatMap((message) =>
    message.role === 'assistant' && message.responseId ? [message.responseId] : []) ?? []));
  const runTask = state.live?.run?.taskId;
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
  const pushAssistant = (rows: readonly ChatMessage[], key: string, message: AssistantMessage) => {
    const start = messages.length;
    messages.push(...rows);
    for (const part of message.content) {
      if (part.type !== 'toolCall') continue;
      const offset = rows.findIndex((row) => row.id === `${key}-tool-${part.id}`);
      if (offset >= 0) calls.set(part.id, start + offset);
    }
  };
  for (const entry of visible) {
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
      const webSearch = webSearchFor(message.responseId);
      if (message.stopReason === 'error' && retried(entry)) {
        // A failed attempt's answer stays hidden; its searches remain as an interrupted row.
        if (webSearch) {
          messages.push({ id: key, role: 'assistant', text: '', createdAt: message.timestamp,
            streaming: false, interrupted: true, webSearch });
        }
        return;
      }
      pushAssistant(assistantRows(message, key, false, webSearch), key, message);
    });
  }

  const partial = state.live?.generation?.message;
  if (partial) {
    const key = `assistant-${assistantCount++}`;
    pushAssistant(assistantRows(partial, key, true, webSearchFor(partial.responseId)), key, partial);
  }
  // A busy run whose current response has search activity but no partial yet shows a live search row.
  const liveSearchId = runTask !== undefined && state.search?.live?.taskId === runTask
    ? state.search.live.responseId : undefined;
  if (liveSearchId !== undefined && liveSearchId !== partial?.responseId && !represented.has(liveSearchId)) {
    const presentation = presentations[liveSearchId];
    if (presentation && hasSearchActivity(presentation)) {
      const key = `assistant-${assistantCount++}`;
      messages.push({ id: key, role: 'assistant', text: '', createdAt, streaming: true,
        webSearch: toWebSearchPresentation(presentation) });
    }
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
  // Queued inputs wait in the inbox for a turn boundary; write items are evidence for the model, never rows.
  for (const item of state.inbox?.items ?? []) {
    if (item.mode === 'write') continue;
    messages.push({ id: `queued-${item.id}`, role: 'user', text: textOf(item.content), createdAt: 0,
      queued: { submissionId: item.id, mode: item.mode } });
  }
  return messages;
}
