import { BACKGROUND_CONTEXT } from '@earendil-works/chord/context';
import { Type, uuidv7, type Models } from '@earendil-works/pi-ai';
import {
  AgentDoc, Harness, InboxDoc, LiveDoc, configure, createRegistry, defineDoc, defineExtension, defineTool, section,
  type AgentState, type ConversationId, type Cursor, type EntryRecord, type LiveState,
  type SettledSubmissionRecord, type Storage, type SubmissionId, type SubmissionRecord,
} from '@earendil-works/pi-durable';
import type { SqliteDatabase } from '@earendil-works/pi-durable/storage/sqlite';

import type { ChatConversation, ChatSummary } from '../chat/types';
import { openWorkspaceDatabase } from './workspace/database';
import { createWorkspaceExtension } from './workspace/extension';
import { migrateWorkspaceCapabilities, WORKSPACE_CAPABILITY_REVISION, WorkspaceDoc } from './workspace/document';
import { WorkspaceRuntime } from './workspace/runtime';
import { CODEX_PROVIDER_ID, MODEL_ID } from './codex-auth/identity';
import { assertModelSettings, buildModelCatalog, getDefaultModelSettings, type ChatModelSettings } from './model-catalog';
import { createNativeWebSearchBridge, NativeLiveDoc, NativeResponsesDoc, type NativeLiveState, type NativeResponsesState } from './native-web-search/durable';
import { hasPendingWork, projectChat, sameSummary, type ChatProjectionState } from './chat-projection';

type ChatMetadata = { title: string; createdAt: number; archived: boolean };
export const ChatMetadataDoc = defineDoc<ChatMetadata>({
  kind: 'app.chat', version: 1, scope: 'conversation', history: 'latest', fork: 'initial',
  initial: () => ({ title: '', createdAt: 0, archived: false }),
});

type CachedChat = ChatProjectionState & { revision: number; summary?: ChatSummary };
export interface ChatServiceSnapshot { chats: ChatSummary[]; error?: string }

const context = BACKGROUND_CONTEXT;
const errorText = (error: unknown) => error instanceof Error ? error.message : String(error);

function settingsOf(agent?: Readonly<AgentState> | null): ChatModelSettings {
  // Missing models stay visibly unavailable; never replace a saved choice with
  // another provider. An omitted effort follows the SDK's own default.
  return { model: { provider: agent?.model?.provider ?? '', modelId: agent?.model?.modelId ?? '' },
    thinkingLevel: agent?.thinkingLevel ?? 'off' };
}

function sameSettings(left: ChatModelSettings, right: ChatModelSettings) {
  return left.model.provider === right.model.provider && left.model.modelId === right.model.modelId &&
    left.thinkingLevel === right.thinkingLevel;
}

function conversationId(id: string): ConversationId {
  const value = Number(id);
  if (!Number.isSafeInteger(value) || value < 0 || String(value) !== id) throw new Error('Invalid conversation.');
  return value as ConversationId;
}

/** Owns one durable session. Views are projections of committed records, never a second message store. */
export class DurableChatService {
  private readonly cache = new Map<string, CachedChat>();
  private readonly conversations = new Map<string, ChatConversation>();
  private readonly listeners = new Set<() => void>();
  private snapshot: ChatServiceSnapshot = { chats: [] };
  private scheduling = false;
  private closed = false;
  private closePromise?: Promise<void>;
  private unsubscribeCommits = () => {};
  private notifyScheduled = false;
  private commands: Promise<unknown> = Promise.resolve();
  private readonly hydratingForks = new Set<string>();

  private constructor(
    private readonly harness: Harness,
    private readonly storage: Storage,
    private readonly models: Models,
    private readonly canRun: () => boolean,
    private readonly workspaces: WorkspaceRuntime,
  ) {}

