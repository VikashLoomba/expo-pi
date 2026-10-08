import { BACKGROUND_CONTEXT } from '@earendil-works/chord/context';
import { uuidv7, type Models } from '@earendil-works/pi-ai';
import {
  AgentDoc, Harness, InboxDoc, LiveDoc, configure, createRegistry, defineExtension, section,
  type ConversationId, type Cursor, type DocumentState, type Extension, type SettledSubmissionRecord, type Storage,
  type SubmissionId, type SubmissionRecord, type Tx,
} from '@earendil-works/pi-durable';
import { CodingTools } from '@earendil-works/pi-durable/tools';

import type { ChatSummary } from '../chat/types';
import { ChatMetadataDoc, type ChatMetadata } from './chat-metadata';
import { isBusy, oneLine, settingsOf, summarizeChat } from './chat-projection';
import { ChatView } from './chat-view';
import { WorkspaceExtension } from './workspace/extension';
import { WorkspaceDoc } from './workspace/document';
import { WorkspaceExecutionEnv } from './workspace/execution-env';
import type { Workspaces } from './workspace/storage';
import {
  ExecutionTargetDoc, validateExecution, type ChatExecutionSettings,
} from './execution/document';
import { RemoteExecutionExtension, type RemoteExecution } from './execution/remote/composition';
import {
  assertModelSettings, buildModelCatalog, getDefaultModelSettings, getModelSettingsError,
  type ChatModelSettings, type NewChatDefaults,
} from './model-catalog';
import { createNativeWebSearchBridge } from './native-web-search/durable';

export interface ChatServiceSnapshot { chats: ChatSummary[]; error?: string }

const context = BACKGROUND_CONTEXT;
const errorText = (error: unknown) => error instanceof Error ? error.message : String(error);

