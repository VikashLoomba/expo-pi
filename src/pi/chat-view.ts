import type { AttachedReplicatedState } from '@earendil-works/chord';
import { BACKGROUND_CONTEXT, withCancel } from '@earendil-works/chord/context';
import type {
  CommitPublication, Conversation, ConversationDocToken, ConversationId, ConversationView, Cursor, DocumentState,
  EntryId, EntryRecord, Harness, JsonObject, SubmissionId, SubmissionRecord,
} from '@earendil-works/pi-durable';

import type { ChatControls, ChatMessage } from '../chat/types';
import { ChatMetadataDoc } from './chat-metadata';
import { projectControls, projectMessages, readConversationView, type ChatState } from './chat-projection';
import { ExecutionTargetDoc } from './execution/document';
import { NativeLiveDoc, NativeResponsesDoc } from './native-web-search/durable';

const context = BACKGROUND_CONTEXT;
const noop = () => {};

export type ChatViewSnapshot = {
  status: 'loading' | 'ready' | 'missing' | 'failed';
  error?: string;
};

/** One document of an open chat. A document created after the chat opened is attached when its commit arrives. */
class DocumentView<T extends JsonObject> {
  private state?: DocumentState<T>;
  private unsubscribe = noop;

  constructor(readonly kind: string, private readonly acquire: () => Promise<DocumentState<T> | undefined>) {}

  get value(): Readonly<T> | undefined { return this.state?.value ?? undefined; }
  get attached() { return this.state !== undefined; }

  async attach(changed: () => void, current: () => boolean): Promise<void> {
    if (this.state) return;
    const state = await this.acquire();
    if (!state) return;
    if (!current() || this.state) {
      state.dispose();
      return;
    }
    this.state = state;
    this.unsubscribe = state.subscribe(changed);
  }

  dispose() {
    this.unsubscribe();
    this.unsubscribe = noop;
    this.state?.dispose();
    this.state = undefined;
  }
}

/**
 * A chat while something shows it. The first subscriber attaches pi-durable's conversation view and the chat's
 * app document states; the last one to leave disposes them. With `transcript`, it also reads the chat's whole
 * history once, so messages from before a compaction stay visible.
 */
export class ChatView {
  private readonly listeners = new Set<() => void>();
  private readonly documents;
  /** Each connection counts up; asynchronous work from a disposed connection is dropped. */
  private connection = 0;
  private view?: AttachedReplicatedState<ConversationView>;
  private unsubscribeView = noop;
  private unsubscribeCommits = noop;
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
  ) {
    const document = <T extends JsonObject>(token: ConversationDocToken<T>) =>
      new DocumentView(token.definition.kind, () => harness.documentState(token, id, context));
    // pi.live, pi.inbox and pi.agent come with the view's entries; these are the app's own documents.
    this.documents = {
      metadata: document(ChatMetadataDoc),
      target: document(ExecutionTargetDoc),
      native: document(NativeResponsesDoc),
      nativeLive: document(NativeLiveDoc),
    };
  }

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
      // A document state cannot observe a document that does not exist yet (OpenAI chats create their native
      // documents on the first request). Commits announce it.
      this.unsubscribeCommits = this.harness.subscribeCommits((publication) => this.observe(publication, current));
      const view = await conversation.viewState(context);
      if (!current()) {
        view.dispose();
        return;
      }
      this.view = view;
      this.unsubscribeView = view.subscribe(this.schedule);
      await Promise.all(Object.values(this.documents).map((document) => document.attach(this.schedule, current)));
      if (!current()) return;
      const metadata = this.documents.metadata.value;
      if (!metadata || metadata.deleted) {
        this.publish({ status: 'missing' });
        return;
      }
      if (metadata.lastInput !== undefined) await this.follow(metadata.lastInput, current);
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
    this.unsubscribeCommits();
    this.unsubscribeCommits = noop;
    this.unsubscribeView();
    this.unsubscribeView = noop;
    this.view?.dispose();
    this.view = undefined;
    for (const document of Object.values(this.documents)) document.dispose();
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

  private observe(publication: CommitPublication, current: () => boolean) {
    for (const change of publication.changes) {
      if (change.type !== 'document' || change.conversationId !== this.id) continue;
      const document = Object.values(this.documents).find((candidate) =>
        candidate.kind === change.record.kind && !candidate.attached);
      // Commit listeners must not call Session APIs, so attach after this publication.
      if (document) {
        queueMicrotask(() => {
          document.attach(this.schedule, current).then(this.schedule, (error: unknown) => {
            if (current()) this.fail(error);
          });
        });
      }
    }
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
    const { metadata, target, native, nativeLive } = this.documents;
    if (metadata.value?.deleted) {
      this.controls = undefined;
      this.messages = [];
      this.publish({ status: 'missing' });
      return;
    }
    const lastInput = metadata.value?.lastInput;
    if (lastInput !== undefined && lastInput !== this.followed?.id) {
      // Only the loaded connection updates, so this one is current.
      const connection = this.connection;
      const current = () => connection === this.connection;
      this.follow(lastInput, current).catch((error: unknown) => {
        if (current()) this.fail(error);
      });
    }
    const state: ChatState = { id: this.id, ...readConversationView(view), metadata: metadata.value,
      execution: target.value, native: native.value, nativeLive: nativeLive.value, submission: this.submission };
    this.controls = projectControls(state);
    if (this.transcript) {
      for (const entry of view.entries) this.entries.set(entry.id, entry);
      this.messages = projectMessages(state, [...this.entries.values()].sort((left, right) => left.id - right.id));
    }
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
