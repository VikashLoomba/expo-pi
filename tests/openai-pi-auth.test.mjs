import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { registerHooks, stripTypeScriptTypes } from 'node:module';
import { dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import test from 'node:test';

// Keep real Pi Models and Expo AuthRequest/PKCE/token builders. Only native I/O
// is substituted; all HTTP requests below are intercepted with synthetic data.
globalThis.__DEV__ = false;
const expoBuild = pathToFileURL(`${dirname(fileURLToPath(import.meta.resolve('expo-auth-session')))}/`).href;
const root = new URL('../src/', import.meta.url).href;
const sources = {
  'test:modern-native': `export const native = { secure: new Map(), browser: async () => { throw new Error('not available'); },
    dismiss: () => {}, openURL: async () => true };`,
  'test:callback-module': `let callbackModule = null;
    export { callbackModule as default };
    export function setCallbackModule(value) { callbackModule = value; }`,
  'expo-secure-store': `import { native } from 'test:modern-native';
    export const WHEN_UNLOCKED_THIS_DEVICE_ONLY = 4;
    export const getItemAsync = async (key) => native.secure.get(key) ?? null;
    export const setItemAsync = async (key,value) => { native.secure.set(key,value); };
    export const deleteItemAsync = async (key) => { native.secure.delete(key); };`,
  'react-native': `export const Platform = { OS: 'ios', select: (values) => values.ios ?? values.default };`,
  'expo-clipboard': `export const setStringAsync = async () => true;`,
  'expo-linking': `import { native } from 'test:modern-native'; export const openURL = (...args) => native.openURL(...args);`,
  'expo-web-browser': `import { native } from 'test:modern-native';
    export const openAuthSessionAsync = (...args) => native.browser(...args);
    export const dismissAuthSession = () => native.dismiss();`,
  'expo-modules-core': `export class CodedError extends Error { constructor(code,message) { super(message); this.code=code; } }`,
  'expo-crypto': `export const randomUUID = () => crypto.randomUUID();
    export const getRandomValues = (value) => crypto.getRandomValues(value);
    export const CryptoDigestAlgorithm = { SHA256: 'SHA-256' };
    export const CryptoEncoding = { BASE64: 'base64', HEX: 'hex' };
    export const digestStringAsync = async (algorithm,value,options) =>
      Buffer.from(await crypto.subtle.digest(algorithm,new TextEncoder().encode(value))).toString(options.encoding);`,
  'expo-auth-session': `export { AccessTokenRequest, RefreshTokenRequest } from '${expoBuild}TokenRequest.js';
    export { AuthRequest } from '${expoBuild}AuthRequest.js';
    export { ResponseType } from '${expoBuild}AuthRequest.types.js';
    export const makeRedirectUri = ({scheme,path}) => scheme+'://'+path;`,
};
const hooks = registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier.endsWith('/modules/pi-oauth-callback/src/PiOAuthCallbackModule')) {
      return { url: 'test:module/test:callback-module', shortCircuit: true };
    }
    if (Object.hasOwn(sources, specifier)) return { url: `test:module/${specifier}`, shortCircuit: true };
    if (context.parentURL?.startsWith(root) && specifier.startsWith('.')) {
      try { return nextResolve(specifier, context); }
      catch {
        try { return nextResolve(`${specifier}.ts`, context); }
        catch { return nextResolve(`${specifier}/index.ts`, context); }
      }
    }
    if (context.parentURL?.startsWith(expoBuild) && specifier.startsWith('./') && !specifier.endsWith('.js')) {
      return { url: new URL(`${specifier}.js`, context.parentURL).href, shortCircuit: true };
    }
    const result = nextResolve(specifier, context);
    assert.ok(!/\/auth\/oauth\/openai-chatgpt\.js$/.test(result.url), 'Never load desktop Node OAuth in mobile');
    return result;
  },
  load(url, context, nextLoad) {
    if (url.startsWith('test:module/')) return { format: 'module', source: sources[url.slice(12)], shortCircuit: true };
    if (url.startsWith(root) && url.endsWith('.ts')) return { format: 'module', shortCircuit: true,
      source: stripTypeScriptTypes(readFileSync(new URL(url), 'utf8'), { mode: 'transform' }) };
    return nextLoad(url, context);
  },
});
test.after(() => hooks.deregister());
// eslint-disable-next-line import/no-unresolved -- Synthetic native boundary above.
const { native } = await import('test:modern-native');
// eslint-disable-next-line import/no-unresolved -- Synthetic optional native module above.
const { setCallbackModule } = await import('test:callback-module');
const { createChatModels, createChatCredentialStore, NEW_CHAT_DEFAULTS } = await import('../src/pi/models.ts');
const { buildModelCatalog, findCatalogModel } = await import('../src/pi/model-catalog.ts');
const { getOpenAILoginOptions } = await import('../src/pi/openai-auth/installation.ts');
const { createNativeOpenAIOAuth, openOpenAIManualBrowser } = await import('../src/pi/openai-auth/index.ts');
const { OPENAI_REDIRECT_URI, OPENAI_RESOURCE, OPENAI_DIRECT_SCOPE, OPENAI_DISCOVERY,
  validateOpenAICallback, openAICredentialFromToken } = await import('../src/pi/openai-auth/core.ts');
