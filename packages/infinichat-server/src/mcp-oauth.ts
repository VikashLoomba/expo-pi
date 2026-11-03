import type { ProviderAuthInteraction } from '@earendil-works/pi-ai';
import { oauthErrorHtml, oauthSuccessHtml } from '@earendil-works/pi-ai/utils/oauth-page';
import type { AuthProvider } from '@earendil-works/pi-mcp';
import {
  adaptOAuthProvider, authorizeMcp, McpOAuthAuthorizationRequiredError, McpOAuthProvider, OAuthCallbackServer,
  parseWwwAuthenticate, stepUpScope, type McpOAuthState, type McpOAuthStateStore, type OAuthCallback,
  type OAuthCallbackPage, type OAuthChallenge, type OAuthClientInformationMixed,
} from '@earendil-works/pi-mcp/oauth';
import { arr, compile, num, obj, opt, str } from '@earendil-works/pi-schema';
import type { CredentialBackend } from '@pi-agent/infinichat/pi/provider-credentials';

import type { McpOAuthSettings } from './mcp-config';

/**
 * OAuth for the machine's remote MCP servers, as pi's coding agent signs in to them (`src/extensions/mcp/oauth.ts` at
 * v1.5.0) with pi-mcp's own provider (README "OAuth"). Connections never start a browser flow on their own: they send
 * the stored access token and, after a 401, refresh it; when that is not possible they fail with
 * `McpOAuthAuthorizationRequiredError`, and a client signs in through `/mcp`. The machine holds the credentials, in
 * `~/.infinichat/mcp-auth.json` keyed by server name and URL, as the coding agent's `mcp-auth.json`. It registers a
 * client as InfiniChat: the coding agent's Client ID Metadata Documents on pi.dev name pi, which it uses only when the
 * app is pi (`oauth.ts:250-255`).
 */

const CALLBACK_HOST = '127.0.0.1';
const CALLBACK_PATH = '/callback';
/** Redirect URI for refreshes when none is stored. Refreshing never redirects the user. */
const FALLBACK_REDIRECT_URL = `http://${CALLBACK_HOST}${CALLBACK_PATH}`;
const CLIENT_NAME = 'InfiniChat';

/**
 * pi-mcp's `McpOAuthState` as this machine stores it, checked when read back. Open objects, so the client registration
 * and the discovered metadata keep every field pi-mcp saved.
 */
const isStoredState = compile(obj({
  serverUrl: str(),
  clientInformation: opt(obj({
    client_id: str(), client_secret: opt(str()), client_id_issued_at: opt(num()), client_secret_expires_at: opt(num()),
    redirect_uris: opt(arr(str())),
  }, { open: true })),
  tokens: opt(obj({
    access_token: str(), token_type: str(), expires_in: opt(num()), scope: opt(str()), refresh_token: opt(str()),
    id_token: opt(str()),
  }, { open: true })),
  tokensExpireAt: opt(num()),
  codeVerifier: opt(str()),
  oauthState: opt(str()),
  discovery: opt(obj({ authorizationServerUrl: str(), resourceMetadataUrl: opt(str()) }, { open: true })),
}, { open: true })).check;

/** A server's OAuth state in the machine's store, and its removal when the user signs out. */
export interface McpCredentials extends McpOAuthStateStore {
  load(): Promise<McpOAuthState | undefined>;
  save(state: McpOAuthState): Promise<void>;
  remove(): Promise<void>;
}

/**
 * One server's state in `backend`, by name and URL, so servers sharing a URL keep separate accounts (coding-agent
 * `oauth.ts:126-133`). A value that does not parse reads as none, so the next sign-in replaces it.
 */
export function mcpCredentials(backend: CredentialBackend, name: string, serverUrl: string): McpCredentials {
  const key = `mcp:${name}|${String(new URL(serverUrl))}`;
  return {
    load: async (): Promise<McpOAuthState | undefined> => {
      const text = await backend.getItemAsync(key);
      if (text === null) return undefined;
      try {
        const value: unknown = JSON.parse(text);
        return isStoredState(value) ? value : undefined;
      } catch {
        return undefined;
      }
    },
    save: (state) => backend.setItemAsync(key, JSON.stringify(state)),
    remove: () => backend.deleteItemAsync(key),
  };
}

/** Where the loopback callback server listens and the redirect URI it serves (coding-agent `oauth.ts:75-106`). */
interface CallbackSettings {
  host: string;
  redirectHost: string;
  port: number | undefined;
  path: string;
  /** The exact redirect URI, when the port is fixed. */
  fixedRedirectUrl: string | undefined;
}

