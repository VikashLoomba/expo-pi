import { BACKGROUND_CONTEXT, type Context } from '@earendil-works/chord/context';
import type { JsonValue } from '@earendil-works/chord/json';
import {
  ROOT_CONVERSATION_ID, ResetEntry,
  type Conversation, type ConversationId, type ConversationView, type Cursor, type DocumentWatch, type EntryId,
  type EntryRecord, type Harness, type InboxItem, type InboxState, type TranscriptItem,
} from '@earendil-works/pi-durable';
import { arr, bool, compile, nul, num, obj, opt, str, union, type Static } from '@earendil-works/pi-schema';

import { ChatControlsProperties, ChatMessageSchema, type ChatMessage } from '../chat/types';
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

/**
 * Target upper bound for one Chord state snapshot or history RPC page: comfortably under Chord's 16 MiB untrusted
 * wire part limit so large inline images or long uptimes can never lock clients out.
 */
const MAX_WIRE_BYTES = 6 * 1024 * 1024;
/** Entries fetched per remote history page, matching pi-durable's `ConversationTranscript` default. */
const HISTORY_PAGE_SIZE = 50;
/** Cap on cached SDK-issued EntryIds kept for O(1) pagination boundary lookup on the server. */
const MAX_KNOWN_ENTRY_IDS = 4096;

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

/** Entry-ID span of a server's bounded live window; clients use `before` to page earlier history on demand. */
export const TranscriptBoundsSchema = obj({
  firstEntryId: opt(num()),
  lastEntryId: opt(num()),
  before: opt(num()),
}, { open: true });
export type TranscriptBounds = Static<typeof TranscriptBoundsSchema>;

/** Closed Chord method arguments for loading one historical page of projected `ChatMessage` rows. */
export const HistoryPageQuerySchema = obj({
  /** Inclusive newest entry ID for an earlier page (`TranscriptBounds.before` or prior page's `before`). */
  before: opt(num()),
  /** Exclusive start entry ID when filling a gap (`after < id < upTo`). */
  after: opt(num()),
  /** Exclusive end entry ID when filling a gap (`after < id < upTo`). */
  upTo: opt(num()),
});
export type HistoryPageQuery = Static<typeof HistoryPageQuerySchema>;

/** One bounded page of historical transcript rows returned by `loadHistory`, without synthetic history markers. */
export const HistoryPageSchema = obj({
  messages: arr(ChatMessageSchema),
  firstEntryId: opt(num()),
  lastEntryId: opt(num()),
  before: opt(num()),
  more: bool(),
}, { open: true });
export type HistoryPage = Static<typeof HistoryPageSchema>;

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

/**
 * Whether slicing an ascending entry list at `index` avoids separating a `toolResult` from its `assistant` call or
 * splitting retry attempts of the same generation task.
 */
function isCleanStart(entries: readonly EntryRecord[], index: number): boolean {
  if (index <= 0 || index >= entries.length) return true;
  const entry = entries[index];
  if (entry.model?.some((message) => message.role === 'toolResult')) return false;
  const previous = entries[index - 1];
  if (entry.byTaskId !== undefined && entry.byTaskId === previous.byTaskId
    && entry.model?.some((message) => message.role === 'assistant')) return false;
  return true;
}

/** Conservative wire-byte estimate of one entry after InfiniChat swaps envelopes for original inputs. */
function entryWireBytes(entry: EntryRecord, originals: ReadonlyMap<string, Admission>): number {
  if (ResetEntry.is(entry)) return 0;
  if (DeliveryEntry.is(entry)) {
    const original = originals.get(entry.data.requestId);
    return original === undefined ? 0 : JSON.stringify(original.content).length + 256;
  }
  return entry.model === undefined ? 0 : JSON.stringify(entry.model).length + 256;
}

/** Keeps the newest clean rounds of `entries` within `budget` bytes, returning the entry ID right before the cut. */
function trimFrontToBudget(
  entries: readonly EntryRecord[], originals: ReadonlyMap<string, Admission>, budget: number,
): { kept: readonly EntryRecord[]; before: EntryId | undefined } {
  if (entries.length === 0) return { kept: entries, before: undefined };
  let total = 0;
  let cut = entries.length;
  for (let end = entries.length; end > 0;) {
    let start = end - 1;
    while (start > 0 && !isCleanStart(entries, start)) start--;
    let roundBytes = 0;
    for (let index = start; index < end; index++) roundBytes += entryWireBytes(entries[index], originals);
    if (cut < entries.length && total + roundBytes > budget) break;
    total += roundBytes;
    cut = start;
    end = start;
  }
  return { kept: cut === 0 ? entries : entries.slice(cut), before: cut > 0 ? entries[cut - 1].id : undefined };
}

