import { BACKGROUND_CONTEXT } from '@earendil-works/chord/context';
import type { Models } from '@earendil-works/pi-ai';
import type { ConversationId, Storage } from '@earendil-works/pi-durable';
import React, {
  createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, useSyncExternalStore,
} from 'react';
import { AppState } from 'react-native';

import { KeepAliveController } from '../keep-alive/controller';
import { createKeepAliveSettings } from '../keep-alive/settings';
import { DurableChatService, type ChatServiceSnapshot } from '../pi/chat-service';
import type { ChatView, ChatViewSnapshot, ChatViewSource } from '../pi/chat-view';
import { createRemoteHostRepository } from '../pi/execution/remote/host-storage';
import { createRemoteExecution } from '../pi/execution/remote/owner';
import { openPhoneInfiniChat, type PhoneInfiniChat } from '../pi/infinichat-phone';
import { RemoteInfiniChat, type RemoteConnection } from '../pi/infinichat-remote/client';
import { createInfiniChatMachineChoice } from '../pi/infinichat-remote/machine-choice';
import type { ScheduledTask } from '../pi/infinichat-scheduled';
import type { InfiniChatHost } from '../pi/infinichat-service';
import type { InfiniChatControls } from '../pi/infinichat-view';
import type { ProviderAccount } from '../components/chat/provider-section';
import { buildModelCatalog, type ModelCatalog } from '../pi/model-catalog';
import { createChatCredentialStore, createChatModels, NEW_CHAT_DEFAULTS } from '../pi/models';
import { OPENAI_PROVIDER_ID, openOpenAIBrowserFor, openOpenAIManualBrowser } from '../pi/openai-auth';
import { getOpenAILoginOptions } from '../pi/openai-auth/installation';
import type { ProviderAccess, ProviderCredentialStore } from '../pi/provider-credentials';
import { openExpoSqliteStorage } from '../pi/storage';
import { createDeviceWorkspaces } from '../pi/workspace/device-storage';
import { AuthPromptController } from './auth-prompt-controller';
import type { ChatControls, ChatMessage } from './types';

const subscribeNothing = () => () => {};
const closedService: ChatServiceSnapshot = { chats: [] };
const getClosedService = () => closedService;
const errorText = (error: unknown) => error instanceof Error ? error.message : String(error);
const INFINICHAT_DATABASE = 'infinichat.db';

/**
 * App-lifetime objects. Chats open at launch and stay open in the background until the provider unmounts.
 * Account changes go straight to Pi's credential store: requests resolve auth when they start, so open chats
 * need no restart.
 */
