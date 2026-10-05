import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { registerHooks, stripTypeScriptTypes } from 'node:module';
import test from 'node:test';
import { createModels } from '@earendil-works/pi-ai';
import { openaiCodexProvider } from '@earendil-works/pi-ai/providers/openai-codex';

const sourceRoot = new URL('../src/pi/codex-auth/', import.meta.url).href;
const secureStoreSource = `
  export const calls = [];
  export const values = new Map();
  export const WHEN_UNLOCKED_THIS_DEVICE_ONLY = 4;
  export const getItemAsync = async (key, options) => { calls.push({ operation: 'get', key, options }); return values.get(key) ?? null; };
  export const setItemAsync = async (key, value, options) => { calls.push({ operation: 'set', key, options }); values.set(key, value); };
  export const deleteItemAsync = async (key, options) => { calls.push({ operation: 'delete', key, options }); values.delete(key); };
`;
const hooks = registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier === 'expo-secure-store' || specifier === 'test:credential-secure-store') {
      return { url: 'test:credential-secure-store', shortCircuit: true };
    }
    if (context.parentURL?.startsWith(sourceRoot) && specifier.startsWith('.') && !specifier.endsWith('.ts')) {
      return nextResolve(`${specifier}.ts`, context);
    }
    return nextResolve(specifier, context);
  },
  load(url, context, nextLoad) {
    if (url === 'test:credential-secure-store') return { shortCircuit: true, format: 'module', source: secureStoreSource };
    if (url.startsWith(sourceRoot) && url.endsWith('.ts')) {
      return { shortCircuit: true, format: 'module', source: stripTypeScriptTypes(readFileSync(new URL(url), 'utf8'), {
        mode: 'transform', sourceMap: false, sourceUrl: url,
      }) };
    }
    return nextLoad(url, context);
  },
});
const { ObservableCredentialStore } = await import('../src/pi/codex-auth/credential-store.ts');
const { CodexTokenRequestError } = await import('../src/pi/codex-auth/core.ts');
const { createCodexCredentialStore, credentialStorageKey } = await import('../src/pi/codex-auth/credential-storage.ts');
// eslint-disable-next-line import/no-unresolved -- The native SecureStore boundary is supplied by this test's module hook.
const secureStore = await import('test:credential-secure-store');
hooks.deregister();

const providerId = 'openai-codex';
const credential = (label, expires = Date.now() + 3_600_000) => ({
  type: 'oauth', access: `synthetic-access-${label}`, refresh: `synthetic-refresh-${label}`,
  accountId: `synthetic-account-${label}`, expires,
});
const turn = () => new Promise((resolve) => setImmediate(resolve));
const isAbort = (error) => error.name === 'AbortError';

function backend() {
  const values = new Map();
  const events = [];
  return {
    values, events,
    async getItemAsync(key) { events.push(['get', key]); return values.get(key) ?? null; },
    async setItemAsync(key, value) { events.push(['set', key]); values.set(key, value); },
    async deleteItemAsync(key) { events.push(['delete', key]); values.delete(key); },
  };
}

function assertSanitized(error) {
  for (let current = error, depth = 0; current && depth < 8; current = current.cause, depth++) {
    assert.doesNotMatch(`${current.message}\n${current.stack}\n${JSON.stringify(current)}`, /synthetic-secret|synthetic-access|synthetic-refresh/);
  }
  return true;
}

test('OAuth credentials survive a fresh store instance, list metadata only, and delete durably', async () => {
  const native = backend();
  const first = new ObservableCredentialStore(native);
  const saved = credential('restart');
  assert.equal(await first.read(providerId), undefined);
  assert.deepEqual(await first.list(), []);
  assert.deepEqual(await first.modify(providerId, async () => saved), saved);
  const reopened = new ObservableCredentialStore(native);
  assert.deepEqual(await reopened.read(providerId), saved);
  assert.deepEqual(await reopened.list(), [{ providerId, type: 'oauth' }]);
  await reopened.delete(providerId);
  assert.equal(await new ObservableCredentialStore(native).read(providerId), undefined);
});

