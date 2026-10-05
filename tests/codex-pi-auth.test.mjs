import assert from 'node:assert/strict';
import { Buffer } from 'node:buffer';
import { registerHooks } from 'node:module';
import { dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import test from 'node:test';

// Exercise the app adapter and installed Pi implementations. Only native APIs are
// substituted; Expo's token builders, AuthRequest and PKCE remain real code.
const expoBuild = pathToFileURL(`${dirname(fileURLToPath(import.meta.resolve('expo-auth-session')))}/`).href;
const adapterUrl = new URL('../src/pi/codex-auth/index.ts', import.meta.url).href;
const sources = {
  'test:codex-native': `export const native = {
    secure: new Map(),
    clipboard: async () => true,
    browser: async () => { throw new Error('Unexpected native browser presentation'); },
    dismiss: () => {},
  };`,
  'expo-secure-store': `import { native } from 'test:codex-native';
    export const WHEN_UNLOCKED_THIS_DEVICE_ONLY = 4;
    export const getItemAsync = async (key) => native.secure.get(key) ?? null;
    export const setItemAsync = async (key, value) => { native.secure.set(key, value); };
    export const deleteItemAsync = async (key) => { native.secure.delete(key); };`,
  'react-native': `export const Platform = { OS: 'ios', select: (values) => values.ios ?? values.default };`,
  'expo-clipboard': `import { native } from 'test:codex-native';
    export const setStringAsync = (...args) => native.clipboard(...args);`,
  'expo-web-browser': `import { native } from 'test:codex-native';
    export const openAuthSessionAsync = (...args) => native.browser(...args);
    export const dismissAuthSession = () => native.dismiss();`,
  'expo-modules-core': `export class CodedError extends Error {
    constructor(code, message) { super(message); this.code = code; }
  }`,
  'expo-crypto': `export const getRandomValues = (value) => globalThis.crypto.getRandomValues(value);
    export const CryptoDigestAlgorithm = { SHA256: 'SHA-256' };
    export const CryptoEncoding = { BASE64: 'base64', HEX: 'hex' };
    export const digestStringAsync = async (algorithm, value, options) =>
      Buffer.from(await globalThis.crypto.subtle.digest(algorithm, new TextEncoder().encode(value))).toString(options.encoding);`,
  'expo-auth-session': `export { AccessTokenRequest, RefreshTokenRequest } from '${expoBuild}TokenRequest.js';
    export { AuthRequest } from '${expoBuild}AuthRequest.js';
    export { ResponseType } from '${expoBuild}AuthRequest.types.js';
    export const makeRedirectUri = ({ scheme, path }) => scheme + '://' + path;`,
};
const hooks = registerHooks({
  resolve(specifier, context, nextResolve) {
    if (Object.hasOwn(sources, specifier)) return { url: `test:module/${specifier}`, shortCircuit: true };
    if (context.parentURL?.startsWith(new URL('../src/pi/codex-auth/', import.meta.url).href) && specifier.startsWith('./')) {
      return { url: new URL(`${specifier}.ts`, context.parentURL).href, shortCircuit: true };
    }
    // Expo's Metro-targeted JS uses extensionless internal imports.
    if (context.parentURL?.startsWith(expoBuild) && specifier.startsWith('./') && !specifier.endsWith('.js')) {
      return { url: new URL(`${specifier}.js`, context.parentURL).href, shortCircuit: true };
    }
    const resolved = nextResolve(specifier, context);
    assert.ok(!/\/auth\/oauth\/openai-(?:codex|chatgpt)\.js$/.test(resolved.url),
      'The native adapter must never load Pi desktop OAuth');
    return resolved;
  },
  load(url, context, nextLoad) {
    if (url.startsWith('test:module/')) {
      return { format: 'module', source: sources[url.slice('test:module/'.length)], shortCircuit: true };
    }
    return nextLoad(url, context);
  },
});
test.after(() => hooks.deregister());
// eslint-disable-next-line import/no-unresolved -- Provided by the test's module hook above.
const { native } = await import('test:codex-native');
test.beforeEach(() => native.secure.clear());
const { CODEX_PROVIDER_ID, MODEL_ID, createCodexSession, createNativeCodexOAuth } = await import(adapterUrl);
const { CODEX_CLIENT_ID, CODEX_DISCOVERY } = await import('../src/pi/codex-auth/core.ts');
const { DEVICE_REDIRECT_URI, DEVICE_VERIFICATION_URI } = await import('../src/pi/codex-auth/device-auth.ts');

function tokenResponse({ label = 'initial', expiresIn = 3600 } = {}) {
  const claims = { 'https://api.openai.com/auth': { chatgpt_account_id: `test-account-${label}` } };
  return {
    access_token: `header.${Buffer.from(JSON.stringify(claims)).toString('base64url')}.signature`,
    refresh_token: `test-refresh-${label}`,
    expires_in: expiresIn,
  };
}

function session(t) {
  const originalClient = process.env.EXPO_PUBLIC_CODEX_OAUTH_CLIENT_ID;
  delete process.env.EXPO_PUBLIC_CODEX_OAUTH_CLIENT_ID;
  t.after(() => {
    if (originalClient === undefined) delete process.env.EXPO_PUBLIC_CODEX_OAUTH_CLIENT_ID;
    else process.env.EXPO_PUBLIC_CODEX_OAUTH_CLIENT_ID = originalClient;
  });
  return createCodexSession();
}

function interaction(signal = new AbortController().signal) {
  const notifications = [];
  return {
    signal, notifications,
    notify: (notification) => notifications.push(notification),
    prompt: async () => { throw new Error('Device login must not prompt for desktop input'); },
  };
}

async function login(t, models, token = tokenResponse()) {
  const copied = [];
  t.mock.method(native, 'clipboard', async (...args) => { copied.push(args); return true; });
  const requests = [];
  t.mock.method(globalThis, 'fetch', async (url, options) => {
    requests.push({ url, options });
    assert.equal(options.method, 'POST');
    assert.ok(options.signal instanceof AbortSignal);
    if (url === 'https://auth.openai.com/api/accounts/deviceauth/usercode') {
      assert.deepEqual(JSON.parse(options.body), { client_id: CODEX_CLIENT_ID });
      return Response.json({ device_auth_id: 'test-device', user_code: 'TEST-CODE', interval: 5 });
    }
    if (url === 'https://auth.openai.com/api/accounts/deviceauth/token') {
      assert.deepEqual(JSON.parse(options.body), { device_auth_id: 'test-device', user_code: 'TEST-CODE' });
      return Response.json({ authorization_code: 'test-authorization-code', code_verifier: 'test-verifier' });
    }
    assert.equal(url, CODEX_DISCOVERY.tokenEndpoint, 'No unmocked network destinations');
    assert.deepEqual(Object.fromEntries(new URLSearchParams(options.body)), {
      grant_type: 'authorization_code', client_id: CODEX_CLIENT_ID,
      code: 'test-authorization-code', code_verifier: 'test-verifier', redirect_uri: DEVICE_REDIRECT_URI,
    });
    assert.equal(new Headers(options.headers).get('content-type'), 'application/x-www-form-urlencoded');
    return Response.json(token);
  });
  const authInteraction = interaction();
  const credential = await models.login(CODEX_PROVIDER_ID, 'oauth', authInteraction);
  return { credential, requests, copied, notifications: authInteraction.notifications };
}

test('native device login stores its credential in real Pi Models and exposes the authenticated catalog', async (t) => {
  const models = session(t);
  assert.equal(await models.checkAuth(CODEX_PROVIDER_ID), undefined);
  assert.deepEqual(await models.getAvailable(CODEX_PROVIDER_ID), []);
  const token = tokenResponse();
  const before = Date.now();
  const result = await login(t, models, token);
  assert.equal(result.requests.length, 3);
  assert.deepEqual(result.copied, [['TEST-CODE', { android: { isSensitive: true } }]]);
  assert.deepEqual(result.notifications.find(({ type }) => type === 'device_code'), {
    type: 'device_code', userCode: 'TEST-CODE', verificationUri: DEVICE_VERIFICATION_URI,
    intervalSeconds: 5, expiresInSeconds: 900,
  });
  assert.equal(result.credential.type, 'oauth');
  assert.equal(result.credential.accountId, 'test-account-initial');
  assert.equal(result.credential.refresh, token.refresh_token);
  assert.ok(result.credential.expires >= before + 3600_000);
  assert.deepEqual(await models.getAuth(CODEX_PROVIDER_ID), { auth: { apiKey: token.access_token }, source: 'OAuth' });
  assert.deepEqual(await models.checkAuth(CODEX_PROVIDER_ID), { type: 'oauth', source: 'OAuth' });
  assert.ok((await models.getAvailable(CODEX_PROVIDER_ID)).some(({ id }) => id === MODEL_ID));
});

test('concurrent Pi auth resolutions refresh once and persist the rotated native credential', async (t) => {
  const models = session(t);
  const initial = tokenResponse({ expiresIn: 60 });
  await login(t, models, initial);
  const rotated = tokenResponse({ label: 'rotated' });
  let releaseRefresh;
  const refreshGate = new Promise((resolve) => { releaseRefresh = resolve; });
  let markStarted;
  const started = new Promise((resolve) => { markStarted = resolve; });
  const fetch = t.mock.method(globalThis, 'fetch', async (url, options) => {
    assert.equal(url, CODEX_DISCOVERY.tokenEndpoint);
    assert.deepEqual(Object.fromEntries(new URLSearchParams(options.body)), {
      grant_type: 'refresh_token', client_id: CODEX_CLIENT_ID, refresh_token: initial.refresh_token,
    });
    markStarted();
    await refreshGate;
    return Response.json(rotated);
  });
  const resolutions = Array.from({ length: 8 }, () => models.getAuth(CODEX_PROVIDER_ID));
  await started;
  assert.equal(fetch.mock.callCount(), 1);
  releaseRefresh();
  for (const result of await Promise.all(resolutions)) {
    assert.deepEqual(result, { auth: { apiKey: rotated.access_token }, source: 'OAuth' });
  }
  assert.equal((await models.getAuth(CODEX_PROVIDER_ID)).auth.apiKey, rotated.access_token);
  assert.equal(fetch.mock.callCount(), 1);
});

test('failed native refresh surfaces the Pi OAuth error and preserves the credential for retry', async (t) => {
  const models = session(t);
  const initial = tokenResponse({ expiresIn: 60 });
  await login(t, models, initial);
  const fetch = t.mock.method(globalThis, 'fetch', async (url, options) => {
    assert.equal(url, CODEX_DISCOVERY.tokenEndpoint);
    assert.equal(new URLSearchParams(options.body).get('refresh_token'), initial.refresh_token);
    return Response.json({ error: 'synthetic sensitive remote detail' }, { status: 401 });
  });
  await assert.rejects(models.getAuth(CODEX_PROVIDER_ID), (error) => {
    assert.equal(error.code, 'oauth');
    assert.match(error.cause.message, /HTTP 401/);
    assert.doesNotMatch(error.cause.message, /sensitive/);
    return true;
  });
  assert.equal(fetch.mock.callCount(), 1);
  assert.deepEqual(await models.checkAuth(CODEX_PROVIDER_ID), { type: 'oauth', source: 'OAuth' });
  const rotated = tokenResponse({ label: 'retry' });
  fetch.mock.mockImplementation(async () => Response.json(rotated));
  assert.equal((await models.getAuth(CODEX_PROVIDER_ID)).auth.apiKey, rotated.access_token);
  assert.equal(fetch.mock.callCount(), 2);
});

test('real Codex SSE provider sends native OAuth bearer and account headers and completes a response', async (t) => {
  const models = session(t);
  const token = tokenResponse();
  await login(t, models, token);
  const fetch = t.mock.method(globalThis, 'fetch', async (url, options) => {
    assert.equal(url, 'https://chatgpt.com/backend-api/codex/responses');
    const headers = new Headers(options.headers);
    assert.equal(headers.get('authorization'), `Bearer ${token.access_token}`);
    assert.equal(headers.get('chatgpt-account-id'), 'test-account-initial');
    assert.equal(headers.get('accept'), 'text/event-stream');
    const events = [
      { type: 'response.created', response: { id: 'test-response' } },
      { type: 'response.output_item.added', output_index: 0, item: { id: 'test-message', type: 'message', role: 'assistant', content: [] } },
      { type: 'response.output_text.delta', output_index: 0, delta: 'Authenticated response' },
      { type: 'response.completed', response: { id: 'test-response', status: 'completed', output: [], usage: { input_tokens: 3, output_tokens: 2, total_tokens: 5 } } },
    ];
    return new Response(events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join(''), {
      headers: { 'content-type': 'text/event-stream' },
    });
  });
  const model = models.getModel(CODEX_PROVIDER_ID, MODEL_ID);
  assert.ok(model);
  const response = await models.complete(model, {
    messages: [{ role: 'user', content: 'Reply briefly.', timestamp: Date.now() }],
  }, { transport: 'sse' });
  assert.equal(response.stopReason, 'stop');
  assert.equal(response.content.find(({ type }) => type === 'text').text, 'Authenticated response');
  assert.equal(fetch.mock.callCount(), 1);
});

test('logout removes native credentials and cannot fall back to desktop environment credentials', async (t) => {
  const models = session(t);
  await login(t, models);
  const originalKey = process.env.OPENAI_API_KEY;
  process.env.OPENAI_API_KEY = 'test-desktop-key-must-not-be-used';
  t.after(() => {
    if (originalKey === undefined) delete process.env.OPENAI_API_KEY;
    else process.env.OPENAI_API_KEY = originalKey;
  });
  const fetch = t.mock.method(globalThis, 'fetch', () => { throw new Error('Logged-out sessions must not make requests'); });
  await models.logout(CODEX_PROVIDER_ID);
  assert.equal(await models.checkAuth(CODEX_PROVIDER_ID), undefined);
  assert.equal(await models.getAuth(CODEX_PROVIDER_ID), undefined);
  assert.deepEqual(await models.getAvailable(CODEX_PROVIDER_ID), []);
  const response = await models.complete(models.getModel(CODEX_PROVIDER_ID, MODEL_ID), {
    messages: [{ role: 'user', content: 'Should not send', timestamp: Date.now() }],
  }, { transport: 'sse' });
  assert.equal(response.stopReason, 'error');
  assert.match(response.errorMessage, /Provider is not configured/);
  assert.equal(fetch.mock.callCount(), 0);
  assert.equal(await session(t).getAuth(CODEX_PROVIDER_ID), undefined);
});

test('aborting device login leaves no credential stored by Pi', async (t) => {
  const models = session(t);
  const controller = new AbortController();
  let markStarted;
  const started = new Promise((resolve) => { markStarted = resolve; });
  t.mock.method(globalThis, 'fetch', async (_url, { signal }) => {
    markStarted();
    return new Promise((_, reject) => signal.addEventListener('abort', () => reject(signal.reason), { once: true }));
  });
  const pending = models.login(CODEX_PROVIDER_ID, 'oauth', interaction(controller.signal));
  const rejected = assert.rejects(pending, { name: 'AbortError' });
  await started;
  controller.abort();
  await rejected;
  assert.equal(await models.getAuth(CODEX_PROVIDER_ID), undefined);
});

test('registered-client adapter retains PKCE and exchanges the callback through real Expo builders', async (t) => {
  const devDescriptor = Object.getOwnPropertyDescriptor(globalThis, '__DEV__');
  globalThis.__DEV__ = false;
  t.after(() => {
    if (devDescriptor) Object.defineProperty(globalThis, '__DEV__', devDescriptor);
    else delete globalThis.__DEV__;
  });
  const redirectUri = 'piagent://auth/callback';
  const clientId = 'test-registered-public-client';
  let challenge;
  t.mock.method(native, 'browser', async (url, redirect) => {
    assert.equal(redirect, redirectUri);
    const query = new URL(url).searchParams;
    assert.equal(query.get('client_id'), clientId);
    assert.equal(query.get('redirect_uri'), redirectUri);
    assert.equal(query.get('response_type'), 'code');
    assert.equal(query.get('code_challenge_method'), 'S256');
    challenge = query.get('code_challenge');
    assert.ok(challenge);
    return { type: 'success', url: `${redirectUri}?code=test-code&state=${query.get('state')}` };
  });
  t.mock.method(globalThis, 'fetch', async (url, options) => {
    assert.equal(url, CODEX_DISCOVERY.tokenEndpoint);
    const body = new URLSearchParams(options.body);
    assert.equal(body.get('client_id'), clientId);
    assert.equal(body.get('code'), 'test-code');
    assert.equal(body.get('redirect_uri'), redirectUri);
    const derived = Buffer.from(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(body.get('code_verifier')))).toString('base64url');
    assert.equal(derived, challenge);
    return Response.json(tokenResponse());
  });
  const credential = await createNativeCodexOAuth({ clientId, redirectUri }).login(interaction());
  assert.equal(credential.accountId, 'test-account-initial');
});