/** Commits that change a chat's model, environment or archive state wait until its work has settled. */
async function assertIdle(tx: Tx, id: ConversationId, message: string) {
  if (isBusy(await tx.doc(LiveDoc, id), await tx.doc(InboxDoc, id))) throw new Error(message);
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
  private listScheduled = false;
  private closed = false;
  private closePromise?: Promise<void>;

  private constructor(
    private readonly harness: Harness,
    private readonly storage: Storage,
    private readonly models: Models,
    private readonly remote: RemoteExecution,
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
    /** Why a provider has no usable credential, for example a locked keychain. */
    authError?: (providerId: string) => string | undefined;
    /** Installed beside the app's own extensions; tests and probes register their tools here. */
    extensions?: readonly Extension[];
  }): Promise<DurableChatService> {
    const { workspaces, remote } = options;
    const registry = createRegistry();
    registry.install(CodingTools);
    registry.install(RemoteExecutionExtension);
    registry.install(WorkspaceExtension);
    const nativeSearch = createNativeWebSearchBridge(options.models);
    registry.install(nativeSearch.extension);
    registry.install(defineExtension({
      name: 'mobile-chat',
      sections: [section('assistant',
        () => 'You are a helpful, thoughtful assistant. Use Markdown when it improves clarity.', { tag: false })],
    }));
    for (const extension of options.extensions ?? []) registry.install(extension);
    const now = options.now ?? Date.now;
    let service: DurableChatService | undefined;
    const harness = await Harness.open(options.storage, {
      models: nativeSearch.models, registry, now,
      // Each use reads the chat's committed selection, like pi's sandbox-per-conversation example.
      env: async ({ conversationId, cwd, read }, envContext) => {
        const target = (await read.snapshot(ExecutionTargetDoc, conversationId, envContext))?.target;
        if (target?.kind === 'ssh') return remote.environment(target.machineId, cwd);
        // Without workspaces there is no local environment, and the tools fail with Pi's ordinary error result.
        if (!workspaces) return undefined;
        const workspace = await read.snapshot(WorkspaceDoc, conversationId, envContext);
        if (!workspace?.id) throw new Error('This conversation has no committed workspace identity.');
        // The environment holds no handles between calls, so a fresh one per use needs no cleanup.
        return new WorkspaceExecutionEnv(workspaces.workspace(workspace.id), workspace.id, cwd);
      },
      settings: {
        // SDK retry and timeout defaults apply, so a request cut off while the app was suspended is retried.
        stream: { transport: 'sse' },
        // Keep long conversations usable, without starting background model calls.
        compaction: { backgroundTokens: 0 },
      },
      async conversationCreated(tx, conversation) {
        const metadata = await tx.doc(ChatMetadataDoc, conversation.id);
        metadata.createdAt = now();
      },
      onReport: (error) => service?.report(error),
    }, context);
    nativeSearch.attach(harness);
    service = new DurableChatService(harness, options.storage, options.models, remote, {
      now, newChat: options.newChat ?? { models: {} }, authError: options.authError,
    });
    try { await service.loadChats(); }
    catch (error) {
      await service.close();
      throw error;
    }
    // Continue work the last process left unfinished. A chat whose provider cannot authenticate fails on its own.
    harness.resume();
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
    state.subscribe(this.scheduleList);
  }

  private readonly scheduleList = () => {
    if (this.listScheduled) return;
    this.listScheduled = true;
    queueMicrotask(() => {
      this.listScheduled = false;
      this.updateList();
    });
  };

  private updateList() {
    if (this.closed) return;
    const chats = [...this.chats].flatMap(([id, state]) => {
      const summary = state.value ? summarizeChat(id, state.value) : undefined;
      return summary ? [summary] : [];
    }).sort((a, b) => b.updatedAt - a.updatedAt || b.id - a.id);
    this.snapshot = { ...this.snapshot, chats };
    this.notify();
  }

  private notify() {
    for (const listener of [...this.listeners]) listener();
  }

  private report(error: unknown) {
    this.snapshot = { ...this.snapshot, error: errorText(error) };
    this.notify();
  }

  private assertOpen() { if (this.closed) throw new Error('Chat storage is closed.'); }

  /** The one pre-send check: the chat's provider is registered and authenticated and offers its model. */
  private async requireAuth(settings: ChatModelSettings) {
    assertModelSettings(this.getCatalog(), settings);
    const provider = this.models.getProvider(settings.model.provider);
    if (!provider) throw new Error(`The provider ${settings.model.provider} is unavailable.`);
    const signIn = () => new Error(this.options.authError?.(provider.id)
      || `Sign in or connect ${provider.name} in Account to send a message.`);
    if (!await this.models.checkAuth(provider.id)) throw signIn();
    // Resolving refreshes an expiring token now, so a failed refresh never becomes failed durable work.
    if (!await this.models.getAuth(provider.id)) throw signIn();
    const available = await this.models.getAvailable(provider.id);
    if (!available.some((model) => model.id === settings.model.modelId)) {
      throw new Error(`${settings.model.modelId} is not available for this account. `
        + 'Choose another model in chat settings.');
    }
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
  getCatalog() { return buildModelCatalog(this.models); }

  /** The listed chat a route names, or undefined when there is none. */
  findChat(key: string): ConversationId | undefined { return this.ids.get(key); }

  /** A chat's committed state while subscribed; `transcript` adds its messages, including pre-compaction history. */
  chat(id: ConversationId, options: { transcript?: boolean } = {}): ChatView {
    return new ChatView(this.harness, id, options.transcript ?? false, () => this.latestInput(id));
  }

  /** The latest input submission is not part of the conversation view; read it once when a chat opens. */
  private async latestInput(id: ConversationId): Promise<SubmissionRecord | undefined> {
    let latest: SubmissionRecord | undefined;
    let cursor: Cursor | undefined;
    do {
      const page = await this.storage.scanSubmissions({ conversationId: id }, 100, cursor, context);
      for (const record of page.items) if (record.type === 'input') latest = record;
      cursor = page.next;
    } while (cursor !== undefined);
    return latest;
  }

  /**
   * A new chat continues with the most recently used chat's model and effort while that model
   * is available and its provider connected. Otherwise it uses a connected provider's default.
   */
  private async defaultSettings(): Promise<ChatModelSettings | undefined> {
    const catalog = this.getCatalog();
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
      init: async (tx, id) => {
        (await tx.doc(WorkspaceDoc, id)).id = uuidv7();
      },
    }, context);
    await this.watchChat(conversation.id);
    this.updateList();
    return conversation.id;
  }

  async updateSettings(id: ConversationId, settings: ChatModelSettings): Promise<void> {
    const selected = { model: { ...settings.model }, thinkingLevel: settings.thinkingLevel };
    assertModelSettings(this.getCatalog(), selected);
    const conversation = await this.conversation(id);
    await conversation.commit(async (tx) => {
      await assertIdle(tx, id, 'Finish or stop the pending response before changing chat settings.');
      if ((await tx.doc(ChatMetadataDoc, id)).archived) throw new Error('This chat is archived.');
      // The public SDK mutation keeps history/fork semantics and preserves
      // unrelated agent fields. Model and effort commit in the same transaction.
      await configure(tx, id, selected);
    }, context);
  }

  updateExecution(id: ConversationId, settings: ChatExecutionSettings, modelSettings?: ChatModelSettings) {
    const selected = structuredClone(settings);
    validateExecution(selected);
    const selectedModel = modelSettings
      && { model: { ...modelSettings.model }, thinkingLevel: modelSettings.thinkingLevel };
    return this.configureExecution(id, { cwd: selected.cwd }, async (tx) => {
      if (selectedModel) assertModelSettings(this.getCatalog(), selectedModel);
      (await tx.doc(ExecutionTargetDoc, id)).target = selected.target;
      if (selectedModel) await configure(tx, id, selectedModel);
    });
  }

  /** Commit cwd and application-owned selection state together after old work settles. */
  async configureExecution(id: ConversationId, change: { cwd?: string | null },
    updateState?: (tx: Tx, id: ConversationId) => Promise<void>): Promise<void> {
    const conversation = await this.conversation(id);
    await conversation.commit(async (tx) => {
      // Any durable task can call runtime.env(), including custom/background
      // tasks that never appear in LiveDoc. Abort intent is not settled work.
      // Read on this same transaction line before changing selection or cwd,
      // so a task admitted concurrently cannot slip through an earlier check.
      for (const status of ['pending', 'running', 'waiting', 'completing'] as const) {
        if ((await tx.scanTasks({ conversationId: id, status }, 1)).items.length) {
          throw new Error('Wait for execution to stop before changing its environment or working directory.');
        }
      }
      await assertIdle(tx, id, 'Wait for execution to stop before changing its environment or working directory.');
      if ((await tx.doc(ChatMetadataDoc, id)).archived) throw new Error('This chat is archived.');
      await updateState?.(tx, id);
      await configure(tx, id, change);
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

  async archiveChat(id: ConversationId) {
    const conversation = await this.conversation(id);
    await conversation.commit(async (tx) => {
      await assertIdle(tx, id, 'Stop the response before archiving this chat.');
      (await tx.doc(ChatMetadataDoc, id)).archived = true;
    }, context);
  }

  async send(id: ConversationId, text: string, requestId = uuidv7()): Promise<SubmissionId> {
    const content = text.trim();
    if (!content) throw new Error('Enter a message.');
    const conversation = await this.conversation(id);
    const metadata = await this.harness.snapshot(ChatMetadataDoc, id, context);
    if (metadata?.archived) throw new Error('This chat is archived.');
    await this.requireAuth(settingsOf(await this.harness.snapshot(AgentDoc, id, context)));
    const submission = await conversation.submit({ type: 'input', content, whenBusy: 'reject', requestId }, context);
    // The list shows this without reading the transcript; an untitled chat is named after its first message.
    // The message is already admitted, so a failure here is reported rather than failing the send.
    try {
      await conversation.commit(async (tx) => {
        const chat = await tx.doc(ChatMetadataDoc, id);
        chat.title ||= oneLine(content, 64);
        chat.preview = oneLine(content, 120);
        chat.updatedAt = this.options.now();
      }, context);
    } catch (error) {
      this.report(error);
      return submission.id;
    }
    // A later send that also updates the list supersedes an earlier failure to do so.
    if (this.snapshot.error !== undefined) {
      this.snapshot = { chats: this.snapshot.chats };
      this.notify();
    }
    return submission.id;
  }

  async waitForSubmission(id: SubmissionId): Promise<SettledSubmissionRecord> {
    const submission = await this.harness.submission(id, context);
    if (!submission) throw new Error('Submission not found.');
    return submission.wait(context);
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
      // Harness close seals admission and aborts running work at once; the remote owner then stops its
      // environments, so a command the daemon cannot cancel does not hold the Harness open.
      const results = await Promise.allSettled([this.harness.close(context), this.remote.close()]);
      const failures = results.filter((result): result is PromiseRejectedResult => result.status === 'rejected');
      if (failures.length) {
        throw new AggregateError(failures.map((result) => result.reason), 'Chat storage could not close cleanly.');
      }
    })();
    return this.closePromise;
  }
}