test('undefined from a modifier preserves the current credential without a persistence write', async () => {
  const native = backend();
  const store = new ObservableCredentialStore(native);
  const saved = credential('unchanged');
  await store.modify(providerId, async () => saved);
  const writes = native.events.filter(([operation]) => operation === 'set').length;
  assert.deepEqual(await store.modify(providerId, async (current) => {
    assert.deepEqual(current, saved);
    return undefined;
  }), saved);
  assert.equal(native.events.filter(([operation]) => operation === 'set').length, writes);
  assert.deepEqual(await store.read(providerId), saved);
});

test('asynchronous modifications serialize and each sees its predecessor’s committed credential', { timeout: 3_000 }, async (t) => {
  const native = backend();
  const store = new ObservableCredentialStore(native);
  await store.modify(providerId, async () => credential('initial'));
  const gate = Promise.withResolvers();
  const started = Promise.withResolvers();
  t.after(() => gate.resolve());
  const first = store.modify(providerId, async (current) => {
    assert.equal(current.refresh, 'synthetic-refresh-initial');
    started.resolve();
    await gate.promise;
    return credential('first');
  });
  await started.promise;
  let secondStarted = false;
  const second = store.modify(providerId, async (current) => {
    secondStarted = true;
    assert.equal(current.refresh, 'synthetic-refresh-first');
    return credential('second');
  });
  await turn();
  assert.equal(secondStarted, false);
  gate.resolve();
  await Promise.all([first, second]);
  assert.equal((await new ObservableCredentialStore(native).read(providerId)).refresh, 'synthetic-refresh-second');
});

test('logout waits for an active refresh and its deletion cannot be undone by that refresh', { timeout: 3_000 }, async (t) => {
  const native = backend();
  const store = new ObservableCredentialStore(native);
  await store.modify(providerId, async () => credential('initial'));
  const started = Promise.withResolvers();
  const gate = Promise.withResolvers();
  t.after(() => gate.resolve());
  const refresh = store.modify(providerId, async () => {
    started.resolve(); await gate.promise; return credential('rotated');
  });
  await started.promise;
  const logout = store.delete(providerId);
  await turn();
  assert.equal(native.events.some(([operation]) => operation === 'delete'), false);
  gate.resolve();
  await Promise.all([refresh, logout]);
  assert.equal(await store.read(providerId), undefined);
  assert.equal(await new ObservableCredentialStore(native).read(providerId), undefined);
});

test('pre-aborted operations never touch storage or invoke a modifier', async () => {
  const native = backend();
  const store = new ObservableCredentialStore(native);
  const controller = new AbortController();
  controller.abort();
  const options = { signal: controller.signal };
  let modified = false;
  await assert.rejects(store.read(providerId, options), isAbort);
  await assert.rejects(store.list(options), isAbort);
  await assert.rejects(store.modify(providerId, async () => { modified = true; return credential('wrong'); }, options), isAbort);
  await assert.rejects(store.delete(providerId, options), isAbort);
  assert.equal(modified, false);
  assert.deepEqual(native.events, []);
});

test('a queued abort rejects promptly, skips its modifier, and leaves the queue usable', { timeout: 3_000 }, async (t) => {
  const native = backend();
  const store = new ObservableCredentialStore(native);
  const started = Promise.withResolvers();
  const gate = Promise.withResolvers();
  t.after(() => gate.resolve());
  const active = store.modify(providerId, async () => { started.resolve(); await gate.promise; return credential('active'); });
  await started.promise;
  const controller = new AbortController();
  let abortedModifierRan = false;
  const cancelled = store.modify(providerId, async () => { abortedModifierRan = true; return credential('wrong'); }, { signal: controller.signal });
  const rejection = assert.rejects(cancelled, isAbort);
  controller.abort();
  await rejection;
  gate.resolve();
  await active;
  assert.equal(abortedModifierRan, false);
  await store.modify(providerId, async () => credential('after-abort'));
  assert.equal((await store.read(providerId)).refresh, 'synthetic-refresh-after-abort');
});

