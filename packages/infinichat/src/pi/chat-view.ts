import { BACKGROUND_CONTEXT } from '@earendil-works/chord/context';
import {
  ConversationTranscript,
  type ConversationId, type ConversationView, type ConversationWatch, type DocumentWatch, type Harness,
  type TranscriptItem, type TranscriptView, type WatchHandle,
} from '@earendil-works/pi-durable';
import { obj, oneOf, opt, str, type Static } from '@earendil-works/pi-schema';

import type { ChatControls, ChatMessage, TranscriptGap } from '../chat/types';
import { ChatMetadataDoc, type ChatMetadata } from './chat-metadata';
import { projectControls, projectMessages, readConversationView, type ChatState } from './chat-projection';
import {
  DEFAULT_LOCAL_ROOT, ExecutionTargetDoc, type ExecutionTargetState, type LocalRoot,
} from './execution/document';
import { SearchPresentationsDoc, type SearchPresentationsState } from './native-web-search/durable';

const context = BACKGROUND_CONTEXT;

export const ChatViewSnapshotSchema = obj({
  status: oneOf(['loading', 'ready', 'missing', 'failed']),
  error: opt(str()),
}, { open: true });
export type ChatViewSnapshot = Static<typeof ChatViewSnapshotSchema>;

/** What screens read from a conversation's view; InfiniChat's view extends the controls. */
export interface ChatViewSource<C extends ChatControls = ChatControls> {
  readonly subscribe: (listener: () => void) => () => void;
  readonly getSnapshot: () => ChatViewSnapshot;
  readonly getControls: () => C | undefined;
  readonly getMessages: () => readonly ChatMessage[];
  /** Loads the page of entries before the oldest one held, for the `earlier` row once it scrolls into view. */
  readonly loadEarlier: () => Promise<void>;
  /** Loads the next page of a `gap` row's entries once it scrolls into view. */
  readonly fillGap: (gap: TranscriptGap) => Promise<void>;
}

type Gap = Extract<TranscriptItem, { kind: 'gap' }>;

/** The gap item of `view` that a row names, looked up among the items pi-durable's transcript returned. */
export const gapOf = (view: TranscriptView | undefined, { after, upTo }: TranscriptGap): Gap | undefined =>
  view?.items.find((item): item is Gap => item.kind === 'gap' && item.after === after && item.upTo === upTo);

/**
 * A conversation while something shows it: the lifecycle `ChatView` and `InfiniChatView` share. The first subscriber
 * attaches pi-durable's conversation view and the view's own watches (`attach`); the last one to leave stops them. A
 * commit reaches the view and each document in its own call, so they are coalesced into one projection (`project`).
 * With `transcript`, a `ConversationTranscript` keeps what was shown beyond the view's window across attachments,
 * resumes after it, and loads earlier and missed entries when their rows scroll into view (pi-durable's
 * `31-transcript.ts`).
 */
export abstract class WatchedView<C extends ChatControls, W> implements ChatViewSource<C> {
  private readonly listeners = new Set<() => void>();
  /** Each connection counts up; asynchronous work from a disposed connection is dropped. */
  private connection = 0;
  private view?: ConversationWatch;
  /** The view's own watches while it is attached. */
  protected watches?: W;
  private history?: ConversationTranscript;
  protected shown?: TranscriptView;
  private loaded = false;
  private scheduled = false;
  private snapshot: ChatViewSnapshot = { status: 'loading' };
  protected controls?: C;
  protected messages: readonly ChatMessage[] = [];

  constructor(protected readonly harness: Harness, readonly id: ConversationId, private readonly transcript: boolean) {}

  /** Opens the view's own watches. */
  protected abstract attach(): Promise<W>;
  /** Every watch of `watches`, to follow and to stop. */
  protected abstract handles(watches: W): readonly (WatchHandle<unknown> | undefined)[];
  /** Whether the conversation is there to show, by its watches as they attached. */
  protected abstract present(watches: W): boolean;
  /** Reads what the first projection needs before the view counts as loaded. */
  protected prepare?(): Promise<void>;
  /**
   * Sets `controls` and `messages` from the conversation view and the watches, and says what to publish; undefined
   * leaves the last snapshot.
   */
  protected abstract project(view: ConversationView, watches: W): 'ready' | 'missing' | undefined;

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

  readonly loadEarlier = async () => {
    if (this.history === undefined || this.shown === undefined) return;
    this.shown = await this.history.loadEarlier(context);
    this.schedule();
  };

  readonly fillGap = async (gap: TranscriptGap) => {
    const item = gapOf(this.shown, gap);
    if (this.history === undefined || item === undefined) return;
    this.shown = await this.history.fillGap(item, context);
    this.schedule();
  };

