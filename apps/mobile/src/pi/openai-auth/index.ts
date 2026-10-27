import type { OAuthAuth } from '@earendil-works/pi-ai';
import {
  OPENAI_DISCOVERY, OPENAI_DYNAMIC_CLIENT_ID, OPENAI_REDIRECT_URI, OPENAI_RESOURCE, OPENAI_SCOPES, requestOpenAIToken,
  validateOpenAICallback, validateOpenAICredential,
} from '@pi-agent/infinichat/pi/openai-auth/core';
import { AccessTokenRequest, AuthRequest, RefreshTokenRequest, ResponseType } from 'expo-auth-session';
import * as Crypto from 'expo-crypto';
import * as Linking from 'expo-linking';

import { openOpenAIBrowser } from './browser';

export { OPENAI_PROVIDER_ID } from '@pi-agent/infinichat/pi/openai-auth/core';

/** An authorization URL for ChatGPT that returns to the redirect the native receiver serves. */
function authorizationUrl(value: string): URL {
  const url = new URL(value);
  const expected = new URL(OPENAI_DISCOVERY.authorizationEndpoint);
  if (url.origin !== expected.origin || url.pathname !== expected.pathname || url.username || url.password || url.hash
    || url.searchParams.get('redirect_uri') !== OPENAI_REDIRECT_URI) {
    throw new Error('The sign-in link is invalid. Start sign-in again.');
  }
  return url;
}

/** Retry the same authorization in a browser with an address bar for manual return. */
export async function openOpenAIManualBrowser(value: string, signal: AbortSignal): Promise<void> {
  signal.throwIfAborted();
  const url = authorizationUrl(value);
  // An external browser exposes the full callback in its address bar, including
  // when a loopback page cannot load. It is owned by the user, not dismissible.
  await Linking.openURL(url.toString());
  signal.throwIfAborted();
}

/**
 * A machine's ChatGPT sign-in, which pi-ai built there with the same redirect: the phone's receiver and browser catch
 * its callback, for the machine's `manual_code` prompt. Expo's `AuthRequest` stands for that request with its state;
 * `promptAsync({ url })` uses only the redirect and the state (`AuthRequest.ts:137-201`), and the PKCE verifier stays
 * on the machine. Resolves with the whole callback URL, checked as the phone's own, or undefined without one.
 */
export async function openOpenAIBrowserFor(value: string, signal: AbortSignal): Promise<string | undefined> {
  signal.throwIfAborted();
  const url = authorizationUrl(value);
  const state = url.searchParams.get('state') ?? '';
  const request = new AuthRequest({ clientId: OPENAI_DYNAMIC_CLIENT_ID, redirectUri: OPENAI_REDIRECT_URI, state,
    usePKCE: false });
  const callback = await openOpenAIBrowser(request, url.toString(), signal);
  if (callback !== undefined) validateOpenAICallback(callback, state);
  return callback;
}

/** Native implementation of Pi's public OAuthAuth boundary. */
export function createNativeOpenAIOAuth(): OAuthAuth {
  return {
    name: 'OpenAI (ChatGPT subscription)', isSubscription: true, loginLabel: 'Continue with ChatGPT',
    async login(interaction, options) {
      const { signal, notify } = interaction;
      signal.throwIfAborted();
      const deviceId = options?.getDeviceId?.();
      if (!deviceId || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(deviceId)) {
        throw new Error('ChatGPT sign-in requires a saved installation ID.');
      }
      const request = new AuthRequest({ clientId: OPENAI_DYNAMIC_CLIENT_ID, redirectUri: OPENAI_REDIRECT_URI,
        responseType: ResponseType.Code, usePKCE: true, scopes: [...OPENAI_SCOPES],
        state: Crypto.randomUUID(), extraParams: { nonce: Crypto.randomUUID(), resource: OPENAI_RESOURCE,
          ext_agent_host_id: `urn:uuid:${deviceId.toLowerCase()}`, agent_name_hint: 'InfiniChat' } });
      const url = await request.makeAuthUrlAsync(OPENAI_DISCOVERY);
      signal.throwIfAborted();
      notify({ type: 'auth_url', url, instructions: 'Complete sign-in in the browser. If it cannot return here, paste the full return URL.' });
      notify({ type: 'progress', message: 'Complete ChatGPT sign-in in the browser.' });
      let callback = await openOpenAIBrowser(request, url, signal);
      if (!callback) {
        notify({ type: 'info', message: 'The browser did not return a sign-in result. Paste its full return URL to finish, or cancel.' });
        callback = await interaction.prompt({ type: 'manual_code', signal,
          message: 'Finish sign-in in the browser, then copy and paste the full return URL, even if that page does not load.',
          placeholder: OPENAI_REDIRECT_URI });
      }
      signal.throwIfAborted();
      const { code, clientId } = validateOpenAICallback(callback, request.state);
      // Expo performs its own OAuth error/state parsing for manual returns too.
      if (request.parseReturnUrl(callback.trim()).type !== 'success') throw new Error('OpenAI sign-in did not complete. Start sign-in again.');
      if (!request.codeVerifier) throw new Error('Secure sign-in could not be initialized.');
      notify({ type: 'progress', message: 'Completing ChatGPT sign-in…' });
      return requestOpenAIToken(new AccessTokenRequest({ clientId, code, redirectUri: OPENAI_REDIRECT_URI,
        extraParams: { code_verifier: request.codeVerifier, resource: OPENAI_RESOURCE } }), clientId, signal);
    },
    async refresh(credential, signal) {
      validateOpenAICredential(credential);
      const clientId = credential.clientId;
      if (typeof clientId !== 'string' || !clientId || clientId === OPENAI_DYNAMIC_CLIENT_ID) {
        throw new Error('The saved ChatGPT sign-in is incomplete. Connect ChatGPT again.');
      }
      return requestOpenAIToken(new RefreshTokenRequest({ clientId, refreshToken: credential.refresh,
        extraParams: { resource: OPENAI_RESOURCE } }), clientId, signal, credential);
    },
    async toAuth(credential) { validateOpenAICredential(credential); return { apiKey: credential.access }; },
  };
}