test('aborting an active modifier does not release its queue until the callback settles or persist its result', { timeout: 3_000 }, async (t) => {
  const native = backend();
  const store = new ObservableCredentialStore(native);
  await store.modify(providerId, async () => credential('before'));
  const started = Promise.withResolvers();
  const gate = Promise.withResolvers();
  t.after(() => gate.resolve());
  const controller = new AbortController();
  const active = store.modify(providerId, async () => { started.resolve(); await gate.promise; return credential('wrong'); }, { signal: controller.signal });
  const rejection = assert.rejects(active, isAbort);
  await started.promise;
  controller.abort();
  await rejection;
  let nextStarted = false;
  const next = store.modify(providerId, async (current) => {
    nextStarted = true;
    assert.equal(current.refresh, 'synthetic-refresh-before');
    return credential('after');
  });
  await turn();
  assert.equal(nextStarted, false);
  gate.resolve();
  await next;
  assert.equal((await new ObservableCredentialStore(native).read(providerId)).refresh, 'synthetic-refresh-after');
});

test('read, write, and deletion failures expose sanitized errors and do not claim persistence succeeded', async () => {
  const native = backend();
  const store = new ObservableCredentialStore(native);
  const saved = credential('kept');
  await store.modify(providerId, async () => saved);
  const pending = credential('pending-save');
  const originalWrite = native.setItemAsync;
  native.setItemAsync = async () => { throw new Error('synthetic-secret secure-store write details'); };
  await assert.rejects(store.modify(providerId, async () => pending), assertSanitized);
  await assert.rejects(store.read(providerId), assertSanitized, 'never expose an old token while a replacement is waiting to persist');
  assert.deepEqual(await new ObservableCredentialStore(native).read(providerId), saved);
  native.setItemAsync = originalWrite;
  await store.restore();
  assert.deepEqual(await store.read(providerId), pending);
  assert.deepEqual(await new ObservableCredentialStore(native).read(providerId), pending);
  const originalDelete = native.deleteItemAsync;
  native.deleteItemAsync = async () => { throw new Error('synthetic-secret keychain deletion details'); };
  await assert.rejects(store.delete(providerId), assertSanitized);
  assert.deepEqual(await store.read(providerId), pending);
  assert.deepEqual(await new ObservableCredentialStore(native).read(providerId), pending);
  native.deleteItemAsync = originalDelete;
  native.getItemAsync = async () => { throw new Error('synthetic-secret keychain read details'); };
  await assert.rejects(new ObservableCredentialStore(native).read(providerId), assertSanitized);
});

test('a failed modifier propagates its error, leaves stored credentials intact, and does not poison later writes', async () => {
  const native = backend();
  const store = new ObservableCredentialStore(native);
  const saved = credential('kept');
  await store.modify(providerId, async () => saved);
  const failure = new Error('Synthetic refresh is temporarily unavailable.');
  await assert.rejects(store.modify(providerId, async () => { throw failure; }), (error) => error === failure);
  assert.deepEqual(await new ObservableCredentialStore(native).read(providerId), saved);
  await store.modify(providerId, async () => credential('recovered'));
  assert.equal((await store.read(providerId)).refresh, 'synthetic-refresh-recovered');
});

test('real Pi concurrent auth requests refresh once and a new store instance sees the rotated credential', { timeout: 3_000 }, async (t) => {
  const native = backend();
  const store = new ObservableCredentialStore(native);
  await store.modify(providerId, async () => credential('expired', Date.now() - 1_000));
  const models = createModels({ credentials: store,
    authContext: { env: async () => undefined, fileExists: async () => false } });
  const gate = Promise.withResolvers();
  const started = Promise.withResolvers();
  t.after(() => gate.resolve());
  let refreshCalls = 0;
  models.setProvider({ ...openaiCodexProvider(), auth: { oauth: {
    name: 'Synthetic OAuth', login: async () => credential('login'),
    refresh: async (current) => {
      refreshCalls++;
      assert.equal(current.refresh, 'synthetic-refresh-expired');
      started.resolve(); await gate.promise;
      return credential('rotated');
    },
    toAuth: async (current) => ({ apiKey: current.access }),
  } } });
  const resolutions = Array.from({ length: 8 }, () => models.getAuth(providerId));
  await started.promise;
  assert.equal(refreshCalls, 1);
  gate.resolve();
  for (const result of await Promise.all(resolutions)) assert.equal(result.auth.apiKey, 'synthetic-access-rotated');
  assert.equal(refreshCalls, 1);
  assert.equal((await new ObservableCredentialStore(native).read(providerId)).refresh, 'synthetic-refresh-rotated');
});

