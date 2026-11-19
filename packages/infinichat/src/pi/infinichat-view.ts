import { BACKGROUND_CONTEXT } from '@earendil-works/chord/context';
import type { JsonValue } from '@earendil-works/chord/json';
import {
  ROOT_CONVERSATION_ID, ResetEntry,
  type ConversationId, type ConversationView, type DocumentWatch, type EntryRecord, type Harness, type InboxItem,
  type InboxState, type TranscriptItem,
} from '@earendil-works/pi-durable';
import { bool, compile, nul, obj, str, union, type Static } from '@earendil-works/pi-schema';

import { ChatControlsProperties, type ChatMessage } from '../chat/types';
import { ChatMetadataDoc, type ChatMetadata } from './chat-metadata';
import { projectControls, projectMessages, queuedRow, readConversationView, type ChatState } from './chat-projection';
import { WatchedView } from './chat-view';
import { TreeDoc, USER, agentNamed, type Tree } from './infinichat/agents';
import { AppDoc, DeliveryEntry, InputDoc, turnOpen, type Admission, type AppState } from './infinichat/app';
import { MemoryDoc, type MemoryState } from './infinichat/memory';
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
  /** The name the user gave InfiniChat; empty for InfiniChat. */
  name: str(),
  /** Whose chat this is, by the agent's name in the tree: `root`, which alone takes the user's messages, or a child. */
  agent: str(),
  /** This agent's model and the summary model are both chosen; InfiniChat sends and builds nothing before. */
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

/**
 * What a message waits for while no run has it: its turn starts once every earlier message has its line in memory
 * (`memoryReady`), which the summary model writes or, while it fails, doesn't.
 */
function waitingOnMemory(memory: MemoryState | undefined): string | undefined {
  if (memory === undefined || memory.frontier >= memory.nextMessage) return undefined;
  if (memory.stalled !== null) return `Memory can’t be written: ${memory.stalled.slice(0, 200)}`;
  const left = memory.pendingLeaves.length;
  return `Writing memory · ${left} ${left === 1 ? 'line' : 'lines'} left`;
}

/** A `tell` call's arguments, as its row shows them (`toolInput`'s JSON), also while they stream. */
const tellArguments = compile(obj({ name: str(), message: str() }, { open: true }));
function told(args: string): { name: string; message: string } | undefined {
  try {
    const parsed: unknown = JSON.parse(args);
    return tellArguments.check(parsed) ? parsed : undefined;
  } catch {
    return undefined;
  }
}

/**
 * An agent's rows as UniiChat's terse view shows its chat: what it tells its parent, the user for root, is its message,
 * and a reply, which it keeps for itself, is a step of its work, shown with its thinking. A reply from before `since`
 * is from a chat older than the tree, where it answered the user, and stays a message.
 */
function spoken(rows: readonly ChatMessage[], parent: string, since: number): ChatMessage[] {
  return rows.map((row): ChatMessage => {
    if (row.role === 'tool' && row.tool?.name === 'tell' && row.tool.status !== 'error') {
      const sent = told(row.tool.args);
      if (sent?.name !== parent) return row;
      return { id: row.id, role: 'assistant', text: sent.message, createdAt: row.createdAt,
        streaming: row.tool.status === 'running' };
    }
    if (row.role !== 'assistant' || row.text === '' || row.createdAt < since) return row;
    return { ...row, text: '', thinking: row.thinking ? `${row.thinking}\n\n${row.text}` : row.text };
  });
}

type InfiniChatWatches = {
  metadata: DocumentWatch<ChatMetadata> | undefined;
  app: DocumentWatch<AppState> | undefined;
  /** OptChat's memory, for what an accepted input waits on. */
  memory: DocumentWatch<MemoryState> | undefined;
  /** The whole tree's settings and its agents, which root's conversation keeps. */
  config: DocumentWatch<OptChatConfig> | undefined;
  tree: DocumentWatch<Tree> | undefined;
  /** OpenAI's hosted searches by response, as `ChatView` reads them. */
  search: DocumentWatch<SearchPresentationsState> | undefined;
};

