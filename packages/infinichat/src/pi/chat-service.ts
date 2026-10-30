import { BACKGROUND_CONTEXT } from '@earendil-works/chord/context';
import { uuidv7, type Models, type UserMessage } from '@earendil-works/pi-ai';
import {
  AgentDoc, Harness, configure, createRegistry, defineExtension, section,
  type ConversationId, type Cursor, type DocumentState, type SessionEnd, type Storage, type SubmissionId,
  type TaskGraphNode,
} from '@earendil-works/pi-durable';
import type { ExecutionEnv } from '@earendil-works/pi-durable/env';
import { createCodingTools, type ImageProcessor } from '@earendil-works/pi-durable/tools';

import type { ChatSummary } from '../chat/types';
import { ChatMetadataDoc, type ChatMetadata } from './chat-metadata';
import { oneLine, settingsOf, summarizeChat } from './chat-projection';
import { ChatView } from './chat-view';
import {
  DEFAULT_LOCAL_ROOT, ExecutionTargetDoc, validateExecution, type ChatExecutionSettings, type LocalRoot,
} from './execution/document';
import { requireModelAuth } from './model-auth';
import {
  assertModelSettings, buildModelCatalog, getDefaultModelSettings, getModelSettingsError,
  type ChatModelSettings, type NewChatDefaults,
} from './model-catalog';
import { createNativeWebSearchBridge, SearchPresentationsDoc } from './native-web-search/durable';
import { imagesOf, textOf } from './user-input';
import { WorkspaceDoc } from './workspace/document';

/** `error` is the Harness's latest report; operations reject to their callers instead. */
export interface ChatServiceSnapshot { chats: ChatSummary[]; error?: string }

const context = BACKGROUND_CONTEXT;
const errorText = (error: unknown) => error instanceof Error ? error.message : String(error);

/** `deleteChat` marked the chat deleted but could not remove its workspace directories. */
export class WorkspaceRemovalError extends Error {
  constructor(cause: unknown) {
    super(errorText(cause), { cause });
    this.name = 'WorkspaceRemovalError';
  }
}

/** A chat's work is its conversation's foreground tasks; background tasks never keep it busy. */
export const chatTasks = (task: TaskGraphNode): string | undefined =>
  task.background ? undefined : String(task.conversationId);

/**
 * Owns the app's durable session for its lifetime. The chat list reads each chat's metadata document; a chat's
 * transcript is read only while a `ChatView` of it is shown.
 */
export class DurableChatService {
  private readonly chats = new Map<ConversationId, DocumentState<ChatMetadata>>();
  /** Routes carry a chat's ID as text; it is only ever resolved to an ID pi-durable issued. */
  private readonly ids = new Map<string, ConversationId>();
  private readonly listeners = new Set<() => void>();
  private snapshot: ChatServiceSnapshot = { chats: [] };
  private closed = false;
  private closePromise?: Promise<void>;
  private detachObserver = () => {};

  private constructor(
    private readonly harness: Harness,
    private readonly storage: Storage,
    private readonly models: Models,
    private readonly local: { remove(workspaceId: string): void } | undefined,
    private readonly options: {
      now: () => number;
      newChat: NewChatDefaults;
      localRoot: LocalRoot;
      authError?: (providerId: string) => string | undefined;
    },
  ) {}