test('real Pi retries persistence of an already rotated token without refreshing the spent token again', async () => {
  const native = backend();
  const store = new ObservableCredentialStore(native);
  await store.modify(providerId, async () => credential('spent', Date.now() - 1_000));
  const models = createModels({ credentials: store,
    authContext: { env: async () => undefined, fileExists: async () => false } });
  let refreshCalls = 0;
  models.setProvider({ ...openaiCodexProvider(), auth: { oauth: {
    name: 'Synthetic OAuth', login: async () => credential('login'),
    refresh: async (current) => {
      refreshCalls++;
      assert.equal(current.refresh, 'synthetic-refresh-spent');
      assert.equal(refreshCalls, 1, 'the old refresh token was consumed by its first successful exchange');
      return credential('retained-rotation');
    },
    toAuth: async (current) => ({ apiKey: current.access }),
  } } });
  const write = native.setItemAsync;
  native.setItemAsync = async () => { throw new Error('synthetic-secret Keychain temporarily unavailable'); };
  await assert.rejects(models.getAuth(providerId), assertSanitized);
  assert.equal(refreshCalls, 1);
  await assert.rejects(models.getAuth(providerId), assertSanitized);
  assert.equal(refreshCalls, 1, 'another auth attempt retries storage instead of the OAuth endpoint');
  native.setItemAsync = write;
  assert.equal((await models.getAuth(providerId)).auth.apiKey, 'synthetic-access-retained-rotation');
  assert.equal(refreshCalls, 1);
  assert.equal((await new ObservableCredentialStore(native).read(providerId)).refresh, 'synthetic-refresh-retained-rotation');
  assert.deepEqual(store.getSnapshot(), { ready: true, signedIn: true });
});

test('successful logout discards a pending token so a later storage recovery cannot resurrect sign-in', async () => {
  const native = backend();
  const store = new ObservableCredentialStore(native);
  await store.modify(providerId, async () => credential('before'));
  const write = native.setItemAsync;
  native.setItemAsync = async () => { throw new Error('synthetic-secret failed write'); };
  await assert.rejects(store.modify(providerId, async () => credential('pending')), assertSanitized);
  await store.delete(providerId);
  native.setItemAsync = write;
  await store.restore();
  assert.equal(await store.read(providerId), undefined);
  assert.equal(await new ObservableCredentialStore(native).read(providerId), undefined);
  assert.deepEqual(store.getSnapshot(), { ready: true, signedIn: false });
});

test('observable account state changes only after durable writes and retains its identity across token rotation', { timeout: 3_000 }, async (t) => {
  const native = backend();
  const store = new ObservableCredentialStore(native);
  assert.deepEqual(store.getSnapshot(), { ready: false, signedIn: false });
  const observed = [];
  const unsubscribe = store.subscribe(() => observed.push(store.getSnapshot()));
  t.after(unsubscribe);
  await store.restore();
  assert.deepEqual(store.getSnapshot(), { ready: true, signedIn: false });
  const gate = Promise.withResolvers();
  const started = Promise.withResolvers();
  t.after(() => gate.resolve());
  const write = native.setItemAsync;
  native.setItemAsync = async (...args) => { started.resolve(); await gate.promise; await write(...args); };
  const saving = store.modify(providerId, async () => credential('saved'));
  await started.promise;
  assert.equal(store.getSnapshot().signedIn, false, 'pending native persistence does not claim sign-in succeeded');
  gate.resolve();
  await saving;
  const signedIn = store.getSnapshot();
  assert.deepEqual(signedIn, { ready: true, signedIn: true });
  native.setItemAsync = write;
  await store.modify(providerId, async () => credential('rotation'));
  assert.equal(store.getSnapshot(), signedIn, 'secret-only rotation does not rerender account subscribers');
  assert.deepEqual(observed, [{ ready: true, signedIn: false }, { ready: true, signedIn: true }]);
  assert.doesNotMatch(JSON.stringify(observed), /synthetic-access|synthetic-refresh/);
  unsubscribe();
  await store.delete(providerId);
  assert.equal(observed.length, 2);
});

