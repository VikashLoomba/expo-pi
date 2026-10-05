import type { OAuthCredential } from '@earendil-works/pi-ai';

// A received rotation may already have consumed the previous refresh token.
// Keep this proof by object identity only; it never enters stored credentials.
const completedRefreshes = new WeakSet<object>();
export function isCompletedCodexRefresh(value: unknown): boolean {
  return typeof value === 'object' && value !== null && completedRefreshes.has(value);
}

// Pi's public Codex client is used only for its device-code flow here.
// Browser redirects require a client registered for this mobile app.
export const CODEX_CLIENT_ID = 'app_EMoamEEZ73f0CkXaXp7hrann';
export const CODEX_DISCOVERY = {
  authorizationEndpoint: 'https://auth.openai.com/oauth/authorize',
  tokenEndpoint: 'https://auth.openai.com/oauth/token',
};

export function validateCodexCallback(value: string, expectedState: string, redirectUri: string): string {
  const url = new URL(value);
  const expected = new URL(redirectUri);
  // URL.origin is "null" for custom schemes; compare their full components.
  if (url.protocol !== expected.protocol || url.host !== expected.host || url.pathname !== expected.pathname ||
      url.username || url.password || url.hash || expected.search || expected.hash) {
    throw new Error('Unexpected sign-in callback address.');
  }
  const states = url.searchParams.getAll('state');
  if (!expectedState || states.length !== 1 || states[0] !== expectedState) {
    throw new Error('Sign-in state did not match. Please try again.');
  }
  if (url.searchParams.has('error')) throw new Error('OpenAI declined the sign-in request. Please try again.');
  const codes = url.searchParams.getAll('code');
  if (codes.length !== 1 || !codes[0]) throw new Error('OpenAI did not return an authorization code.');
  return codes[0];
}

export class CodexTokenRequestError extends Error {
  readonly status: number;
  readonly code?: 'invalid_grant';
  constructor(status: number, code?: 'invalid_grant') {
    super(code === 'invalid_grant' ? 'Your ChatGPT session expired. Sign in again.'
      : `OpenAI token request failed (HTTP ${status}). Please try again.`);
    this.name = 'CodexTokenRequestError';
    this.status = status;
    this.code = code;
  }
}

export function isPermanentCodexAuthError(error: unknown): boolean {
  const visited = new Set<unknown>();
  while (error instanceof Error && !visited.has(error)) {
    if (error instanceof CodexTokenRequestError && error.code === 'invalid_grant') return true;
    visited.add(error);
    error = error.cause;
  }
  return false;
}

export function codexCredentialFromToken(value: unknown, now = Date.now(), previous?: OAuthCredential): OAuthCredential {
  if (!value || typeof value !== 'object') throw new Error('OpenAI returned an invalid token response.');
  const token = value as Record<string, unknown>;
  // OAuth refresh may omit refresh_token when the existing one remains valid.
  const refresh = token.refresh_token === undefined ? previous?.refresh : token.refresh_token;
  if (typeof token.access_token !== 'string' || !token.access_token ||
      typeof refresh !== 'string' || !refresh ||
      typeof token.expires_in !== 'number' || !Number.isFinite(token.expires_in) || token.expires_in <= 0) {
    throw new Error('OpenAI returned an incomplete token response.');
  }
  let accountId: unknown;
  try {
    const payload = token.access_token.split('.')[1].replace(/-/g, '+').replace(/_/g, '/');
    const decoded = JSON.parse(new TextDecoder().decode(Uint8Array.from(atob(payload), (c) => c.charCodeAt(0))));
    accountId = decoded['https://api.openai.com/auth']?.chatgpt_account_id;
  } catch { /* Credentials and token contents must never appear in errors. */ }
  if (typeof accountId !== 'string' || !accountId) throw new Error('OpenAI token is missing its ChatGPT account ID.');
  return { type: 'oauth', access: token.access_token, refresh,
    expires: now + token.expires_in * 1000, accountId };
}

/** Expo's token helpers don't expose AbortSignal; use their request builders with cancellable fetch. */
export async function requestCodexToken(
  request: { getQueryBody(): Record<string, string>; getHeaders(): Record<string, string> },
  signal: AbortSignal,
  previous?: OAuthCredential,
): Promise<OAuthCredential> {
  signal.throwIfAborted();
  const response = await fetch(CODEX_DISCOVERY.tokenEndpoint, {
    method: 'POST', headers: request.getHeaders(),
    body: new URLSearchParams(request.getQueryBody()).toString(), signal,
  });
  if (!response.ok) {
    // Only recognized protocol codes enter errors. Server text may echo secrets.
    let invalidGrant = false;
    try {
      const error = (await response.json())?.error;
      invalidGrant = (response.status === 400 || response.status === 401) &&
        (error === 'invalid_grant' || error?.code === 'invalid_grant');
    } catch { /* A non-JSON error is still retryable. */ }
    signal.throwIfAborted();
    throw new CodexTokenRequestError(response.status, invalidGrant ? 'invalid_grant' : undefined);
  }
  let body: unknown;
  try { body = await response.json(); }
  catch { signal.throwIfAborted(); throw new Error('OpenAI returned an invalid token response.'); }
  if (!previous) signal.throwIfAborted();
  let credential: OAuthCredential;
  try { credential = codexCredentialFromToken(body, Date.now(), previous); }
  catch (error) { signal.throwIfAborted(); throw error; }
  // Preserve a fully received refresh even if its caller just stopped waiting.
  // Failed/aborted fetches and login exchanges retain normal cancellation.
  if (previous) completedRefreshes.add(credential);
  return credential;
}
