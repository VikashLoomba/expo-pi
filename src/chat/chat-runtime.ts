import { BACKGROUND_CONTEXT } from '@earendil-works/chord/context';
import type { AuthInteraction, CredentialStore, LoginOptions, Models } from '@earendil-works/pi-ai';
import type { ConversationId, Storage } from '@earendil-works/pi-durable';

import { DurableChatService, type ChatServiceSnapshot } from '../pi/chat-service';
import type { ChatExecutionSettings } from '../pi/execution/document';
import type { RemoteExecution } from '../pi/execution/remote/composition';
import type { Workspaces } from '../pi/workspace/storage';
import type { ChatModelSettings, NewChatDefaults } from '../pi/model-catalog';
import type { ProviderAccess } from '../pi/provider-credentials';

export interface ChatRuntimeSnapshot extends ChatServiceSnapshot {
  ready: boolean;
  signOutPending: boolean;
  disconnectingProvider?: string;
}

interface Credentials {
  readonly getProviderSnapshot: (providerId: string) => ProviderAccess;
  readonly modify: CredentialStore['modify'];
  readonly restoreProvider: (providerId: string) => Promise<void>;
}

const errorText = (error: unknown) => error instanceof Error ? error.message : String(error);

/**
 * Opens the chat service once and keeps it open until teardown, including while the app is in the background.
 * Account changes go straight to Pi's credential store: requests resolve auth when they start, so open chats
 * need no restart.
 */
export class ChatRuntime {
  private service?: DurableChatService;
  /** Opening and closing storage apply in order, so two connections never coexist. */
  private lifecycle: Promise<unknown> = Promise.resolve();
  private unsubscribe = () => {};
  private readonly listeners = new Set<() => void>();
  private snapshot: ChatRuntimeSnapshot = { ready: false, chats: [], signOutPending: false };
  private error?: string;
  private loginController?: AbortController;
  private disconnectingProvider?: string;

  constructor(private readonly options: {
    models: Models; openStorage: () => Promise<Storage>; credentials: Credentials;
    remote: RemoteExecution;
    workspaces: Workspaces;
    newChat?: NewChatDefaults;
  }) {}

  private serialize<T>(action: () => Promise<T>): Promise<T> {
    const operation = this.lifecycle.then(action);
    this.lifecycle = operation.catch(() => {});
    return operation;
  }

  private publish() {
    const state = this.service?.getSnapshot();
    const chats = state?.chats ?? [];
    const error = this.error ?? state?.error;
    const ready = !!this.service;
    const signOutPending = !!this.disconnectingProvider;
    const previous = this.snapshot;
    if (chats !== previous.chats || error !== previous.error || ready !== previous.ready
        || signOutPending !== previous.signOutPending
        || this.disconnectingProvider !== previous.disconnectingProvider) {
      this.snapshot = { chats, ready, signOutPending,
        ...(this.disconnectingProvider ? { disconnectingProvider: this.disconnectingProvider } : {}),
        ...(error ? { error } : {}) };
    }
    for (const listener of [...this.listeners]) listener();
  }

  private require(): DurableChatService {
    if (!this.service) throw new Error('Your chats are still opening.');
    return this.service;
  }

  /** Chat operations clear an earlier failure once one succeeds. */
  private async run<T>(action: (service: DurableChatService) => Promise<T>): Promise<T> {
    const result = await action(this.require());
    if (this.error) {
      this.error = undefined;
      this.publish();
    }
    return result;
  }

