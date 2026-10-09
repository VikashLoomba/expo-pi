import { BACKGROUND_CONTEXT } from '@earendil-works/chord/context';
import type { Models } from '@earendil-works/pi-ai';
import type { ConversationId, Storage } from '@earendil-works/pi-durable';
import React, {
  createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, useSyncExternalStore,
} from 'react';
import { AppState } from 'react-native';

import { DurableChatService, type ChatServiceSnapshot } from '../pi/chat-service';
import type { ChatView, ChatViewSnapshot } from '../pi/chat-view';
import { createRemoteHostRepository } from '../pi/execution/remote/host-storage';
import { createRemoteExecution } from '../pi/execution/remote/composition';
import { buildModelCatalog } from '../pi/model-catalog';
import { createChatCredentialStore, createChatModels, NEW_CHAT_DEFAULTS } from '../pi/models';
import { OPENAI_PROVIDER_ID, openOpenAIManualBrowser } from '../pi/openai-auth';
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
  const [models] = useState(() => {
    const session = createChatModels(credentials);
    credentials.registerProviders(session.getProviders().map((provider) => provider.id));
    return session;
  });
  const [service, setService] = useState<DurableChatService>();
  const [openError, setOpenError] = useState<string>();
  // Opening and closing storage apply in order, also across a remount, so two connections never coexist.
  const lifecycle = useRef<{ queue: Promise<void>; service?: DurableChatService }>({ queue: Promise.resolve() });
  useEffect(() => {
    const state = lifecycle.current;
    const serialize = (step: () => Promise<void>) => {
      // Teardown has no screen left to report a failed close to; an open reports its own failure.
      state.queue = state.queue.then(step).catch(() => {});
    };
    // The repository reports a failed restore in its own snapshot.
    void remoteHosts.restore().catch(() => {});
    // Account restoration does not depend on SQLite, so a database failure leaves sign-in usable. A provider whose
    // credential cannot be read reports it in its own access state.
    void credentials.restore().catch(() => {});
    // Returning to the app retries a failed open; an open service ignores the call.
    const open = () => serialize(async () => {
      if (state.service) return;
      let storage: Storage | undefined;
      try {
        storage = await openExpoSqliteStorage();
        state.service = await DurableChatService.open({ storage, models, remote, workspaces,
          newChat: NEW_CHAT_DEFAULTS,
          authError: (providerId) => credentials.getProviderSnapshot(providerId).error,
        });
        setService(state.service);
        setOpenError(undefined);
      } catch (error) {
        // Release the database so a later attempt never holds two connections. Closing again is a no-op.
        await storage?.close(BACKGROUND_CONTEXT).catch(() => {});
        setOpenError(errorText(error));
      }
    });
    open();
    const subscription = AppState.addEventListener('change', (appState) => { if (appState === 'active') open(); });
    return () => {
      subscription.remove();
      serialize(async () => {
        const closing = state.service;
        state.service = undefined;
        setService(undefined);
        await closing?.close();
      });
    };
  }, [credentials, models, remote, remoteHosts, workspaces]);
  return { remoteHosts, credentials, models, service, openError };
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
  const { remoteHosts, credentials, models, service, openError } = useChatRuntime();
  const serviceState = useSyncExternalStore(service?.subscribe ?? subscribeNothing,
    service?.getSnapshot ?? getClosedService, service?.getSnapshot ?? getClosedService);
  const credentialState = useSyncExternalStore(credentials.subscribe, credentials.getSnapshot, credentials.getSnapshot);
  const [catalog, setCatalog] = useState(() => buildModelCatalog(models));
  const [disconnectingProvider, setDisconnectingProvider] = useState<string>();
  const signOutPending = disconnectingProvider !== undefined;
  const onSignedIn = useCallback(() => setCatalog(buildModelCatalog(models)), [models]);
  const { setAuthNotice, ...signIn } = useProviderSignIn({ models, credentials, signOutPending, onSignedIn });
  const { signingIn, cancelSignIn } = signIn;

  const providerAccess = useCallback((providerId: string): ProviderAccess => {
    const state = credentialState.providers[providerId] ?? { ready: false, connected: false };
    return signOutPending ? { ...state, ready: false, connected: false } : state;
  }, [credentialState, signOutPending]);
  const providerName = useCallback((providerId: string) => models.getProvider(providerId)?.name ?? providerId,
    [models]);
  const refreshCatalog = useCallback(async () => {
    const result = await models.refresh();
    setCatalog(buildModelCatalog(models));
    if (result.errors.size) {
      throw new Error('Some provider models could not be refreshed. Existing models are still available.');
    }
  }, [models]);
  const retryAuth = useCallback(async (providerId: string) => {
    setAuthNotice(undefined);
    await credentials.restoreProvider(providerId);
  }, [credentials, setAuthNotice]);
  const saveProviderKey = useCallback(async (providerId: string, input: string) => {
    if (signingIn) throw new Error('Finish or cancel sign-in before changing provider credentials.');
    const key = input.trim();
    if (!key) throw new Error('Enter an API key.');
    if (!models.getProvider(providerId)?.auth.apiKey?.login) {
      throw new Error('This provider does not support API key sign-in.');
    }
    // Pi's store contract has one write path, the same `modify` that `models.login` ends in.
    await credentials.modify(providerId, async () => ({ type: 'api_key', key }));
    await refreshCatalog();
  }, [credentials, models, refreshCatalog, signingIn]);
  /** Removes the saved credential. A failed removal stays pending so the account screen can retry it. */
  const disconnectProvider = useCallback(async (providerId: string) => {
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
  }, [cancelSignIn, disconnectingProvider, models, providerName]);
  const providerOAuth = useCallback((providerId: string) => {
    const oauth = models.getProvider(providerId)?.auth.oauth;
    return oauth ? { name: oauth.name, loginLabel: oauth.loginLabel, isSubscription: oauth.isSubscription } : undefined;
  }, [models]);

  // Only a failed open and the Harness's own reports reach every screen; operations return their errors to the
  // screen that started them.
  return { service, ready: service !== undefined, chats: serviceState.chats, error: openError ?? serviceState.error,
    signOutPending, disconnectingProvider, ...signIn, remoteHosts, catalog, refreshCatalog, providerAccess,
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

export function useChatControls(view: ChatView | undefined): ChatControls | undefined {
  return useSyncExternalStore(view?.subscribe ?? subscribeNothing, view?.getControls ?? noControls,
    view?.getControls ?? noControls);
}

export function useChatMessages(view: ChatView | undefined): readonly ChatMessage[] {
  return useSyncExternalStore(view?.subscribe ?? subscribeNothing, view?.getMessages ?? getNoMessages,
    view?.getMessages ?? getNoMessages);
}

export function useChatStatus(view: ChatView | undefined): ChatViewSnapshot['status'] {
  const getStatus = useCallback(() => view?.getSnapshot().status ?? 'loading', [view]);
  return useSyncExternalStore(view?.subscribe ?? subscribeNothing, getStatus, getStatus);
}

/** Why the chat could not be opened, when it could not. */
export function useChatError(view: ChatView | undefined): string | undefined {
  const getError = useCallback(() => view?.getSnapshot().error, [view]);
  return useSyncExternalStore(view?.subscribe ?? subscribeNothing, getError, getError);
}
