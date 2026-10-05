import { BACKGROUND_CONTEXT } from '@earendil-works/chord/context';
import type { AuthInteraction, LoginOptions, Models } from '@earendil-works/pi-ai';
import type { Storage } from '@earendil-works/pi-durable';

import { DurableChatService, type ChatServiceSnapshot } from '../pi/chat-service';
import { CODEX_PROVIDER_ID } from '../pi/codex-auth/identity';
import { buildModelCatalog, type ChatModelSettings } from '../pi/model-catalog';
import type { ProviderAccess } from '../pi/provider-credentials';
import type { ChatConversation } from './types';

export interface ChatRuntimeSnapshot extends ChatServiceSnapshot {
  ready: boolean;
  authChecking: boolean;
  signOutPending: boolean;
  disconnectingProvider?: string;
  authError?: string;
}
export type ChatConversationState = Omit<ChatConversation, 'messages'>;
interface ObservableCredentials {
  readonly getSnapshot: () => { ready: boolean; signedIn: boolean; error?: string };
  readonly subscribe: (listener: () => void) => () => void;
  readonly getProviderSnapshot?: (providerId: string) => ProviderAccess;
  readonly replaceApiKey?: (providerId: string, key: string) => Promise<void>;
  readonly restoreProvider?: (providerId: string) => Promise<void>;
  restore(): Promise<void>;
}

/** Serializes native lifecycle changes with message admission and account changes. */
export class ChatRuntime {
  private service?: DurableChatService;
  private opened = false;
  private active = false;
  private queue: Promise<unknown> = Promise.resolve();
  private unsubscribe = () => {};
  private listeners = new Set<() => void>();
  private snapshot: ChatRuntimeSnapshot = { ready: false, chats: [], authChecking: false, signOutPending: false };
  private readonly conversationStates = new Map<string, ChatConversationState>();
  private runtimeError?: string;
  private closeFailure?: Error;
  private authChecking = false;
  private authError?: string;
  private authController?: AbortController;
  private loginController?: AbortController;
  private signOutRequested = false;
  private disconnectingProvider?: string;
  private unsubscribeCredentials?: () => void;
  private credentialRestoration?: Promise<void>;

  constructor(private readonly options: { models: Models; openStorage: () => Promise<Storage>; platform: string; credentials?: ObservableCredentials }) {}

  private serialize<T>(action: () => Promise<T>): Promise<T> {
    const operation = this.queue.then(action);
    this.queue = operation.catch(() => {});
    return operation;
  }

  private publish() {
    const present = new Set<string>();
    for (const current of this.service?.getConversations() ?? []) {
      present.add(current.id);
      const previous = this.conversationStates.get(current.id);
      if (!previous || previous.title !== current.title || previous.busy !== current.busy ||
          previous.settings !== current.settings || previous.pending !== current.pending || previous.error !== current.error) {
        this.conversationStates.set(current.id, { id: current.id, title: current.title,
          settings: current.settings, busy: current.busy, pending: current.pending, ...(current.error ? { error: current.error } : {}) });
      }
    }
    for (const id of this.conversationStates.keys()) if (!present.has(id)) this.conversationStates.delete(id);
    const state = this.service?.getSnapshot();
    const chats = state?.chats ?? this.snapshot.chats;
    const error = this.runtimeError ?? state?.error;
    const ready = this.opened && this.active;
    if (chats !== this.snapshot.chats || error !== this.snapshot.error || ready !== this.snapshot.ready ||
        this.authChecking !== this.snapshot.authChecking || this.authError !== this.snapshot.authError ||
        this.signOutRequested !== this.snapshot.signOutPending || this.disconnectingProvider !== this.snapshot.disconnectingProvider) {
      this.snapshot = { chats, ready, authChecking: this.authChecking, signOutPending: this.signOutRequested,
        ...(this.disconnectingProvider ? { disconnectingProvider: this.disconnectingProvider } : {}),
        ...(error ? { error } : {}), ...(this.authError ? { authError: this.authError } : {}) };
    }
    // A streaming update can change a conversation without changing the list.
    for (const listener of this.listeners) listener();
  }

  private canRun() {
    return this.active && !this.signOutRequested && !this.loginController;
  }

  private credentialAccess(providerId: string): ProviderAccess | undefined {
    const credentials = this.options.credentials;
    if (credentials?.getProviderSnapshot) return credentials.getProviderSnapshot(providerId);
    if (!credentials || providerId !== CODEX_PROVIDER_ID) return undefined;
    const state = credentials.getSnapshot();
    return { ready: state.ready, connected: state.signedIn && !state.error, error: state.error };
  }

