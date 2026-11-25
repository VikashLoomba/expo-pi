import { BACKGROUND_CONTEXT } from '@earendil-works/chord/context';
import { uuidv7, type Models, type UserMessage } from '@earendil-works/pi-ai';
import {
  AgentDoc, configure, type ConversationId, type Harness, type HarnessOptions, type RegistryReader, type SessionEnd,
  type Storage, type TaskGraphNode,
} from '@earendil-works/pi-durable';

import { ChatMetadataDoc } from './chat-metadata';
import { settingsOf } from './chat-projection';
import type { ChatViewSnapshot, ChatViewSource } from './chat-view';
import { AgentList, type AgentInfo } from './infinichat-agents';
import { PendingQuestions } from './infinichat-questions';
import { ScheduledTasks, type ScheduledTask } from './infinichat-scheduled';
import type { Machine } from './infinichat-remote/contract';
import {
  MachineList, patchMachine, putMachine, removeMachine, type MachinePatch, type MachinesState,
} from './infinichat-remote/machines';
import { InfiniChatView, type InfiniChatControls } from './infinichat-view';
import { openOptChat, optChatParts, type OptChat, type OptChatParts } from './infinichat/app';
import {
  answerQuestionBatch, type PendingQuestionBatch, type UserQuestionAnswer,
} from './infinichat/ask';
import type { InfiniChatDevices } from './infinichat/device-tools';
import { SCHEDULED_TASK, type ScheduledInput } from './infinichat/schedule';
import { SecretVault, type ActiveSecretInfo } from './infinichat/secrets';
import { MemoryUsageDoc, usageRows, type InfiniChatUsage } from './infinichat/usage';
import { BuildNode, ConfigDoc } from './infinichat/summary';
import { requireModelAuth } from './model-auth';
import { infiniChatDefaults, NEW_CHAT_DEFAULTS } from './new-chat';
import { assertModelSettings, buildModelCatalog, type ChatModelSettings } from './model-catalog';
import { createNativeWebSearchBridge, SearchPresentationsDoc } from './native-web-search/durable';
import { imagesOf, textOf } from './user-input';
import { WorkspaceDoc } from './workspace/document';

/** `error` is the Harness's latest report; operations reject to their callers instead. */
export interface InfiniChatSnapshot { error?: string }

/** What InfiniChat's settings save, in one commit. */
export type InfiniChatSettings = {
  main: ChatModelSettings;
  summary: ChatModelSettings;
  /** The user's own instructions that follow the prompt; empty for none. */
  instructions: string;
  /** The name the user gives InfiniChat; empty for InfiniChat. */
  name: string;
};

/** A value the screens follow with `useSyncExternalStore`. */
interface Store<T> {
  readonly subscribe: (listener: () => void) => () => void;
  readonly getSnapshot: () => T;
}

/**
 * One agent's chat as the screens show it, as UniiChat's views show any unii's: the user reads it, stops its turn and
 * picks its model, and talks only to root.
 */
export interface AgentChat {
  view(): ChatViewSource<InfiniChatControls>;
  /** Continues the run the view's `runFailure` names (pi-durable's continue). */
  continue(): Promise<void>;
  stop(): Promise<void>;
  /** The model and effort this agent runs on from its next request. */
  setModel(settings: ChatModelSettings): Promise<void>;
}

/**
 * InfiniChat as its screens use it, wherever its Harness runs: this core on the phone, or `RemoteInfiniChat` showing
 * a machine's. The store itself is the Harness's latest report. `view`, `accept`, `continue`, `stop` and the
 * settings' main model are root's; `agent` is any agent of the tree, by its name there.
 */
