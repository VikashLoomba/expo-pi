import type { AttachedReplicatedState, Context, JsonValue } from '@earendil-works/chord';
import { BACKGROUND_CONTEXT, withCancel } from '@earendil-works/chord/context';
import {
  ResetEntry,
  type Conversation, type ConversationId, type ConversationView, type Cursor, type DocumentState, type EntryId,
  type EntryRecord, type Harness, type InboxItem, type InboxState, type SettledSubmissionRecord, type UserInput,
} from '@earendil-works/pi-durable';

import type { ChatControls, ChatMessage } from '../chat/types';
import { ChatMetadataDoc, type ChatMetadata } from './chat-metadata';
import {
  projectControls, projectMessages, queuedRow, readConversationView, stoppedNotice, type ChatState,
} from './chat-projection';
import type { ChatViewSnapshot, ChatViewSource } from './chat-view';
import { AppDoc, DeliveryEntry, InputDoc, type AppState } from './infinichat/app';
import { ConfigDoc, type SummarySelection } from './infinichat/summary';

const context = BACKGROUND_CONTEXT;
const noop = () => {};

export type InfiniChatControls = ChatControls & {
  /** The main and summary models are both chosen; InfiniChat sends and builds nothing before. */
  configured: boolean;
};

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
 * InfiniChat's entries as the transcript shows them. A delivery shows the input the user sent, never the saved view
 * and turn state ahead of it, and the reset that begins each fresh turn summarizes nothing.
 */
function shownEntries(entries: readonly EntryRecord[], originals: ReadonlyMap<string, UserInput>): EntryRecord[] {
  return entries.flatMap((entry): EntryRecord[] => {
    if (ResetEntry.is(entry)) return [];
    if (!DeliveryEntry.is(entry)) return [entry];
    const original = originals.get(entry.data.requestId);
    const delivered = entry.model?.[0];
    if (original === undefined || delivered?.role !== 'user') return [];
    return [{ ...entry, model: [{ ...delivered, content: original }] }];
  });
}

/** The inbox with each queued delivery showing its original input, as `shownEntries` does once it is placed. */
function shownInbox(inbox: InboxState | undefined, originals: ReadonlyMap<string, UserInput>): InboxState | undefined {
  return inbox && { items: inbox.items.flatMap((item): InboxItem[] => {
    if (item.mode === 'write') return [item];
    const requestId = queuedRequest(item.entry);
    if (requestId === undefined) return [item];
    const original = originals.get(requestId);
    return original === undefined ? [] : [{ ...item, content: original }];
  }) };
}

/**
 * InfiniChat's one conversation while something shows it, as `ChatView` shows a chat: the first subscriber attaches
 * pi-durable's conversation view, the chat metadata document and OptChat's application and summary-model documents,
 * and reads the whole history once; the last one to leave disposes them. OptChat accepts an input before its
 * coordinator submits it, so the view follows the latest accepted request rather than a submission, and shows
 * accepted inputs from `AppDoc.pending` as queued rows.
 */
export class InfiniChatView implements ChatViewSource<InfiniChatControls> {
  private readonly listeners = new Set<() => void>();
  /** Each connection counts up; asynchronous work from a disposed connection is dropped. */
  private connection = 0;
  private view?: AttachedReplicatedState<ConversationView>;
  private unsubscribeView = noop;
  private unsubscribeDocs: (() => void)[] = [];
  private metadata?: DocumentState<ChatMetadata>;
  private app?: DocumentState<AppState>;
  private config?: DocumentState<{ summary: SummarySelection | null }>;
  private loaded = false;
  private scheduled = false;
  private readonly entries = new Map<EntryId, EntryRecord>();
  /** Each request's original input, which its `InputDoc` keeps unchanged, so a later subscriber reuses it. */
  private readonly originals = new Map<string, UserInput>();
  private readonly reading = new Set<string>();
  /** The latest accepted request, followed until it settles; disconnecting or a newer request cancels the wait. */
  private followed?: { requestId: string; cancel: (reason?: unknown) => void };
  private submission?: SettledSubmissionRecord;
  /** A stop cancelled the followed request before the coordinator submitted it. */
  private stopped = false;
  private answerError?: string;
  private snapshot: ChatViewSnapshot = { status: 'loading' };
  private controls?: InfiniChatControls;
  private messages: readonly ChatMessage[] = [];