test('abort during a native write preserves queue ownership until commit and a following logout wins', { timeout: 3_000 }, async (t) => {
  const native = backend();
  const store = new ObservableCredentialStore(native);
  await store.modify(providerId, async () => credential('initial'));
  const gate = Promise.withResolvers();
  const started = Promise.withResolvers();
  t.after(() => gate.resolve());
  const write = native.setItemAsync;
  native.setItemAsync = async (...args) => { started.resolve(); await gate.promise; await write(...args); };
  const controller = new AbortController();
  const pending = store.modify(providerId, async () => credential('committing'), { signal: controller.signal });
  const rejected = assert.rejects(pending, isAbort);
  await started.promise;
  controller.abort();
  await rejected;
  const deleting = store.delete(providerId);
  await turn();
  assert.equal(native.events.some(([operation]) => operation === 'delete'), false);
  gate.resolve();
  await deleting;
  assert.equal(store.getSnapshot().signedIn, false);
  assert.equal(await new ObservableCredentialStore(native).read(providerId), undefined);
});

test('corrupt and unsupported persisted records are removed and show a sanitized signed-out notice', async () => {
  const cases = [
    '{ synthetic-secret invalid JSON',
    JSON.stringify({ version: 99, credential: credential('wrong-version') }),
    JSON.stringify({ version: 1, credential: { type: 'oauth', access: 'synthetic-secret', refresh: 'synthetic-secret', expires: null, accountId: 'account' } }),
    JSON.stringify({ version: 1, credential: { ...credential('missing-account'), accountId: '' } }),
  ];
  for (const raw of cases) {
    const native = backend();
    native.values.set('corruption-test', raw);
    const store = new ObservableCredentialStore(native, 'corruption-test');
    assert.equal(await store.read(providerId), undefined);
    assert.equal(native.values.size, 0);
    assert.equal(store.getSnapshot().ready, true);
    assert.equal(store.getSnapshot().signedIn, false);
    assert.match(store.getSnapshot().error, /sign in again/i);
    assert.doesNotMatch(JSON.stringify(store.getSnapshot()), /synthetic-secret|synthetic-access|synthetic-refresh/);
    await store.modify(providerId, async () => credential('new-login'));
    assert.deepEqual(store.getSnapshot(), { ready: true, signedIn: true });
  }
});

test('failed corrupt-record deletion stays retryable and force restore observes storage changes', async () => {
  const native = backend();
  native.values.set('retry-test', 'synthetic-secret corrupt JSON');
  const remove = native.deleteItemAsync;
  native.deleteItemAsync = async () => { throw new Error('synthetic-secret delete failure'); };
  const store = new ObservableCredentialStore(native, 'retry-test');
  await assert.rejects(store.restore(), assertSanitized);
  assert.equal(native.values.size, 1);
  native.deleteItemAsync = remove;
  await store.restore();
  assert.equal(native.values.size, 0);
  await store.modify(providerId, async () => credential('persisted'));
  native.values.delete('retry-test');
  await store.restore();
  assert.deepEqual(store.getSnapshot(), { ready: true, signedIn: false });
});

test('failed restore does not cache missing credentials and succeeds after the backend becomes available', async () => {
  const native = backend();
  await new ObservableCredentialStore(native).modify(providerId, async () => credential('available-later'));
  const read = native.getItemAsync;
  native.getItemAsync = async () => { throw new Error('synthetic-secret temporarily locked'); };
  const store = new ObservableCredentialStore(native);
  await assert.rejects(store.restore(), assertSanitized);
  assert.equal(store.getSnapshot().signedIn, false);
  native.getItemAsync = read;
  await store.restore();
  assert.deepEqual(store.getSnapshot(), { ready: true, signedIn: true });
  assert.equal((await store.read(providerId)).refresh, 'synthetic-refresh-available-later');
});

test('namespaces isolate credentials and unsupported provider reads do not touch Codex storage', async () => {
  const native = backend();
  const first = new ObservableCredentialStore(native, 'namespace-one');
  const second = new ObservableCredentialStore(native, 'namespace-two');
  assert.equal(await first.read('another-provider'), undefined);
  await first.delete('another-provider');
  await assert.rejects(first.modify('another-provider', async () => credential('wrong')), /ChatGPT sign-in only/);
  assert.deepEqual(native.events, []);
  await first.modify(providerId, async () => credential('first'));
  await second.modify(providerId, async () => credential('second'));
  await first.delete(providerId);
  assert.equal((await new ObservableCredentialStore(native, 'namespace-two').read(providerId)).refresh, 'synthetic-refresh-second');
});