export interface InfiniChatHost extends Store<InfiniChatSnapshot> {
  view(): ChatViewSource<InfiniChatControls>;
  /** The tree of agents, root first; undefined until read. */
  readonly agents: Store<readonly AgentInfo[] | undefined>;
  agent(name: string): AgentChat;
  /** The conversation's machines document (`infinichat-remote/machines.ts`); undefined until read. */
  readonly machines: Store<MachinesState | undefined>;
  putMachine(record: Machine): Promise<void>;
  patchMachine(endpoint: string, patch: MachinePatch): Promise<void>;
  removeMachine(endpoint: string): Promise<void>;
  accept(input: UserMessage['content'], requestId: string): Promise<void>;
  /** Continues the run the view's `runFailure` names, with no message of the user's (pi-durable's continue). */
  continue(): Promise<void>;
  stop(): Promise<void>;
  updateSettings(settings: InfiniChatSettings): Promise<void>;
  cancelScheduled(id: number, replacement?: ScheduledInput): Promise<boolean>;
  /** What the conversation has spent, by model, and what writing its memory has; read when a screen asks. */
  usage(): Promise<InfiniChatUsage>;
  /** The user's `/reload-plugins` (`chat/commands.ts`): what reloading the machine's plugins did. */
  reloadPlugins(): Promise<string>;
  dismissError(): void;
  /** The scheduled tasks still waiting, soonest first; undefined until they are first read. */
  readonly scheduled: Store<readonly ScheduledTask[] | undefined>;
  /** Parked `ask_user` batches waiting across the agent tree; undefined until read. */
  readonly questions: Store<readonly PendingQuestionBatch[] | undefined>;
  /** Metadata of user-provided secrets currently live in RAM (never values). */
  readonly secrets: Store<readonly ActiveSecretInfo[]>;
  /** Delivers answers to a parked `ask_user` batch by its task ID. */
  answerQuestions(taskId: number, answers: readonly UserQuestionAnswer[]): Promise<void>;
  /** Clears one active secret by ID, or all active secrets when omitted. */
  clearSecrets(id?: string): Promise<void>;
}

const TITLE = 'InfiniChat';
const errorText = (error: unknown) => error instanceof Error ? error.message : String(error);

/**
 * InfiniChat's extensions, from the host's devices: OptChat's, and OpenAI's hosted web search, bound to each
 * generation request as the chats bind it (`chat-service.ts`). `harness` and `report` reach the open service, which a
 * host's registry may hold the extensions before and after.
 */
export function infiniChatExtensions(devices: InfiniChatDevices, harness: () => Harness | undefined,
  report: (error: unknown) => void, secrets?: SecretVault): OptChatParts {
  return optChatParts({
    name: TITLE,
    harness,
    hasDeviceTools: true,
    ...devices,
    secrets,
    nativeContracts: { bash: 'bash', read: 'read' },
    extensions: [createNativeWebSearchBridge(report, harness)],
  });
}

const INFINICHAT = 'infinichat';
const NO_MESSAGES: readonly never[] = [];
const MISSING: ChatViewSnapshot = { status: 'missing' };
/** The view of an agent the tree does not name. */
const NO_AGENT: ChatViewSource<InfiniChatControls> = {
  subscribe: () => () => {},
  getSnapshot: () => MISSING,
  getControls: () => undefined,
  getMessages: () => NO_MESSAGES,
  loadEarlier: async () => {},
  fillGap: async () => {},
};

/**
 * InfiniChat's work, in one Harness: every agent's turns are foreground tasks, and their summary builds are work
 * although they are background tasks. A turn's coordinator sleeps while the turn's own tasks work, and a scheduled
 * task waits for its time, so neither is.
 */
export const infiniChatTasks = (task: TaskGraphNode): string | undefined =>
  !task.background || task.kind === BuildNode.definition.name ? INFINICHAT : undefined;

/**
 * Owns InfiniChat's Harness, on its own database: OptChat's sequential tools, steer-all queueing and disabled
 * compaction are Harness-wide settings that must not reach ordinary chats. It runs wherever its host opens it, the
 * phone or a machine, with the devices that host gives its tools. Operations take the caller's context for their own
 * waits and for a single commit that has not started; cancelling one never leaves work half done.
 */
export class InfiniChatService implements InfiniChatHost {
  private readonly listeners = new Set<() => void>();
  private snapshot: InfiniChatSnapshot = {};
  private closed = false;
  private closePromise?: Promise<void>;
  /** Each agent's view by its conversation, shared by the screens that show it; it attaches while one subscribes. */
  private readonly views = new Map<ConversationId, InfiniChatView>();
  private readonly chats = new Map<string, AgentChat>();
  private unfollowAccount = () => {};

  private constructor(
    private readonly chat: OptChat,
    /** The scheduled tasks still waiting. */
    readonly scheduled: ScheduledTasks,
    readonly questions: PendingQuestions,
    readonly secrets: SecretVault,
    private readonly ownsSecrets: boolean,
    readonly machines: MachineList,
    readonly agents: AgentList,
    private readonly models: Models,
    private readonly authError?: (providerId: string) => string | undefined,
    private readonly machine?: string,
  ) {}