function callbackSettings(settings: McpOAuthSettings): CallbackSettings {
  const url = new URL(settings.callbackUrl ?? `http://${CALLBACK_HOST}${CALLBACK_PATH}`);
  const address = url.hostname.replace(/^\[|\]$/g, '');
  const port = url.port ? Number(url.port) : settings.callbackPort;
  let fixedRedirectUrl: string | undefined;
  // A configured URI with a port is sent exactly as written, since servers compare it as a string.
  if (url.port) {
    fixedRedirectUrl = settings.callbackUrl;
  } else if (port !== undefined) {
    url.port = String(port);
    fixedRedirectUrl = url.href;
  }
  // `localhost` is served on 127.0.0.1; browsers fall back to it when ::1 refuses.
  return { host: address === 'localhost' ? CALLBACK_HOST : address, redirectHost: address, port, path: url.pathname,
    fixedRedirectUrl };
}

function registeredRedirectUrls(client: OAuthClientInformationMixed | undefined): string[] {
  return client && 'redirect_uris' in client ? client.redirect_uris : [];
}

/** Scopes of both lists, each once. */
function mergeScopes(...scopes: (string | undefined)[]): string | undefined {
  const merged = [...new Set(scopes.flatMap((scope) => scope?.split(/\s+/).filter(Boolean) ?? []))];
  return merged.length > 0 ? merged.join(' ') : undefined;
}

function oauthProvider(serverUrl: string, store: McpOAuthStateStore, settings: McpOAuthSettings, redirectUrl: string,
  onRedirect: (url: URL) => void): McpOAuthProvider {
  return new McpOAuthProvider({
    serverUrl, redirectUrl, store, onRedirect,
    clientMetadata: { client_name: settings.clientName ?? CLIENT_NAME },
    clientId: settings.clientId,
    clientSecret: settings.clientSecret,
  });
}

/**
 * The auth provider of a server's connection: pi-mcp's `adaptOAuthProvider`, which sends the stored token and refreshes
 * it after a 401, one refresh for concurrent ones. Before it, the coding agent's rule (`oauth.ts:345`, `:384`): without
 * a refresh token, or when the server asks for more scope, the user signs in, so a connection never registers a client
 * or starts an authorization. `onChallenge` keeps the server's `WWW-Authenticate` challenge for that sign-in.
 */
export function connectionAuth(serverUrl: string, store: McpOAuthStateStore, settings: McpOAuthSettings,
  onChallenge: (challenge: OAuthChallenge) => void): AuthProvider {
  const provider = oauthProvider(serverUrl, store, settings, callbackSettings(settings).fixedRedirectUrl
    ?? FALLBACK_REDIRECT_URL, () => {});
  const adapted = adaptOAuthProvider(provider);
  return {
    token: adapted.token,
    async onUnauthorized(context) {
      const challenge = parseWwwAuthenticate(context.response.headers.get('www-authenticate'));
      onChallenge(challenge);
      if (challenge.error === 'insufficient_scope' || !(await provider.tokens())?.refresh_token) {
        throw new McpOAuthAuthorizationRequiredError();
      }
      await adapted.onUnauthorized?.(context);
    },
  };
}

/** The browser's return as the user pasted it from its address bar (coding-agent `oauth.ts:413-430`). */
function responseFromRedirectUrl(input: string, state: string, redirectUrl: URL): Pick<OAuthCallback, 'code' | 'iss'> {
  let url: URL;
  try {
    url = new URL(input.trim());
  } catch {
    throw new Error('Expected the full redirect URL from the browser address bar.');
  }
  // A server-specific redirect URI tells authorization servers apart, so it must match exactly.
  if (url.origin !== redirectUrl.origin || url.pathname !== redirectUrl.pathname) {
    throw new Error('The redirect URL does not match this sign-in’s redirect URI.');
  }
  const error = url.searchParams.get('error');
  if (error) throw new Error(url.searchParams.get('error_description') ?? error);
  if (url.searchParams.get('state') !== state) throw new Error('The redirect URL belongs to a different sign-in.');
  const code = url.searchParams.get('code');
  if (!code) throw new Error('The redirect URL does not contain an authorization code.');
  return { code, iss: url.searchParams.get('iss') ?? undefined };
}

/** Listens on `port`, or on a free port when it is taken and not `required` (coding-agent `oauth.ts:460-483`). */
async function listenForCallback(settings: CallbackSettings, port: number | undefined,
  required: boolean): Promise<OAuthCallbackServer> {
  const options = {
    host: settings.host,
    redirectHost: settings.redirectHost,
    path: settings.path,
    renderPage: (page: OAuthCallbackPage) => page.ok
      ? oauthSuccessHtml('Signed in to the MCP server. You may now close this page.')
      : oauthErrorHtml(page.message, page.details),
  };
  try {
    return await OAuthCallbackServer.listen({ ...options, port: port ?? 0 });
  } catch (error) {
    if (required || port === undefined) throw error;
    return OAuthCallbackServer.listen(options);
  }
}

