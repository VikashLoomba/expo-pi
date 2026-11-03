import type { AssistantMessage, ToolResultMessage, UserMessage } from '@earendil-works/pi-ai';
import {
  AgentDoc, CompactionEntry, InboxDoc, LiveDoc, ResetEntry,
  type AgentState, type ConversationId, type ConversationView, type EntryId, type EntryRecord,
  type InboxState, type LiveState, type RunFailure, type TaskId, type TranscriptItem,
} from '@earendil-works/pi-durable';
import { CODEMODE_TOOL_NAME } from '@earendil-works/pi-durable/codemode';
import { compile, obj, str } from '@earendil-works/pi-schema';

import type { ChatControls, ChatMessage, ChatSummary } from '../chat/types';
import type { WebSearchPresentation } from '../chat/web-search-types';
import type { ChatMetadata } from './chat-metadata';
import {
  DEFAULT_LOCAL_ROOT, executionSettings, type ExecutionTargetState, type LocalRoot,
} from './execution/document';
import { fileToolPresentation, withFileToolDetails } from './file-tool-presentation';
import type { ChatModelSettings } from './model-catalog';
import type { SearchPresentationsState } from './native-web-search/documents';
import { isSearchObservationEntry } from './native-web-search/entries';
import { hasSearchActivity, toWebSearchPresentation } from './native-web-search/presentation';
import { imagesOf, textOf } from './user-input';

/** Code mode's arguments, `{ code }` (durable `src/codemode/codemode.ts`). */
const codemodeArguments = compile(obj({ code: str() }, { open: true }));

/** A call's input as its step shows it: a code mode script as the source the model wrote, any other as JSON. */
function toolInput(name: string, args: unknown): string {
  return name === CODEMODE_TOOL_NAME && codemodeArguments.check(args) ? args.code : JSON.stringify(args, null, 2);
}

/** Committed state of one chat: its conversation view's documents and the chat's app documents. */
export type ChatState = {
  readonly id: ConversationId;
  readonly metadata?: Readonly<ChatMetadata>;
  readonly agent?: Readonly<AgentState>;
  readonly execution?: Readonly<ExecutionTargetState>;
  readonly live?: Readonly<LiveState>;
  readonly inbox?: Readonly<InboxState>;
  readonly search?: Readonly<SearchPresentationsState>;
};

const SUMMARIZED_NOTICE = 'Earlier messages summarized';

/**
 * The built-in documents of a conversation view, published with its entries in one revision so a row never shows
 * a streamed partial beside its saved entry. The view keys them by kind as JSON whose shapes pi-durable defines.
 */
export function readConversationView(view: { readonly docs: ConversationView['docs'] }) {
  // pi-durable reads its view this way in its own example, test/examples/20-late-join.ts.
  return {
    live: view.docs[LiveDoc.definition.kind] as LiveState | undefined,
    agent: view.docs[AgentDoc.definition.kind] as AgentState | undefined,
    inbox: view.docs[InboxDoc.definition.kind] as InboxState | undefined,
  };
}

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
 * What the screens say about the last run that ended without an answer (pi-durable README "Busy Conversations"), or
 * nothing for a continue that found nothing to answer. A failed response's own error shows in the transcript.
 */
function runFailureMessage(failure: Readonly<RunFailure>, entries: readonly EntryRecord[]): string | undefined {
  const { detail } = failure;
  switch (failure.reason) {
    case 'nothing_to_answer':
      return undefined;
    case 'aborted':
      return 'Response stopped.';
    case 'model_error': {
      const shown = entries.some((entry) => entry.byTaskId === failure.taskId
        && entry.model?.some((message) => message.role === 'assistant' && message.stopReason === 'error'));
      return shown || !detail ? 'The response failed.' : detail;
    }
    case 'no_model':
      return `${detail ? `The model ${detail}` : 'This chat’s model'} is not available. `
        + 'Choose another in its settings.';
    case 'interrupted':
      return 'The response was interrupted while the model was answering.';
    case 'restart_limit':
      return 'The response stopped after it was interrupted several times in a row.';
    case 'turn_limit':
      return `The response reached its limit of ${detail ?? 'tool rounds'}.`;
    case 'faulted':
      return detail || 'The response failed.';
    case 'orphaned':
      return 'This version of the app can’t continue that response.';
    case 'reset':
      return 'The conversation was reset before the response finished.';
  }
}

/** `entries` are the newest the client holds, which include the last run's. */
export function projectControls(state: ChatState, entries: readonly EntryRecord[],
  localRoot: LocalRoot = DEFAULT_LOCAL_ROOT): ChatControls {
  const compaction = state.live?.compactionFailure;
  const failure = state.live?.runFailure;
  const message = failure && runFailureMessage(failure, entries);
  return {
    id: state.id,
    title: state.metadata?.title || 'New chat',
    settings: settingsOf(state.agent),
    execution: executionSettings(state.execution, state.agent, localRoot),
    busy: state.live?.run !== undefined,
    compacting: (state.live?.compactions?.length ?? 0) > 0,
    // pi-durable waits before retrying a failed request; the failed attempt is not an answer.
    retrying: state.live?.generation?.retry !== undefined,
    ...(compaction ? { error: `Could not summarize earlier messages: ${compaction.error}` } : {}),
    ...(failure && message ? { runFailure: { reason: failure.reason, message } } : {}),
  };
}

