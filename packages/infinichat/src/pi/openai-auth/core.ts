import type { Credential, OAuthCredential } from '@earendil-works/pi-ai';
import { arr, compile, lit, num, obj, opt, str, union } from '@earendil-works/pi-schema';

// Protocol constants from Pi's openai ChatGPT OAuth provider (pi-ai 1.1.0).
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

/** A stored grant must carry the issued client ID and the ChatGPT direct-use scope. */
export function validateOpenAICredential(credential: Credential): void {
  if (credential.type !== 'oauth') return;
  if (typeof credential.clientId !== 'string' || !credential.clientId
    || credential.clientId === OPENAI_DYNAMIC_CLIENT_ID || /[\s\u0000-\u001f\u007f]/.test(credential.clientId)
    || !Array.isArray(credential.scopes) || !credential.scopes.every((scope) => typeof scope === 'string')
    || !credential.scopes.includes(OPENAI_DIRECT_SCOPE)) {
    throw new Error('The saved ChatGPT sign-in is incomplete. Connect ChatGPT again.');
  }
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

/** OpenAI refused the refresh grant. pi-ai wraps refresh failures, so the cause chain is searched. */
export function isPermanentOpenAIAuthError(error: unknown): boolean {
  const visited = new Set<unknown>();
  while (error instanceof Error && !visited.has(error)) {
    if (error instanceof OpenAITokenRequestError && error.code === 'invalid_grant') return true;
    visited.add(error);
    error = error.cause;
  }
  return false;
}

/** Text with something besides whitespace. */
const filled = () => str({ pattern: '\\S' });
/** OpenAI's token response, as pi-ai's ChatGPT provider reads it; a refresh may omit the refresh token and scope. */
const tokenResponse = compile(obj({
  access_token: filled(), refresh_token: opt(filled()), expires_in: num({ exclusiveMinimum: 0 }),
  scope: opt(str()), id_token: opt(str()),
}, { open: true }));
const scopeList = compile(arr(str()));
/** A refused grant, as OpenAI's token endpoint names it: a code, or an object with one. */
const refusedGrant = compile(obj({
  error: union([lit('invalid_grant'), obj({ code: lit('invalid_grant') }, { open: true })]),
}, { open: true }));

export function openAICredentialFromToken(value: unknown, clientId: string, previous?: OAuthCredential, now = Date.now()): OAuthCredential {
  if (!tokenResponse.check(value)) throw new Error('OpenAI returned an incomplete token response.');
  const refresh = value.refresh_token ?? previous?.refresh;
  const expires = now + value.expires_in * 1000;
  if (!refresh?.trim() || !Number.isFinite(expires)) throw new Error('OpenAI returned an incomplete token response.');
  const scopes = value.scope === undefined ? previous?.scopes : value.scope.trim().split(/\s+/).filter(Boolean);
  if (!scopeList.check(scopes) || !scopes.includes(OPENAI_DIRECT_SCOPE)) {
    throw new Error('ChatGPT plan access was not granted. Sign in again and allow plan access.');
  }
  // Like Pi, use only the access token for inference. No unverified ID-token
  // claims are used as identity or displayed as an authenticated profile.
  if (!previous && !value.id_token?.trim()) {
    throw new Error('OpenAI did not return a complete sign-in response.');
  }
  return { type: 'oauth', access: value.access_token, refresh, expires, clientId, scopes: [...scopes] };
}

/** Expo builds OAuth grants; a cancellable fetch carries them. */
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
      const body: unknown = await response.json();
      if ([400, 401].includes(response.status) && refusedGrant.check(body)) code = 'invalid_grant';
    } catch { /* Remote error bodies can contain secrets; never surface them. */ }
    signal.throwIfAborted();
    throw new OpenAITokenRequestError(response.status, code);
  }
  let body: unknown;
  try { body = await response.json(); }
  catch { signal.throwIfAborted(); throw new Error('OpenAI returned an invalid token response.'); }
  // A received rotation may already have spent the previous refresh token, so only login
  // honors a late abort. Pi refreshes under its credential lock with a timeout signal and
  // never forwards caller cancellation there, so the result always reaches storage.
  if (!previous) signal.throwIfAborted();
  return openAICredentialFromToken(body, clientId, previous);
}