function useChatRuntime() {
  const [remoteHosts] = useState(createRemoteHostRepository);
  const [remote] = useState(() => createRemoteExecution(remoteHosts));
  const [workspaces] = useState(() => createDeviceWorkspaces());
  const [credentials] = useState(createChatCredentialStore);
  const [keepAliveSettings] = useState(createKeepAliveSettings);
  const [models] = useState(() => {
    const session = createChatModels(credentials);
    credentials.registerProviders(session.getProviders().map((provider) => provider.id));
    return session;
  });
  const [machineChoice] = useState(createInfiniChatMachineChoice);
  const [service, setService] = useState<DurableChatService>();
  const [infiniChat, setInfiniChat] = useState<InfiniChatHost>();
  const [openError, setOpenError] = useState<string>();
  // Opening and closing storage apply in order, also across a remount, so two connections never coexist.
  const lifecycle = useRef<{
    queue: Promise<void>; service?: DurableChatService; infiniChat?: PhoneInfiniChat | RemoteInfiniChat;
  }>({ queue: Promise.resolve() });
  useEffect(() => {
    const state = lifecycle.current;
    const serialize = (step: () => Promise<void>) => {
      // Teardown has no screen left to report a failed close to; an open reports its own failure.
      state.queue = state.queue.then(step).catch(() => {});
    };
    // One controller for both services' Harnesses, so there is one Live Activity and one location stream. It
    // outlives a service reopened after a storage failure, and starts and closes in order with storage, so an
    // earlier mount's controller has ended its Live Activity before this one adopts any.
    const keepAlive = new KeepAliveController(keepAliveSettings);
    serialize(async () => keepAlive.start());
    // The repository reports a failed restore in its own snapshot.
    void remoteHosts.restore().catch(() => {});
    // Account restoration does not depend on SQLite, so a database failure leaves sign-in usable. A provider whose
    // credential cannot be read reports it in its own access state.
    void credentials.restore().catch(() => {});
    const authError = (providerId: string) => credentials.getProviderSnapshot(providerId).error;
    // Release the database when its service does not open, so a later attempt never holds two connections.
    const withStorage = async <T,>(databaseName: string | undefined, open: (storage: Storage) => Promise<T>) => {
      let storage: Storage | undefined;
      try {
        storage = await openExpoSqliteStorage(databaseName);
        return await open(storage);
      } catch (error) {
        // Closing again is a no-op.
        await storage?.close(BACKGROUND_CONTEXT).catch(() => {});
        throw error;
      }
    };
    // Returning to the app retries a failed open; an open service ignores the call. InfiniChat has its own database
    // and Harness, opened in the same step, unless it runs on a machine: then it connects there, and returning to the
    // app reconnects a failed connection.
    const open = () => serialize(async () => {
      const failures: string[] = [];
      if (!state.service) {
        try {
          const opened = await withStorage(undefined, (storage) => DurableChatService.open({
            storage, models, remote, workspaces, newChat: NEW_CHAT_DEFAULTS, keepAlive, authError,
            onClosed: (end) => {
              // pi-durable "Errors": a storage error ends the Harness; reopen to recover.
              if (end.reason !== 'failed') return;
              serialize(async () => {
                if (state.service !== opened) return;
                state.service = undefined;
                setService(undefined);
                await opened.close().catch(() => {});
              });
              open();
            },
          }));
          state.service = opened;
          setService(opened);
        } catch (error) {
          failures.push(errorText(error));
        }
      }
      const machineId = machineChoice.getSnapshot();
      if (state.infiniChat instanceof RemoteInfiniChat) {
        state.infiniChat.reconnect();
      } else if (!state.infiniChat && machineId !== null) {
        // The machine's own service runs the Harness there, so the keep-alive observes nothing for InfiniChat.
        const opened = new RemoteInfiniChat(remoteHosts, machineId);
        state.infiniChat = opened;
        setInfiniChat(opened);
        opened.reconnect();
      } else if (!state.infiniChat) {
        try {
          const opened = await withStorage(INFINICHAT_DATABASE, (storage) => openPhoneInfiniChat({
            storage, models, workspaces, remote, remoteHosts, keepAlive, authError,
            onClosed: (end) => {
              if (end.reason !== 'failed') return;
              serialize(async () => {
                if (state.infiniChat !== opened) return;
                state.infiniChat = undefined;
                setInfiniChat(undefined);
                await opened.close().catch(() => {});
              });
              open();
            },
          }));
          state.infiniChat = opened;
          setInfiniChat(opened.service);
        } catch (error) {
          failures.push(`InfiniChat: ${errorText(error)}`);
        }
      }
      setOpenError(failures.length ? failures.join('\n') : undefined);
    });
    open();
    // iOS suspends the app only in the background, Chord's pinger and the SSH keepalive with it, so only a return from
    // there replaces InfiniChat's remote link; returning from inactive (Control Center, a system prompt) doesn't.
    let previousState = AppState.currentState;
    const subscription = AppState.addEventListener('change', (appState) => {
      if (appState === 'active') {
        if (previousState === 'background' && state.infiniChat instanceof RemoteInfiniChat) state.infiniChat.resume();
        open();
      }
      previousState = appState;
    });
    // Choosing where InfiniChat runs closes it where it ran, then opens it on the chosen side.
    const unsubscribeChoice = machineChoice.subscribe(() => {
      serialize(async () => {
        const closing = state.infiniChat;
        state.infiniChat = undefined;
        setInfiniChat(undefined);
        await closing?.close();
      });
      open();
    });
    return () => {
      subscription.remove();
      unsubscribeChoice();
      serialize(async () => {
        const closing = state.service;
        const closingInfiniChat = state.infiniChat;
        state.service = undefined;
        state.infiniChat = undefined;
        setService(undefined);
        setInfiniChat(undefined);
        // Both Harnesses stop before the remote owner they share closes its connections. Every step runs; the
        // first failure is reported once the rest are done.
        let failure: unknown;
        for (const step of [() => closingInfiniChat?.close(), () => closing?.close(), () => remote.close(),
          () => keepAlive.close()]) {
          try { await step(); } catch (error) { failure ??= error; }
        }
        if (failure !== undefined) throw failure;
      });
    };
  }, [credentials, keepAliveSettings, machineChoice, models, remote, remoteHosts, workspaces]);
  return { remoteHosts, remote, credentials, keepAliveSettings, models, service, infiniChat, machineChoice, openError,
    setOpenError };
}