const id = 'cf10e79d-7d53-4e89-bf98-471257858985';
const options = { getDeviceId: () => id };
const token = (label = 'initial', expiry = 3600) => ({ access_token: `eyJ.synthetic-${label}.signature`,
  refresh_token: `synthetic-refresh-${label}`, expires_in: expiry, scope: `openid offline_access ${OPENAI_DIRECT_SCOPE}`, id_token: 'opaque-not-used-as-identity' });
const callback = (url) => `${OPENAI_REDIRECT_URI}?code=synthetic-code&state=${new URL(url).searchParams.get('state')}&client_id=oaiapp_synthetic`;
function fixture() {
  const credentials = createChatCredentialStore();
  const models = createChatModels(credentials);
  credentials.registerProviders(models.getProviders().map((p) => p.id));
  return { credentials, models };
}
test.beforeEach(() => { native.secure.clear(); setCallbackModule(null); });
function interaction(signal = new AbortController().signal, prompt = async () => { throw new Error('Unexpected manual entry'); }) {
  const events = [];
  return { signal, events, notify(event) { events.push(event); }, prompt };
}

function callbackReceiver({ ready, stopped } = {}) {
  const delivery = Promise.withResolvers();
  const started = Promise.withResolvers();
  const events = [];
  let accepted;
  let state;
  const module = {
    async start(value) { events.push('start'); state = value; started.resolve(); await ready; events.push('ready'); return 'synthetic-listener-session'; },
    waitForCallback(id) { assert.equal(id, 'synthetic-listener-session'); events.push('wait'); return delivery.promise; },
    async stop(id) {
      assert.equal(id, 'synthetic-listener-session'); events.push('stop');
      if (accepted) delivery.resolve(accepted); else delivery.reject(new Error('Listener stopped'));
      await stopped;
    },
  };
  setCallbackModule(module);
  return { module, events, started: started.promise, get state() { return state; },
    accept(url, buffered = false) { accepted = url; if (!buffered) delivery.resolve(url); },
    fail() { delivery.reject(new Error('Synthetic listener timeout')); } };
}

test('loopback receiver is ready before browser presentation and its callback dismisses Expo before token exchange', async (t) => {
  const ready = Promise.withResolvers();
  const browser = Promise.withResolvers();
  const receiver = callbackReceiver({ ready: ready.promise });
  const presented = t.mock.method(native, 'browser', async (url) => {
    receiver.events.push('browser');
    assert.equal(receiver.state, new URL(url).searchParams.get('state'));
    receiver.accept(callback(url));
    return browser.promise;
  });
  const dismiss = t.mock.method(native, 'dismiss', () => { receiver.events.push('dismiss'); browser.resolve({ type: 'dismiss' }); });
  t.mock.method(globalThis, 'fetch', async () => {
    assert.ok(receiver.events.includes('dismiss'));
    assert.ok(receiver.events.includes('stop'));
    return Response.json(token());
  });
  const login = createNativeOpenAIOAuth().login(interaction(), options);
  await receiver.started;
  assert.equal(presented.mock.callCount(), 0, 'no browser can redirect before NWListener is ready');
  ready.resolve();
  const credential = await login;
  assert.equal(credential.clientId, 'oaiapp_synthetic');
  assert.deepEqual(receiver.events, ['start', 'ready', 'wait', 'browser', 'dismiss', 'stop']);
  assert.equal(dismiss.mock.callCount(), 1);
});