  /**
   * `parts` are `infiniChatExtensions`, which the Harness reads from `registry` with the host's own. It opens paused
   * (`openOptChat`): the host resumes `harness` once `registry` holds them all.
   */
  static async open(options: {
    storage: Storage; models: Models; parts: OptChatParts; registry: RegistryReader;
    /** Why a provider has no usable credential, for example a locked keychain or `SESSION_EXPIRED`. */
    authError?: (providerId: string) => string | undefined;
    /** The host's credential store, followed so a conversation without models chooses them (`chooseDefaults`). */
    accountChanges?: (listener: () => void) => () => void;
    /** The machine this runs on, named where a message sends the user to sign in; none on the phone. */
    machine?: string;
    /** The conversation's environment for pi-durable's own tools (`HarnessOptions.env`); device tools bring theirs. */
    env?: HarnessOptions['env'];
    /** Ephemeral RAM secret store; borrowed when passed by a host that shares it with MCP tools. */
    secrets?: SecretVault;
    /** The Harness closed: `failed` after a storage error (pi-durable README "Errors"), `closed` after close(). */
    onClosed?: (end: SessionEnd) => void;
  }): Promise<InfiniChatService> {
    let service: InfiniChatService | undefined;
    const chat = await openOptChat(options.storage, {
      models: options.models,
      registry: options.registry,
      env: options.env,
      parts: options.parts,
      // A crash that ended a run shows in the conversation as its `runFailure` (`InfiniChatView`).
      onReport: (report) => {
        if (report.kind !== 'task_interrupted') service?.report(report.error);
      },
      // Root's title is its metadata document's; the phone device reads the workspace, which every agent shares.
      init: async (tx, id) => {
        const metadata = await tx.doc(ChatMetadataDoc, id);
        metadata.title = TITLE;
        metadata.createdAt = Date.now();
        (await tx.doc(WorkspaceDoc, id)).id = uuidv7();
      },
      // A child's too: `watchDoc` finds no document that doesn't exist yet (below), so each conversation has its
      // searches document from the commit that makes it.
      conversationCreated: async (tx, conversation) => {
        await tx.doc(SearchPresentationsDoc, conversation.id);
      },
    }, BACKGROUND_CONTEXT);
    // pi-durable's `watchDoc` finds no document that doesn't exist yet, and a view stays attached without it, so
    // the searches document exists before any view, as a chat's does from its creating commit (`chat-service.ts`). A
    // conversation from before web search gets it here once; a new document is adopted even unmodified.
    await chat.root.commit(async (tx) => {
      await tx.doc(SearchPresentationsDoc, chat.root.id);
    }, BACKGROUND_CONTEXT);
    const scheduled = new ScheduledTasks(chat.harness, (error) => service?.report(error));
    const questions = new PendingQuestions(chat.harness, (error) => service?.report(error));
    const ownsSecrets = options.secrets === undefined;
    const secrets = options.secrets ?? new SecretVault();
    const machines = new MachineList(chat.harness);
    const agents = new AgentList(chat.harness, chat.root.id);
    service = new InfiniChatService(chat, scheduled, questions, secrets, ownsSecrets, machines, agents,
      options.models, options.authError, options.machine);
    void scheduled.start().catch((error: unknown) => service?.report(error));
    void questions.start().catch((error: unknown) => service?.report(error));
    void machines.start().catch((error: unknown) => service?.report(error));
    void agents.start().catch((error: unknown) => service?.report(error));
    // A new conversation is ready as soon as a provider is connected, now or at a later sign-in.
    const choose = () => {
      void service.chooseDefaults().catch((error: unknown) => service.report(error));
    };
    service.unfollowAccount = options.accountChanges?.(choose) ?? service.unfollowAccount;
    choose();
    // A storage error ends the Harness: report it once and let the owner reopen (pi-durable README "Errors").
    void chat.harness.closed.then((end) => {
      if (end.kind === 'failed') service.report(end.error);
      options.onClosed?.(end);
    });
    return service;
  }

  /** The Harness, for a host that follows its tasks. */
  get harness(): Harness {
    return this.chat.harness;
  }

  /** The tool the model is offered alone (`OptChat.offer`), which the host sets before it resumes `harness`. */
  offer(only?: string): Promise<void> {
    return this.chat.offer(only);
  }

  /** Shows an error as the latest report until it is dismissed; the host reports its own failures here too. */
  report(error: unknown) {
    this.snapshot = { error: errorText(error) };
    for (const listener of [...this.listeners]) listener();
  }