/** Browser sign-in for the account screen: one attempt at a time, cancellable, with its own prompts. */
function useProviderSignIn({ models, credentials, signOutPending, onSignedIn }: {
  models: Models; credentials: ProviderCredentialStore; signOutPending: boolean; onSignedIn: () => void;
}) {
  const [signingInProvider, setSigningInProvider] = useState<string | null>(null);
  const [authNotice, setAuthNotice] = useState<{ providerId: string; message: string }>();
  const [prompts] = useState(() => new AuthPromptController());
  const authPrompt = useSyncExternalStore(prompts.subscribe, prompts.getSnapshot, prompts.getSnapshot);
  const [browserOpen, setBrowserOpen] = useState(false);
  const login = useRef<AbortController | null>(null);
  const browser = useRef<AbortController | null>(null);
  const authUrl = useRef<string | null>(null);
  const mounted = useRef(false);

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      login.current?.abort();
      browser.current?.abort();
      prompts.cancel();
    };
  }, [prompts]);

  const cancelSignIn = useCallback(() => {
    login.current?.abort();
    browser.current?.abort();
  }, []);
  const signIn = useCallback(async (providerId: string) => {
    if (login.current || signOutPending || !credentials.getProviderSnapshot(providerId).ready) return;
    if (!models.getProvider(providerId)?.auth.oauth) return;
    const controller = new AbortController();
    login.current = controller;
    setSigningInProvider(providerId);
    setAuthNotice({ providerId, message: 'Starting sign-in…' });
    authUrl.current = null;
    try {
      const options = providerId === OPENAI_PROVIDER_ID ? await getOpenAILoginOptions() : undefined;
      controller.signal.throwIfAborted();
      // Pi's store replaces the credential atomically; work in progress keeps the auth it resolved.
      await models.login(providerId, 'oauth', {
        signal: controller.signal,
        prompt: (prompt) => {
          setAuthNotice({ providerId, message: prompt.type === 'manual_code'
            ? 'Finish sign-in with the browser return URL.' : 'Complete the next sign-in step.' });
          return prompts.prompt(prompt, controller.signal);
        },
        notify(event) {
          if (!mounted.current || controller.signal.aborted) return;
          if (event.type === 'auth_url') authUrl.current = event.url;
          // OAuth diagnostics can include callback URLs or tokens. The account
          // screen uses public status copy and never renders raw server payloads.
          if (event.type === 'progress' || event.type === 'info' || event.type === 'auth_url') {
            setAuthNotice({ providerId,
              message: event.type === 'auth_url' ? 'Continue in your browser to sign in.' : 'Sign-in in progress…' });
          }
        },
      }, options);
      if (mounted.current && !controller.signal.aborted) {
        setAuthNotice(undefined);
        onSignedIn();
      }
    } catch {
      if (mounted.current) {
        setAuthNotice({ providerId, message: controller.signal.aborted
          ? 'Sign-in cancelled.' : 'Sign-in could not be completed. Please try again.' });
      }
    } finally {
      if (login.current === controller) login.current = null;
      browser.current?.abort();
      authUrl.current = null;
      prompts.cancel();
      if (mounted.current) setSigningInProvider(null);
    }
  }, [credentials, models, onSignedIn, prompts, signOutPending]);
  const openSignInPage = useCallback(async () => {
    if (!login.current || browser.current || !signingInProvider) return;
    const controller = new AbortController();
    browser.current = controller;
    setBrowserOpen(true);
    try {
      if (signingInProvider === OPENAI_PROVIDER_ID && authUrl.current) {
        await openOpenAIManualBrowser(authUrl.current, controller.signal);
      }
    } catch {
      if (mounted.current && !controller.signal.aborted) {
        setAuthNotice({ providerId: signingInProvider, message: 'Could not open the sign-in page. Please try again.' });
      }
    } finally {
      if (browser.current === controller) browser.current = null;
      if (mounted.current) setBrowserOpen(false);
    }
  }, [signingInProvider]);

  return { signingIn: signingInProvider !== null, signingInProvider, authNotice, setAuthNotice, browserOpen,
    authPrompt, submitAuthPrompt: prompts.submit, signIn, cancelSignIn, openSignInPage };
}