/**
 * One agent's chat while something shows it, root's or a child's, as `ChatView` shows a chat (`WatchedView`):
 * pi-durable's conversation view, the chat metadata and web search documents, and OptChat's application, memory,
 * settings and tree documents, with a `ConversationTranscript` kept across attachments. OptChat accepts an input
 * before its coordinator submits it, so accepted inputs from `AppDoc.pending` show as queued rows.
 */
export class InfiniChatView extends WatchedView<InfiniChatControls, InfiniChatWatches> {
  /** Each request's admission, whose input and kind its `InputDoc` keeps unchanged, so a later subscriber reuses it. */
  private readonly originals = new Map<string, Admission>();
  private readonly reading = new Set<string>();

  constructor(harness: Harness, id: ConversationId) {
    super(harness, id, true);
  }

  protected async attach(): Promise<InfiniChatWatches> {
    const [metadata, app, memory, config, tree, search] = await Promise.all([
      this.harness.watchDoc(ChatMetadataDoc, this.id, context),
      this.harness.watchDoc(AppDoc, this.id, context),
      this.harness.watchDoc(MemoryDoc, this.id, context),
      this.harness.watchDoc(ConfigDoc, ROOT_CONVERSATION_ID, context),
      this.harness.watchDoc(TreeDoc, ROOT_CONVERSATION_ID, context),
      this.harness.watchDoc(SearchPresentationsDoc, this.id, context),
    ]);
    return { metadata, app, memory, config, tree, search };
  }

  protected handles({ metadata, app, memory, config, tree, search }: InfiniChatWatches) {
    return [metadata, app, memory, config, tree, search];
  }

  /** Every agent's conversation has its application document from the commit that made it; only root has metadata. */
  protected present({ app, tree }: InfiniChatWatches) {
    return app?.value !== undefined && tree !== undefined && agentNamed(tree.value.agents, this.id) !== undefined;
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
    const tree = watches.tree?.value;
    const agent = tree && agentNamed(tree.agents, this.id);
    if (tree === undefined || agent === undefined) return 'missing';
    const { parent } = tree.agents[agent];
    const state: ChatState = { id: this.id, ...docs, inbox: shownInbox(docs.inbox, this.originals),
      metadata: watches.metadata?.value, search: watches.search?.value };
    const controls = projectControls(state, view.entries);
    const config = watches.config?.value;
    const summary = config?.summary ?? null;
    const app = watches.app?.value;
    const unsent = pending.some((requestId) => !delivered.has(requestId));
    const waiting = !controls.busy && unsent ? waitingOnMemory(watches.memory?.value) : undefined;
    this.controls = {
      ...controls,
      // Only root's conversation has a title of its own; a child's chat goes by its name.
      ...(parent === null ? {} : { title: agent }),
      ...(waiting === undefined ? {} : { waiting }),
      // An accepted input waits for its turn's summaries or the coordinator before pi-durable runs it, and the
      // coordinator closes a turn after its run (logging what it left), so the agent is working, and a run that ended
      // is continued only once its turn is closed.
      busy: controls.busy || (app !== undefined && turnOpen(app)),
      summary,
      instructions: docs.agent?.instructions ?? '',
      name: config?.name ?? '',
      agent,
      configured: docs.agent?.model !== undefined && summary !== null,
    };
    // A child's message is UniiChat's work message; its delivery row is the child's, not the parent's. Each delivery's
    // row says whether its input opened a turn of its own, from its admission.
    const items = shownItems(shown.items, this.originals);
    const deliveries = new Map<string, { requestId: string; kind: Admission['kind'] }>(items.flatMap((item) =>
      item.kind === 'entry' && DeliveryEntry.is(item.entry) ? [[`${item.entry.id}-0`, item.entry.data]] : []));
    const rows = spoken(projectMessages(state, items), parent ?? USER, parent === null ? tree.since?.at ?? 0 : 0);
    const messages = rows.map((message) => {
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