test('a fresh native session restores saved login and the rotated token without signing in again', async (t) => {
  const models = session(t);
  const initial = tokenResponse({ expiresIn: 60 });
  await login(t, models, initial);
  const reopened = createCodexSession();
  assert.deepEqual(await reopened.checkAuth(CODEX_PROVIDER_ID), { type: 'oauth', source: 'OAuth' });
  const rotated = tokenResponse({ label: 'persisted' });
  const fetch = t.mock.method(globalThis, 'fetch', async (_url, options) => {
    assert.equal(new URLSearchParams(options.body).get('refresh_token'), initial.refresh_token);
    return Response.json(rotated);
  });
  await reopened.getAuth(CODEX_PROVIDER_ID);
  const restarted = createCodexSession();
  assert.equal((await restarted.getAuth(CODEX_PROVIDER_ID)).auth.apiKey, rotated.access_token);
  assert.equal(fetch.mock.callCount(), 1);
  await restarted.logout(CODEX_PROVIDER_ID);
  assert.equal(await createCodexSession().checkAuth(CODEX_PROVIDER_ID), undefined);
  assert.equal(native.secure.size, 0);
});

test('refresh without a replacement refresh token retains the existing refresh token durably', async (t) => {
  const models = session(t);
  const initial = tokenResponse({ expiresIn: 60 });
  await login(t, models, initial);
  const next = tokenResponse({ label: 'same-refresh' });
  delete next.refresh_token;
  t.mock.method(globalThis, 'fetch', async () => Response.json(next));
  assert.equal((await models.getAuth(CODEX_PROVIDER_ID)).auth.apiKey, next.access_token);
  const stored = JSON.parse([...native.secure.values()][0]).credential;
  assert.equal(stored.refresh, initial.refresh_token);
  assert.equal(stored.access, next.access_token);
});