function useChatController() {
  const {
    remoteHosts, remote, credentials, keepAliveSettings, models, service, infiniChat, machineChoice, openError,
    setOpenError,
  } = useChatRuntime();
  const serviceState = useSyncExternalStore(service?.subscribe ?? subscribeNothing,
    service?.getSnapshot ?? getClosedService, service?.getSnapshot ?? getClosedService);
  const infiniChatMachine = useSyncExternalStore(machineChoice.subscribe, machineChoice.getSnapshot,
    machineChoice.getSnapshot);
  const credentialState = useSyncExternalStore(credentials.subscribe, credentials.getSnapshot, credentials.getSnapshot);
  const [catalog, setCatalog] = useState(() => buildModelCatalog(models));
  const [disconnectingProvider, setDisconnectingProvider] = useState<string>();
  const signOutPending = disconnectingProvider !== undefined;
  const onSignedIn = () => setCatalog(buildModelCatalog(models));
  const { setAuthNotice, ...signIn } = useProviderSignIn({ models, credentials, signOutPending, onSignedIn });
  const { signingIn, cancelSignIn } = signIn;

  const providerAccess = (providerId: string): ProviderAccess => {
    const state = credentialState.providers[providerId] ?? { ready: false, connected: false };
    return signOutPending ? { ...state, ready: false, connected: false } : state;
  };
  const providerName = (providerId: string) => models.getProvider(providerId)?.name ?? providerId;
  const refreshCatalog = async () => {
    const result = await models.refresh();
    setCatalog(buildModelCatalog(models));
    if (result.errors.size) {
      throw new Error('Some provider models could not be refreshed. Existing models are still available.');
    }
  };
  const retryAuth = async (providerId: string) => {
    setAuthNotice(undefined);
    await credentials.restoreProvider(providerId);
  };
  const saveProviderKey = async (providerId: string, input: string) => {
    if (signingIn) throw new Error('Finish or cancel sign-in before changing provider credentials.');
    const key = input.trim();
    if (!key) throw new Error('Enter an API key.');
    if (!models.getProvider(providerId)?.auth.apiKey?.login) {
      throw new Error('This provider does not support API key sign-in.');
    }
    // Pi's store contract has one write path, the same `modify` that `models.login` ends in.
    await credentials.modify(providerId, async () => ({ type: 'api_key', key }));
    await refreshCatalog();
  };
  /** Removes the saved credential. A failed removal stays pending so the account screen can retry it. */
  const disconnectProvider = async (providerId: string) => {
    if (disconnectingProvider !== undefined && disconnectingProvider !== providerId) {
      throw new Error(`Finish disconnecting ${providerName(disconnectingProvider)} before removing another provider.`);
    }
    cancelSignIn();
    setDisconnectingProvider(providerId);
    try {
      await models.logout(providerId);
    } catch (error) {
      throw new Error(`Could not remove the saved ${providerName(providerId)} key. Try again.`, { cause: error });
    }
    setDisconnectingProvider(undefined);
  };
  const providerOAuth = (providerId: string) => {
    const oauth = models.getProvider(providerId)?.auth.oauth;
    return oauth ? { name: oauth.name, loginLabel: oauth.loginLabel, isSubscription: oauth.isSubscription } : undefined;
  };

  // Hides the current app-wide error; a later failed open or Harness report shows again.
  const dismissError = () => {
    setOpenError(undefined);
    service?.dismissError();
  };

  // Only a failed open and the Harness's own reports reach every screen; operations return their errors to the
  // screen that started them.
  return { service, infiniChat, infiniChatMachine, chooseInfiniChatMachine: machineChoice.choose,
    ready: service !== undefined, chats: serviceState.chats,
    error: openError ?? serviceState.error,
    dismissError, signOutPending, disconnectingProvider,
    ...signIn, remoteHosts, remote, catalog, refreshCatalog, providerAccess, keepAliveSettings,
    hasConnectedProvider: catalog.some((provider) => providerAccess(provider.id).connected),
    providerOAuth, retryAuth, saveProviderKey, disconnectProvider };
}