  static async open(options: {
    storage: Storage; models: Models; platform: string; now?: () => number; canRun?: () => boolean;
    openWorkspaceDatabase?: () => Promise<SqliteDatabase>;
  }): Promise<DurableChatService> {
    const registry = createRegistry();
    const workspaces = new WorkspaceRuntime(options.openWorkspaceDatabase ?? openWorkspaceDatabase);
    registry.install(createWorkspaceExtension(workspaces));
    const nativeSearch = createNativeWebSearchBridge(options.models);
    registry.install(nativeSearch.extension);
    registry.install(defineExtension({
      name: 'mobile-chat',
      sections: [section('assistant', () => 'You are a helpful, thoughtful assistant. Use Markdown when it improves clarity. Use add_numbers when asked to add numbers.', { tag: false })],
      tools: [defineTool({
        name: 'add_numbers', description: 'Add two numbers on this device.',
        parameters: Type.Object({ a: Type.Number(), b: Type.Number() }), replay: 'safe',
        async execute({ a, b }, _api, ctx) {
          ctx.abortSignal?.throwIfAborted();
          const result = { sum: a + b, platform: options.platform, runtime: 'on-device' };
          return { content: [{ type: 'text', text: JSON.stringify(result) }], details: result };
        },
      })],
    }));
    const now = options.now ?? Date.now;
    let service: DurableChatService | undefined;
    const harness = await Harness.open(options.storage, {
      models: options.models, registry, now,
      settings: {
        stream: { transport: 'sse', maxRetries: 0, timeoutMs: 60_000 },
        retry: { enabled: false, maxRetries: 0 },
        // Keep long conversations usable, without starting background model calls.
        compaction: { backgroundTokens: 0 },
      },
      async conversationCreated(tx, conversation) {
        const metadata = await tx.doc(ChatMetadataDoc, conversation.id);
        metadata.createdAt = now();
        await migrateWorkspaceCapabilities(tx, conversation.id, conversation.parent ? 'fork' : 'new');
      },
      onReport: (error) => service?.report(error),
    }, context);
    nativeSearch.attach(harness);
    service = new DurableChatService(harness, options.storage, options.models, options.canRun ?? (() => true), workspaces);
    try { await service.initialize(); }
    catch (error) { await service.close(); throw error; }
    return service;
  }

  private async initialize() {
    let cursor: Cursor | undefined;
    do {
      const page = await this.storage.scanConversations({}, 100, cursor, context);
      for (const record of page.items) {
        if (record.owner) continue;
        const metadata = await this.harness.snapshot(ChatMetadataDoc, record.id, context);
        if (!metadata) continue;
        const agent = await this.harness.snapshot(AgentDoc, record.id, context);
        const workspace = await this.harness.snapshot(WorkspaceDoc, record.id, context);
        if (!workspace?.id || workspace.capabilityRevision < WORKSPACE_CAPABILITY_REVISION) {
          // Upgrade existing conversations while dispatch is still paused. Never copy a
          // parent's workspace ID: inherited transcript entries are not file snapshots.
          await this.harness.commit(async (tx) => {
            await migrateWorkspaceCapabilities(tx, record.id, record.parent ? 'fork' : 'existing');
          }, context);
        }
        const native = await this.harness.snapshot(NativeResponsesDoc, record.id, context);
        const nativeLive = await this.harness.snapshot(NativeLiveDoc, record.id, context);
        const cached: CachedChat = { revision: 0, metadata: { ...metadata }, settings: settingsOf(agent), entries: new Map(), live: {},
          native: native ?? { responses: {} }, nativeLive: nativeLive ?? {}, unsettled: new Set(), abortRequested: new Set() };
        let entryCursor: Cursor | undefined;
        do {
          const entries = await this.storage.scanEntries({ conversationId: record.id }, 200, entryCursor, context);
          for (const entry of entries.items) cached.entries.set(entry.id, entry);
          entryCursor = entries.next;
        } while (entryCursor !== undefined);
        const live = await this.storage.findDocument({ kind: 'pi.live', scope: { kind: 'conversation', conversationId: record.id } }, 'current', context);
        if (live) cached.live = (await this.storage.document(live.id, 'current', context))?.value as LiveState ?? {};
        const tasks = [cached.live.run?.taskId, ...(cached.live.compactions ?? []).map((task) => task.taskId)];
        for (const taskId of tasks) if (taskId !== undefined && (await this.harness.getTask(taskId, context))?.abortRequested) {
          cached.abortRequested.add(taskId);
        }
        let submissionCursor: Cursor | undefined;
        do {
          const submissions = await this.storage.scanSubmissions({ conversationId: record.id }, 100, submissionCursor, context);
          for (const submission of submissions.items) this.adoptSubmission(cached, submission);
          submissionCursor = submissions.next;
        } while (submissionCursor !== undefined);
        this.cache.set(String(record.id), cached);
      }
      cursor = page.next;
    } while (cursor !== undefined);
    this.rebuild(new Set(this.cache.keys()));
    // The harness is paused during hydration; there is no dispatch/read-registration gap.
    this.unsubscribeCommits = this.harness.subscribeCommits((publication) => {
      const affected = new Set<string>();
      for (const change of publication.changes) {
        if (change.type === 'conversation' && !change.value.owner) {
          const id = String(change.value.id);
          if (!this.cache.has(id)) {
            this.cache.set(id, { revision: 0, metadata: { title: '', createdAt: 0, archived: false }, settings: settingsOf(), entries: new Map(), live: {},
              native: { responses: {} }, nativeLive: {}, unsettled: new Set(), abortRequested: new Set() });
            affected.add(id);
            if (change.value.parent) this.scheduleForkHydration(id);
          }
        }
      }
      for (const change of publication.changes) {
        const id = change.type === 'conversation' ? String(change.value.id)
          : change.type === 'document' || change.type === 'document.copy' ? String(change.conversationId)
            : String(change.value.conversationId);
        const cached = this.cache.get(id);
        if (!cached) continue;
        cached.revision++;
        if (change.type === 'entry') {
          cached.entries.set(change.value.id, change.value);
          cached.committed = undefined;
          affected.add(id);
        }
        if (change.type === 'submission' && change.value.type === 'input') {
          this.adoptSubmission(cached, change.value);
          affected.add(id);
        }
        if (change.type === 'task' && change.value.abortRequested) {
          cached.abortRequested.add(change.value.id);
          affected.add(id);
        }
        if (change.type === 'document' && change.value) {
          if (change.record.kind === 'pi.agent') {
            const settings = settingsOf(change.value as AgentState);
            if (!sameSettings(cached.settings, settings)) cached.settings = settings;
            affected.add(id);
          }
          if (change.record.kind === 'app.chat') {
            cached.metadata = change.value as ChatMetadata;
            affected.add(id);
          }
          if (change.record.kind === 'pi.live') {
            if (cached.live.run?.taskId !== (change.value as LiveState).run?.taskId) cached.committed = undefined;
            cached.live = change.value as LiveState;
            affected.add(id);
          }
          if (change.record.kind === NativeResponsesDoc.definition.kind) {
            cached.native = change.value as NativeResponsesState;
            cached.committed = undefined;
            affected.add(id);
          }
          if (change.record.kind === NativeLiveDoc.definition.kind) {
            cached.nativeLive = change.value as NativeLiveState;
            cached.committed = undefined;
            affected.add(id);
          }
        }
      }
      for (const id of affected) {
        const cached = this.cache.get(id)!;
        const liveTasks = new Set<number | undefined>([cached.live.run?.taskId, ...(cached.live.compactions ?? []).map((task) => task.taskId)]);
        for (const taskId of cached.abortRequested) if (!liveTasks.has(taskId)) cached.abortRequested.delete(taskId);
      }
      // No Session calls here: publications are already immutable adopted revisions.
      this.rebuild(affected);
    });
  }