test('returned credential copies cannot mutate cached or persisted tokens', async () => {
  const native = backend();
  const store = new ObservableCredentialStore(native);
  const original = credential('safe');
  const result = await store.modify(providerId, async () => original);
  original.refresh = 'changed original';
  result.access = 'changed result';
  const read = await store.read(providerId);
  read.refresh = 'changed read';
  await store.modify(providerId, async (current) => { current.refresh = 'changed callback'; return undefined; });
  assert.equal((await store.read(providerId)).refresh, 'synthetic-refresh-safe');
  assert.equal((await new ObservableCredentialStore(native).read(providerId)).access, 'synthetic-access-safe');
});

test('typed invalid_grant nested by real Pi clears expired credentials durably without deadlocking', { timeout: 3_000 }, async () => {
  const native = backend();
  const store = new ObservableCredentialStore(native);
  await store.modify(providerId, async () => credential('revoked', Date.now() - 1_000));
  const models = createModels({ credentials: store,
    authContext: { env: async () => undefined, fileExists: async () => false } });
  const failure = new CodexTokenRequestError(400, 'invalid_grant');
  let attempts = 0;
  models.setProvider({ ...openaiCodexProvider(), auth: { oauth: {
    name: 'Synthetic OAuth', login: async () => credential('login'),
    refresh: async () => { attempts++; throw failure; }, toAuth: async (value) => ({ apiKey: value.access }),
  } } });
  await assert.rejects(models.getAuth(providerId), (error) => {
    assert.equal(error.code, 'oauth');
    assert.equal(error.cause, failure);
    return assertSanitized(error);
  });
  assert.equal(store.getSnapshot().signedIn, false);
  assert.match(store.getSnapshot().error, /session expired/i);
  assert.equal(await new ObservableCredentialStore(native).read(providerId), undefined);
  assert.equal(await models.getAuth(providerId), undefined);
  assert.equal(attempts, 1, 'revoked refresh tokens are not retried after removal');
});

test('transient typed errors and untyped invalid_grant text preserve credentials for retry', async () => {
  const native = backend();
  const store = new ObservableCredentialStore(native);
  const saved = credential('retry');
  await store.modify(providerId, async () => saved);
  const lookalike = Object.assign(new Error('invalid_grant text from an unrelated operation'), { code: 'invalid_grant' });
  for (const failure of [new CodexTokenRequestError(429), new CodexTokenRequestError(503), lookalike]) {
    await assert.rejects(store.modify(providerId, async () => { throw failure; }), (error) => error === failure);
    assert.deepEqual(await new ObservableCredentialStore(native).read(providerId), saved);
    assert.equal(store.getSnapshot().signedIn, true);
  }
});

test('the native factory uses matching SecureStore service and accessibility options for read, write, reopen, and delete', async () => {
  secureStore.calls.length = 0;
  secureStore.values.clear();
  const clientId = 'synthetic-client';
  const first = createCodexCredentialStore(clientId);
  const saved = credential('native-wrapper');
  await first.modify(providerId, async () => saved);
  const second = createCodexCredentialStore(clientId);
  assert.deepEqual(await second.read(providerId), saved);
  await second.delete(providerId);
  assert.equal(secureStore.values.size, 0);
  assert.deepEqual(secureStore.calls.map(({ operation }) => operation), ['get', 'set', 'get', 'delete']);
  for (const call of secureStore.calls) {
    assert.equal(call.key, credentialStorageKey(clientId));
    assert.deepEqual(call.options, { keychainService: 'com.vikashloomba.piagent.oauth',
      keychainAccessible: secureStore.WHEN_UNLOCKED_THIS_DEVICE_ONLY, requireAuthentication: false });
  }
});

test('native storage keys satisfy SecureStore restrictions without colliding across distinct OAuth clients', () => {
  const clients = ['client/a', 'client_a', 'client-a', 'client.a', 'client a', 'client🙂', 'client🙃'];
  const keys = clients.map(credentialStorageKey);
  assert.equal(new Set(keys).size, clients.length);
  for (const key of keys) assert.match(key, /^[A-Za-z0-9._-]+$/);
});