const ChatContext = createContext<ReturnType<typeof useChatController> | null>(null);
export function ChatProvider({ children }: React.PropsWithChildren) {
  const controller = useChatController();
  return <ChatContext.Provider value={controller}>{children}</ChatContext.Provider>;
}
export function useChatApp() {
  const value = useContext(ChatContext);
  if (!value) throw new Error('ChatProvider is missing.');
  return value;
}

const noControls = () => undefined;
const noMessages: readonly ChatMessage[] = [];
const getNoMessages = () => noMessages;

/** The chat a route parameter names, once chats are open; undefined when there is no such chat. */
export function useChatId(key: string | undefined): ConversationId | undefined {
  const { service } = useChatApp();
  return key !== undefined ? service?.findChat(key) : undefined;
}

/**
 * One chat's committed state for the calling component. It attaches when the first hook below subscribes and
 * detaches when the last unmounts. `transcript` also reads the messages; controls alone never do.
 */
export function useChatView(id: ConversationId | undefined, transcript = false): ChatView | undefined {
  const { service } = useChatApp();
  return useMemo(() => id !== undefined ? service?.chat(id, { transcript }) : undefined, [service, id, transcript]);
}

export function useChatControls<C extends ChatControls>(view: ChatViewSource<C> | undefined): C | undefined {
  return useSyncExternalStore(view?.subscribe ?? subscribeNothing, view?.getControls ?? noControls,
    view?.getControls ?? noControls);
}

export function useChatMessages(view: ChatViewSource | undefined): readonly ChatMessage[] {
  return useSyncExternalStore(view?.subscribe ?? subscribeNothing, view?.getMessages ?? getNoMessages,
    view?.getMessages ?? getNoMessages);
}

export function useChatStatus(view: ChatViewSource | undefined): ChatViewSnapshot['status'] {
  const getStatus = () => view?.getSnapshot().status ?? 'loading';
  return useSyncExternalStore(view?.subscribe ?? subscribeNothing, getStatus, getStatus);
}

/** Why the chat could not be opened, when it could not. */
export function useChatError(view: ChatViewSource | undefined): string | undefined {
  const getError = () => view?.getSnapshot().error;
  return useSyncExternalStore(view?.subscribe ?? subscribeNothing, getError, getError);
}