  private assertOpen() { if (this.closed) throw new Error('InfiniChat storage is closed.'); }

  readonly subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  };
  readonly getSnapshot = () => this.snapshot;

  /** Plugins load into a machine's server host; a conversation held here runs only the code its app shipped with. */
  async reloadPlugins(): Promise<string> {
    throw new Error('Plugins run on a machine’s InfiniChat server. Move InfiniChat to a machine to use them.');
  }

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
  async accept(input: UserMessage['content'], requestId: string, context = BACKGROUND_CONTEXT): Promise<void> {
    const content = typeof input === 'string' ? input.trim() : input;
    if (!textOf(content).trim() && !imagesOf(content).length) throw new Error('Enter a message or attach a photo.');
    this.assertOpen();
    const root = this.chat.root;
    // A sign-in the host has not told of yet still counts.
    await this.chooseDefaults(context);
    const agent = await this.chat.harness.snapshot(AgentDoc, root.id, context);
    if (!agent?.model) {
      const where = this.machine === undefined ? 'in Account' : `on ${this.machine}`;
      throw new Error(`Sign in or connect a provider ${where} to send a message.`);
    }
    await requireModelAuth(this.models, settingsOf(agent), this.authError, this.machine);
    // The turn starts only once the summary model has written the earlier messages' lines, so it must answer too.
    const summary = (await this.chat.harness.snapshot(ConfigDoc, root.id, context))?.summary;
    if (summary) await requireModelAuth(this.models, summary, this.authError, this.machine);
    this.assertOpen();
    await this.chat.accept({ requestId, content });
  }

  continue(): Promise<void> {
    this.assertOpen();
    return this.chat.continue();
  }

  /** An agent of the tree by its name there, root too; one the tree does not name shows as missing and refuses. */
  agent(name: string): AgentChat {
    let found = this.chats.get(name);
    if (found === undefined) {
      const conversation = () => {
        this.assertOpen();
        const id = this.agents.conversation(name);
        if (id === undefined) throw new Error(`InfiniChat has no agent ${name}.`);
        return id;
      };
      found = {
        view: () => {
          const id = this.agents.conversation(name);
          return id === undefined ? NO_AGENT : this.viewOf(id);
        },
        continue: async () => this.chat.continue(conversation()),
        stop: async () => this.chat.abort(conversation()),
        setModel: async (settings) => {
          const selected = { model: { ...settings.model }, thinkingLevel: settings.thinkingLevel };
          assertModelSettings(buildModelCatalog(this.models), selected);
          const id = conversation();
          await this.chat.harness.commit((tx) => configure(tx, id, selected), BACKGROUND_CONTEXT);
        },
      };
      this.chats.set(name, found);
    }
    return found;
  }

  putMachine(record: Machine): Promise<void> {
    this.assertOpen();
    return putMachine(this.chat.harness, record);
  }

  patchMachine(endpoint: string, patch: MachinePatch): Promise<void> {
    this.assertOpen();
    return patchMachine(this.chat.harness, endpoint, patch);
  }

  removeMachine(endpoint: string): Promise<void> {
    this.assertOpen();
    return removeMachine(this.chat.harness, endpoint);
  }

  /** Cancels root's accepted inputs not yet sent and aborts its running turn; summaries and the other agents go on. */
  stop(): Promise<void> {
    this.assertOpen();
    return this.chat.abort();
  }

  /**
   * Root's model and effort with pi-durable's `configure`, and what the whole tree shares: the summary model and
   * effort, the user's own instructions and the name, in one commit. Another agent's model is its own (`agent`).
   */
  async updateSettings({ main, summary, instructions, name }: InfiniChatSettings,
    context = BACKGROUND_CONTEXT): Promise<void> {
    const catalog = buildModelCatalog(this.models);
    const selectedMain = { model: { ...main.model }, thinkingLevel: main.thinkingLevel };
    const selectedSummary = { model: { ...summary.model }, thinkingLevel: summary.thinkingLevel };
    assertModelSettings(catalog, selectedMain);
    assertModelSettings(catalog, selectedSummary);
    this.assertOpen();
    const root = this.chat.root;
    await root.commit(async (tx) => {
      await configure(tx, root.id, selectedMain);
      const config = await tx.doc(ConfigDoc, root.id);
      config.summary = selectedSummary;
      config.name = name.trim() || null;
      await this.chat.setInstructions(tx, instructions);
    }, context);
  }

  /**
   * Chooses the models of a conversation that has none, once a provider is connected: that provider's defaults
   * (`infiniChatDefaults`), the preferred provider first, as a new chat's are chosen. Only what is still unchosen is
   * saved, so a conversation with both models is left as it is. It runs as the service opens, whenever the host's
   * credentials change, and before a send.
   */
  async chooseDefaults(context = BACKGROUND_CONTEXT): Promise<void> {
    if (this.closed) return;
    const root = this.chat.root;
    const agent = await this.chat.harness.snapshot(AgentDoc, root.id, context);
    const config = await this.chat.harness.snapshot(ConfigDoc, root.id, context);
    if (agent?.model && config?.summary) return;
    const chosen = agent?.model?.provider;
    const { preferredProvider } = NEW_CHAT_DEFAULTS;
    // Sorting is stable: the preferred provider moves first and the rest keep catalog order. A main model already
    // chosen keeps its provider for the summaries.
    const providers = buildModelCatalog(this.models)
      .filter((provider) => chosen === undefined || provider.id === chosen)
      .sort((left, right) => Number(right.id === preferredProvider) - Number(left.id === preferredProvider));
    for (const provider of providers) {
      // Saved credentials that cannot be read do not make a provider usable.
      if (!await this.models.checkAuth(provider.id).then(Boolean, () => false)) continue;
      // What the account offers, as a send checks; when it can't be asked now, the catalog's models stand.
      const offered = await this.models.getAvailable(provider.id).catch(() => provider.models);
      const defaults = infiniChatDefaults(provider, new Set(offered.map((model) => model.id)));
      if (!defaults || this.closed) continue;
      await root.commit(async (tx) => {
        if ((await tx.doc(AgentDoc, root.id)).model === undefined) await configure(tx, root.id, defaults.main);
        const saved = await tx.doc(ConfigDoc, root.id);
        saved.summary ??= defaults.summary;
      }, context);
      return;
    }
  }

  /**
   * pi-durable's ledger of the whole session (README "Usage and Cost"), which counts every agent of the tree, and
   * OptChat's own of the summaries it wrote for them (`MemoryUsageDoc`).
   */
  async usage(context = BACKGROUND_CONTEXT): Promise<InfiniChatUsage> {
    this.assertOpen();
    const { models } = await this.chat.harness.usage(context);
    const memory = await this.chat.harness.snapshot(MemoryUsageDoc, this.chat.root.id, context);
    return [...usageRows(models, false), ...usageRows(memory?.models ?? {}, true)];
  }

  /**
   * Deletes a scheduled task still waiting, or edits it; false when it was sent first. The caller names it by number,
   * so its ID comes from pi-durable's own record of the waiting task.
   */
  async cancelScheduled(id: number, replacement?: ScheduledInput, context = BACKGROUND_CONTEXT): Promise<boolean> {
    this.assertOpen();
    const { tasks } = await this.chat.harness.inspect(context);
    const task = tasks.find(({ record }) => record.kind === SCHEDULED_TASK && record.id === id);
    return task ? this.chat.cancelScheduled(task.record.id, replacement) : false;
  }

  async answerQuestions(taskId: number, answers: readonly UserQuestionAnswer[],
    context = BACKGROUND_CONTEXT): Promise<void> {
    this.assertOpen();
    await answerQuestionBatch(this.chat.harness, this.secrets, taskId, answers, context);
  }

  async clearSecrets(id?: string): Promise<void> {
    this.secrets.clear(id);
  }

  /** Root's chat, where the user talks. */
  view(): InfiniChatView {
    return this.viewOf(this.chat.root.id);
  }

  /** A view is shared, so the settings opened over a chat do not read its history again. */
  private viewOf(id: ConversationId): InfiniChatView {
    let view = this.views.get(id);
    if (view === undefined) {
      view = new InfiniChatView(this.chat.harness, id);
      this.views.set(id, view);
    }
    return view;
  }

  close(): Promise<void> {
    if (this.closePromise) return this.closePromise;
    this.closed = true;
    this.listeners.clear();
    this.unfollowAccount();
    this.closePromise = (async () => {
      try {
        await this.chat.close();
      } finally {
        this.scheduled.close();
        this.questions.close();
        if (this.ownsSecrets) this.secrets.close();
        this.machines.close();
        this.agents.close();
      }
    })();
    return this.closePromise;
  }
}
