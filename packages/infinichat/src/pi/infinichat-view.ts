import { BACKGROUND_CONTEXT } from '@earendil-works/chord/context';
import type { JsonValue } from '@earendil-works/chord/json';
import {
  ResetEntry,
  type ConversationId, type ConversationView, type DocumentWatch, type EntryRecord, type Harness, type InboxItem,
  type InboxState, type TaskGraphWatch, type TranscriptItem,
} from '@earendil-works/pi-durable';
import { bool, nul, obj, str, union, type Static } from '@earendil-works/pi-schema';

import { ChatControlsProperties, type ChatMessage } from '../chat/types';
import { ChatMetadataDoc, type ChatMetadata } from './chat-metadata';
import { projectControls, projectMessages, queuedRow, readConversationView, type ChatState } from './chat-projection';
import { WatchedView } from './chat-view';
import { AGENT_TASK } from './infinichat/agents';
import { AppDoc, DeliveryEntry, InputDoc, turnOpen, type Admission, type AppState } from './infinichat/app';
import { ConfigDoc, type OptChatConfig } from './infinichat/summary';
import { ChatModelSettingsSchema } from './model-catalog';
import { SearchPresentationsDoc, type SearchPresentationsState } from './native-web-search/durable';

const context = BACKGROUND_CONTEXT;
const workRow = (message: ChatMessage): ChatMessage => ({ ...message, role: 'work' });

export const InfiniChatControlsSchema = obj({
  ...ChatControlsProperties,
  /** The summary model and effort, or `null` until they are chosen. */
  summary: union([ChatModelSettingsSchema, nul()]),
  /** The user's own instructions that follow the prompt; empty until written. */
  instructions: str(),
  /** The name the user gave the agent; empty for InfiniChat. */
  name: str(),
  /** What subagents run on, or `null` for the main model and effort. */
  subagents: union([ChatModelSettingsSchema, nul()]),
  /** The main and summary models are both chosen; InfiniChat sends and builds nothing before. */
  configured: bool(),
}, { open: true });
export type InfiniChatControls = Static<typeof InfiniChatControlsSchema>;

/** The request a queued delivery is for: its inbox item carries the entry it will be placed as. */
function queuedRequest(entry: { readonly kind: string; readonly data?: JsonValue } | undefined): string | undefined {
  if (entry?.kind !== DeliveryEntry.kind) return undefined;
  const data = entry.data;
  if (data === null || typeof data !== 'object' || Array.isArray(data)) return undefined;
  return typeof data.requestId === 'string' ? data.requestId : undefined;
}

/** The requests placed as delivery entries or queued as deliveries in the inbox. */
function deliveredRequests(entries: readonly EntryRecord[], inbox: InboxState | undefined): Set<string> {
  const requests = new Set(entries.flatMap((entry) => DeliveryEntry.is(entry) ? [entry.data.requestId] : []));
  for (const item of inbox?.items ?? []) {
    const requestId = item.mode === 'write' ? undefined : queuedRequest(item.entry);
    if (requestId !== undefined) requests.add(requestId);
  }
  return requests;
}

/**
 * InfiniChat's transcript items as the transcript shows them. A delivery shows the input the user sent, never the saved
 * view and turn state ahead of it, and the reset that begins each fresh turn summarizes nothing.
 */
function shownItems(items: readonly TranscriptItem[], originals: ReadonlyMap<string, Admission>): TranscriptItem[] {
  return items.flatMap((item): TranscriptItem[] => {
    if (item.kind !== 'entry') return [item];
    const { entry } = item;
    if (ResetEntry.is(entry)) return [];
    if (!DeliveryEntry.is(entry)) return [item];
    const original = originals.get(entry.data.requestId);
    const delivered = entry.model?.[0];
    if (original === undefined || delivered?.role !== 'user') return [];
    return [{ kind: 'entry', entry: { ...entry, model: [{ ...delivered, content: original.content }] } }];
  });
}

/** The inbox with each queued delivery showing its original input, as `shownEntries` does once it is placed. */
function shownInbox(inbox: InboxState | undefined, originals: ReadonlyMap<string, Admission>): InboxState | undefined {
  return inbox && { items: inbox.items.flatMap((item): InboxItem[] => {
    if (item.mode === 'write') return [item];
    const requestId = queuedRequest(item.entry);
    if (requestId === undefined) return [item];
    const original = originals.get(requestId);
    return original === undefined ? [] : [{ ...item, content: original.content }];
  }) };
}

type InfiniChatWatches = {
  metadata: DocumentWatch<ChatMetadata> | undefined;
  app: DocumentWatch<AppState> | undefined;
  config: DocumentWatch<OptChatConfig> | undefined;
  /** OpenAI's hosted searches by response, as `ChatView` reads them. */
  search: DocumentWatch<SearchPresentationsState> | undefined;
  /** pi-durable's live tasks, for the agents at work, as the keep-alive counts them. */
  tasks: TaskGraphWatch;
};

/**
 * InfiniChat's one conversation while something shows it, as `ChatView` shows a chat (`WatchedView`): pi-durable's
 * conversation view, the chat metadata and web search documents, OptChat's application and summary-model documents
 * and the task graph, with a `ConversationTranscript` kept across attachments. OptChat accepts an input before its
 * coordinator submits it, so accepted inputs from `AppDoc.pending` show as queued rows.
 */