test('a fully received refresh survives caller cancellation and persists before the next real Pi auth request', { timeout: 3_000 }, async (t) => {
  const models = session(t);
  const initial = tokenResponse({ expiresIn: 60 });
  await login(t, models, initial);
  const controller = new AbortController();
  const rotated = tokenResponse({ label: 'received-before-abort' });
  const fetch = t.mock.method(globalThis, 'fetch', async (_url, options) => {
    assert.equal(new URLSearchParams(options.body).get('refresh_token'), initial.refresh_token);
    return { ok: true, async json() {
      // The server's successful body is available when backgrounding cancels
      // the caller. Pi must reject that caller without losing the rotation.
      controller.abort();
      return rotated;
    } };
  });
  await assert.rejects(models.getAuth(CODEX_PROVIDER_ID, { signal: controller.signal }), { name: 'AbortError' });
  assert.equal((await models.getAuth(CODEX_PROVIDER_ID)).auth.apiKey, rotated.access_token);
  assert.equal((await createCodexSession().getAuth(CODEX_PROVIDER_ID)).auth.apiKey, rotated.access_token);
  assert.equal(fetch.mock.callCount(), 1, 'the spent refresh token is never exchanged again');
  const stored = JSON.parse([...native.secure.values()][0]).credential;
  assert.equal(stored.refresh, rotated.refresh_token);
  assert.deepEqual(Object.keys(stored).sort(), ['access', 'accountId', 'expires', 'refresh', 'type'],
    'completed-refresh identity metadata never enters native storage');
});

