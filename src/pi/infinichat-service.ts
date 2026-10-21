import type { Context } from '@earendil-works/chord';
import { BACKGROUND_CONTEXT } from '@earendil-works/chord/context';
import { uuidv7, type Models, type UserMessage } from '@earendil-works/pi-ai';
import { AgentDoc, configure, type SessionEnd, type Storage, type TaskId } from '@earendil-works/pi-durable';

import { infiniChatTasks, type KeepAliveController } from '../keep-alive/controller';
import { ChatMetadataDoc } from './chat-metadata';
import { settingsOf } from './chat-projection';
import type { RemoteHostRepository } from './execution/remote/hosts';
import type { RemoteExecution } from './execution/remote/owner';
import { ScheduledTaskNotifier } from './infinichat-notifications';
import { InfiniChatView } from './infinichat-view';
import { openOptChat, type OptChat } from './infinichat/app';
import type { ScheduledInput } from './infinichat/schedule';
import { createDevices, deviceTools } from './infinichat/devices';
import { ConfigDoc } from './infinichat/summary';
import { requireModelAuth } from './model-auth';
import { assertModelSettings, buildModelCatalog, type ChatModelSettings } from './model-catalog';
import { imagesOf, textOf } from './user-input';
import { WorkspaceDoc } from './workspace/document';
import type { Workspaces } from './workspace/storage';

/** `error` is the Harness's latest report; operations reject to their callers instead. */
export interface InfiniChatSnapshot { error?: string }

const context = BACKGROUND_CONTEXT;
const TITLE = 'InfiniChat';
const errorText = (error: unknown) => error instanceof Error ? error.message : String(error);

/**
 * Owns InfiniChat's Harness, on its own database beside the chats' one: OptChat's sequential tools, steer-all
 * queueing and disabled compaction are Harness-wide settings that must not reach ordinary chats. It borrows the
 * chats' remote machine connections; their creator closes them.
 */
export class InfiniChatService {
  private readonly listeners = new Set<() => void>();
  private snapshot: InfiniChatSnapshot = {};
  private closed = false;
  private closePromise?: Promise<void>;
  private detachKeepAlive = () => {};
  private shownView?: InfiniChatView;

  private constructor(
    private readonly chat: OptChat,
    /** The scheduled tasks still waiting, which it also mirrors as local notifications. */
    readonly scheduled: ScheduledTaskNotifier,
    private readonly models: Models,
    private readonly authError?: (providerId: string) => string | undefined,
  ) {}

  static async open(options: {
    storage: Storage; models: Models; workspaces: Workspaces;
    /** The remote owner shared with the chat service; InfiniChat uses its connections and never closes them. */
    remote: RemoteExecution;
    remoteHosts: RemoteHostRepository;
    /** Why a provider has no usable credential, for example a locked keychain or `SESSION_EXPIRED`. */
    authError?: (providerId: string) => string | undefined;
    /** The Harness closed: `failed` after a storage error (pi-durable README "Errors"), `closed` after close(). */
    onClosed?: (end: SessionEnd) => void;
    /** Counts InfiniChat's live work while the service is open; its owner closes it. */
    keepAlive?: KeepAliveController;
  }): Promise<InfiniChatService> {
    const devices = createDevices(options.workspaces, options.remote, options.remoteHosts);
    let service: InfiniChatService | undefined;
    const chat = await openOptChat(options.storage, {
      models: options.models,
      name: TITLE,
      hasDeviceTools: true,
      tools: deviceTools(devices),
      callEnv: (call, target, callContext) =>
        devices.callEnvironment(call, target.read, target.conversationId, callContext),
      nativeContracts: { bash: 'bash', read: 'read' },
      turnState: () => devices.turnState(),
      onReport: (error) => service?.report(error),
      // The chat view shows a conversation only with its metadata document; the phone device reads the workspace.
      init: async (tx, id) => {
        const metadata = await tx.doc(ChatMetadataDoc, id);
        metadata.title = TITLE;
        metadata.createdAt = Date.now();
        (await tx.doc(WorkspaceDoc, id)).id = uuidv7();
      },
    }, context);
    // Scheduled tasks remind the user through local notifications while the app is closed.
    const scheduled = new ScheduledTaskNotifier(chat.harness, (error) => service?.report(error));
    service = new InfiniChatService(chat, scheduled, options.models, options.authError);
    if (options.keepAlive) service.detachKeepAlive = options.keepAlive.observe(chat.harness, infiniChatTasks);
    void scheduled.start().catch((error: unknown) => service?.report(error));
    // A storage error ends the Harness: report it once and let the owner reopen (pi-durable README "Errors").
    void chat.harness.closed.then((end) => {
      if (end.reason === 'failed') service.report(end.error);
      options.onClosed?.(end);
    });
    return service;
  }