/**
 * Signs in to an MCP server, as the coding agent's `signInMcpServer` (`oauth.ts:485-579`) over pi-ai's
 * `AuthInteraction`, which a client answers: the stored refresh token when it can, otherwise the authorization code
 * flow with PKCE and dynamic client registration. The authorization URL goes out as `auth_url`. Its redirect is this
 * machine's loopback, which the callback server answers when the browser runs here; a client's browser runs elsewhere,
 * so the `manual_code` prompt takes the return URL its receiver caught or the user pasted, whichever comes first.
 * Aborting the interaction stops it at any step.
 */
export async function signInMcpServer(options: {
  serverUrl: string;
  store: McpOAuthStateStore;
  settings: McpOAuthSettings;
  challenge?: OAuthChallenge;
  interaction: ProviderAuthInteraction;
}): Promise<void> {
  const { serverUrl, store, settings, interaction } = options;
  const { signal } = interaction;
  signal.throwIfAborted();
  const stored = await store.load();
  const stepUp = options.challenge?.error === 'insufficient_scope';
  const callbackOptions = callbackSettings(settings);
  // Reuse the port of the registered redirect URI so the registered client stays valid.
  const registered = registeredRedirectUrls(stored?.clientInformation)[0];
  const preferredPort = callbackOptions.port ?? (registered ? Number(new URL(registered).port) || undefined : undefined);
  const callback = await listenForCallback(callbackOptions, preferredPort, callbackOptions.port !== undefined);
  const redirectUrl = callbackOptions.fixedRedirectUrl ?? callback.redirectUrl;
  try {
    if (stored) {
      const next: McpOAuthState = { ...stored };
      // Every sign-in gets a fresh `state` parameter.
      delete next.oauthState;
      // A registered client cannot use another redirect URI, and its tokens belong to it.
      const keepClient = settings.clientId !== undefined
        || registeredRedirectUrls(stored.clientInformation).includes(redirectUrl);
      if (!keepClient) {
        delete next.clientInformation;
        delete next.tokens;
        delete next.tokensExpireAt;
      }
      await store.save(next);
    }
    let authorizationUrl: URL | undefined;
    const provider = oauthProvider(serverUrl, store, settings, redirectUrl, (url) => {
      authorizationUrl = url;
    });
    const flow = {
      serverUrl,
      signal,
      resourceMetadataUrl: options.challenge?.resourceMetadataUrl,
      authorizationServerMetadataUrl: settings.authServerMetadataUrl === undefined ? undefined
        : new URL(settings.authServerMetadataUrl),
      // A server asking for more scope gets it on top of the configured scope and, since the challenge may list only
      // the missing scopes, on top of the scope granted so far.
      scope: mergeScopes(settings.scope,
        stepUp ? stepUpScope(stored?.tokens?.scope, options.challenge?.scope) : options.challenge?.scope),
    };
    // A refresh keeps the granted scope; a server asking for more needs the browser flow.
    if (await authorizeMcp(provider, { ...flow, skipRefresh: stepUp }) === 'AUTHORIZED') return;
    if (authorizationUrl === undefined) throw new Error('The OAuth flow did not produce an authorization URL.');
    const state = await provider.state();
    // The flow picks the redirect URI, which the authorization URL carries.
    const returnTo = new URL(authorizationUrl.searchParams.get('redirect_uri') ?? redirectUrl);
    interaction.notify({ type: 'auth_url', url: authorizationUrl.href });
    const answered = new AbortController();
    const fromBrowser = callback.waitForCallback(state, returnTo.pathname);
    const fromUser = interaction.prompt({
      type: 'manual_code', signal: answered.signal, placeholder: returnTo.href,
      message: 'Finish sign-in in the browser, then paste the full return URL, even if that page does not load.',
    }).then((input) => responseFromRedirectUrl(input, state, returnTo));
    let response: Pick<OAuthCallback, 'code' | 'iss'>;
    try {
      response = await Promise.race([fromBrowser, fromUser]);
    } finally {
      // The losing side rejects once the prompt is answered away or the callback server closes.
      answered.abort();
      fromBrowser.catch(() => {});
      fromUser.catch(() => {});
    }
    await authorizeMcp(provider, { ...flow, authorizationCode: response.code, iss: response.iss });
  } finally {
    await callback.close();
  }
}
