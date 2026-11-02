import { BACKGROUND_CONTEXT } from '@earendil-works/chord/context';
import {
  ConversationTranscript,
  type ConversationId, type ConversationWatch, type DocumentWatch, type Harness, type TranscriptItem,
  type TranscriptView,
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
 * A chat while something shows it. The first subscriber attaches watches of pi-durable's conversation view and of the
 * chat's app documents — every one of them exists from the creating commit, so nothing attaches late; the last one to
 * leave stops them. With `transcript`, a `ConversationTranscript` keeps what the chat showed beyond the view's window
 * across attachments, resumes after it, and loads earlier and missed entries when their rows scroll into view
 * (pi-durable's `31-transcript.ts`).
 */
export class ChatView implements ChatViewSource {
  private readonly listeners = new Set<() => void>();
  /** Each connection counts up; asynchronous work from a disposed connection is dropped. */
  private connection = 0;
  private view?: ConversationWatch;
  private metadata?: DocumentWatch<ChatMetadata>;
  private target?: DocumentWatch<ExecutionTargetState>;
  private search?: DocumentWatch<SearchPresentationsState>;
  private history?: ConversationTranscript;
  private shown?: TranscriptView;
  private loaded = false;
  private scheduled = false;
  private snapshot: ChatViewSnapshot = { status: 'loading' };
  private controls?: ChatControls;
  private messages: readonly ChatMessage[] = [];

  constructor(
    private readonly harness: Harness,
    readonly id: ConversationId,
    private readonly transcript: boolean,
    private readonly localRoot: LocalRoot = DEFAULT_LOCAL_ROOT,
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
      const [view, metadata, target, search] = await Promise.all([
        conversation.watch(context, this.history?.resume),
        this.harness.watchDoc(ChatMetadataDoc, this.id, context),
        this.harness.watchDoc(ExecutionTargetDoc, this.id, context),
        this.harness.watchDoc(SearchPresentationsDoc, this.id, context),
      ]);
      const docs = [metadata, target, search];
      if (!current()) {
        await Promise.all([view.stop(), ...docs.map((watch) => watch?.stop())]);
        return;
      }
      this.view = view;
      this.metadata = metadata;
      this.target = target;
      this.search = search;
      this.shown = this.history?.merge(view.value);
      view.start(async (call) => {
        if (call.kind !== 'value') return;
        // Every value joins the transcript, which keeps what the window drops.
        this.shown = this.history?.merge(call.value);
        this.schedule();
      });
      for (const watch of docs) {
        watch?.start(async (call) => {
          if (call.kind === 'value') this.schedule();
        });
      }
      const chat = metadata?.value;
      if (!chat || chat.deleted) {
        this.publish({ status: 'missing' });
        return;
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
    for (const watch of [this.view, this.metadata, this.target, this.search]) void watch?.stop();
    this.view = undefined;
    this.metadata = undefined;
    this.target = undefined;
    this.search = undefined;
  }

  /**
   * The view and each app document deliver a commit in their own call. Coalesce them into one projection; entries and
   * the built-in documents always come from the same view revision.
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
    const state: ChatState = { id: this.id, ...readConversationView(view), metadata,
      execution: this.target?.value, search: this.search?.value };
    // The window holds the newest entries, which include the last run's.
    this.controls = projectControls(state, view.entries, this.localRoot);
    if (this.shown) this.messages = projectMessages(state, this.shown.items);
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