test('cancelling auth before refresh admission makes no token request or credential change', async (t) => {
  const models = session(t);
  await login(t, models, tokenResponse({ expiresIn: 60 }));
  const before = [...native.secure.values()];
  const controller = new AbortController();
  controller.abort();
  const fetch = t.mock.method(globalThis, 'fetch', async () => { throw new Error('Unexpected token request'); });
  await assert.rejects(models.getAuth(CODEX_PROVIDER_ID, { signal: controller.signal }), { name: 'AbortError' });
  const stored = JSON.parse(before[0]).credential;
  await assert.rejects(createNativeCodexOAuth().refresh(stored, controller.signal), { name: 'AbortError' });
  assert.equal(fetch.mock.callCount(), 0);
  assert.deepEqual([...native.secure.values()], before);
});

test('a cancelled login token response remains cancelled and cannot persist as a completed refresh', async (t) => {
  const models = session(t);
  const controller = new AbortController();
  t.mock.method(globalThis, 'fetch', async (url) => {
    if (url.endsWith('/deviceauth/usercode')) return Response.json({ device_auth_id: 'test-device', user_code: 'TEST-CODE', interval: 0 });
    if (url.endsWith('/deviceauth/token')) return Response.json({ authorization_code: 'test-code', code_verifier: 'test-verifier' });
    assert.equal(url, CODEX_DISCOVERY.tokenEndpoint);
    return { ok: true, async json() { controller.abort(); return tokenResponse(); } };
  });
  await assert.rejects(models.login(CODEX_PROVIDER_ID, 'oauth', interaction(controller.signal)), { name: 'AbortError' });
  assert.equal(await models.checkAuth(CODEX_PROVIDER_ID), undefined);
  assert.equal(native.secure.size, 0);
});

