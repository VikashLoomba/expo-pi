import { createModels, type CredentialStore, type OAuthAuth } from '@earendil-works/pi-ai';
import { openaiCodexProvider } from '@earendil-works/pi-ai/providers/openai-codex';
import { AccessTokenRequest, AuthRequest, makeRedirectUri, RefreshTokenRequest, ResponseType } from 'expo-auth-session';
import * as Clipboard from 'expo-clipboard';
import * as WebBrowser from 'expo-web-browser';
import { Platform } from 'react-native';

import { CODEX_CLIENT_ID, CODEX_DISCOVERY, requestCodexToken, validateCodexCallback } from './core';
import { createCodexCredentialStore } from './credential-storage';
import { DEVICE_REDIRECT_URI, DEVICE_VERIFICATION_URI, pollCodexDeviceLogin, startCodexDeviceLogin } from './device-auth';

export { CODEX_PROVIDER_ID, MODEL_ID } from './identity';
export { createCodexCredentialStore } from './credential-storage';
export type { CredentialSnapshot } from './credential-store';

export interface CodexBrowserConfig {
  /** OpenAI-issued public client registered for this app's redirect and Codex access. */
  clientId: string;
  redirectUri: string;
}

let authSessionOpen = false;

async function withAuthSession<T>(open: () => Promise<T>, signal: AbortSignal): Promise<T> {
  signal.throwIfAborted();
  if (Platform.OS !== 'ios') throw new Error('ChatGPT sign-in is currently supported on iOS.');
  if (authSessionOpen) throw new Error('A sign-in browser is already open.');
  authSessionOpen = true;
  const abort = () => WebBrowser.dismissAuthSession();
  signal.addEventListener('abort', abort, { once: true });
  try {
    const result = await open();
    signal.throwIfAborted();
    return result;
  } finally {
    signal.removeEventListener('abort', abort);
    authSessionOpen = false;
  }
}

/** Device authorization completes through polling; closing this page leaves that login pending. */
export async function openCodexDeviceBrowser(signal: AbortSignal): Promise<void> {
  await withAuthSession(() => WebBrowser.openAuthSessionAsync(DEVICE_VERIFICATION_URI), signal);
}

/** Implement Pi's public OAuthAuth contract using Expo's native authentication session. */
export function createNativeCodexOAuth(browser?: CodexBrowserConfig): OAuthAuth {
  const clientId = browser?.clientId ?? CODEX_CLIENT_ID;
  return {
    name: 'OpenAI (ChatGPT)', isSubscription: true,
    async login(interaction) {
      const { signal, notify } = interaction;
      signal.throwIfAborted();
      if (!browser) {
        notify({ type: 'progress', message: 'Requesting a sign-in code…' });
        const device = await startCodexDeviceLogin(clientId, signal);
        signal.throwIfAborted();
        let copied = false;
        try {
          copied = await Clipboard.setStringAsync(device.userCode, { android: { isSensitive: true } });
        } catch {
          // Clipboard access is a convenience; manual code entry must still work.
        }
        signal.throwIfAborted();
        notify({ type: 'device_code', userCode: device.userCode, verificationUri: DEVICE_VERIFICATION_URI,
          intervalSeconds: device.intervalSeconds, expiresInSeconds: 900 });
        notify({ type: 'progress', message: copied
          ? 'Sign-in code copied. Paste it on the OpenAI sign-in page.'
          : 'Could not copy the sign-in code. Enter the displayed code on the OpenAI sign-in page.' });
        const code = await pollCodexDeviceLogin(device, signal);
        notify({ type: 'progress', message: 'Completing sign-in…' });
        return requestCodexToken(new AccessTokenRequest({
          clientId, code: code.authorizationCode, redirectUri: DEVICE_REDIRECT_URI,
          extraParams: { code_verifier: code.codeVerifier },
        }), signal);
      }

      const request = new AuthRequest({
        clientId, redirectUri: browser.redirectUri,
        responseType: ResponseType.Code, usePKCE: true,
        scopes: ['openid', 'profile', 'email', 'offline_access'],
      });
      // Prepare PKCE before installing the cancellation handler/opening the session.
      const url = await request.makeAuthUrlAsync(CODEX_DISCOVERY);
      notify({ type: 'progress', message: 'Complete sign-in in the browser.' });
      const result = await withAuthSession(() => request.promptAsync(CODEX_DISCOVERY, { url }), signal);
      if (result.type === 'cancel' || result.type === 'dismiss') throw new DOMException('Sign-in cancelled.', 'AbortError');
      if (result.type !== 'success') throw new Error('OpenAI sign-in did not complete. Please try again.');
      const code = validateCodexCallback(result.url, request.state, browser.redirectUri);
      if (!request.codeVerifier) throw new Error('PKCE was not initialized.');
      notify({ type: 'progress', message: 'Completing sign-in…' });
      return requestCodexToken(new AccessTokenRequest({ clientId, code, redirectUri: browser.redirectUri,
        extraParams: { code_verifier: request.codeVerifier },
      }), signal);
    },
    refresh: (credential, signal) => requestCodexToken(new RefreshTokenRequest({
      clientId, refreshToken: credential.refresh,
    }), signal, credential),
    async toAuth(credential) { return { apiKey: credential.access }; },
  };
}

export function createCodexSession(credentials: CredentialStore = createCodexCredentialStore()) {
  const models = createModels({ credentials, authContext: { env: async () => undefined, fileExists: async () => false } });
  const provider = openaiCodexProvider();
  // A separately registered mobile client can use standard authorization-code login.
  // Pi's existing desktop client uses its supported device-code flow by default.
  const clientId = process.env.EXPO_PUBLIC_CODEX_OAUTH_CLIENT_ID?.trim();
  const oauth = createNativeCodexOAuth(clientId ? {
    clientId, redirectUri: makeRedirectUri({ scheme: 'piagent', path: 'auth/callback' }),
  } : undefined);
  models.setProvider({ ...provider, auth: { ...provider.auth, oauth } });
  return models;
}