  static async open(options: {
    storage: Storage; models: Models; now?: () => number;
    /** Prepares photos for `read` (pi-durable "Images"). */
    images: ImageProcessor;
    /**
     * A chat's own environment on this device, built at each use, and removing it with the chat; without it the tools
     * of a chat on this device fail with Pi's ordinary error result. `root` is where its working directory may be
     * (`LocalRoot`): the phone's sandbox root unless given.
     */
    local?: {
      environment(workspaceId: string, cwd: string | undefined): ExecutionEnv;
      remove(workspaceId: string): void;
      root?: LocalRoot;
    };
    /** A chat on a configured machine. The service borrows it; its owner closes it after the service. */
    machines: { environment(machineId: string, cwd: string | undefined): Promise<ExecutionEnv> };
    newChat?: NewChatDefaults;
    /** Why a provider has no usable credential, for example a locked keychain or `SESSION_EXPIRED`. */
    authError?: (providerId: string) => string | undefined;
    /** The Harness closed: `failed` after a storage error (pi-durable README "Errors"), `closed` after close(). */
    onClosed?: (end: SessionEnd) => void;
    /** Counts the chats' live work while the service is open; returns its detach, which the service calls on close. */
    observe?: (harness: Harness) => () => void;
  }): Promise<DurableChatService> {
    const { local, machines } = options;
    const registry = createRegistry();
    // With a processor, `read` turns photos upright and shrinks them to the model's limits (pi-durable "Images").
    registry.install(createCodingTools({ images: options.images }));
    let harness: Harness | undefined;
    registry.install(createNativeWebSearchBridge((error) => service?.report(error), () => harness));
    registry.install(defineExtension({
      name: 'mobile-chat',
      sections: [section('assistant',
        () => 'You are a helpful, thoughtful assistant. Use Markdown when it improves clarity.', { tag: false }),
      // The folder the tools resolve paths against, as pi-durable's README "System Prompt" shows; without it, models
      // guess one, such as /mnt/data.
      section('cwd', (input) => input.env?.cwd)],
    }));
    const now = options.now ?? Date.now;
    let service: DurableChatService | undefined;
    harness = await Harness.open(options.storage, {
      models: options.models, registry, now,
      // Each use reads the chat's committed selection, like pi's sandbox-per-conversation example.
      env: async ({ conversationId, cwd, read }, envContext) => {
        const target = (await read.snapshot(ExecutionTargetDoc, conversationId, envContext))?.target;
        if (target?.kind === 'ssh') return machines.environment(target.machineId, cwd);
        if (!local) return undefined;
        const workspace = await read.snapshot(WorkspaceDoc, conversationId, envContext);
        if (!workspace?.id) throw new Error('This conversation has no committed workspace identity.');
        return local.environment(workspace.id, cwd);
      },
      async conversationCreated(tx, conversation) {
        const metadata = await tx.doc(ChatMetadataDoc, conversation.id);
        metadata.createdAt = now();
      },
      // A parked task shows in its own chat, which offers to resume it (pi-durable README "Crash loops").
      onReport: (error, info) => {
        if (info.type !== 'task_parked') service?.report(error);
      },
    }, context);
    service = new DurableChatService(harness, options.storage, options.models, local, {
      now, newChat: options.newChat ?? { models: {} }, authError: options.authError,
      // `??` would turn a host's `null` into the phone's root.
      localRoot: local?.root === undefined ? DEFAULT_LOCAL_ROOT : local.root,
    });
    try { await service.loadChats(); }
    catch (error) {
      await service.close();
      throw error;
    }
    // Continue work the last process left unfinished. A chat whose provider cannot authenticate fails on its own.
    harness.resume();
    if (options.observe) service.detachObserver = options.observe(harness);
    // A storage error ends the Harness: report it once and let the owner reopen (pi-durable README "Errors").
    void harness.closed.then((end) => {
      if (end.reason === 'failed') service.report(end.error);
      options.onClosed?.(end);
    });
    return service;
  }

  /** Read each chat's metadata document; transcripts stay in storage until a chat is shown. */
  private async loadChats() {
    let cursor: Cursor | undefined;
    do {
      const page = await this.storage.scanConversations({}, 100, cursor, context);
      for (const record of page.items) await this.watchChat(record.id);
      cursor = page.next;
    } while (cursor !== undefined);
    this.updateList();
  }

  private async watchChat(id: ConversationId) {
    const state = await this.harness.documentState(ChatMetadataDoc, id, context);
    if (!state) return;
    this.chats.set(id, state);
    this.ids.set(String(id), id);
    state.subscribe(this.updateList);
  }

  private readonly updateList = () => {
    if (this.closed) return;
    const chats = [...this.chats].flatMap(([id, state]) => {
      const summary = state.value ? summarizeChat(id, state.value) : undefined;
      return summary ? [summary] : [];
    }).sort((a, b) => b.updatedAt - a.updatedAt || b.id - a.id);
    this.snapshot = { ...this.snapshot, chats };
    this.notify();
  };

  private notify() {
    for (const listener of [...this.listeners]) listener();
  }

  private report(error: unknown) {
    this.snapshot = { ...this.snapshot, error: errorText(error) };
    this.notify();
  }

  private assertOpen() { if (this.closed) throw new Error('Chat storage is closed.'); }

  /** The one pre-send check, then whether the service closed while it ran. */
  private async requireAuth(settings: ChatModelSettings) {
    await requireModelAuth(this.models, settings, this.options.authError);
    this.assertOpen();
  }

  private async conversation(id: ConversationId) {
    this.assertOpen();
    const conversation = this.chats.has(id) ? await this.harness.conversation(id, context) : undefined;
    if (!conversation) throw new Error('Conversation not found.');
    return conversation;
  }