test('permanently rejected refresh clears secure credentials before Pi flattens the error', async (t) => {
  const models = session(t);
  await login(t, models, tokenResponse({ expiresIn: 60 }));
  t.mock.method(globalThis, 'fetch', async () => Response.json({ error: 'invalid_grant',
    error_description: 'test-secret-must-not-escape' }, { status: 400 }));
  const response = await models.complete(models.getModel(CODEX_PROVIDER_ID, MODEL_ID), {
    messages: [{ role: 'user', content: 'Should not reach the model', timestamp: Date.now() }],
  }, { transport: 'sse' });
  assert.equal(response.stopReason, 'error');
  assert.doesNotMatch(response.errorMessage, /test-secret/);
  assert.equal(await models.checkAuth(CODEX_PROVIDER_ID), undefined);
  assert.equal(await createCodexSession().checkAuth(CODEX_PROVIDER_ID), undefined);
  assert.equal(native.secure.size, 0);
});

test('server errors cannot force deletion with an invalid_grant-shaped body', async (t) => {
  const models = session(t);
  await login(t, models, tokenResponse({ expiresIn: 60 }));
  t.mock.method(globalThis, 'fetch', async () => Response.json({ error: 'invalid_grant' }, { status: 503 }));
  await assert.rejects(models.getAuth(CODEX_PROVIDER_ID));
  assert.deepEqual(await createCodexSession().checkAuth(CODEX_PROVIDER_ID), { type: 'oauth', source: 'OAuth' });
});

test('native credential namespaces prevent reuse across OAuth client registrations', async (t) => {
  const models = session(t);
  await login(t, models);
  process.env.EXPO_PUBLIC_CODEX_OAUTH_CLIENT_ID = 'test-different-client';
  assert.equal(await createCodexSession().checkAuth(CODEX_PROVIDER_ID), undefined);
  delete process.env.EXPO_PUBLIC_CODEX_OAUTH_CLIENT_ID;
  assert.deepEqual(await createCodexSession().checkAuth(CODEX_PROVIDER_ID), { type: 'oauth', source: 'OAuth' });
});