  /** Document-copy publications intentionally omit values. Hydrate after the listener returns. */
  private scheduleForkHydration(id: string) {
    if (this.hydratingForks.has(id)) return;
    this.hydratingForks.add(id);
    queueMicrotask(() => {
      void (async () => {
        const cid = conversationId(id);
        while (!this.closed) {
          const cached = this.cache.get(id);
          if (!cached) return;
          const revision = cached.revision;
          const [metadata, agent, live, native, nativeLive] = await Promise.all([
            this.harness.snapshot(ChatMetadataDoc, cid, context),
            this.harness.snapshot(AgentDoc, cid, context),
            this.harness.snapshot(LiveDoc, cid, context),
            this.harness.snapshot(NativeResponsesDoc, cid, context),
            this.harness.snapshot(NativeLiveDoc, cid, context),
          ]);
          const entries = new Map<number, EntryRecord>();
          let cursor: Cursor | undefined;
          do {
            const page = await this.storage.scanEntries({ conversationId: cid }, 200, cursor, context);
            for (const entry of page.items) entries.set(entry.id, entry);
            cursor = page.next;
          } while (cursor !== undefined);
          if (this.closed) return;
          // Reads are asynchronous: never overwrite a newer commit's projection.
          if (cached.revision !== revision) continue;
          if (metadata) cached.metadata = { ...metadata };
          cached.settings = settingsOf(agent);
          cached.live = live ?? {};
          cached.native = native ?? { responses: {} };
          cached.nativeLive = nativeLive ?? {};
          cached.entries = entries;
          cached.committed = undefined;
          this.rebuild(new Set([id]));
          return;
        }
      })().catch((error) => { if (!this.closed) this.report(error); })
        .finally(() => this.hydratingForks.delete(id));
    });
  }