test('browser dismissal cannot discard an already accepted native callback buffered on the bridge', async (t) => {
  const receiver = callbackReceiver();
  t.mock.method(native, 'browser', async (url) => {
    receiver.accept(callback(url), true);
    return { type: 'cancel' };
  });
  const dismiss = t.mock.method(native, 'dismiss', () => {});
  t.mock.method(globalThis, 'fetch', async () => Response.json(token()));
  const credential = await createNativeOpenAIOAuth().login(interaction(), options);
  assert.equal(credential.clientId, 'oaiapp_synthetic');
  assert.equal(receiver.events.filter((event) => event === 'stop').length, 1);
  assert.equal(dismiss.mock.callCount(), 0, 'an already closed browser is never dismissed again');
});

test('occupied loopback port preserves browser and SDK manual_code fallback without stopping another listener', async (t) => {
  const stop = t.mock.fn();
  setCallbackModule({ async start() { throw new Error('Synthetic port in use'); }, waitForCallback: t.mock.fn(), stop });
  let authorization;
  t.mock.method(native, 'browser', async (url) => { authorization = url; return { type: 'cancel' }; });
  t.mock.method(globalThis, 'fetch', async () => Response.json(token()));
  const auth = interaction(undefined, async (prompt) => { assert.equal(prompt.type, 'manual_code'); return callback(authorization); });
  assert.equal((await createNativeOpenAIOAuth().login(auth, options)).clientId, 'oaiapp_synthetic');
  assert.equal(stop.mock.callCount(), 0);
  assert.doesNotMatch(JSON.stringify(auth.events), /port in use/);
});

test('receiver timeout offers manual fallback after ordinary browser dismissal and releases its session', async (t) => {
  const receiver = callbackReceiver();
  const browser = Promise.withResolvers();
  const presented = Promise.withResolvers();
  let authorization;
  t.mock.method(native, 'browser', async (url) => { authorization = url; presented.resolve(); return browser.promise; });
  const dismiss = t.mock.method(native, 'dismiss', () => {});
  t.mock.method(globalThis, 'fetch', async () => Response.json(token()));
  let prompts = 0;
  const auth = interaction(undefined, async (prompt) => { prompts++; assert.equal(prompt.type, 'manual_code'); return callback(authorization); });
  const login = createNativeOpenAIOAuth().login(auth, options);
  await presented.promise;
  receiver.fail();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(prompts, 0, 'manual entry must not appear behind the still open browser');
  assert.equal(dismiss.mock.callCount(), 0);
  browser.resolve({ type: 'cancel' });
  await login;
  assert.equal(prompts, 1);
  assert.equal(receiver.events.filter((event) => event === 'stop').length, 1);
});

test('explicit cancellation stops and awaits the receiver, dismisses Expo, and never exchanges a late callback', async (t) => {
  const closed = Promise.withResolvers();
  const receiver = callbackReceiver({ stopped: closed.promise });
  const browser = Promise.withResolvers();
  const presented = Promise.withResolvers();
  let authorization;
  t.mock.method(native, 'browser', async (url) => { authorization = url; presented.resolve(); return browser.promise; });
  const dismiss = t.mock.method(native, 'dismiss', () => browser.resolve({ type: 'dismiss' }));
  const fetch = t.mock.method(globalThis, 'fetch', async () => { throw new Error('No token request after cancellation'); });
  const controller = new AbortController();
  let settled = false;
  const login = createNativeOpenAIOAuth().login(interaction(controller.signal), options).finally(() => { settled = true; });
  const rejected = assert.rejects(login, { name: 'AbortError' });
  await presented.promise;
  controller.abort();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(settled, false, 'adapter cleanup awaits native listener disposal');
  assert.equal(receiver.events.filter((event) => event === 'stop').length, 1);
  receiver.accept(callback(authorization));
  closed.resolve();
  await rejected;
  assert.equal(fetch.mock.callCount(), 0);
  assert.equal(dismiss.mock.callCount(), 1);
});

test('locked Expo browser is an explicit error and listener cleanup never dismisses another session', async (t) => {
  const receiver = callbackReceiver();
  // Expo AuthRequest maps WebBrowser results; its own locked result must be
  // simulated at the request boundary to exercise the ownership rule.
  const { AuthRequest } = await import('expo-auth-session');
  t.mock.method(AuthRequest.prototype, 'promptAsync', async () => ({ type: 'locked' }));
  const dismiss = t.mock.method(native, 'dismiss', () => {});
  const fetch = t.mock.method(globalThis, 'fetch', async () => { throw new Error('No token exchange'); });
  await assert.rejects(createNativeOpenAIOAuth().login(interaction(), options), /Another sign-in browser/);
  assert.equal(receiver.events.filter((event) => event === 'stop').length, 1);
  assert.equal(dismiss.mock.callCount(), 0);
  assert.equal(fetch.mock.callCount(), 0);
});