  private report(error: unknown) {
    this.snapshot = { error: errorText(error) };
    for (const listener of [...this.listeners]) listener();
  }

  private assertOpen() { if (this.closed) throw new Error('InfiniChat storage is closed.'); }

  readonly subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  };
  readonly getSnapshot = () => this.snapshot;

  /** Clears the Harness's latest report once the user dismisses it; the next report sets it again. */
  dismissError() {
    if (this.snapshot.error === undefined) return;
    this.snapshot = {};
    for (const listener of [...this.listeners]) listener();
  }

  /**
   * The caller keeps one `requestId` for every attempt to send the same draft; OptChat admits a repeated one once.
   * The content is pi-ai's user message content: text, or text and image parts.
   */
  async accept(input: UserMessage['content'], requestId: string): Promise<void> {
    const content = typeof input === 'string' ? input.trim() : input;
    if (!textOf(content).trim() && !imagesOf(content).length) throw new Error('Enter a message or attach a photo.');
    this.assertOpen();
    const root = this.chat.root;
    const agent = await this.chat.harness.snapshot(AgentDoc, root.id, context);
    // OptChat has no default model; nothing is sent until the settings choose one.
    if (!agent?.model) throw new Error('Choose InfiniChat’s models in its settings to send a message.');
    await requireModelAuth(this.models, settingsOf(agent), this.authError);
    this.assertOpen();
    await this.chat.accept({ requestId, content });
    // OptChat's acceptance commit is its own, so the view's record of the request follows in the next one.
    await root.commit(async (tx) => {
      (await tx.doc(ChatMetadataDoc, root.id)).lastRequest = requestId;
    }, context);
  }

  /** Cancels accepted inputs not yet sent and aborts the running turn; summaries and agents keep running. */
  stop(): Promise<void> {
    this.assertOpen();
    return this.chat.abort();
  }

  /**
   * The main model and effort with pi-durable's `configure`, the summary model and effort, and the user's own
   * instructions, in one commit.
   */
  async updateSettings(main: ChatModelSettings, summary: ChatModelSettings, instructions: string): Promise<void> {
    const catalog = buildModelCatalog(this.models);
    const selectedMain = { model: { ...main.model }, thinkingLevel: main.thinkingLevel };
    const selectedSummary = { model: { ...summary.model }, thinkingLevel: summary.thinkingLevel };
    assertModelSettings(catalog, selectedMain);
    assertModelSettings(catalog, selectedSummary);
    this.assertOpen();
    const root = this.chat.root;
    await root.commit(async (tx) => {
      await configure(tx, root.id, selectedMain);
      (await tx.doc(ConfigDoc, root.id)).summary = selectedSummary;
      await this.chat.setInstructions(tx, instructions);
    }, context);
  }

  /** Deletes a scheduled task still waiting, or edits it; false when it was sent first. */
  cancelScheduled(id: TaskId, replacement?: ScheduledInput): Promise<boolean> {
    this.assertOpen();
    return this.chat.cancelScheduled(id, replacement);
  }

  /**
   * InfiniChat's one conversation, shared by the screens that show it, so the settings opened over the conversation
   * do not read its history again; it attaches while something subscribes.
   */
  view(): InfiniChatView {
    this.shownView ??= new InfiniChatView(this.chat.harness, this.chat.root.id,
      (requestId, waitContext) => this.waitForAnswer(requestId, waitContext));
    return this.shownView;
  }

  /** The native receipt of an accepted input once it is submitted; rejects when a stop cancelled it first. */
  waitForAnswer(requestId: string, waitContext?: Context): ReturnType<OptChat['waitForAnswer']> {
    this.assertOpen();
    return this.chat.waitForAnswer(requestId, waitContext);
  }

  close(): Promise<void> {
    if (this.closePromise) return this.closePromise;
    this.closed = true;
    this.listeners.clear();
    this.closePromise = (async () => {
      try {
        await this.chat.close();
      } finally {
        // Keep-alive stops counting this Harness's work; disposing its task graph after the close is safe.
        this.detachKeepAlive();
        this.scheduled.close();
      }
    })();
    return this.closePromise;
  }
}