function userRows(message: UserMessage, key: string): ChatMessage[] {
  const text = textOf(message.content);
  const images = imagesOf(message.content);
  if (!text && !images.length) return [];
  return [{ id: key, role: 'user', text, createdAt: message.timestamp, ...(images.length ? { images } : {}) }];
}

/** `read` answers an image file with one image block; the diagnostics that follow it stay the text output. */
function toolResultRow(message: ToolResultMessage, key: string, call: ChatMessage | undefined): ChatMessage {
  const output = textOf(message.content);
  const images = imagesOf(message.content);
  const status = message.isError ? 'error' : 'completed';
  if (!call?.tool) {
    return { id: key, role: 'tool', text: output, createdAt: message.timestamp, ...(images.length ? { images } : {}),
      tool: { name: message.toolName, args: '', output, status } };
  }
  // Rows are JSON, which has no `undefined`: Chord diffs them when they cross a link.
  const file = withFileToolDetails(call.tool.file, message.details);
  return { ...call, text: output, ...(images.length ? { images } : {}),
    tool: { ...call.tool, output, status, ...(file ? { file } : {}) } };
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
    const args = file ? '' : toolInput(part.name, part.arguments);
    rows.push({ id: `${key}-tool-${part.id}`, role: 'tool', text: '', createdAt: message.timestamp,
      tool: { name: part.name, args, output: '', status: 'running', ...(file ? { file } : {}) } });
  }
  return rows;
}

/**
 * A transcript item that is not an entry, as a row that loads it (`ChatMessage.history`). Its ID names what it stands
 * before, so a page that leaves more to load makes a new row, which loads again while it is in view.
 */
function historyRow(item: Exclude<TranscriptItem, { kind: 'entry' }>, next: TranscriptItem | undefined): ChatMessage {
  if (item.kind === 'earlier') {
    return { id: `history-earlier-${next?.kind === 'entry' ? next.entry.id : 'start'}`, role: 'notice',
      text: 'Earlier messages', createdAt: 0, history: { kind: 'earlier' } };
  }
  const { after, upTo } = item;
  return { id: `history-${after}-${upTo}`, role: 'notice', text: 'More messages', createdAt: 0,
    history: { kind: 'gap', after, upTo } };
}

/**
 * Derive transcript rows from a client's transcript (pi-durable's `ConversationTranscript` items, in entry order) and
 * live documents. Row IDs stay stable as a streamed partial becomes a saved entry and as earlier pages load: a
 * generation's assistants are numbered in order, and its partial takes the next number.
 */
export function projectMessages(state: ChatState, items: readonly TranscriptItem[]): ChatMessage[] {
  const messages: ChatMessage[] = [];
  const calls = new Map<string, number>();
  const assistants = new Map<TaskId, number>();
  /** The next assistant's row ID: its generation's, or its entry's for one no generation wrote. */
  const assistantKey = (taskId: TaskId | undefined, fallback: string) => {
    if (taskId === undefined) return `assistant-${fallback}`;
    const ordinal = assistants.get(taskId) ?? 0;
    assistants.set(taskId, ordinal + 1);
    return `assistant-${taskId}-${ordinal}`;
  };
  const entries = items.flatMap((item) => item.kind === 'entry' ? [item.entry] : []);
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
  for (const [position, item] of items.entries()) {
    if (item.kind !== 'entry') {
      messages.push(historyRow(item, items[position + 1]));
      continue;
    }
    const { entry } = item;
    if (isSearchObservationEntry(entry)) continue;
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
      const key = assistantKey(entry.byTaskId, `${entry.id}-${index}`);
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
    const key = assistantKey(runTask, 'partial');
    pushAssistant(assistantRows(partial, key, true, webSearchFor(partial.responseId)), key, partial);
  }
  // A busy run whose current response has search activity but no partial yet shows a live search row.
  const liveSearchId = runTask !== undefined && state.search?.live?.taskId === runTask
    ? state.search.live.responseId : undefined;
  if (liveSearchId !== undefined && liveSearchId !== partial?.responseId && !represented.has(liveSearchId)) {
    const presentation = presentations[liveSearchId];
    if (presentation && hasSearchActivity(presentation)) {
      const key = assistantKey(runTask, 'search');
      messages.push({ id: key, role: 'assistant', text: '', createdAt, streaming: true,
        webSearch: toWebSearchPresentation(presentation) });
    }
  }
  for (const slot of state.live?.tools ?? []) {
    const index = calls.get(slot.callId);
    const message = index === undefined ? undefined : messages[index];
    if (message?.tool && index !== undefined && slot.status !== 'done') {
      const file = withFileToolDetails(message.tool.file, slot.details);
      messages[index] = { ...message, tool: { ...message.tool, output: slot.output ?? '', status: 'running',
        ...(file ? { file } : {}) } };
    }
  }
  // Queued inputs wait in the inbox for a turn boundary; write items are evidence for the model, never rows.
  for (const item of state.inbox?.items ?? []) {
    if (item.mode === 'write') continue;
    messages.push(queuedRow(`queued-${item.id}`, item.content, { submissionId: item.id, mode: item.mode }));
  }
  return messages;
}

/** An input that waits to be placed, shown as the user sent it. */
export function queuedRow(id: string, content: UserMessage['content'],
  queued: NonNullable<ChatMessage['queued']>): ChatMessage {
  const images = imagesOf(content);
  return { id, role: 'user', text: textOf(content), createdAt: 0, ...(images.length ? { images } : {}), queued };
}