  private observeCredentials() {
    const credentials = this.options.credentials;
    if (!credentials || this.unsubscribeCredentials) return;
    const usableProviders = () => new Set(this.options.models.getProviders()
      .filter((provider) => this.credentialAccess(provider.id)?.connected).map((provider) => provider.id));
    let previous = usableProviders();
    this.unsubscribeCredentials = credentials.subscribe(() => {
      const current = credentials.getSnapshot();
      const usable = usableProviders();
      const lostProviders = [...previous].filter((providerId) => !usable.has(providerId));
      previous = usable;
      if (current.error) this.authError = current.error;
      else if (current.signedIn) this.authError = undefined;
      this.publish();
      if (lostProviders.length && !this.signOutRequested) {
        // Stop every conversation after permanent invalidation or a failed
        // credential read. Reopening history itself requires no credentials.
        void this.serialize(async () => {
          if (lostProviders.every((providerId) => this.credentialAccess(providerId)?.connected) || this.signOutRequested) return;
          await this.close();
          await this.open(false);
        }).catch((error) => this.report(error));
      }
    });
  }

  /** Resolve through Pi so its store lock owns refresh and durable rotation. */
  private async authenticate(providerId: string): Promise<boolean> {
    if (!this.canRun()) return false;
    const controller = new AbortController();
    this.authController = controller;
    this.authChecking = true;
    this.publish();
    try {
      await this.credentialRestoration;
      const credentials = this.credentialAccess(providerId);
      if (credentials?.error) { if (providerId === CODEX_PROVIDER_ID) this.authError = credentials.error; return false; }
      if (!this.active || this.signOutRequested) return false;
      const present = await this.options.models.checkAuth(providerId, { signal: controller.signal });
      if (!present) { if (providerId === CODEX_PROVIDER_ID) this.authError = credentials?.error; return false; }
      if (!this.canRun()) return false;
      const resolved = await this.options.models.getAuth(providerId, { signal: controller.signal });
      if (providerId === CODEX_PROVIDER_ID) this.authError = undefined;
      return !!resolved && this.canRun();
    } catch (error) {
      if (!controller.signal.aborted) {
        if (providerId !== CODEX_PROVIDER_ID) throw error;
        this.authError = this.credentialAccess(providerId)?.error
          ?? (error instanceof Error ? error.message : 'Could not connect to your ChatGPT account. Try again.');
      }
      return false;
    } finally {
      if (this.authController === controller) this.authController = undefined;
      this.authChecking = false;
      this.publish();
    }
  }

  private async requireAuth(providerId: string) {
    if (!await this.authenticate(providerId)) {
      if (!this.active) throw new Error('Return to the app to continue.');
      if (this.signOutRequested) throw new Error('Finish signing out before connecting again.');
      if (this.loginController) throw new Error('Finish or cancel sign-in before sending a message.');
      throw new Error(this.credentialAccess(providerId)?.error || (providerId === CODEX_PROVIDER_ID ? this.authError : undefined)
        || `Sign in or connect ${this.options.models.getProvider(providerId)?.name ?? providerId} in Account to send a message.`);
    }
  }

  private async authenticateRecovery(): Promise<boolean> {
    const pending = [...this.service?.getConversations() ?? []].filter((conversation) => conversation.pending);
    for (const providerId of new Set(pending.map((conversation) => conversation.settings.model.provider))) {
      if (!await this.authenticate(providerId)) return false;
    }
    return this.canRun();
  }

  private async open(resume = true) {
    if (this.closeFailure) throw this.closeFailure;
    if (this.opened || !this.active) return;
    let storage: Storage | undefined;
    let service: DurableChatService | undefined;
    try {
      storage = await this.options.openStorage();
      service = await DurableChatService.open({ storage, models: this.options.models, platform: this.options.platform,
        canRun: () => this.canRun(),
      });
      this.service = service;
      this.opened = true;
      this.unsubscribe = service.subscribe(() => this.publish());
      // Opening/hydrating itself never dispatches. Recovered work waits for auth.
      await this.credentialRestoration;
      this.runtimeError = undefined;
      if (resume) {
        try { if (await this.authenticateRecovery() && this.canRun()) await service.resume(); }
        catch (error) { this.runtimeError = error instanceof Error ? error.message : 'Could not resume saved responses.'; }
      }
      this.publish();
    } catch (error) {
      this.opened = false;
      this.unsubscribe();
      try {
        if (service) await service.close();
        else await storage?.close(BACKGROUND_CONTEXT);
      } catch (closeError) {
        this.closeFailure = new AggregateError([error, closeError], 'Chat storage could not close after opening failed. Restart the app before retrying.');
      }
      const failure = this.closeFailure ?? error;
      this.report(failure);
      throw failure;
    }
  }