  readonly subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  };
  readonly getSnapshot = () => this.snapshot;

  /** Clears the Harness's latest report once the user dismisses it; the next report sets it again. */
  dismissError() {
    if (this.snapshot.error === undefined) return;
    this.snapshot = { chats: this.snapshot.chats };
    this.notify();
  }

  /** The listed chat a route names, or undefined when there is none. */
  findChat(key: string): ConversationId | undefined { return this.ids.get(key); }

  /** A chat's committed state while subscribed; `transcript` adds its messages, including pre-compaction history. */
  chat(id: ConversationId, options: { transcript?: boolean } = {}): ChatView {
    return new ChatView(this.harness, id, options.transcript ?? false, this.options.localRoot);
  }

  /**
   * A new chat continues with the most recently used chat's model and effort while that model
   * is available and its provider connected. Otherwise it uses a connected provider's default.
   */
  private async defaultSettings(): Promise<ChatModelSettings | undefined> {
    const catalog = buildModelCatalog(this.models);
    // Saved credentials that cannot be read do not make a provider usable for a new chat.
    const connected = (providerId: string) => this.models.checkAuth(providerId).then(Boolean, () => false);
    const recent = this.snapshot.chats[0];
    const recentSettings = recent ? settingsOf(await this.harness.snapshot(AgentDoc, recent.id, context)) : undefined;
    if (recentSettings && !getModelSettingsError(catalog, recentSettings)
        && await connected(recentSettings.model.provider)) {
      return recentSettings;
    }
    const { preferredProvider, models } = this.options.newChat;
    // Sorting is stable: the preferred provider moves first and the rest keep catalog order.
    const providers = [...catalog].sort((left, right) =>
      Number(right.id === preferredProvider) - Number(left.id === preferredProvider));
    for (const provider of providers) {
      if (!await connected(provider.id)) continue;
      const modelId = models[provider.id];
      const preferred = modelId === undefined ? undefined : { provider: provider.id, modelId };
      const settings = getDefaultModelSettings([provider], preferred);
      if (settings) return settings;
    }
    return undefined;
  }

  async createChat(): Promise<ConversationId> {
    this.assertOpen();
    const settings = await this.defaultSettings();
    if (!settings) throw new Error('No chat models are available. Connect a provider in Account.');
    this.assertOpen();
    const conversation = await this.harness.createConversation({
      ownership: { kind: 'ownerless' },
      agent: settings,
      // As pi's examples 06 and 29 create in `init` a document they later read, the execution target exists from the
      // creating commit, so an open chat observes it through `documentState` from the start.
      init: async (tx, id) => {
        (await tx.doc(WorkspaceDoc, id)).id = uuidv7();
        (await tx.doc(ExecutionTargetDoc, id)).target = { kind: 'local' };
        // A new document is adopted even unmodified (transaction semantics), so the chat view
        // observes the presentation document from the start and nothing attaches late.
        await tx.doc(SearchPresentationsDoc, id);
      },
    }, context);
    await this.watchChat(conversation.id);
    this.updateList();
    return conversation.id;
  }

  async updateSettings(id: ConversationId, settings: ChatModelSettings): Promise<void> {
    const selected = { model: { ...settings.model }, thinkingLevel: settings.thinkingLevel };
    assertModelSettings(buildModelCatalog(this.models), selected);
    const conversation = await this.conversation(id);
    await conversation.commit(async (tx) => {
      // The public SDK mutation keeps history/fork semantics and preserves
      // unrelated agent fields. Model and effort commit in the same transaction.
      await configure(tx, id, selected);
    }, context);
  }

  /**
   * Commits the machine, working directory and model together. As in pi-durable, work already running keeps what
   * it resolved; the next request or tool call uses the new selection. A `null` directory clears the agent's `cwd`,
   * so a remote machine runs in its account's home directory.
   */
  async updateExecution(id: ConversationId, settings: ChatExecutionSettings,
    modelSettings?: ChatModelSettings): Promise<void> {
    const selected = structuredClone(settings);
    validateExecution(selected, this.options.localRoot);
    const selectedModel = modelSettings
      && { model: { ...modelSettings.model }, thinkingLevel: modelSettings.thinkingLevel };
    if (selectedModel) assertModelSettings(buildModelCatalog(this.models), selectedModel);
    const conversation = await this.conversation(id);
    await conversation.commit(async (tx) => {
      (await tx.doc(ExecutionTargetDoc, id)).target = selected.target;
      await configure(tx, id, { ...selectedModel, cwd: selected.cwd });
    }, context);
  }

  async renameChat(id: ConversationId, title: string) {
    const value = title.trim();
    if (!value) throw new Error('Enter a conversation name.');
    const conversation = await this.conversation(id);
    await conversation.commit(async (tx) => {
      (await tx.doc(ChatMetadataDoc, id)).title = value.slice(0, 120);
    }, context);
  }

  /**
   * Stops the chat's work, then marks it deleted and removes its workspace directories. The chat stays deleted when
   * the removal fails, which rejects with a `WorkspaceRemovalError`.
   */
  async deleteChat(id: ConversationId) {
    const conversation = await this.conversation(id);
    await conversation.abort(context);
    await conversation.commit(async (tx) => {
      (await tx.doc(ChatMetadataDoc, id)).deleted = true;
    }, context);
    try {
      const workspace = await this.harness.snapshot(WorkspaceDoc, id, context);
      if (workspace?.id) this.local?.remove(workspace.id);
    } catch (cause) {
      throw new WorkspaceRemovalError(cause);
    }
  }

  /**
   * The caller keeps one `requestId` for every attempt to send the same draft. pi-durable returns the existing
   * submission for a repeated one, so a retry after a failure does not submit twice. The content is pi-ai's user
   * message content: text, or text and image parts.
   */
  async send(id: ConversationId, input: UserMessage['content'], requestId: string): Promise<SubmissionId> {
    const content = typeof input === 'string' ? input.trim() : input;
    const text = textOf(content).trim();
    const images = imagesOf(content).length;
    if (!text && !images) throw new Error('Enter a message or attach a photo.');
    const conversation = await this.conversation(id);
    await this.requireAuth(settingsOf(await this.harness.snapshot(AgentDoc, id, context)));
    const submission = await conversation.submit({ type: 'input', content, requestId }, context);
    // pi-durable has no public way to write this in the submission's own commit, so it follows in the next one, and
    // a retry of the same request writes it again. The list shows it without reading the transcript; an untitled
    // chat is named after its first message.
    const photos = images === 1 ? 'Photo' : `${images} photos`;
    await conversation.commit(async (tx) => {
      const chat = await tx.doc(ChatMetadataDoc, id);
      chat.lastInput = submission.id;
      chat.title ||= oneLine(text, 64) || photos;
      chat.preview = oneLine(text, 120) || photos;
      chat.updatedAt = this.options.now();
    }, context);
    return submission.id;
  }

  /**
   * Turns one queued follow-up into a steer, as pi-durable's busy queueing allows: withdraw the submission, then
   * submit the same text again with `whenBusy: 'steer'`. A follow-up a boundary placed meanwhile is left alone.
   * The row carries the submission's number; its record comes from the Harness's queued and placed submissions.
   */
  async steerQueued(id: ConversationId, submissionId: number, content: UserMessage['content']): Promise<void> {
    const conversation = await this.conversation(id);
    const record = (await this.harness.inspect(context)).submissions.find((each) => each.id === submissionId);
    if (!record) throw new Error('That message already left the queue.');
    const result = await this.harness.abortSubmission(record.id, context, id);
    if (result === 'already_placed') return;
    if (result === 'settled' || result === 'not_found') throw new Error('That message already left the queue.');
    // A new request ID: the withdrawn submission is settled, and its ID would return that aborted submission.
    const submission = await conversation.submit(
      { type: 'input', content, whenBusy: 'steer', requestId: uuidv7() }, context);
    await conversation.commit(async (tx) => {
      const chat = await tx.doc(ChatMetadataDoc, id);
      chat.lastInput = submission.id;
      chat.updatedAt = this.options.now();
    }, context);
  }

  /** Runs a chat's parked tasks again, the ones its view's controls list by number, from the Harness's records. */
  async retryParked(tasks: readonly number[]): Promise<void> {
    this.assertOpen();
    for (const { record } of (await this.harness.inspect(context)).tasks) {
      if (tasks.includes(record.id)) await this.harness.retryTask(record.id, context);
    }
  }

  /** Withdraws queued input and aborts the running work; resolves once the chat is idle. */
  async cancel(id: ConversationId): Promise<void> {
    const conversation = await this.conversation(id);
    await conversation.abort(context);
  }

  close(): Promise<void> {
    if (this.closePromise) return this.closePromise;
    this.closed = true;
    for (const state of this.chats.values()) state.dispose();
    this.listeners.clear();
    this.closePromise = (async () => {
      // The Harness aborts and waits for running task code, which still uses the environments; the owner of
      // `machines` closes it after this. A close after the Harness failed on its own returns the same settled close.
      try {
        await this.harness.close(context);
      } finally {
        // The observer stops counting this Harness's work; disposing its task graph after the close is safe.
        this.detachObserver();
      }
    })();
    return this.closePromise;
  }
}