  private adoptSubmission(cached: CachedChat, submission: SubmissionRecord) {
    if (submission.type !== 'input') return;
    if (!cached.submission || submission.id >= cached.submission.id) cached.submission = submission;
    if (submission.status === 'queued' || submission.status === 'placed') cached.unsettled.add(submission.id);
    else cached.unsettled.delete(submission.id);
  }

  private rebuild(affected: Set<string>) {
    let changed = false;
    let summariesChanged = false;
    for (const id of affected) {
      const cached = this.cache.get(id)!;
      const previous = this.conversations.get(id);
      const next = projectChat(id, cached, previous, this.scheduling);
      cached.committed = next.committed;
      if (next.conversation !== previous) {
        this.conversations.set(id, next.conversation);
        changed = true;
      }
      if (!sameSummary(cached.summary, next.summary)) {
        cached.summary = next.summary;
        summariesChanged = true;
      }
    }
    if (summariesChanged) {
      const chats = [...this.cache.values()].flatMap((cached) => cached.summary ? [cached.summary] : [])
        .sort((a, b) => b.updatedAt - a.updatedAt || Number(b.id) - Number(a.id));
      this.snapshot = { ...this.snapshot, chats };
    }
    if (changed || summariesChanged) this.notify();
  }

  private notify() {
    if (this.notifyScheduled || this.closed) return;
    this.notifyScheduled = true;
    queueMicrotask(() => {
      this.notifyScheduled = false;
      if (!this.closed) for (const listener of this.listeners) listener();
    });
  }

  private report(error: unknown) { this.snapshot = { ...this.snapshot, error: errorText(error) }; this.notify(); }
  private assertOpen() { if (this.closed) throw new Error('Chat storage is closed.'); }
  private serializeCommand<T>(action: () => Promise<T>): Promise<T> {
    const command = this.commands.then(action);
    this.commands = command.catch(() => {});
    return command;
  }
  private async requireAuth(id: string) {
    this.assertOpen();
    const settings = this.cache.get(id)?.settings;
    if (!settings) throw new Error('Conversation not found.');
    assertModelSettings(this.getCatalog(), settings);
    const provider = this.models.getProvider(settings.model.provider)!;
    if (!await this.models.checkAuth(provider.id)) throw new Error(`Sign in or connect ${provider.name} in Account to send a message.`);
    const available = await this.models.getAvailable(provider.id);
    if (!available.some((model) => model.id === settings.model.modelId)) {
      throw new Error(`${settings.model.modelId} is not available for this account. Choose another model in chat settings.`);
    }
    this.assertOpen();
  }
  private async prepareScheduling() {
    if (this.scheduling) return;
    // Scheduling is session-wide. Validate all recovered work before enabling
    // it, so sending in one chat cannot fail another chat's pending request.
    for (const [id, cached] of this.cache) {
      if (hasPendingWork(cached)) await this.requireAuth(id);
    }
  }
  private enableScheduling() {
    this.assertOpen();
    // Native activity may change while auth or a conversation lookup awaits.
    if (!this.canRun()) throw new Error('Return to the app to continue.');
    if (this.scheduling) return;
    this.harness.resume();
    this.scheduling = true;
    this.rebuild(new Set(this.cache.keys()));
  }
  private async conversation(id: string) {
    this.assertOpen();
    const conversation = await this.harness.conversation(conversationId(id), context);
    if (!conversation || !this.cache.has(id)) throw new Error('Conversation not found.');
    return conversation;
  }
  readonly subscribe = (listener: () => void) => { this.listeners.add(listener); return () => { this.listeners.delete(listener); }; };
  readonly getSnapshot = () => this.snapshot;
  getConversation(id: string) { return this.conversations.get(id); }
  getConversations() { return this.conversations.values(); }
  getCatalog() { return buildModelCatalog(this.models); }