test('cancellation while native start is pending cleans up the eventual session without opening a browser', async (t) => {
  const ready = Promise.withResolvers();
  const receiver = callbackReceiver({ ready: ready.promise });
  const browser = t.mock.method(native, 'browser', async () => { throw new Error('Browser must not open'); });
  const dismiss = t.mock.method(native, 'dismiss', () => {});
  const controller = new AbortController();
  const login = createNativeOpenAIOAuth().login(interaction(controller.signal), options);
  const rejected = assert.rejects(login, { name: 'AbortError' });
  await receiver.started;
  assert.deepEqual(receiver.events, ['start']);
  controller.abort();
  ready.resolve();
  await rejected;
  assert.deepEqual(receiver.events, ['start', 'ready', 'wait', 'stop']);
  assert.equal(browser.mock.callCount(), 0);
  assert.equal(dismiss.mock.callCount(), 0);
});

test('a native callback cannot start token exchange until Expo has released its previous auth session', async (t) => {
  const receiver = callbackReceiver();
  const browser = Promise.withResolvers();
  const dismissed = Promise.withResolvers();
  t.mock.method(native, 'browser', async (url) => { receiver.accept(callback(url)); return browser.promise; });
  t.mock.method(native, 'dismiss', () => { dismissed.resolve(); });
  const fetch = t.mock.method(globalThis, 'fetch', async () => Response.json(token()));
  const login = createNativeOpenAIOAuth().login(interaction(), options);
  await dismissed.promise;
  assert.equal(fetch.mock.callCount(), 0);
  await assert.rejects(createNativeOpenAIOAuth().login(interaction(), options), /already open/);
  browser.resolve({ type: 'dismiss' });
  await login;
  assert.equal(fetch.mock.callCount(), 1);
});

test('real Pi login persists an Expo PKCE grant with issued client ID and keeps API-key auth available', async (t) => {
  const { models, credentials } = fixture();
  let challenge;
  t.mock.method(native, 'browser', async (url, redirect) => {
    const query = new URL(url).searchParams;
    assert.equal(redirect, OPENAI_REDIRECT_URI);
    assert.equal(query.get('client_id'), 'dynamic_agent_client');
    assert.equal(query.get('resource'), OPENAI_RESOURCE);
    assert.equal(query.get('ext_agent_host_id'), `urn:uuid:${id}`);
    assert.ok(query.get('scope').split(' ').includes(OPENAI_DIRECT_SCOPE));
    assert.equal(query.get('code_challenge_method'), 'S256');
    assert.ok(query.get('nonce'));
    challenge = query.get('code_challenge');
    return { type: 'success', url: callback(url) };
  });
  t.mock.method(globalThis, 'fetch', async (url, init) => {
    assert.equal(url, OPENAI_DISCOVERY.tokenEndpoint);
    const body = new URLSearchParams(init.body);
    assert.equal(body.get('client_id'), 'oaiapp_synthetic');
    assert.equal(body.get('resource'), OPENAI_RESOURCE);
    assert.equal(body.get('redirect_uri'), OPENAI_REDIRECT_URI);
    assert.equal(body.get('grant_type'), 'authorization_code');
    const derived = Buffer.from(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(body.get('code_verifier')))).toString('base64url');
    assert.equal(derived, challenge);
    return Response.json(token());
  });
  await models.login('openai', 'oauth', interaction(), options);
  assert.deepEqual(await models.checkAuth('openai'), { type: 'oauth', source: 'OAuth' });
  assert.ok(models.getProvider('openai').auth.apiKey);
  assert.equal((await credentials.read('openai')).clientId, 'oaiapp_synthetic');
  assert.equal((await fixture().models.getAuth('openai')).auth.apiKey, token().access_token);
});

for (const failure of ['throw', 'cancel', 'dismiss']) test(`browser ${failure} falls back to Pi manual_code with the same Expo transaction`, async (t) => {
  let authUrl;
  t.mock.method(native, 'browser', async (url) => { authUrl = url; if (failure === 'throw') throw new Error('native private detail'); return { type: failure }; });
  t.mock.method(globalThis, 'fetch', async () => Response.json(token()));
  const auth = interaction(undefined, async (prompt) => {
    assert.equal(prompt.type, 'manual_code');
    assert.equal(prompt.placeholder, OPENAI_REDIRECT_URI);
    assert.ok(prompt.signal instanceof AbortSignal);
    return callback(authUrl);
  });
  const result = await createNativeOpenAIOAuth().login(auth, options);
  assert.equal(result.clientId, 'oaiapp_synthetic');
  assert.doesNotMatch(JSON.stringify(auth.events), /native private detail/);
});