  constructor(
    private readonly harness: Harness,
    readonly id: ConversationId,
    /** The service's wait for a request's native receipt; it rejects when a stop cancelled the request first. */
    private readonly waitForAnswer: (requestId: string, context: Context) => Promise<SettledSubmissionRecord>,
  ) {}

  readonly subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    if (this.listeners.size === 1) void this.connect();
    return () => {
      this.listeners.delete(listener);
      if (!this.listeners.size) this.disconnect();
    };
  };
  readonly getSnapshot = () => this.snapshot;
  readonly getControls = () => this.controls;
  readonly getMessages = () => this.messages;

  private async connect() {
    const connection = ++this.connection;
    const current = () => connection === this.connection;
    try {
      const conversation = await this.harness.conversation(this.id, context);
      if (!current()) return;
      if (!conversation) {
        this.publish({ status: 'missing' });
        return;
      }
      const view = await conversation.viewState(context);
      if (!current()) {
        view.dispose();
        return;
      }
      this.view = view;
      this.unsubscribeView = view.subscribe(this.schedule);
      const [metadata, app, config] = await Promise.all([
        this.harness.documentState(ChatMetadataDoc, this.id, context),
        this.harness.documentState(AppDoc, this.id, context),
        this.harness.documentState(ConfigDoc, this.id, context),
      ]);
      if (!current()) {
        metadata?.dispose();
        app?.dispose();
        config?.dispose();
        return;
      }
      this.metadata = metadata;
      this.app = app;
      this.config = config;
      this.unsubscribeDocs = [metadata?.subscribe(this.schedule) ?? noop, app?.subscribe(this.schedule) ?? noop,
        config?.subscribe(this.schedule) ?? noop];
      if (!metadata?.value) {
        this.publish({ status: 'missing' });
        return;
      }
      await this.readHistory(conversation, current);
      if (!current()) return;
      // Inputs read before the first projection show with the history rather than after it.
      await this.readOriginals(this.collect(view.value).requests);
      if (!current()) return;
      this.loaded = true;
      this.update();
    } catch (error) {
      if (current()) this.fail(error);
    }
  }

  private disconnect() {
    // Committed entries and original inputs are immutable, so a later subscriber reuses them. The last snapshot
    // stays readable; the next one is published once every document is attached again.
    this.connection++;
    this.loaded = false;
    this.followed?.cancel();
    this.followed = undefined;
    this.submission = undefined;
    this.stopped = false;
    this.answerError = undefined;
    this.unsubscribeView();
    this.unsubscribeView = noop;
    for (const unsubscribe of this.unsubscribeDocs) unsubscribe();
    this.unsubscribeDocs = [];
    this.view?.dispose();
    this.view = undefined;
    this.metadata?.dispose();
    this.metadata = undefined;
    this.app?.dispose();
    this.app = undefined;
    this.config?.dispose();
    this.config = undefined;
  }

  /**
   * The view holds only the active context, which each fresh turn resets. Read the whole history once, newest
   * first; the view supplies everything committed afterwards.
   */
  private async readHistory(conversation: Conversation, current: () => boolean) {
    let cursor: Cursor | undefined;
    do {
      const page = await conversation.entries({}, 200, cursor, context);
      if (!current()) return;
      for (const entry of page.items) this.entries.set(entry.id, entry);
      cursor = page.next;
    } while (cursor !== undefined);
  }

  /** Reads the original input of each request not read yet; resolves whether any was added. */
  private async readOriginals(requestIds: Iterable<string>): Promise<boolean> {
    const unread = [...new Set(requestIds)].filter((id) => !this.originals.has(id) && !this.reading.has(id));
    const added = await Promise.all(unread.map(async (requestId) => {
      this.reading.add(requestId);
      try {
        const admission = await this.harness.snapshot(InputDoc, this.id, requestId, context);
        if (!admission?.value) return false;
        this.originals.set(requestId, admission.value.content);
        return true;
      } finally {
        this.reading.delete(requestId);
      }
    }));
    return added.includes(true);
  }

  /**
   * The outcome of the latest input. OptChat's coordinator submits it later, so wait on the request through the
   * service, as pi-durable's inbox example waits on a submission; the wait's context is cancelled when the view
   * disconnects or a newer request replaces it.
   */
  private async follow(requestId: string) {
    this.followed?.cancel();
    this.submission = undefined;
    this.stopped = false;
    this.answerError = undefined;
    const connection = this.connection;
    const waiting = withCancel(context);
    const followed = { requestId, cancel: waiting.cancel };
    this.followed = followed;
    const following = () => connection === this.connection && this.followed === followed;
    try {
      const settled = await this.waitForAnswer(requestId, waiting.context);
      if (!following()) return;
      this.submission = settled;
    } catch (error) {
      if (!following()) return;
      // A stop cancels an input still waiting for the coordinator, and its admission records that.
      const admission = await this.harness.snapshot(InputDoc, this.id, requestId, context);
      if (!following()) return;
      if (admission?.value?.phase === 'cancelled') this.stopped = true;
      else this.answerError = error instanceof Error ? error.message : String(error);
    }
    this.schedule();
  }

  /**
   * The view and each document deliver a commit in their own microtask. Coalesce them into one projection;
   * entries and the built-in documents always come from the same view revision.
   */
  private readonly schedule = () => {
    if (this.scheduled) return;
    this.scheduled = true;
    queueMicrotask(() => {
      this.scheduled = false;
      this.update();
    });
  };

  /** The whole history in entry order, and every request whose original input the projection shows. */
  private collect(view: ConversationView) {
    for (const entry of view.entries) this.entries.set(entry.id, entry);
    const entries = [...this.entries.values()].sort((left, right) => left.id - right.id);
    const docs = readConversationView(view);
    const delivered = deliveredRequests(entries, docs.inbox);
    const pending = this.app?.value?.pending ?? [];
    return { entries, docs, delivered, pending, requests: [...delivered, ...pending] };
  }

  private update() {
    const view = this.view?.value;
    if (!this.loaded || !view) return;
    // Only the loaded connection updates, so this one is current.
    const connection = this.connection;
    const failCurrent = (error: unknown) => {
      if (connection === this.connection) this.fail(error);
    };
    const metadata = this.metadata?.value ?? undefined;
    const lastRequest = metadata?.lastRequest;
    if (lastRequest !== undefined && lastRequest !== this.followed?.requestId) {
      this.follow(lastRequest).catch(failCurrent);
    }
    const { entries, docs, delivered, pending, requests } = this.collect(view);
    if (requests.some((requestId) => !this.originals.has(requestId))) {
      this.readOriginals(requests).then((added) => {
        if (added) this.schedule();
      }, failCurrent);
    }
    const shown = shownEntries(entries, this.originals);
    const state: ChatState = { id: this.id, ...docs, inbox: shownInbox(docs.inbox, this.originals), metadata,
      submission: this.submission };
    const controls = projectControls(state, shown);
    const error = controls.error ?? this.answerError;
    this.controls = {
      ...controls,
      // An accepted input waits for its turn's summaries or the coordinator before pi-durable runs it; a stop
      // cancels it, so the conversation is working.
      busy: controls.busy || pending.length > 0,
      configured: docs.agent?.model !== undefined && !!this.config?.value?.summary,
      ...(error ? { error } : {}),
    };
    const messages = projectMessages(state, shown);
    if (this.stopped && lastRequest !== undefined) messages.push(stoppedNotice(`stopped-${lastRequest}`));
    for (const requestId of pending) {
      const original = this.originals.get(requestId);
      if (original === undefined || delivered.has(requestId)) continue;
      messages.push(queuedRow(`pending-${requestId}`, original, { mode: 'pending' }));
    }
    this.messages = messages;
    this.publish({ status: 'ready' });
  }

  private fail(error: unknown) {
    this.publish({ status: 'failed', error: error instanceof Error ? error.message : String(error) });
  }

  private publish(snapshot: ChatViewSnapshot) {
    this.snapshot = snapshot;
    for (const listener of [...this.listeners]) listener();
  }
}
