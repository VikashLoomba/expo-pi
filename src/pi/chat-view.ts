import type { AttachedReplicatedState } from '@earendil-works/chord';
import { BACKGROUND_CONTEXT, withCancel } from '@earendil-works/chord/context';
import type {
  Conversation, ConversationId, ConversationView, Cursor, DocumentState, EntryId, EntryRecord, Harness,
  SubmissionId, SubmissionRecord,
} from '@earendil-works/pi-durable';

import type { ChatControls, ChatMessage } from '../chat/types';
import { ChatMetadataDoc, type ChatMetadata } from './chat-metadata';
import { projectControls, projectMessages, readConversationView, type ChatState } from './chat-projection';
import { ExecutionTargetDoc, type ExecutionTargetState } from './execution/document';
import { SearchPresentationsDoc, type SearchPresentationsState } from './native-web-search/durable';

const context = BACKGROUND_CONTEXT;
const noop = () => {};

export type ChatViewSnapshot = {
  status: 'loading' | 'ready' | 'missing' | 'failed';
  error?: string;
};

/** What screens read from a conversation's view; InfiniChat's view extends the controls. */
export interface ChatViewSource<C extends ChatControls = ChatControls> {
  readonly subscribe: (listener: () => void) => () => void;
  readonly getSnapshot: () => ChatViewSnapshot;
  readonly getControls: () => C | undefined;
  readonly getMessages: () => readonly ChatMessage[];
}

/**
 * A chat while something shows it. The first subscriber attaches pi-durable's conversation view and the chat's
 * app document states — every one of them exists from the creating commit, so nothing attaches late — and the
 * last one to leave disposes them. With `transcript`, it also reads the chat's whole history once, so messages
 * from before a compaction stay visible.
 */
export class ChatView implements ChatViewSource {
  private readonly listeners = new Set<() => void>();
  /** Each connection counts up; asynchronous work from a disposed connection is dropped. */
  private connection = 0;
  private view?: AttachedReplicatedState<ConversationView>;
  private unsubscribeView = noop;
  private unsubscribeDocs: (() => void)[] = [];
  private metadata?: DocumentState<ChatMetadata>;
  private target?: DocumentState<ExecutionTargetState>;
  private search?: DocumentState<SearchPresentationsState>;
  private loaded = false;
  private scheduled = false;
  private readonly entries = new Map<EntryId, EntryRecord>();
  /** The chat's latest input, followed until it settles; disconnecting or a newer input cancels the wait. */
  private followed?: { id: SubmissionId; cancel: (reason?: unknown) => void };
  private submission?: SubmissionRecord;
  private snapshot: ChatViewSnapshot = { status: 'loading' };
  private controls?: ChatControls;
  private messages: readonly ChatMessage[] = [];

  constructor(
    private readonly harness: Harness,
    readonly id: ConversationId,
    private readonly transcript: boolean,
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
      const [metadata, target, search] = await Promise.all([
        this.harness.documentState(ChatMetadataDoc, this.id, context),
        this.harness.documentState(ExecutionTargetDoc, this.id, context),
        this.harness.documentState(SearchPresentationsDoc, this.id, context),
      ]);
      if (!current()) {
        for (const state of [metadata, target, search]) state?.dispose();
        return;
      }
      this.metadata = metadata;
      this.target = target;
      this.search = search;
      this.unsubscribeDocs = [metadata?.subscribe(this.schedule) ?? noop,
        target?.subscribe(this.schedule) ?? noop, search?.subscribe(this.schedule) ?? noop];
      const chat = metadata?.value;
      if (!chat || chat.deleted) {
        this.publish({ status: 'missing' });
        return;
      }
      if (chat.lastInput !== undefined) await this.follow(chat.lastInput, current);
      if (!current()) return;
      if (this.transcript) await this.readHistory(conversation, current);
      if (!current()) return;
      this.loaded = true;
      this.update();
    } catch (error) {
      if (current()) this.fail(error);
    }
  }

  private disconnect() {
    // Committed entries are immutable, so a later subscriber reuses them. The last snapshot stays
    // readable; the next one is published once every document is attached again.
    this.connection++;
    this.loaded = false;
    this.followed?.cancel();
    this.followed = undefined;
    this.submission = undefined;
    this.unsubscribeView();
    this.unsubscribeView = noop;
    for (const unsubscribe of this.unsubscribeDocs) unsubscribe();
    this.unsubscribeDocs = [];
    this.view?.dispose();
    this.view = undefined;
    this.metadata?.dispose();
    this.metadata = undefined;
    this.target?.dispose();
    this.target = undefined;
    this.search?.dispose();
    this.search = undefined;
  }

  /**
   * The view holds only the active context, from the newest head on. Read the whole history once, newest first;
   * the view supplies everything committed afterwards.
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

  /**
   * The outcome of an input is not part of the view. Read its record now, then wait for it to settle, as pi-durable's
   * inbox example does; the wait's context is cancelled when the chat disconnects or a newer input replaces it.
   */
  private async follow(id: SubmissionId, current: () => boolean) {
    this.followed?.cancel();
    this.submission = undefined;
    const waiting = withCancel(context);
    const followed = { id, cancel: waiting.cancel };
    this.followed = followed;
    const following = () => current() && this.followed === followed;
    // A read that the cancellation interrupted belongs to an input or a connection that was replaced.
    const unlessReplaced = (error: unknown): undefined => {
      if (following()) throw error;
      return undefined;
    };
    const submission = await this.harness.submission(id, waiting.context).catch(unlessReplaced);
    if (!submission || !following()) return;
    const record = await submission.status(waiting.context).catch(unlessReplaced);
    if (!record || !following()) return;
    this.submission = record;
    this.schedule();
    submission.wait(waiting.context).then((settled) => {
      if (!following()) return;
      this.submission = settled;
      this.schedule();
    }, (error: unknown) => {
      if (following()) this.fail(error);
    });
  }

  /**
   * The view and each app document deliver a commit in their own microtask. Coalesce them into one projection;
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

  private update() {
    const view = this.view?.value;
    if (!this.loaded || !view) return;
    const metadata = this.metadata?.value;
    if (metadata?.deleted) {
      this.controls = undefined;
      this.messages = [];
      this.publish({ status: 'missing' });
      return;
    }
    const lastInput = metadata?.lastInput;
    if (lastInput !== undefined && lastInput !== this.followed?.id) {
      // Only the loaded connection updates, so this one is current.
      const connection = this.connection;
      const current = () => connection === this.connection;
      this.follow(lastInput, current).catch((error: unknown) => {
        if (current()) this.fail(error);
      });
    }
    const state: ChatState = { id: this.id, ...readConversationView(view), metadata: metadata ?? undefined,
      execution: this.target?.value ?? undefined, search: this.search?.value ?? undefined,
      submission: this.submission };
    if (this.transcript) {
      for (const entry of view.entries) this.entries.set(entry.id, entry);
    }
    const entries = this.transcript
      ? [...this.entries.values()].sort((left, right) => left.id - right.id) : view.entries;
    this.controls = projectControls(state, entries);
    if (this.transcript) this.messages = projectMessages(state, entries);
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