test('forged browser callback is rejected without token exchange or manual downgrade', async (t) => {
  t.mock.method(native, 'browser', async (url) => ({ type: 'success', url: callback(url).replace('state=', 'state=forged') }));
  const fetch = t.mock.method(globalThis, 'fetch', async () => { throw new Error('Unexpected request'); });
  await assert.rejects(createNativeOpenAIOAuth().login(interaction(), options), /different attempt/);
  assert.equal(fetch.mock.callCount(), 0);
});

test('explicit cancellation dismisses native auth without entering manual fallback or replacing a saved API key', async (t) => {
  const { models, credentials } = fixture();
  await credentials.replaceApiKey('openai', 'previous-key');
  const controller = new AbortController();
  let finish;
  let started;
  const ready = new Promise((resolve) => { started = resolve; });
  t.mock.method(native, 'browser', () => new Promise((resolve) => { finish = resolve; started(); }));
  const dismiss = t.mock.method(native, 'dismiss', () => finish({ type: 'dismiss' }));
  const pending = models.login('openai', 'oauth', interaction(controller.signal), options);
  const rejected = assert.rejects(pending, { name: 'AbortError' });
  await ready;
  controller.abort();
  await rejected;
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(dismiss.mock.callCount(), 1);
  assert.deepEqual(await credentials.read('openai'), { type: 'api_key', key: 'previous-key' });
});

test('real Pi serializes modern refresh and persists new client/scopes while keeping other providers', async (t) => {
  const { models, credentials } = fixture();
  await credentials.replaceApiKey('anthropic', 'synthetic-anthropic-key');
  await credentials.modify('openai', async () => openAICredentialFromToken(token('old', 1), 'oaiapp_synthetic'));
  const fetch = t.mock.method(globalThis, 'fetch', async (url, init) => {
    assert.equal(url, OPENAI_DISCOVERY.tokenEndpoint);
    assert.deepEqual(Object.fromEntries(new URLSearchParams(init.body)), { grant_type: 'refresh_token', client_id: 'oaiapp_synthetic', refresh_token: 'synthetic-refresh-old', resource: OPENAI_RESOURCE });
    return Response.json(token('new'));
  });
  const results = await Promise.all(Array.from({ length: 8 }, () => models.getAuth('openai')));
  assert.equal(fetch.mock.callCount(), 1);
  assert.ok(results.every((result) => result.auth.apiKey === token('new').access_token));
  assert.equal((await fixture().credentials.read('openai')).refresh, token('new').refresh_token);
  await models.logout('openai');
  assert.equal((await credentials.read('anthropic')).key, 'synthetic-anthropic-key');
});

test('a completed modern refresh survives caller cancellation and the next request uses its rotation', async (t) => {
  const { models, credentials } = fixture();
  await credentials.modify('openai', async () => openAICredentialFromToken(token('old', 1), 'oaiapp_synthetic'));
  const controller = new AbortController();
  const fetch = t.mock.method(globalThis, 'fetch', async () => ({ ok: true, async json() { controller.abort(); return token('new'); } }));
  await assert.rejects(models.getAuth('openai', { signal: controller.signal }), { name: 'AbortError' });
  assert.equal((await models.getAuth('openai')).auth.apiKey, token('new').access_token);
  assert.equal(fetch.mock.callCount(), 1);
});

test('refresh invalid_grant disconnects only modern OpenAI and never leaks the response body', async (t) => {
  const { models, credentials } = fixture();
  await credentials.modify('openai', async () => openAICredentialFromToken(token('old', 1), 'oaiapp_synthetic'));
  t.mock.method(globalThis, 'fetch', async () => Response.json({ error: 'invalid_grant', error_description: 'sensitive-value' }, { status: 400 }));
  await assert.rejects(models.getAuth('openai'), (error) => { assert.doesNotMatch(String(error.cause), /sensitive-value/); return true; });
  assert.equal(await credentials.read('openai'), undefined);
});

