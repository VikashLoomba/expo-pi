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
import { createInfiniChatHome } from '../pi/infinichat-remote/home';
import { INFINICHAT_DATABASE, InfiniChatMoves } from '../pi/infinichat-remote/move';
import type { ScheduledTask } from '../pi/infinichat-scheduled';
import type { InfiniChatControls } from '../pi/infinichat-view';
import { buildModelCatalog, type ModelCatalog } from '../pi/model-catalog';
import { createChatCredentialStore, createChatModels, NEW_CHAT_DEFAULTS } from '../pi/models';
import { OPENAI_PROVIDER_ID, openOpenAIBrowserFor, openOpenAIManualBrowser } from '../pi/openai-auth';
import { getOpenAILoginOptions } from '../pi/openai-auth/installation';
import type { ProviderAccess, ProviderCredentialStore } from '../pi/provider-credentials';
import { openExpoSqliteStorage } from '../pi/storage';
import { createDeviceWorkspaces } from '../pi/workspace/device-storage';
import { AuthPromptController } from './auth-prompt-controller';
import type { ProviderAccount } from './provider-account';
import { ShownInfiniChat } from './shown-infinichat';
import type { ChatControls, ChatMessage } from './types';

const subscribeNothing = () => () => {};
const closedService: ChatServiceSnapshot = { chats: [] };
const getClosedService = () => closedService;
const errorText = (error: unknown) => error instanceof Error ? error.message : String(error);
const INFINICHAT_MOVING = 'InfiniChat is moving. Send again once the move is done.';

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
  // Where InfiniChat's conversation lives; only that side opens it.
  const [infiniChatHome] = useState(createInfiniChatHome);
  // What the screens show of InfiniChat, across moves.
  const [infiniChat] = useState(() => new ShownInfiniChat(INFINICHAT_MOVING));
  const [moves, setMoves] = useState<InfiniChatMoves>();
  // The client of the machine InfiniChat lives on or moves to or from, for its connection.
  const [infiniChatClient, setInfiniChatClient] = useState<RemoteInfiniChat>();
  const [service, setService] = useState<DurableChatService>();
  const [openError, setOpenError] = useState<string>();
  // Opening and closing storage apply in order, also across a remount, so two connections never coexist.
  const lifecycle = useRef<{
    queue: Promise<void>; service?: DurableChatService; phone?: PhoneInfiniChat; remote?: RemoteInfiniChat;
  }>({ queue: Promise.resolve() });
  useEffect(() => {
    const state = lifecycle.current;
    let unmounted = false;
    const queued = <T,>(step: () => Promise<T>): Promise<T> => {
      const result = state.queue.then(step);
      state.queue = result.then(() => {}, () => {});
      return result;
    };
    const serialize = (step: () => Promise<void>) => {
      // Teardown has no screen left to report a failed close to; an open reports its own failure.
      queued(step).catch(() => {});
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
    // InfiniChat has its own database and Harness, opened only while its home record names this phone.
    const openPhone = async () => {
      if (state.phone || unmounted) return;
      const opened = await withStorage(INFINICHAT_DATABASE, (storage) => openPhoneInfiniChat({
        storage, models, workspaces, remote, remoteHosts, keepAlive, authError,
        onClosed: (end) => {
          if (end.reason !== 'failed') return;
          serialize(async () => {
            if (state.phone !== opened) return;
            state.phone = undefined;
            infiniChat.hold();
            await opened.close().catch(() => {});
          });
          open();
        },
      }));
      state.phone = opened;
      infiniChat.show(opened.service);
    };
    // One client for the machine InfiniChat lives on or moves to; the machine's own service runs the Harness there, so
    // the keep-alive observes nothing for InfiniChat.
    const machine = (machineId: string) => {
      if (unmounted) throw new Error('InfiniChat closed.');
      if (state.remote?.machineId === machineId) return state.remote;
      const previous = state.remote;
      if (previous) serialize(() => previous.close());
      state.remote = new RemoteInfiniChat(remoteHosts, machineId);
      setInfiniChatClient(state.remote);
      return state.remote;
    };
    const moves = new InfiniChatMoves(infiniChatHome, remoteHosts, {
      hold: () => infiniChat.hold(),
      closePhone: () => queued(async () => {
        const closing = state.phone;
        state.phone = undefined;
        await closing?.close();
      }),
      openPhone: () => queued(async () => {
        try {
          await openPhone();
        } catch (error) {
          setOpenError(`InfiniChat: ${errorText(error)}`);
        }
      }),
      machine,
      show: (opened) => infiniChat.show(opened),
      // Let go of the client at once, so a move chosen next gets a new one, and close it in order with storage.
      closeMachine: () => {
        const closing = state.remote;
        state.remote = undefined;
        setInfiniChatClient(undefined);
        return queued(async () => {
          await closing?.close();
        });
      },
    });
    setMoves(moves);
    // Returning to the app retries a failed open; an open service ignores the call. While InfiniChat lives on a
    // machine, it connects there instead, and returning to the app reconnects a failed connection; a move the app
    // left goes on.
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
      const home = infiniChatHome.getSnapshot();
      if (home.home === 'phone') {
        try {
          await openPhone();
        } catch (error) {
          failures.push(`InfiniChat: ${errorText(error)}`);
        }
      } else if (home.phase === 'there') {
        const opened = machine(home.machineId);
        infiniChat.show(opened);
        opened.reconnect();
      } else {
        moves.resume();
      }
      setOpenError(failures.length ? failures.join('\n') : undefined);
    });
    open();
    // iOS suspends the app only in the background, Chord's pinger and the SSH keepalive with it, so only a return from
    // there replaces InfiniChat's remote link; returning from inactive (Control Center, a system prompt) doesn't.
    let previousState = AppState.currentState;
    const subscription = AppState.addEventListener('change', (appState) => {
      if (appState === 'active') {
        if (previousState === 'background') state.remote?.resume();
        open();
      }
      previousState = appState;
    });
    return () => {
      subscription.remove();
      unmounted = true;
      // A move stops where it is; its home record carries it on at the next launch.
      void moves.close();
      serialize(async () => {
        const closing = state.service;
        const closingPhone = state.phone;
        const closingRemote = state.remote;
        state.service = undefined;
        state.phone = undefined;
        state.remote = undefined;
        setService(undefined);
        setInfiniChatClient(undefined);
        infiniChat.hold();
        // Both Harnesses stop before the remote owner they share closes its connections. Every step runs; the
        // first failure is reported once the rest are done.
        let failure: unknown;
        for (const step of [() => closingPhone?.close(), () => closingRemote?.close(), () => closing?.close(),
          () => remote.close(), () => keepAlive.close()]) {
          try { await step(); } catch (error) { failure ??= error; }
        }
        if (failure !== undefined) throw failure;
      });
    };
  }, [credentials, infiniChat, infiniChatHome, keepAliveSettings, models, remote, remoteHosts, workspaces]);
  return { remoteHosts, remote, credentials, keepAliveSettings, models, service, infiniChat, infiniChatHome, moves,
    infiniChatClient, openError, setOpenError };
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
    remoteHosts, remote, credentials, keepAliveSettings, models, service, infiniChat, infiniChatHome, moves,
    infiniChatClient, openError, setOpenError,
  } = useChatRuntime();
  const serviceState = useSyncExternalStore(service?.subscribe ?? subscribeNothing,
    service?.getSnapshot ?? getClosedService, service?.getSnapshot ?? getClosedService);
  const infiniChatHomeRecord = useSyncExternalStore(infiniChatHome.subscribe, infiniChatHome.getSnapshot,
    infiniChatHome.getSnapshot);
  const getMove = () => moves?.getSnapshot();
  const infiniChatMoveStatus = useSyncExternalStore(moves?.subscribe ?? subscribeNothing, getMove, getMove);
  const getMoveNotice = () => moves?.getNotice();
  const infiniChatMoveNotice = useSyncExternalStore(moves?.subscribe ?? subscribeNothing, getMoveNotice, getMoveNotice);
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
  return { service, infiniChat, infiniChatHome: infiniChatHomeRecord, infiniChatMove: infiniChatMoveStatus, moves,
    infiniChatMoveNotice, infiniChatClient,
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

/** InfiniChat's conversation for the calling screen, the same one across moves; the hooks above read it. */
export function useInfiniChatView(): ChatViewSource<InfiniChatControls> {
  const { infiniChat } = useChatApp();
  return useMemo(() => infiniChat.view(), [infiniChat]);
}

/** The machine whose InfiniChat the screens show; undefined while they show this iPhone's. */
function useShownMachine(): RemoteInfiniChat | undefined {
  const { infiniChat } = useChatApp();
  const host = useSyncExternalStore(infiniChat.subscribe, infiniChat.getHost, infiniChat.getHost);
  return host instanceof RemoteInfiniChat ? host : undefined;
}

/**
 * The connection to the machine InfiniChat lives on or moves to or from, and its actions; undefined while it has no
 * machine.
 */
export function useInfiniChatConnection(): (RemoteConnection & { retry(): void; dismissNotice(): void }) | undefined {
  const { infiniChatClient: remote } = useChatApp();
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
  const { remoteHosts, providerOAuth } = app;
  const remote = useShownMachine();
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
  if (!remote) return { ...app, machine: undefined };

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
      const callback = await openOpenAIBrowserFor(url, controller.signal).catch((error: unknown) => {
        // A callback that declined or failed the check, or a browser that could not open, ends the attempt, as it
        // ends the phone's own; leaving the machine's prompt open would wait for a paste nobody was asked for.
        if (!controller.signal.aborted) {
          setNotice({ providerId, message: 'Sign-in could not be completed. Please try again.' });
          void remote.cancelSignIn().catch(() => {});
        }
        throw error;
      });
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
    machine: machines.hosts.find((host) => host.id === remote.machineId)?.name ?? 'the machine',
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
  return useSyncExternalStore(infiniChat.scheduled.subscribe, infiniChat.scheduled.getSnapshot,
    infiniChat.scheduled.getSnapshot);
}

/** InfiniChat's Harness's latest report, until it is dismissed. */
export function useInfiniChatError(): string | undefined {
  const { infiniChat } = useChatApp();
  const getError = () => infiniChat.getSnapshot().error;
  return useSyncExternalStore(infiniChat.subscribe, getError, getError);
}