  /** The conversation view's latest value while attached. */
  protected get conversation(): ConversationView | undefined {
    return this.view?.value;
  }

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
      if (this.transcript) {
        this.history ??= new ConversationTranscript((query, limit, loadContext) =>
          conversation.entries(query, limit, undefined, loadContext));
      }
      const [view, watches] = await Promise.all([conversation.watch(context, this.history?.resume), this.attach()]);
      const handles = this.handles(watches);
      if (!current()) {
        await Promise.all([view.stop(), ...handles.map((watch) => watch?.stop())]);
        return;
      }
      this.view = view;
      this.watches = watches;
      this.shown = this.history?.merge(view.value);
      view.start(async (call) => {
        if (call.kind !== 'value') return;
        // Every value joins the transcript, which keeps what the window drops.
        this.shown = this.history?.merge(call.value);
        this.schedule();
      });
      for (const watch of handles) {
        watch?.start(async (call) => {
          if (call.kind === 'value') this.schedule();
        });
      }
      if (!this.present(watches)) {
        this.publish({ status: 'missing' });
        return;
      }
      if (this.prepare) {
        await this.prepare();
        if (!current()) return;
      }
      this.loaded = true;
      this.update();
    } catch (error) {
      if (current()) this.fail(error);
    }
  }

  private disconnect() {
    // The transcript keeps what was shown, so a later subscriber resumes after it. The last snapshot stays readable;
    // the next one is published once every watch is attached again.
    this.connection++;
    this.loaded = false;
    void this.view?.stop();
    for (const watch of this.watches === undefined ? [] : this.handles(this.watches)) void watch?.stop();
    this.view = undefined;
    this.watches = undefined;
  }

  /**
   * The view and each document deliver a commit in their own call. Coalesce them into one projection; entries and the
   * built-in documents always come from the same view revision.
   */
  protected readonly schedule = () => {
    if (this.scheduled) return;
    this.scheduled = true;
    queueMicrotask(() => {
      this.scheduled = false;
      this.update();
    });
  };

  private update() {
    const view = this.view?.value;
    if (!this.loaded || !view || this.watches === undefined) return;
    const status = this.project(view, this.watches);
    if (status !== undefined) this.publish({ status });
  }

  /** Reports a failure of work this attachment started, unless the view detached meanwhile. */
  protected failing(): (error: unknown) => void {
    const connection = this.connection;
    return (error) => {
      if (connection === this.connection) this.fail(error);
    };
  }

  private fail(error: unknown) {
    this.publish({ status: 'failed', error: error instanceof Error ? error.message : String(error) });
  }

  private publish(snapshot: ChatViewSnapshot) {
    this.snapshot = snapshot;
    for (const listener of [...this.listeners]) listener();
  }
}

type ChatWatches = {
  metadata: DocumentWatch<ChatMetadata> | undefined;
  target: DocumentWatch<ExecutionTargetState> | undefined;
  search: DocumentWatch<SearchPresentationsState> | undefined;
};

/**
 * A chat while something shows it (`WatchedView`): pi-durable's conversation view and the chat's app documents, every
 * one of which exists from the creating commit, so nothing attaches late.
 */
export class ChatView extends WatchedView<ChatControls, ChatWatches> {
  constructor(harness: Harness, id: ConversationId, transcript: boolean,
    private readonly localRoot: LocalRoot = DEFAULT_LOCAL_ROOT) {
    super(harness, id, transcript);
  }

  protected async attach(): Promise<ChatWatches> {
    const [metadata, target, search] = await Promise.all([
      this.harness.watchDoc(ChatMetadataDoc, this.id, context),
      this.harness.watchDoc(ExecutionTargetDoc, this.id, context),
      this.harness.watchDoc(SearchPresentationsDoc, this.id, context),
    ]);
    return { metadata, target, search };
  }

  protected handles({ metadata, target, search }: ChatWatches) {
    return [metadata, target, search];
  }

  protected present({ metadata }: ChatWatches) {
    const chat = metadata?.value;
    return chat !== undefined && !chat.deleted;
  }

  protected project(view: ConversationView, watches: ChatWatches) {
    const metadata = watches.metadata?.value;
    if (metadata?.deleted) {
      this.controls = undefined;
      this.messages = [];
      return 'missing';
    }
    const state: ChatState = { id: this.id, ...readConversationView(view), metadata,
      execution: watches.target?.value, search: watches.search?.value };
    // The window holds the newest entries, which include the last run's.
    this.controls = projectControls(state, view.entries, this.localRoot);
    if (this.shown) this.messages = projectMessages(state, this.shown.items);
    return 'ready';
  }
}
