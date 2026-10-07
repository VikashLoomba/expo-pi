import React, { createContext, useCallback, useContext, useEffect, useRef, useState, useSyncExternalStore } from 'react';
import { AppState, Platform } from 'react-native';

import { createRemoteHostRepository } from '../pi/execution/remote/host-storage';
import { createRemoteExecution } from '../pi/execution/remote/composition';
import type { ChatExecutionSettings } from '../pi/execution/document';
import { CODEX_PROVIDER_ID, openCodexDeviceBrowser } from '../pi/codex-auth';
import { buildModelCatalog, type ChatModelSettings } from '../pi/model-catalog';
import { createChatCredentialStore, createChatModels } from '../pi/models';
import { OPENAI_PROVIDER_ID, openOpenAIManualBrowser } from '../pi/openai-auth';
import { getOpenAILoginOptions } from '../pi/openai-auth/installation';
import type { ProviderAccess } from '../pi/provider-credentials';
import { openExpoSqliteStorage } from '../pi/storage';
import { AuthPromptController } from './auth-prompt-controller';
import { ChatRuntime } from './chat-runtime';

function useChatController() {
  const [remoteHosts] = useState(createRemoteHostRepository);
  const [credentials] = useState(createChatCredentialStore);
  const [models] = useState(() => {
    const session = createChatModels(credentials);
    credentials.registerProviders(session.getProviders().map((provider) => provider.id));
    return session;
  });
  const [catalog, setCatalog] = useState(() => buildModelCatalog(models));
  const [runtime] = useState(() => new ChatRuntime({ models, credentials, openStorage: openExpoSqliteStorage, platform: Platform.OS, execution: (local) => createRemoteExecution(local, remoteHosts) }));
  const snapshot = useSyncExternalStore(runtime.subscribe, runtime.getSnapshot, runtime.getSnapshot);
  const credentialState = useSyncExternalStore(credentials.subscribe, credentials.getSnapshot, credentials.getSnapshot);
  const [signingInProvider, setSigningInProvider] = useState<string | null>(null);
  const [authNotice, setAuthNotice] = useState<{ providerId: string; message: string }>();
  const [prompts] = useState(() => new AuthPromptController());
  const authPrompt = useSyncExternalStore(prompts.subscribe, prompts.getSnapshot, prompts.getSnapshot);
  const [deviceLogin, setDeviceLogin] = useState<{ userCode: string; verificationUri: string } | null>(null);
  const [browserOpen, setBrowserOpen] = useState(false);
  const login = useRef<AbortController | null>(null);
  const browser = useRef<AbortController | null>(null);
  const authUrl = useRef<string | null>(null);
  const authAction = useRef(0);
  const mounted = useRef(false);
  const hasSavedSignIn = credentialState.signedIn;
  const codexSignOutPending = snapshot.signOutPending && snapshot.disconnectingProvider === CODEX_PROVIDER_ID;
  const signedIn = hasSavedSignIn && !credentialState.error && !codexSignOutPending;
  const authReady = credentialState.ready;
  const authError = snapshot.authError || credentialState.error;
  const signingIn = signingInProvider !== null;
  const codexSigningIn = signingInProvider === CODEX_PROVIDER_ID;
  const codexNotice = authNotice?.providerId === CODEX_PROVIDER_ID ? authNotice.message : undefined;
  const authStatus = codexSigningIn ? codexNotice || 'Starting sign-in…'
    : snapshot.signOutPending ? codexSignOutPending ? snapshot.authError || 'Signing out…'
      : `Finish disconnecting ${catalog.find((provider) => provider.id === snapshot.disconnectingProvider)?.name ?? snapshot.disconnectingProvider} in Providers.`
      : !authReady ? 'Restoring your saved sign-in…'
        : snapshot.authChecking ? 'Checking the provider connection…'
          : authError || codexNotice || (signedIn ? 'Connected to ChatGPT.' : 'Sign in to start a conversation.');

  useEffect(() => {
    mounted.current = true;
    void remoteHosts.restore().catch((error) => runtime.report(error));
    if (AppState.currentState !== 'background') void runtime.activate().catch((error) => runtime.report(error));
    const subscription = AppState.addEventListener('change', (state) => {
      const operation = state === 'background' ? runtime.deactivate() : state === 'active' ? runtime.activate() : undefined;
      void operation?.catch((error) => runtime.report(error));
    });
    return () => {
      mounted.current = false;
      subscription.remove();
      login.current?.abort();
      browser.current?.abort();
      prompts.cancel();
      void runtime.deactivate().catch((error) => runtime.report(error));
    };
  }, [prompts, remoteHosts, runtime]);

  const cancelSignIn = useCallback(() => { login.current?.abort(); browser.current?.abort(); }, []);
  const signIn = useCallback(async (providerId = CODEX_PROVIDER_ID) => {
    if (login.current || snapshot.signOutPending || !credentials.getProviderSnapshot(providerId).ready) return;
    if (!models.getProvider(providerId)?.auth.oauth) return;
    const controller = new AbortController();
    const attempt = ++authAction.current;
    login.current = controller;
    setSigningInProvider(providerId);
    setAuthNotice({ providerId, message: 'Starting sign-in…' });
    setDeviceLogin(null);
    authUrl.current = null;
    try {
      const options = providerId === OPENAI_PROVIDER_ID ? await getOpenAILoginOptions() : undefined;
      controller.signal.throwIfAborted();
      await runtime.login(providerId, {
        signal: controller.signal,
        prompt: (prompt) => {
          setAuthNotice({ providerId, message: prompt.type === 'manual_code'
            ? 'Finish sign-in with the browser return URL.' : 'Complete the next sign-in step.' });
          return prompts.prompt(prompt, controller.signal);
        },
        notify(event) {
          if (!mounted.current || controller.signal.aborted) return;
          if (event.type === 'device_code') setDeviceLogin({ userCode: event.userCode, verificationUri: event.verificationUri });
          if (event.type === 'auth_url') authUrl.current = event.url;
          // OAuth diagnostics can include callback URLs or tokens. The account
          // screen uses public status copy and never renders raw server payloads.
          if (event.type === 'progress' || event.type === 'info' || event.type === 'auth_url') {
            setAuthNotice({ providerId, message: event.type === 'auth_url' ? 'Continue in your browser to sign in.' : 'Sign-in in progress…' });
          }
        },
      }, options);
      if (mounted.current && !controller.signal.aborted && attempt === authAction.current) {
        setAuthNotice(undefined);
        setCatalog(buildModelCatalog(models));
      }
    } catch {
      if (mounted.current && attempt === authAction.current) {
        setAuthNotice({ providerId, message: controller.signal.aborted ? 'Sign-in cancelled.' : 'Sign-in could not be completed. Please try again.' });
      }
    } finally {
      if (login.current === controller) login.current = null;
      browser.current?.abort();
      authUrl.current = null;
      prompts.cancel();
      if (mounted.current) { setSigningInProvider(null); setDeviceLogin(null); }
    }
  }, [credentials, models, prompts, runtime, snapshot.signOutPending]);
  const openSignInPage = useCallback(async () => {
    if (!login.current || browser.current || !signingInProvider) return;
    const controller = new AbortController();
    browser.current = controller;
    setBrowserOpen(true);
    try {
      if (signingInProvider === CODEX_PROVIDER_ID) await openCodexDeviceBrowser(controller.signal);
      else if (signingInProvider === OPENAI_PROVIDER_ID && authUrl.current) await openOpenAIManualBrowser(authUrl.current, controller.signal);
    } catch {
      if (mounted.current && !controller.signal.aborted) setAuthNotice({ providerId: signingInProvider, message: 'Could not open the sign-in page. Please try again.' });
    } finally {
      if (browser.current === controller) browser.current = null;
      if (mounted.current) setBrowserOpen(false);
    }
  }, [signingInProvider]);
  const signOut = useCallback(async () => {
    authAction.current++;
    cancelSignIn();
    await runtime.signOut();
    if (mounted.current) setAuthNotice({ providerId: CODEX_PROVIDER_ID, message: 'Signed out. Your chats are saved on this device.' });
  }, [cancelSignIn, runtime]);
  const retryAuth = useCallback(async () => {
    setAuthNotice(undefined);
    await runtime.retryAuth();
  }, [runtime]);
  const providerAccess = useCallback((providerId: string): ProviderAccess => {
    const state = providerId === CODEX_PROVIDER_ID
      ? { ready: credentialState.ready, connected: signedIn, ...(signedIn ? { type: 'oauth' as const } : {}), ...(authError ? { error: authError } : {}) }
      : credentialState.providers[providerId] ?? { ready: false, connected: false };
    return snapshot.signOutPending ? { ...state, ready: false, connected: false } : state;
  }, [authError, credentialState, signedIn, snapshot.signOutPending]);
  const hasConnectedProvider = catalog.some((provider) => providerAccess(provider.id).connected);
  const refreshCatalog = useCallback(async () => {
    const result = await models.refresh();
    if (mounted.current) setCatalog(buildModelCatalog(models));
    if (result.errors.size) throw new Error('Some provider models could not be refreshed. Existing models are still available.');
  }, [models]);
  const saveProviderKey = useCallback(async (providerId: string, key: string) => {
    if (login.current) throw new Error('Finish or cancel sign-in before changing provider credentials.');
    await runtime.saveProviderKey(providerId, key);
    await refreshCatalog();
  }, [runtime, refreshCatalog]);

  return { ...snapshot, runtime, remoteHosts, catalog, refreshCatalog, providerAccess, hasConnectedProvider,
    signedIn, hasSavedSignIn, authReady, authError, signingIn, signingInProvider, authStatus, authNotice, deviceLogin, browserOpen,
    authPrompt, submitAuthPrompt: prompts.submit,
    providerOAuth: useCallback((providerId: string) => {
      const oauth = models.getProvider(providerId)?.auth.oauth;
      return oauth ? { name: oauth.name, loginLabel: oauth.loginLabel, isSubscription: oauth.isSubscription } : undefined;
    }, [models]),
    signIn, cancelSignIn, openSignInPage, signOut, retryAuth,
    saveProviderKey,
    disconnectProvider: useCallback(async (providerId: string) => {
      cancelSignIn();
      await runtime.signOut(providerId);
    }, [cancelSignIn, runtime]),
    createChat: useCallback(() => runtime.createChat(), [runtime]),
    renameChat: useCallback((id: string, title: string) => runtime.renameChat(id, title), [runtime]),
    archiveChat: useCallback((id: string) => runtime.archiveChat(id), [runtime]),
  };
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
export function useChatConversation(id: string) {
  const { runtime } = useChatApp();
  const getConversation = useCallback(() => runtime.getConversation(id), [runtime, id]);
  const conversation = useSyncExternalStore(runtime.subscribe, getConversation, getConversation);
  return { conversation, error: conversation?.error,
    send: useCallback((text: string) => runtime.send(id, text), [runtime, id]),
    cancel: useCallback(() => runtime.cancel(id), [runtime, id]),
    resume: useCallback(() => runtime.resume(id), [runtime, id]),
    updateExecution: useCallback((execution: ChatExecutionSettings, settings?: ChatModelSettings) => runtime.updateExecution(id, execution, settings), [runtime, id]),
    updateSettings: useCallback((settings: ChatModelSettings) => runtime.updateSettings(id, settings), [runtime, id]),
  };
}

/** Header and composer subscribe to control state, not every streamed character. */
export function useChatConversationState(id: string) {
  const { runtime } = useChatApp();
  const getState = useCallback(() => runtime.getConversationState(id), [runtime, id]);
  const conversation = useSyncExternalStore(runtime.subscribe, getState, getState);
  return { conversation, error: conversation?.error,
    send: useCallback((text: string) => runtime.send(id, text), [runtime, id]),
    cancel: useCallback(() => runtime.cancel(id), [runtime, id]),
    resume: useCallback(() => runtime.resume(id), [runtime, id]),
    updateExecution: useCallback((execution: ChatExecutionSettings, settings?: ChatModelSettings) => runtime.updateExecution(id, execution, settings), [runtime, id]),
    updateSettings: useCallback((settings: ChatModelSettings) => runtime.updateSettings(id, settings), [runtime, id]),
  };
}