export class InfiniChatView extends WatchedView<InfiniChatControls, InfiniChatWatches> {
  /** Each request's admission, whose input and kind its `InputDoc` keeps unchanged, so a later subscriber reuses it. */
  private readonly originals = new Map<string, Admission>();
  private readonly reading = new Set<string>();

  constructor(harness: Harness, id: ConversationId) {
    super(harness, id, true);
  }

  protected async attach(): Promise<InfiniChatWatches> {
    const [metadata, app, config, search, tasks] = await Promise.all([
      this.harness.watchDoc(ChatMetadataDoc, this.id, context),
      this.harness.watchDoc(AppDoc, this.id, context),
      this.harness.watchDoc(ConfigDoc, this.id, context),
      this.harness.watchDoc(SearchPresentationsDoc, this.id, context),
      this.harness.watchTaskGraph(context),
    ]);
    return { metadata, app, config, search, tasks };
  }

  protected handles({ metadata, app, config, search, tasks }: InfiniChatWatches) {
    return [metadata, app, config, search, tasks];
  }

  protected present({ metadata }: InfiniChatWatches) {
    return metadata?.value !== undefined;
  }

  /** Inputs read before the first projection show with the transcript rather than after it. */
  protected async prepare() {
    await this.readOriginals(this.collect(this.shown?.items ?? []).requests);
  }

  /** Reads the original input of each request not read yet; resolves whether any was added. */
  private async readOriginals(requestIds: Iterable<string>): Promise<boolean> {
    const unread = [...new Set(requestIds)].filter((id) => !this.originals.has(id) && !this.reading.has(id));
    const added = await Promise.all(unread.map(async (requestId) => {
      this.reading.add(requestId);
      try {
        const admission = await this.harness.snapshot(InputDoc, this.id, requestId, context);
        if (!admission?.value) return false;
        this.originals.set(requestId, admission.value);
        return true;
      } finally {
        this.reading.delete(requestId);
      }
    }));
    return added.includes(true);
  }

  /** The entries held, and every request whose original input the projection shows. */
  private collect(items: readonly TranscriptItem[]) {
    const entries = items.flatMap((item) => item.kind === 'entry' ? [item.entry] : []);
    const view = this.conversation;
    const delivered = deliveredRequests(entries, view && readConversationView(view).inbox);
    const pending = this.watches?.app?.value.pending ?? [];
    return { delivered, pending, requests: [...delivered, ...pending] };
  }

  protected project(view: ConversationView, watches: InfiniChatWatches) {
    const shown = this.shown;
    if (!shown) return undefined;
    const docs = readConversationView(view);
    const { delivered, pending, requests } = this.collect(shown.items);
    if (requests.some((requestId) => !this.originals.has(requestId))) {
      this.readOriginals(requests).then((added) => {
        if (added) this.schedule();
      }, this.failing());
    }
    const state: ChatState = { id: this.id, ...docs, inbox: shownInbox(docs.inbox, this.originals),
      metadata: watches.metadata?.value, search: watches.search?.value };
    const controls = projectControls(state, view.entries);
    const config = watches.config?.value;
    const summary = config?.summary ?? null;
    const app = watches.app?.value;
    this.controls = {
      ...controls,
      // An accepted input waits for its turn's summaries or the coordinator before pi-durable runs it, the coordinator
      // closes a turn after its run (logging what it left), and agents work in the background; a stop cancels them,
      // so the conversation is working, and a run that ended is continued only once its turn is closed.
      busy: controls.busy || (app !== undefined && turnOpen(app))
        || Object.values(watches.tasks.value.tasks).some((task) => task.kind === AGENT_TASK),
      summary,
      instructions: docs.agent?.instructions ?? '',
      name: config?.name ?? '',
      subagents: config?.subagents ?? null,
      configured: docs.agent?.model !== undefined && summary !== null,
    };
    // An agent's report is UniiChat's work message; its delivery row is the agent's, not the user's. Each delivery's
    // row says whether its input opened a turn of its own, from its admission.
    const items = shownItems(shown.items, this.originals);
    const deliveries = new Map<string, { requestId: string; kind: Admission['kind'] }>(items.flatMap((item) =>
      item.kind === 'entry' && DeliveryEntry.is(item.entry) ? [[`${item.entry.id}-0`, item.entry.data]] : []));
    const messages = projectMessages(state, items).map((message) => {
      const delivery = deliveries.get(message.id);
      if (delivery === undefined) return message;
      const fresh = this.originals.get(delivery.requestId)?.fresh;
      const placed = fresh === undefined ? message : { ...message, fresh };
      return delivery.kind === 'work' ? workRow(placed) : placed;
    });
    for (const requestId of pending) {
      const original = this.originals.get(requestId);
      if (original === undefined || delivered.has(requestId)) continue;
      const row = queuedRow(`pending-${requestId}`, original.content, { mode: 'pending' });
      messages.push(original.kind === 'work' ? workRow(row) : row);
    }
    this.messages = messages;
    return 'ready';
  }
}