/** InfiniChat's conversation for the calling screen, once its service is open; the hooks above read it. */
export function useInfiniChatView(): ChatViewSource<InfiniChatControls> | undefined {
  const { infiniChat } = useChatApp();
  return useMemo(() => infiniChat?.view(), [infiniChat]);
}

/** The connection to the machine InfiniChat runs on, and its actions; undefined while it runs on this iPhone. */
export function useInfiniChatConnection(): (RemoteConnection & { retry(): void; dismissNotice(): void }) | undefined {
  const { infiniChat } = useChatApp();
  const remote = infiniChat instanceof RemoteInfiniChat ? infiniChat : undefined;
  const getConnection = () => remote?.getConnection();
  const connection = useSyncExternalStore(remote?.subscribe ?? subscribeNothing, getConnection, getConnection);
  return remote && connection && {
    ...connection, retry: () => remote.reconnect(), dismissNotice: () => remote.dismissNotice(),
  };
}

const noCatalog: ModelCatalog = [];
const notReady: ProviderAccess = { ready: false, connected: false };

/**
 * The sign-ins and models InfiniChat uses: this iPhone's account, or, while InfiniChat runs on a machine, that
 * machine's own credential store. Its sign-in runs there through pi-ai, with this screen as the interaction's front end
 * as on the account screen; for ChatGPT the phone's receiver and browser catch the callback and answer the machine's
 * `manual_code` prompt with it. The phone's own account is never touched then. `machine` names the machine.
 */
