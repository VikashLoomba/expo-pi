import { BACKGROUND_CONTEXT } from '@earendil-works/chord/context';
import { uuidv7, type Models, type UserMessage } from '@earendil-works/pi-ai';
import {
  AgentDoc, Harness, configure, createRegistry, defineExtension, section,
  type ConversationId, type Cursor, type DocumentState, type SessionEnd, type Storage, type SubmissionId,
} from '@earendil-works/pi-durable';
import { createCodingTools } from '@earendil-works/pi-durable/tools';

import type { ChatSummary } from '../chat/types';
import { KeepAliveController } from '../keep-alive/controller';
import type { KeepAliveSettings } from '../keep-alive/settings';
import { ChatMetadataDoc, type ChatMetadata } from './chat-metadata';
import { oneLine, settingsOf, summarizeChat } from './chat-projection';
import { ChatView } from './chat-view';
import { createExpoImages } from './images';
import { WorkspaceDoc } from './workspace/document';
import { WorkspaceExecutionEnv } from './workspace/execution-env';
import type { Workspaces } from './workspace/storage';
import {
  ExecutionTargetDoc, validateExecution, type ChatExecutionSettings,
} from './execution/document';
import type { RemoteExecution } from './execution/remote/owner';
import { requireModelAuth } from './model-auth';
import {
  assertModelSettings, buildModelCatalog, getDefaultModelSettings, getModelSettingsError,
  type ChatModelSettings, type NewChatDefaults,
} from './model-catalog';
import { createNativeWebSearchBridge, SearchPresentationsDoc } from './native-web-search/durable';
import { imagesOf, textOf } from './user-input';

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

  private constructor(
    private readonly harness: Harness,
    private readonly storage: Storage,
    private readonly models: Models,
    private readonly remote: RemoteExecution,
    private readonly workspaces: Workspaces | undefined,
    private readonly keepAlive: KeepAliveController | undefined,
    private readonly options: {
      now: () => number;
      newChat: NewChatDefaults;
      authError?: (providerId: string) => string | undefined;
    },
  ) {}

  static async open(options: {
    storage: Storage; models: Models; now?: () => number;
    /** Where chats' workspace directories live; without it chats have no local execution environment. */
    workspaces?: Workspaces;
    /** Holds the SSH connections of chats that run on a remote machine; the service closes it with the Harness. */
    remote: RemoteExecution;
    newChat?: NewChatDefaults;
    /** Why a provider has no usable credential, for example a locked keychain or `SESSION_EXPIRED`. */
    authError?: (providerId: string) => string | undefined;
    /** The Harness closed: `failed` after a storage error (pi-durable README "Errors"), `closed` after close(). */
    onClosed?: (end: SessionEnd) => void;
    /** The background keep-alive setting; the service closes the controller it builds on it. */
    keepAlive?: KeepAliveSettings;
  }): Promise<DurableChatService> {
    const { workspaces, remote } = options;
    const registry = createRegistry();
    // With a processor, `read` turns photos upright and shrinks them to the model's limits (pi-durable "Images").
    registry.install(createCodingTools({ images: createExpoImages() }));
    const nativeSearch = createNativeWebSearchBridge((error) => service?.report(error));
    registry.install(nativeSearch.extension);
    registry.install(defineExtension({
      name: 'mobile-chat',
      sections: [section('assistant',
        () => 'You are a helpful, thoughtful assistant. Use Markdown when it improves clarity.', { tag: false })],
    }));
    const now = options.now ?? Date.now;
    let service: DurableChatService | undefined;
    const harness = await Harness.open(options.storage, {
      models: options.models, registry, now,
      // Each use reads the chat's committed selection, like pi's sandbox-per-conversation example.
      env: async ({ conversationId, cwd, read }, envContext) => {
        const target = (await read.snapshot(ExecutionTargetDoc, conversationId, envContext))?.target;
        if (target?.kind === 'ssh') return remote.environment(target.machineId, cwd);
        // Without workspaces there is no local environment, and the tools fail with Pi's ordinary error result.
        if (!workspaces) return undefined;
        const workspace = await read.snapshot(WorkspaceDoc, conversationId, envContext);
        if (!workspace?.id) throw new Error('This conversation has no committed workspace identity.');
        // Building it creates the workspace's directory and its temporary directory under the cache, which the
        // system may have purged. It holds no handles between calls, so a fresh one per use needs no cleanup.
        return new WorkspaceExecutionEnv(workspaces.workspace(workspace.id), workspace.id, cwd);
      },
      settings: {
        // SDK retry and timeout defaults apply, so a request cut off while the app was suspended is retried.
        stream: { transport: 'sse' },
      },
      async conversationCreated(tx, conversation) {
        const metadata = await tx.doc(ChatMetadataDoc, conversation.id);
        metadata.createdAt = now();
      },
      onReport: (error) => service?.report(error),
    }, context);
    nativeSearch.attach(harness);
    const keepAlive = options.keepAlive ? new KeepAliveController(harness, options.keepAlive) : undefined;
    service = new DurableChatService(harness, options.storage, options.models, remote, workspaces, keepAlive, {
      now, newChat: options.newChat ?? { models: {} }, authError: options.authError,
    });
    try { await service.loadChats(); }
    catch (error) {
      await service.close();
      throw error;
    }
    // Continue work the last process left unfinished. A chat whose provider cannot authenticate fails on its own.
    harness.resume();
    keepAlive?.start();
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
    return new ChatView(this.harness, id, options.transcript ?? false);
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
    validateExecution(selected);
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
      if (workspace?.id) this.workspaces?.remove(workspace.id);
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
   */
  async steerQueued(id: ConversationId, submissionId: SubmissionId, content: UserMessage['content']): Promise<void> {
    const conversation = await this.conversation(id);
    const result = await this.harness.abortSubmission(submissionId, context, id);
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
      // close.order: the Harness closes first; it aborts and waits for running task code, which still uses
      // the environments. The remote owner closes its connections afterwards. A close after the Harness
      // failed on its own returns the same settled close.
      const failures: unknown[] = [];
      await this.harness.close(context).catch((error: unknown) => failures.push(error));
      await this.remote.close().catch((error: unknown) => failures.push(error));
      // The keep-alive controller uses the Harness only while it runs; its own close touches none of it.
      await this.keepAlive?.close().catch((error: unknown) => failures.push(error));
      if (failures.length) throw new AggregateError(failures, 'Chat storage could not close cleanly.');
    })();
    return this.closePromise;
  }
}