  private async close() {
    if (this.closeFailure) throw this.closeFailure;
    if (!this.opened) return;
    this.opened = false;
    this.unsubscribe();
    this.publish();
    try { await this.service!.close(); }
    catch (error) {
      this.closeFailure = new Error('Chat storage could not close. Restart the app before reopening chats.', { cause: error });
      this.report(this.closeFailure);
      throw this.closeFailure;
    }
  }

  readonly subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  };
  readonly getSnapshot = () => this.snapshot;
  getConversation(id: string) { return this.service?.getConversation(id); }
  getConversationState(id: string) { return this.conversationStates.get(id); }
  getCatalog() { return this.service?.getCatalog() ?? buildModelCatalog(this.options.models); }

  activate(): Promise<void> {
    this.active = true;
    // Auth initialization is independent of SQLite: even a database failure
    // must leave account settings able to restore or replace a saved sign-in.
    if (this.options.credentials && !this.credentialRestoration) {
      this.credentialRestoration = this.options.credentials.restore().catch(() => {
        this.authError = this.options.credentials?.getSnapshot().error;
        this.publish();
      });
    }
    return this.serialize(async () => { this.observeCredentials(); await this.open(); this.publish(); });
  }
  deactivate(): Promise<void> {
    this.active = false;
    this.authController?.abort();
    this.publish();
    return this.serialize(async () => {
      this.unsubscribeCredentials?.();
      this.unsubscribeCredentials = undefined;
      await this.close();
    });
  }
  report(error: unknown) {
    this.runtimeError = error instanceof Error ? error.message : String(error);
    this.publish();
  }
  private operate<T>(action: (service: DurableChatService) => Promise<T>): Promise<T> {
    return this.serialize(async () => {
      if (!this.active) throw new Error('Return to the app to continue.');
      await this.open();
      if (!this.active) throw new Error('Return to the app to continue.');
      const result = await action(this.service!);
      if (this.runtimeError) { this.runtimeError = undefined; this.publish(); }
      return result;
    });
  }
  createChat() { return this.operate((service) => service.createChat()); }
  renameChat(id: string, title: string) { return this.operate((service) => service.renameChat(id, title)); }
  archiveChat(id: string) { return this.operate((service) => service.archiveChat(id)); }
  updateSettings(id: string, settings: ChatModelSettings) { return this.operate((service) => service.updateSettings(id, settings)); }
  async send(id: string, text: string) {
    await this.operate(async (service) => {
      const conversation = service.getConversation(id);
      if (!conversation) throw new Error('Conversation not found.');
      await this.requireAuth(conversation.settings.model.provider);
      if (!await this.authenticateRecovery()) throw new Error('Connect the providers for pending responses in Account before continuing.');
      return service.send(id, text);
    });
  }
  cancel(id: string) { return this.operate((service) => service.cancel(id)); }
  resume(id?: string) { return this.operate(async (service) => {
    const conversations = id ? [service.getConversation(id)].filter((conversation) => !!conversation) : [...service.getConversations()];
    for (const providerId of new Set(conversations.map((conversation) => conversation.settings.model.provider))) await this.requireAuth(providerId);
    if (!await this.authenticateRecovery()) throw new Error('Connect the providers for pending responses in Account before continuing.');
    await service.resume();
  }); }

  retryAuth(providerId = CODEX_PROVIDER_ID) {
    return this.serialize(async () => {
      if (this.signOutRequested) throw new Error('Finish signing out before connecting again.');
      try {
        if (this.options.credentials?.restoreProvider) await this.options.credentials.restoreProvider(providerId);
        else await this.options.credentials?.restore();
      }
      catch (error) {
        if (providerId === CODEX_PROVIDER_ID) this.authError = this.credentialAccess(providerId)?.error
          ?? (error instanceof Error ? error.message : 'Could not restore your ChatGPT sign-in.');
        this.publish();
        throw error;
      }
      await this.open(false);
      if (await this.authenticate(providerId) && await this.authenticateRecovery() && this.canRun()) await this.service?.resume();
    });
  }

  signInCompleted(providerId = CODEX_PROVIDER_ID) {
    return this.serialize(async () => {
      // A login completion queued before sign-out must not override that newer
      // intent. Only successful credential deletion releases the sign-out gate.
      if (this.signOutRequested) return;
      this.authError = undefined;
      this.publish();
      await this.open(false);
      if (await this.authenticate(providerId) && await this.authenticateRecovery() && this.canRun()) await this.service?.resume();
    });
  }

  /** Pause transports while Pi replaces an account; never hold the lifecycle queue over browser UI. */
  async login(providerId: string, interaction: AuthInteraction, options?: LoginOptions): Promise<void> {
    if (this.signOutRequested) throw new Error('Finish disconnecting before connecting again.');
    if (this.loginController) throw new Error('Finish or cancel the current sign-in first.');
    interaction.signal?.throwIfAborted();
    const controller = new AbortController();
    const abort = () => controller.abort(interaction.signal?.reason);
    interaction.signal?.addEventListener('abort', abort, { once: true });
    this.loginController = controller;
    this.authController?.abort();
    try {
      // Closing a live scheduler is required before replacing its account. A
      // successful SQLite reopen is not a prerequisite for independent OAuth.
      await this.serialize(() => this.close());
      controller.signal.throwIfAborted();
      await this.options.models.login(providerId, 'oauth', { ...interaction, signal: controller.signal }, options);
      if (providerId === CODEX_PROVIDER_ID) this.authError = undefined;
    } finally {
      interaction.signal?.removeEventListener('abort', abort);
      await this.serialize(async () => {
        if (this.loginController === controller) this.loginController = undefined;
        try {
          await this.open(false);
          // Cancelling login preserves the previous account. Pending durable work
          // may resume only once account replacement and current lifecycle settle.
          if (this.canRun() && await this.authenticateRecovery()) await this.service?.resume();
        } catch (error) {
          // Chat recovery has its own observable failure state. It must neither
          // turn a committed login into an auth failure nor replace its error.
          this.report(error);
        }
        this.publish();
      });
    }
  }

  saveProviderKey(providerId: string, key: string) {
    return this.serialize(async () => {
      if (!key.trim()) throw new Error('Enter an API key.');
      if (this.signOutRequested) throw new Error('Finish disconnecting before connecting again.');
      if (this.loginController) throw new Error('Finish or cancel sign-in before changing an API key.');
      if (!this.options.models.getProvider(providerId)?.auth.apiKey?.login) throw new Error('This provider does not support API key sign-in.');
      // Do not replace credentials underneath an active transport. The durable
      // scheduler retains its pending inputs while the key is changed.
      await this.close();
      try {
        if (this.options.credentials?.replaceApiKey) await this.options.credentials.replaceApiKey(providerId, key);
        else {
          await this.options.models.login(providerId, 'api_key', {
            async prompt(prompt) {
              if (prompt.type !== 'secret') throw new Error('This provider requires additional configuration.');
              return key.trim();
            },
            notify() {},
          });
        }
      } finally { await this.open(false); }
      if (await this.authenticateRecovery() && this.canRun()) await this.service?.resume();
    });
  }

  /** Close the global scheduler before deleting credentials; reopen with dispatch paused. */
  signOut(providerId = CODEX_PROVIDER_ID): Promise<void> {
    if (this.disconnectingProvider && this.disconnectingProvider !== providerId) {
      return Promise.reject(new Error(`Finish disconnecting ${this.options.models.getProvider(this.disconnectingProvider)?.name ?? this.disconnectingProvider} before removing another provider.`));
    }
    this.signOutRequested = true;
    this.loginController?.abort();
    this.disconnectingProvider = providerId;
    this.authController?.abort();
    this.publish();
    return this.serialize(async () => {
      await this.close();
      let deletionError: unknown;
      let deletionMessage: string | undefined;
      try {
        await this.options.models.logout(providerId);
        this.signOutRequested = false;
        this.disconnectingProvider = undefined;
        if (providerId === CODEX_PROVIDER_ID) this.authError = undefined;
      } catch (error) {
        deletionError = error;
        deletionMessage = providerId === CODEX_PROVIDER_ID
          ? 'Could not remove your saved sign-in. Retry signing out. Model requests are paused.'
          : `Could not remove the saved ${this.options.models.getProvider(providerId)?.name ?? providerId} key. Retry removal in Providers. Model requests are paused.`;
        if (providerId === CODEX_PROVIDER_ID) this.authError = deletionMessage;
      }
      // History remains available even if secure deletion failed. The explicit
      // sign-out intent blocks future foreground activation and send/resume.
      try { await this.open(false); }
      catch (error) {
        if (deletionError) throw new AggregateError([deletionError, error], 'Sign-out and reopening saved chats failed.');
        throw error;
      }
      if (deletionMessage && providerId !== CODEX_PROVIDER_ID) this.runtimeError = deletionMessage;
      this.publish();
      if (deletionError) throw new Error(deletionMessage, { cause: deletionError });
    });
  }
}