/** Keeps the oldest clean rounds of `entries` within `budget` bytes (used for ascending gap filling). */
function trimBackToBudget(
  entries: readonly EntryRecord[], originals: ReadonlyMap<string, Admission>, budget: number,
): { kept: readonly EntryRecord[]; truncated: boolean } {
  if (entries.length === 0) return { kept: entries, truncated: false };
  let total = 0;
  let cut = 0;
  for (let start = 0; start < entries.length;) {
    let end = start + 1;
    while (end < entries.length && !isCleanStart(entries, end)) end++;
    let roundBytes = 0;
    for (let index = start; index < end; index++) roundBytes += entryWireBytes(entries[index], originals);
    if (cut > 0 && total + roundBytes > budget) break;
    total += roundBytes;
    cut = end;
    start = end;
  }
  return { kept: cut === entries.length ? entries : entries.slice(0, cut), truncated: cut < entries.length };
}

/** Projects a slice of InfiniChat transcript items into UI rows using the same rules for live and historical pages. */
function projectInfiniChatRows(
  state: ChatState, rawItems: readonly TranscriptItem[], originals: ReadonlyMap<string, Admission>,
  parent: string | null, since: number,
): ChatMessage[] {
  const items = shownItems(rawItems, originals);
  const deliveries = new Map<string, { requestId: string; kind: Admission['kind'] }>(items.flatMap((item) =>
    item.kind === 'entry' && DeliveryEntry.is(item.entry) ? [[`${item.entry.id}-0`, item.entry.data]] : []));
  const rows = spoken(projectMessages(state, items), parent ?? USER, parent === null ? since : 0);
  return rows.map((message) => {
    const delivery = deliveries.get(message.id);
    if (delivery === undefined) return message;
    const fresh = originals.get(delivery.requestId)?.fresh;
    const placed = fresh === undefined ? message : { ...message, fresh };
    return delivery.kind === 'work' ? workRow(placed) : placed;
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
 * settings and tree documents. Locally on the phone (`windowed: false`), a `ConversationTranscript` accumulates
 * loaded history in-process; on a machine server (`windowed: true`), `messages` holds only the bounded live window
 * (kept under Chord's wire limit) and clients page older turns on demand through `loadHistory`.
 */
export class InfiniChatView extends WatchedView<InfiniChatControls, InfiniChatWatches> {
  /** Each request's admission, whose input and kind its `InputDoc` keeps unchanged, so a later subscriber reuses it. */
  private readonly originals = new Map<string, Admission>();
  private readonly reading = new Set<string>();
  /** Genuine SDK-issued `EntryId`s seen in live windows and history pages, for O(1) boundary lookups without casts. */
  private readonly knownEntries = new Map<number, EntryId>();
  private bounds?: TranscriptBounds;

  constructor(harness: Harness, id: ConversationId, private readonly windowed = false) {
    super(harness, id, !windowed);
  }

  /** Entry-ID span of the live window in windowed mode; undefined until projected or in local transcript mode. */
  getBounds(): TranscriptBounds | undefined {
    return this.bounds;
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
    const entries = this.windowed
      ? (this.conversation?.entries ?? [])
      : (this.shown?.items ?? []).flatMap((item) => item.kind === 'entry' ? [item.entry] : []);
    await this.readOriginals(this.collectEntries(entries).requests);
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

  /** Reads admissions for a stateless history page into a temporary map so historical photos never stay pinned in RAM. */
  private async readPageOriginals(
    entries: readonly EntryRecord[], loadContext: Context,
  ): Promise<Map<string, Admission>> {
    const result = new Map<string, Admission>();
    const unread: string[] = [];
    for (const entry of entries) {
      if (!DeliveryEntry.is(entry)) continue;
      const { requestId } = entry.data;
      if (result.has(requestId)) continue;
      const cached = this.originals.get(requestId);
      if (cached !== undefined) result.set(requestId, cached);
      else unread.push(requestId);
    }
    await Promise.all([...new Set(unread)].map(async (requestId) => {
      const admission = await this.harness.snapshot(InputDoc, this.id, requestId, loadContext);
      if (admission?.value) result.set(requestId, admission.value);
    }));
    return result;
  }

  private rememberEntryId(id: EntryId | undefined): void {
    if (id === undefined) return;
    if (this.knownEntries.has(id)) return;
    if (this.knownEntries.size >= MAX_KNOWN_ENTRY_IDS) {
      const oldest = this.knownEntries.keys().next().value;
      if (oldest !== undefined) this.knownEntries.delete(oldest);
    }
    this.knownEntries.set(id, id);
  }

  /** Looks up the genuine SDK-issued `EntryId` for `target` without minting one; falls back to scanning after restart. */
  private async resolveEntryId(
    conversation: Conversation, target: number, match: 'atOrBefore' | 'atOrAfter', loadContext: Context,
  ): Promise<EntryId | undefined> {
    const cached = this.knownEntries.get(target);
    if (cached !== undefined) return cached;
    let cursor: Cursor | undefined;
    let nearestAbove: EntryId | undefined;
    for (;;) {
      const page = await conversation.entries({ order: 'descending' }, 256, cursor, loadContext);
      for (const entry of page.items) {
        if (entry.id === target) {
          this.rememberEntryId(entry.id);
          return entry.id;
        }
        if (entry.id > target) {
          nearestAbove = entry.id;
          continue;
        }
        if (match === 'atOrBefore') {
          this.rememberEntryId(entry.id);
          return entry.id;
        }
        this.rememberEntryId(nearestAbove);
        return nearestAbove;
      }
      if (page.next === undefined) break;
      cursor = page.next;
    }
    if (match === 'atOrAfter') {
      this.rememberEntryId(nearestAbove);
      return nearestAbove;
    }
    return undefined;
  }

  /**
   * Loads one byte-bounded page of historical rows for a remote client without mutating this view's shared live state.
   * Supports earlier paging (`before`, inclusive) and gap filling (`after` exclusive .. `upTo` exclusive).
   */
  async loadHistory(query: HistoryPageQuery, loadContext: Context = context): Promise<HistoryPage> {
    const conversation = await this.harness.conversation(this.id, loadContext);
    if (!conversation) return { messages: [], more: false };
    const [tree, metadata, search] = await Promise.all([
      this.harness.snapshot(TreeDoc, ROOT_CONVERSATION_ID, loadContext),
      this.harness.snapshot(ChatMetadataDoc, this.id, loadContext),
      this.harness.snapshot(SearchPresentationsDoc, this.id, loadContext),
    ]);
    const agent = tree && agentNamed(tree.agents, this.id);
    if (tree === undefined || agent === undefined) return { messages: [], more: false };
    const { parent } = tree.agents[agent];
    const since = parent === null ? tree.since?.at ?? 0 : 0;
    const state: ChatState = { id: this.id, metadata, search };

    if (query.before !== undefined) {
      let cursorId = await this.resolveEntryId(conversation, query.before, 'atOrBefore', loadContext);
      while (cursorId !== undefined) {
        const page = await conversation.entries(
          { maxEntryId: cursorId, order: 'descending' }, HISTORY_PAGE_SIZE + 1, undefined, loadContext,
        );
        const ascending = [...page.items].reverse();
        for (const entry of ascending) this.rememberEntryId(entry.id);
        const extra = ascending.length > HISTORY_PAGE_SIZE ? ascending[0] : undefined;
        const batch = extra === undefined ? ascending : ascending.slice(1);
        if (batch.length === 0) return { messages: [], more: false };
        const pageOriginals = await this.readPageOriginals(batch, loadContext);
        const { kept, before: trimmedBefore } = trimFrontToBudget(batch, pageOriginals, MAX_WIRE_BYTES);
        const nextBefore = trimmedBefore ?? extra?.id;
        this.rememberEntryId(nextBefore);
        const rawItems: TranscriptItem[] = kept.map((entry) => ({ kind: 'entry', entry }));
        const messages = projectInfiniChatRows(state, rawItems, pageOriginals, parent, since);
        if (messages.length > 0 || nextBefore === undefined) {
          return {
            messages,
            ...(kept[0] === undefined ? {} : { firstEntryId: kept[0].id }),
            ...(kept.at(-1) === undefined ? {} : { lastEntryId: kept.at(-1)?.id }),
            ...(nextBefore === undefined ? {} : { before: nextBefore }),
            more: nextBefore !== undefined,
          };
        }
        cursorId = nextBefore;
      }
      return { messages: [], more: false };
    }

    if (query.after !== undefined && query.upTo !== undefined) {
      const upTo = query.upTo;
      let currentAfter = query.after;
      let afterId = await this.resolveEntryId(conversation, currentAfter, 'atOrAfter', loadContext);
      const upToId = await this.resolveEntryId(conversation, upTo, 'atOrBefore', loadContext);
      if (afterId === undefined || upToId === undefined || afterId >= upTo) {
        return { messages: [], more: false };
      }
      while (afterId !== undefined) {
        const page = await conversation.entries(
          { minEntryId: afterId, maxEntryId: upToId, order: 'ascending' }, HISTORY_PAGE_SIZE + 2, undefined,
          loadContext,
        );
        for (const entry of page.items) this.rememberEntryId(entry.id);
        const inside = page.items.filter((entry) => entry.id > currentAfter && entry.id < upTo);
        const hasExtra = inside.length > HISTORY_PAGE_SIZE
          || (page.next !== undefined && (page.items.at(-1)?.id ?? upTo) < upTo);
        const batch = inside.length > HISTORY_PAGE_SIZE ? inside.slice(0, HISTORY_PAGE_SIZE) : inside;
        if (batch.length === 0) return { messages: [], more: false };
        const pageOriginals = await this.readPageOriginals(batch, loadContext);
        const { kept, truncated } = trimBackToBudget(batch, pageOriginals, MAX_WIRE_BYTES);
        const more = truncated || hasExtra;
        const rawItems: TranscriptItem[] = kept.map((entry) => ({ kind: 'entry', entry }));
        const messages = projectInfiniChatRows(state, rawItems, pageOriginals, parent, since);
        const last = kept.at(-1);
        if (messages.length > 0 || !more || last === undefined) {
          return {
            messages,
            ...(kept[0] === undefined ? {} : { firstEntryId: kept[0].id }),
            ...(last === undefined ? {} : { lastEntryId: last.id }),
            more,
          };
        }
        currentAfter = last.id;
        afterId = last.id;
      }
    }

    return { messages: [], more: false };
  }

  /** The requests whose original input the projection shows for `entries`. */
  private collectEntries(entries: readonly EntryRecord[]) {
    const view = this.conversation;
    const delivered = deliveredRequests(entries, view && readConversationView(view).inbox);
    const pending = this.watches?.app?.value.pending ?? [];
    return { delivered, pending, requests: [...delivered, ...pending] };
  }

  protected project(view: ConversationView, watches: InfiniChatWatches) {
    let rawItems: readonly TranscriptItem[];
    let windowEntries: readonly EntryRecord[];
    if (this.windowed) {
      for (const entry of view.entries) this.rememberEntryId(entry.id);
      this.rememberEntryId(view.before);
      const { kept, before: trimmedBefore } = trimFrontToBudget(view.entries, this.originals, MAX_WIRE_BYTES);
      const before = trimmedBefore ?? view.before;
      this.rememberEntryId(before);
      this.bounds = {
        ...(kept[0] === undefined ? {} : { firstEntryId: kept[0].id }),
        ...(kept.at(-1) === undefined ? {} : { lastEntryId: kept.at(-1)?.id }),
        ...(before === undefined ? {} : { before }),
      };
      windowEntries = kept;
      rawItems = [
        ...(before === undefined ? [] : [{ kind: 'earlier' as const }]),
        ...kept.map((entry) => ({ kind: 'entry' as const, entry })),
      ];
    } else {
      const shown = this.shown;
      if (!shown) return undefined;
      rawItems = shown.items;
      windowEntries = shown.items.flatMap((item) => item.kind === 'entry' ? [item.entry] : []);
    }

    const docs = readConversationView(view);
    const { delivered, pending, requests } = this.collectEntries(windowEntries);
    if (this.windowed) {
      // Evict admissions no longer in the live window so old photo attachments do not accumulate in server RAM.
      const active = new Set(requests);
      for (const key of this.originals.keys()) {
        if (!active.has(key)) this.originals.delete(key);
      }
    }
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
    const messages = projectInfiniChatRows(state, rawItems, this.originals, parent,
      parent === null ? tree.since?.at ?? 0 : 0);
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