  readonly subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  };
  readonly getSnapshot = () => this.snapshot;

  report(error: unknown) {
    this.error = errorText(error);
    this.publish();
  }

  /** Open storage and the chat list. Returns at once when open; a failed attempt can be retried. */
  open(): Promise<void> {
    return this.serialize(async () => {
      if (this.service) return;
      let storage: Storage | undefined;
      try {
        storage = await this.options.openStorage();
        const service = await DurableChatService.open({ storage, models: this.options.models,
          remote: this.options.remote, workspaces: this.options.workspaces,
          newChat: this.options.newChat,
          authError: (providerId) => this.options.credentials.getProviderSnapshot(providerId).error,
        });
        this.service = service;
        this.unsubscribe = service.subscribe(() => this.publish());
        this.error = undefined;
        this.publish();
      } catch (error) {
        // Release the database so a later attempt never holds two connections. Closing again is a no-op.
        await storage?.close(BACKGROUND_CONTEXT).catch(() => {});
        this.report(error);
        throw error;
      }
    });
  }

  /** Teardown only. */
  close(): Promise<void> {
    return this.serialize(async () => {
      const service = this.service;
      if (!service) return;
      this.service = undefined;
      this.unsubscribe();
      this.publish();
      await service.close();
    });
  }

  /** The listed chat a route names; undefined until chats are open or when no such chat exists. */
  findChat(key: string) { return this.service?.findChat(key); }
  chat(id: ConversationId, options?: { transcript?: boolean }) { return this.require().chat(id, options); }
  createChat() { return this.run((service) => service.createChat()); }
  renameChat(id: ConversationId, title: string) { return this.run((service) => service.renameChat(id, title)); }
  archiveChat(id: ConversationId) { return this.run((service) => service.archiveChat(id)); }
  updateSettings(id: ConversationId, settings: ChatModelSettings) {
    return this.run((service) => service.updateSettings(id, settings));
  }
  updateExecution(id: ConversationId, execution: ChatExecutionSettings, settings?: ChatModelSettings) {
    return this.run((service) => service.updateExecution(id, execution, settings));
  }
  send(id: ConversationId, text: string) { return this.run((service) => service.send(id, text)); }
  cancel(id: ConversationId) { return this.run((service) => service.cancel(id)); }

  retryAuth(providerId: string) {
    return this.options.credentials.restoreProvider(providerId);
  }

  /** Browser sign-in. Pi's store replaces the credential atomically; work in progress keeps its resolved auth. */
  async login(providerId: string, interaction: AuthInteraction, options?: LoginOptions): Promise<void> {
    if (this.loginController) throw new Error('Finish or cancel the current sign-in first.');
    interaction.signal?.throwIfAborted();
    const controller = new AbortController();
    const abort = () => controller.abort(interaction.signal?.reason);
    interaction.signal?.addEventListener('abort', abort, { once: true });
    this.loginController = controller;
    try {
      await this.options.models.login(providerId, 'oauth', { ...interaction, signal: controller.signal }, options);
    } finally {
      interaction.signal?.removeEventListener('abort', abort);
      if (this.loginController === controller) this.loginController = undefined;
    }
  }

  /** Pi's store contract has one write path, the same `modify` that `models.login` ends in. */
  async saveProviderKey(providerId: string, input: string) {
    const key = input.trim();
    if (!key) throw new Error('Enter an API key.');
    if (!this.options.models.getProvider(providerId)?.auth.apiKey?.login) {
      throw new Error('This provider does not support API key sign-in.');
    }
    await this.options.credentials.modify(providerId, async () => ({ type: 'api_key', key }));
  }

  /** Removes the saved credential. A failed removal stays pending so the account screen can retry it. */
  async signOut(providerId: string): Promise<void> {
    const name = (id: string) => this.options.models.getProvider(id)?.name ?? id;
    if (this.disconnectingProvider && this.disconnectingProvider !== providerId) {
      throw new Error(`Finish disconnecting ${name(this.disconnectingProvider)} before removing another provider.`);
    }
    this.loginController?.abort();
    this.disconnectingProvider = providerId;
    this.publish();
    try {
      await this.options.models.logout(providerId);
    } catch (error) {
      this.error = `Could not remove the saved ${name(providerId)} key. Retry removal in Providers.`;
      this.publish();
      throw new Error(this.error, { cause: error });
    }
    this.disconnectingProvider = undefined;
    this.error = undefined;
    this.publish();
  }
}
