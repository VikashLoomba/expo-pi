import type { Credential, OAuthCredential } from '@earendil-works/pi-ai';

// Protocol constants from Pi's openai ChatGPT OAuth provider (pi-ai 1.0.0).
// Keep this flow separate from openai-codex: its clients, scopes and tokens differ.
export const OPENAI_PROVIDER_ID = 'openai';
export const OPENAI_DYNAMIC_CLIENT_ID = 'dynamic_agent_client';
export const OPENAI_RESOURCE = 'https://api.openai.com/v1';
export const OPENAI_REDIRECT_URI = 'http://127.0.0.1:1455/auth/callback';
export const OPENAI_DIRECT_SCOPE = 'chatgpt.tokens.use.direct';
export const OPENAI_SCOPES = ['openid', 'profile', 'email', 'offline_access', 'resource.invoke', OPENAI_DIRECT_SCOPE];
export const OPENAI_DISCOVERY = {
  authorizationEndpoint: 'https://auth.openai.com/api/accounts/authorize',
  tokenEndpoint: 'https://auth.openai.com/api/accounts/oauth/token',
};

const completedRefreshes = new WeakSet<object>();

/** A stored modern OAuth grant must not be confused with legacy Codex tokens. */
export function validateOpenAICredential(credential: Credential): void {
  if (credential.type !== 'oauth') return;
  if (typeof credential.clientId !== 'string' || !credential.clientId
    || credential.clientId === OPENAI_DYNAMIC_CLIENT_ID || /[\s\u0000-\u001f\u007f]/.test(credential.clientId)
    || !Array.isArray(credential.scopes) || !credential.scopes.every((scope) => typeof scope === 'string')
    || !credential.scopes.includes(OPENAI_DIRECT_SCOPE)) {
    throw new Error('The saved ChatGPT sign-in is incomplete. Connect ChatGPT again.');
  }
}
export function isCompletedOpenAIRefresh(value: unknown): boolean {
  return typeof value === 'object' && value !== null && completedRefreshes.has(value);
}

/** Both browser callbacks and Pi manual_code input must pass the same checks. */
export function validateOpenAICallback(value: string, expectedState: string) {
  let url: URL;
  try { url = new URL(value.trim()); }
  catch { throw new Error('Paste the full sign-in return URL from your browser.'); }
  const expected = new URL(OPENAI_REDIRECT_URI);
  if (url.origin !== expected.origin || url.pathname !== expected.pathname || url.username || url.password || url.hash) {
    throw new Error('The sign-in return URL has an unexpected address.');
  }
  const states = url.searchParams.getAll('state');
  if (!expectedState || states.length !== 1 || states[0] !== expectedState) {
    throw new Error('This sign-in return URL belongs to a different attempt. Start sign-in again.');
  }
  if (url.searchParams.has('error')) throw new Error('OpenAI declined the sign-in request. Start sign-in again.');
  const codes = url.searchParams.getAll('code');
  const clients = url.searchParams.getAll('client_id');
  if (codes.length !== 1 || !codes[0]?.trim() || clients.length !== 1 || !clients[0]?.trim()
    || clients[0] === OPENAI_DYNAMIC_CLIENT_ID || /[\s\u0000-\u001f\u007f]/.test(clients[0])) {
    throw new Error('OpenAI did not return a complete authorization. Start sign-in again.');
  }
  return { code: codes[0], clientId: clients[0] };
}

export class OpenAITokenRequestError extends Error {
  constructor(readonly status: number, readonly code?: 'invalid_grant') {
    super(code === 'invalid_grant' ? 'Your OpenAI sign-in expired. Connect ChatGPT again.'
      : `OpenAI could not complete sign-in (HTTP ${status}). Please try again.`);
    this.name = 'OpenAITokenRequestError';
  }
}

export function isPermanentOpenAIAuthError(error: unknown): boolean {
  const visited = new Set<unknown>();
  while (error instanceof Error && !visited.has(error)) {
    if (error instanceof OpenAITokenRequestError && error.code === 'invalid_grant') return true;
    visited.add(error);
    error = error.cause;
  }
  return false;
}

export function openAICredentialFromToken(value: unknown, clientId: string, previous?: OAuthCredential, now = Date.now()): OAuthCredential {
  if (!value || typeof value !== 'object') throw new Error('OpenAI returned an invalid token response.');
  const token = value as Record<string, unknown>;
  const refresh = token.refresh_token === undefined ? previous?.refresh : token.refresh_token;
  const scopes = token.scope === undefined && previous ? previous.scopes
    : typeof token.scope === 'string' ? token.scope.trim().split(/\s+/).filter(Boolean) : undefined;
  if (typeof token.access_token !== 'string' || !token.access_token.trim()
    || typeof refresh !== 'string' || !refresh.trim()
    || typeof token.expires_in !== 'number' || !Number.isFinite(token.expires_in) || token.expires_in <= 0
    || !Number.isFinite(now + token.expires_in * 1000)) {
    throw new Error('OpenAI returned an incomplete token response.');
  }
  if (!Array.isArray(scopes) || !scopes.every((scope) => typeof scope === 'string') || !scopes.includes(OPENAI_DIRECT_SCOPE)) {
    throw new Error('ChatGPT plan access was not granted. Sign in again and allow plan access.');
  }
  // Like Pi, use only the access token for inference. No unverified ID-token
  // claims are used as identity or displayed as an authenticated profile.
  if (!previous && (typeof token.id_token !== 'string' || !token.id_token.trim())) {
    throw new Error('OpenAI did not return a complete sign-in response.');
  }
  return { type: 'oauth', access: token.access_token, refresh, expires: now + token.expires_in * 1000,
    clientId, scopes: [...scopes] };
}

/** Expo builds OAuth grants; cancellable fetch carries them, as in the legacy adapter. */
export async function requestOpenAIToken(
  request: { getQueryBody(): Record<string, string>; getHeaders(): Record<string, string> },
  clientId: string,
  signal: AbortSignal,
  previous?: OAuthCredential,
): Promise<OAuthCredential> {
  signal.throwIfAborted();
  let response: Response;
  try {
    response = await fetch(OPENAI_DISCOVERY.tokenEndpoint, { method: 'POST', headers: request.getHeaders(),
      body: new URLSearchParams(request.getQueryBody()).toString(), signal });
  } catch {
    signal.throwIfAborted();
    throw new Error('Could not reach OpenAI. Check your connection and try again.');
  }
  if (!response.ok) {
    let code: 'invalid_grant' | undefined;
    try {
      const error = (await response.json())?.error;
      if ([400, 401].includes(response.status) && (error === 'invalid_grant' || error?.code === 'invalid_grant')) code = 'invalid_grant';
    } catch { /* Remote error bodies can contain secrets; never surface them. */ }
    signal.throwIfAborted();
    throw new OpenAITokenRequestError(response.status, code);
  }
  let body: unknown;
  try { body = await response.json(); }
  catch { signal.throwIfAborted(); throw new Error('OpenAI returned an invalid token response.'); }
  if (!previous) signal.throwIfAborted();
  const credential = openAICredentialFromToken(body, clientId, previous);
  // A fully received rotation must reach secure storage even if its caller
  // stops waiting. Pi performs refresh under CredentialStore.modify's lock.
  if (previous) completedRefreshes.add(credential);
  return credential;
}