  async createChat(): Promise<string> {
    this.assertOpen();
    const settings = getDefaultModelSettings(this.getCatalog(), { provider: CODEX_PROVIDER_ID, modelId: MODEL_ID });
    if (!settings) throw new Error('No chat models are available. Connect a provider in Account.');
    const conversation = await this.harness.createConversation({ ownership: { kind: 'ownerless' },
      agent: settings,
    }, context);
    return String(conversation.id);
  }
  updateSettings(id: string, settings: ChatModelSettings): Promise<void> {
    const selected = { model: { ...settings.model }, thinkingLevel: settings.thinkingLevel };
    return this.serializeCommand(async () => {
      assertModelSettings(this.getCatalog(), selected);
      const conversation = await this.conversation(id);
      await conversation.commit(async (tx) => {
        const live = await tx.doc(LiveDoc, conversation.id);
        const inbox = await tx.doc(InboxDoc, conversation.id);
        const running = live.run && !(await tx.task(live.run.taskId))?.abortRequested;
        let compacting = false;
        for (const task of live.compactions ?? []) if (!(await tx.task(task.taskId))?.abortRequested) compacting = true;
        if (running || compacting || inbox.items.some((item) => item.mode !== 'write')) {
          throw new Error('Finish or stop the pending response before changing chat settings.');
        }
        if ((await tx.doc(ChatMetadataDoc, conversation.id)).archived) throw new Error('This chat is archived.');
        // The public SDK mutation keeps history/fork semantics and preserves
        // unrelated agent fields. Model and effort commit in the same transaction.
        await configure(tx, conversation.id, selected);
      }, context);
    });
  }
  async renameChat(id: string, title: string) {
    const value = title.trim();
    if (!value) throw new Error('Enter a conversation name.');
    const conversation = await this.conversation(id);
    await conversation.commit(async (tx) => { (await tx.doc(ChatMetadataDoc, conversation.id)).title = value.slice(0, 120); }, context);
  }
  async archiveChat(id: string) {
    const conversation = await this.conversation(id);
    const cached = this.cache.get(id);
    if (cached && hasPendingWork(cached)) throw new Error('Stop the response before archiving this chat.');
    await conversation.commit(async (tx) => { (await tx.doc(ChatMetadataDoc, conversation.id)).archived = true; }, context);
  }
  send(id: string, text: string, requestId = uuidv7()): Promise<string> {
    return this.serializeCommand(async () => {
      if (!text.trim()) throw new Error('Enter a message.');
      await this.requireAuth(id);
      const conversation = await this.conversation(id);
      if (this.cache.get(id)?.metadata.archived) throw new Error('This chat is archived.');
      await this.prepareScheduling();
      this.enableScheduling();
      const cached = this.cache.get(id)!;
      if (cached.live.run && cached.abortRequested.has(cached.live.run.taskId)) await conversation.waitForIdle(context);
      const submission = await conversation.submit({ type: 'input', content: text.trim(), whenBusy: 'reject', requestId }, context);
      return String(submission.id);
    });
  }
  async waitForSubmission(id: string): Promise<SettledSubmissionRecord> {
    const value = Number(id);
    if (!Number.isSafeInteger(value) || value < 0 || String(value) !== id) throw new Error('Invalid submission.');
    const submission = await this.harness.submission(value as SubmissionId, context);
    if (!submission) throw new Error('Submission not found.');
    const record = await submission.status(context);
    if (record.status === 'done' || record.status === 'unanswered') return record;
    const cached = this.cache.get(String(record.conversationId));
    if (!cached?.live.run || !cached.abortRequested.has(cached.live.run.taskId)) await this.requireAuth(String(record.conversationId));
    await this.prepareScheduling();
    this.enableScheduling();
    return submission.wait(context);
  }
  async resume() {
    await this.prepareScheduling();
    if (!this.canRun()) return;
    this.enableScheduling();
  }
  cancel(id: string): Promise<void> {
    return this.serializeCommand(async () => {
      const conversation = await this.conversation(id);
      if (this.scheduling) {
        await conversation.abort(context);
        return;
      }
      // Conversation.abort() also resumes every recovered chat. Commit cancellation
      // through the SDK's non-resuming APIs while offline; normal admission later
      // runs the SDK abort handlers and preserves their transcript cleanup semantics.
      const cached = this.cache.get(id)!;
      for (const submissionId of [...cached.unsettled]) await this.harness.abortSubmission(submissionId as SubmissionId, context, conversation.id);
      if (cached.live.run) await this.harness.abortTask(cached.live.run.taskId, context);
      for (const task of cached.live.compactions ?? []) await this.harness.abortTask(task.taskId, context);
    });
  }
  close(): Promise<void> {
    if (this.closePromise) return this.closePromise;
    this.closed = true;
    this.unsubscribeCommits();
    this.listeners.clear();
    this.workspaces.stop();
    this.closePromise = (async () => {
      const results = await Promise.allSettled([this.harness.close(context), this.workspaces.close()]);
      const failures = results.filter((result): result is PromiseRejectedResult => result.status === 'rejected');
      if (failures.length) throw new AggregateError(failures.map((result) => result.reason), 'Chat storage could not close cleanly.');
    })();
    return this.closePromise;
  }
}
