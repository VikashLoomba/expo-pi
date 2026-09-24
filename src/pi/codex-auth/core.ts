import type { OAuthCredential } from '@earendil-works/pi-ai';

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

export function codexCredentialFromToken(value: unknown, now = Date.now()): OAuthCredential {
  if (!value || typeof value !== 'object') throw new Error('OpenAI returned an invalid token response.');
  const token = value as Record<string, unknown>;
  if (typeof token.access_token !== 'string' || !token.access_token ||
      typeof token.refresh_token !== 'string' || !token.refresh_token ||
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
  return { type: 'oauth', access: token.access_token, refresh: token.refresh_token,
    expires: now + token.expires_in * 1000, accountId };
}

/** Expo's token helpers don't expose AbortSignal; use their request builders with cancellable fetch. */
export async function requestCodexToken(
  request: { getQueryBody(): Record<string, string>; getHeaders(): Record<string, string> },
  signal: AbortSignal,
): Promise<OAuthCredential> {
  signal.throwIfAborted();
  const response = await fetch(CODEX_DISCOVERY.tokenEndpoint, {
    method: 'POST', headers: request.getHeaders(),
    body: new URLSearchParams(request.getQueryBody()).toString(), signal,
  });
  if (!response.ok) throw new Error(`OpenAI token request failed (HTTP ${response.status}). Please sign in again.`);
  let body: unknown;
  try { body = await response.json(); }
  catch { signal.throwIfAborted(); throw new Error('OpenAI returned an invalid token response.'); }
  signal.throwIfAborted();
  return codexCredentialFromToken(body);
}