export function useInfiniChatAccount(): ProviderAccount & { catalog: ModelCatalog; machine?: string } {
  const app = useChatApp();
  const { infiniChat, infiniChatMachine, remoteHosts, providerOAuth } = app;
  const remote = infiniChat instanceof RemoteInfiniChat ? infiniChat : undefined;
  const subscribe = remote?.subscribe ?? subscribeNothing;
  const getCatalog = () => remote?.getCatalog() ?? noCatalog;
  const getAccess = () => remote?.getAccess();
  const getSignIn = () => remote?.getSignIn() ?? null;
  const catalog = useSyncExternalStore(subscribe, getCatalog, getCatalog);
  const access = useSyncExternalStore(subscribe, getAccess, getAccess);
  const shown = useSyncExternalStore(subscribe, getSignIn, getSignIn);
  const machines = useSyncExternalStore(remoteHosts.subscribe, remoteHosts.getSnapshot, remoteHosts.getSnapshot);
  const [notice, setNotice] = useState<{ providerId: string; message: string }>();
  const [browserOpen, setBrowserOpen] = useState(false);
  const [disconnectingProvider, setDisconnectingProvider] = useState<string>();
  // This phone's part of an attempt it started, its browser, and the manual browser; both end with the machine.
  const flow = useRef<AbortController | null>(null);
  const manual = useRef<AbortController | null>(null);
  useEffect(() => () => {
    flow.current?.abort();
    manual.current?.abort();
  }, [remote]);
  const cancelSignIn = useCallback(() => {
    flow.current?.abort();
    manual.current?.abort();
    // Only an attempt under way, so leaving the screen while disconnected starts no connection.
    if (remote?.getSignIn()?.running) void remote.cancelSignIn().catch(() => {});
  }, [remote]);
  if (infiniChatMachine === null) return { ...app, machine: undefined };

  const signIn = async (providerId: string) => {
    if (!remote || flow.current) return;
    const controller = new AbortController();
    flow.current = controller;
    setNotice(undefined);
    try {
      // A sign-in the machine never started has no state there to say why.
      const attempt = await remote.signIn(providerId).catch((error: unknown) => {
        setNotice({ providerId, message: error instanceof Error ? error.message : String(error) });
        throw error;
      });
      if (providerId !== OPENAI_PROVIDER_ID) return;
      const url = await remote.signInStep(attempt, (step) => step.url, controller.signal);
      // The browser never outlives the machine's attempt, however that ends.
      void remote.signInStep(attempt, () => undefined, controller.signal).catch(() => controller.abort());
      const callback = await openOpenAIBrowserFor(url, controller.signal);
      // Without a callback the machine's prompt stays for the return URL, pasted or opened again in a browser.
      if (callback === undefined) return;
      const prompt = await remote.signInStep(attempt,
        (step) => step.prompt?.prompt.type === 'manual_code' ? step.prompt.id : undefined, controller.signal);
      await remote.answer(prompt, callback);
    } catch {
      // The machine's state says how its attempt went, and a browser that failed leaves its prompt there.
    } finally {
      if (flow.current === controller) flow.current = null;
      controller.abort();
    }
  };
  const openSignInPage = async () => {
    if (!shown?.running || shown.url === undefined || manual.current) return;
    const { providerId, url } = shown;
    const controller = new AbortController();
    manual.current = controller;
    setBrowserOpen(true);
    try {
      if (providerId === OPENAI_PROVIDER_ID) await openOpenAIManualBrowser(url, controller.signal);
    } catch {
      if (controller.signal.aborted) return;
      setNotice({ providerId, message: 'Could not open the sign-in page. Please try again.' });
    } finally {
      if (manual.current === controller) manual.current = null;
      setBrowserOpen(false);
    }
  };
  const disconnectProvider = async (providerId: string) => {
    if (disconnectingProvider !== undefined && disconnectingProvider !== providerId) {
      const name = catalog.find((provider) => provider.id === disconnectingProvider)?.name ?? disconnectingProvider;
      throw new Error(`Finish disconnecting ${name} before removing another provider.`);
    }
    if (!remote) throw new Error('InfiniChat is not connected yet.');
    flow.current?.abort();
    setDisconnectingProvider(providerId);
    // The machine cancels its own sign-in before it signs out.
    await remote.signOut(providerId);
    setDisconnectingProvider(undefined);
  };
  const signOutPending = disconnectingProvider !== undefined;
  const status = shown?.status === undefined ? undefined : { providerId: shown.providerId, message: shown.status };
  return {
    catalog,
    machine: machines.hosts.find((host) => host.id === infiniChatMachine)?.name ?? 'the machine',
    providerAccess: (providerId) => {
      const state = access?.[providerId] ?? notReady;
      return signOutPending ? { ...state, ready: false, connected: false } : state;
    },
    // What this phone can present: ChatGPT through its receiver, and API keys.
    providerOAuth,
    saveProviderKey: async (providerId, key) => {
      if (!remote) throw new Error('InfiniChat is not connected yet.');
      await remote.setApiKey(providerId, key);
    },
    disconnectProvider,
    signOutPending,
    disconnectingProvider,
    signingIn: !!shown?.running,
    signingInProvider: shown?.running ? shown.providerId : null,
    signIn,
    cancelSignIn,
    authNotice: notice ?? status,
    authPrompt: shown?.running && shown.prompt ? shown.prompt : null,
    submitAuthPrompt: (id, value) => {
      if (!remote || shown?.prompt?.id !== id || !value.trim()) return false;
      void remote.answer(id, value).catch(() => {});
      return true;
    },
    openSignInPage,
    browserOpen,
  };
}

/** InfiniChat's scheduled tasks still waiting, soonest first; undefined until they are read. */
export function useScheduledTasks(): readonly ScheduledTask[] | undefined {
  const { infiniChat } = useChatApp();
  const getTasks = () => infiniChat?.scheduled.getSnapshot();
  return useSyncExternalStore(infiniChat?.scheduled.subscribe ?? subscribeNothing, getTasks, getTasks);
}

/** InfiniChat's Harness's latest report, until it is dismissed. */
export function useInfiniChatError(): string | undefined {
  const { infiniChat } = useChatApp();
  const getError = () => infiniChat?.getSnapshot().error;
  return useSyncExternalStore(infiniChat?.subscribe ?? subscribeNothing, getError, getError);
}