test('modern Responses adapter uses the stored subscription access token and SDK request constraints', async (t) => {
  const { models, credentials } = fixture();
  await credentials.modify('openai', async () => openAICredentialFromToken(token(), 'oaiapp_synthetic'));
  const fetch = t.mock.method(globalThis, 'fetch', async (url, init) => {
    assert.equal(url, 'https://api.openai.com/v1/responses');
    const headers = new Headers(init.headers);
    assert.equal(headers.get('authorization'), `Bearer ${token().access_token}`);
    assert.equal(headers.get('chatgpt-account-id'), null);
    const body = JSON.parse(init.body);
    assert.equal(body.store, false); assert.equal(body.stream, true);
    assert.equal(body.max_output_tokens, undefined); assert.equal(body.temperature, undefined);
    return new Response('data: '+JSON.stringify({ type:'response.completed', response:{id:'test',status:'completed',output:[],usage:{input_tokens:1,output_tokens:0,total_tokens:1}} })+'\n\n', {headers:{'content-type':'text/event-stream'}});
  });
  const model = models.getModels('openai').find((m) => m.id === 'gpt-6-sol');
  assert.ok(model);
  const result = await models.complete(model, { messages: [{ role:'user',content:'Synthetic request',timestamp:Date.now() }] }, { transport:'sse',maxTokens:100,temperature:0.2 });
  assert.equal(result.stopReason, 'stop');
  assert.equal(fetch.mock.callCount(), 1);
});

test('strict manual callback validation rejects wrong routes, duplicate fields, errors and legacy/missing client IDs', () => {
  const good = `${OPENAI_REDIRECT_URI}?code=synthetic&state=expected&client_id=oaiapp_test`;
  assert.deepEqual(validateOpenAICallback(good, 'expected'), { code:'synthetic',clientId:'oaiapp_test' });
  for (const value of [good.replace('127.0.0.1','localhost'),good.replace('1455','1456'),good.replace('/auth/callback','/other'),
    `${good}#fragment`,`${good}&state=expected`,`${good}&code=other`,`${good}&client_id=other`,`${good}&error=access_denied`,
    good.replace('&client_id=oaiapp_test',''),good.replace('oaiapp_test','dynamic_agent_client'),good.replace('state=expected','state=stale')]) {
    assert.throws(() => validateOpenAICallback(value,'expected'));
  }
});

test('scope and token response validation never accepts legacy or malformed grants', () => {
  for (const fields of [{scope:'openid offline_access'}, {access_token:''}, {refresh_token:''}, {expires_in:Infinity}, {id_token:''}]) {
    assert.throws(() => openAICredentialFromToken({...token(),...fields},'oaiapp_test'));
  }
  const previous = openAICredentialFromToken(token(),'oaiapp_test');
  const refreshed = token('next'); delete refreshed.refresh_token; delete refreshed.scope; delete refreshed.id_token;
  assert.equal(openAICredentialFromToken(refreshed,'oaiapp_test',previous).refresh,previous.refresh);
});

test('manual browser action accepts only the modern authorization endpoint and exact redirect', async (t) => {
  const open = t.mock.method(native,'openURL',async () => true);
  const url = `${OPENAI_DISCOVERY.authorizationEndpoint}?redirect_uri=${encodeURIComponent(OPENAI_REDIRECT_URI)}`;
  await openOpenAIManualBrowser(url,new AbortController().signal);
  for (const value of [url.replace('auth.openai.com','evil.example'),url.replace('authorize','other'),`${url}#fragment`]) {
    await assert.rejects(openOpenAIManualBrowser(value,new AbortController().signal));
  }
  assert.equal(open.mock.callCount(),1);
});

test('registered providers ignore credentials in the process environment', async (t) => {
  const names = ['ANTHROPIC_API_KEY', 'OPENAI_API_KEY'];
  const saved = names.map((name) => [name, process.env[name]]);
  t.after(() => {
    for (const [name, value] of saved) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  });
  for (const name of names) process.env[name] = `synthetic-env-${name}`;
  const { models } = fixture();
  assert.equal(await models.checkAuth('anthropic'), undefined);
  assert.equal(await models.getAuth('openai'), undefined);
});

test('every new-chat default is a registered model with a supported reasoning setting', () => {
  const catalog = buildModelCatalog(fixture().models);
  for (const [provider, modelId] of Object.entries(NEW_CHAT_DEFAULTS.models)) {
    assert.ok(findCatalogModel(catalog, { provider, modelId })?.thinkingLevels.length, `${provider}/${modelId}`);
  }
});

test('concurrent initialization returns one durably saved installation UUID', async () => {
  const values = await Promise.all(Array.from({length:8},() => getOpenAILoginOptions()));
  assert.equal(new Set(values.map((value) => value.getDeviceId())).size,1);
  assert.equal(native.secure.get('pi.openai.host.v1'),values[0].getDeviceId());
});
