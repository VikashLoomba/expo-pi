import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { registerHooks, stripTypeScriptTypes } from 'node:module';
import test from 'node:test';
import { createModels } from '@earendil-works/pi-ai';
import { openaiProvider } from '@earendil-works/pi-ai/providers/openai';
import { googleProvider } from '@earendil-works/pi-ai/providers/google';

const sourceRoot = new URL('../src/pi/', import.meta.url).href;
const hooks = registerHooks({
  resolve(specifier, context, nextResolve) {
    if (context.parentURL?.startsWith(sourceRoot) && specifier.startsWith('.') && !specifier.endsWith('.ts')) {
      return nextResolve(`${specifier}.ts`, context);
    }
    return nextResolve(specifier, context);
  },
  load(url, context, nextLoad) {
    if (url.startsWith(sourceRoot) && url.endsWith('.ts')) {
      return { shortCircuit: true, format: 'module', source: stripTypeScriptTypes(readFileSync(new URL(url), 'utf8'), { mode: 'transform' }) };
    }
    return nextLoad(url, context);
  },
});
const { ProviderCredentialStore, providerCredentialKey } = await import('../src/pi/provider-credentials.ts');
hooks.deregister();

function backend() {
  const values = new Map();
  return {
    values,
    async getItemAsync(key) { return values.get(key) ?? null; },
    async setItemAsync(key, value) { values.set(key, value); },
    async deleteItemAsync(key) { values.delete(key); },
  };
}
function store(native, policies = {}) {
  const result = new ProviderCredentialStore(native, policies);
  result.registerProviders(['openai', 'google']);
  return result;
}

test('provider credentials persist independently, resolve through Pi, and publish only metadata', async () => {
  const native = backend();
  const credentials = store(native);
  await credentials.restore();
  await credentials.replaceApiKey('openai', 'synthetic-openai-key');
  await credentials.replaceApiKey('google', 'synthetic-google-key');
  assert.deepEqual(credentials.getProviderSnapshot('google'), { ready: true, connected: true, type: 'api_key' });
  assert.doesNotMatch(JSON.stringify(credentials.getSnapshot()), /synthetic/);
  const reopened = store(native);
  await reopened.restore();
  const models = createModels({ credentials: reopened, authContext: { env: async () => undefined, fileExists: async () => false } });
  models.setProvider(openaiProvider()); models.setProvider(googleProvider());
  assert.equal((await models.getAuth('openai')).auth.apiKey, 'synthetic-openai-key');
  assert.equal((await models.getAuth('google')).auth.apiKey, 'synthetic-google-key');
  await models.logout('openai');
  assert.equal(await models.getAuth('openai'), undefined);
  assert.equal((await models.getAuth('google')).auth.apiKey, 'synthetic-google-key');
});

test('a failed restore of one provider leaves another provider available', async () => {
  const native = backend();
  await store(native).replaceApiKey('google', 'synthetic-google-key');
  const get = native.getItemAsync;
  native.getItemAsync = async (key) => {
    if (key === providerCredentialKey('openai')) throw new Error('synthetic-secret native read');
    return get(key);
  };
  const credentials = store(native);
  await assert.rejects(credentials.restore(), /Could not restore/);
  assert.deepEqual(credentials.getProviderSnapshot('google'), { ready: true, connected: true, type: 'api_key' });
  assert.equal((await credentials.read('google')).key, 'synthetic-google-key');
  assert.match(credentials.getProviderSnapshot('openai').error, /Could not restore/);
  assert.equal(credentials.getProviderSnapshot('openai').retryable, true, 'a storage failure can succeed on retry');
  assert.doesNotMatch(JSON.stringify(credentials.getSnapshot()), /synthetic-secret/);
});

test('malformed and newer-format keys are preserved on read and can be explicitly replaced', async () => {
  for (const raw of ['malformed-synthetic-secret', JSON.stringify({ version: 2, credential: { key: 'future-synthetic-secret' } })]) {
    const native = backend();
    native.values.set(providerCredentialKey('google'), raw);
    const credentials = store(native);
    await assert.rejects(credentials.restore(), /could not be restored/);
    assert.equal(credentials.getProviderSnapshot('google').retryable, undefined, 'only replacement fixes invalid data');
    assert.equal(native.values.get(providerCredentialKey('google')), raw);
    assert.doesNotMatch(JSON.stringify(credentials.getSnapshot()), /synthetic-secret/);
    await credentials.replaceApiKey('google', 'synthetic-replacement');
    assert.equal((await credentials.read('google')).key, 'synthetic-replacement');
    assert.equal((await store(native).read('google')).key, 'synthetic-replacement');
  }
});

test('failed replacement never publishes success and preserves the previous durable key', async () => {
  const native = backend();
  const credentials = store(native);
  await credentials.replaceApiKey('openai', 'synthetic-original');
  const set = native.setItemAsync;
  native.setItemAsync = async () => { throw new Error('synthetic-secret storage failure'); };
  await assert.rejects(credentials.replaceApiKey('openai', 'synthetic-new'), (error) => {
    assert.match(error.message, /Could not save/); assert.doesNotMatch(error.message, /synthetic-secret/); return true;
  });
  assert.equal(credentials.getProviderSnapshot('openai').connected, false);
  assert.equal((await store(native).read('openai')).key, 'synthetic-original');
  native.setItemAsync = set;
  await credentials.replaceApiKey('openai', 'synthetic-new');
  assert.equal(credentials.getProviderSnapshot('openai').connected, true);
});

test('replacement and deletion serialize so a pending key write cannot resurrect a disconnected provider', async () => {
  const native = backend();
  const credentials = store(native);
  const gate = Promise.withResolvers();
  const started = Promise.withResolvers();
  const set = native.setItemAsync;
  native.setItemAsync = async (...args) => { started.resolve(); await gate.promise; return set(...args); };
  const saving = credentials.replaceApiKey('openai', 'synthetic-pending');
  await started.promise;
  assert.equal(credentials.getProviderSnapshot('openai').connected, false);
  const deleting = credentials.delete('openai');
  gate.resolve();
  await Promise.all([saving, deleting]);
  assert.equal(await store(native).read('openai'), undefined);
});

test('aborted mutations keep the provider lock until native completion and other providers remain independent', async () => {
  const native = backend();
  const credentials = store(native);
  await credentials.restore();
  const gate = Promise.withResolvers();
  const started = Promise.withResolvers();
  const set = native.setItemAsync;
  native.setItemAsync = async (key, value) => {
    if (key === providerCredentialKey('openai')) { started.resolve(); await gate.promise; }
    return set(key, value);
  };
  const controller = new AbortController();
  const changing = credentials.modify('openai', async () => ({ type: 'api_key', key: 'synthetic-pending' }), { signal: controller.signal });
  await started.promise;
  const rejected = assert.rejects(changing, (error) => error.name === 'AbortError');
  controller.abort();
  await rejected;
  const deleting = credentials.delete('openai');
  await credentials.replaceApiKey('google', 'synthetic-independent');
  assert.equal(credentials.getProviderSnapshot('google').connected, true);
  gate.resolve();
  await deleting;
  assert.equal(await store(native).read('openai'), undefined);
});

test('provider key names satisfy SecureStore restrictions and do not collide', () => {
  const keys = ['provider/a', 'provider_a', 'provider-a', 'provider.a', 'provider🙂', 'provider🙃'].map(providerCredentialKey);
  assert.equal(new Set(keys).size, keys.length);
  for (const key of keys) assert.match(key, /^[A-Za-z0-9._-]+$/);
});

const oauthCredential = (label, expires = Date.now() + 3_600_000) => ({
  type: 'oauth', access: `synthetic-access-${label}`, refresh: `synthetic-refresh-${label}`, expires,
  clientId: `synthetic-client-${label}`, scopes: ['openid', 'offline_access', 'chatgpt.tokens.use.direct'],
  futureProviderFields: { settings: { values: ['nested-value', 12, true, null] } },
});
const turn = () => new Promise((resolve) => setImmediate(resolve));
const isAbort = (error) => error.name === 'AbortError';
function assertSanitized(error) {
  for (let current = error, depth = 0; current && depth < 8; current = current.cause, depth++) {
    assert.doesNotMatch(`${current.message}\n${current.stack}\n${JSON.stringify(current)}`, /synthetic-secret|synthetic-access|synthetic-refresh/);
  }
  return true;
}
function oauthModels(credentials, overrides = {}) {
  const models = createModels({ credentials, authContext: { env: async () => undefined, fileExists: async () => false } });
  const provider = openaiProvider();
  models.setProvider({ ...provider, auth: { ...provider.auth, oauth: {
    name: 'Synthetic ChatGPT', isSubscription: true,
    login: async () => oauthCredential('login'),
    refresh: async () => oauthCredential('refreshed'),
    toAuth: async (credential) => ({ apiKey: credential.access }),
    ...overrides,
  } } });
  return models;
}

test('OAuth login persists SDK extension fields across restart; logout removes only that provider', async () => {
  const native = backend();
  const credentials = store(native);
  await credentials.replaceApiKey('google', 'synthetic-google-key');
  const modern = oauthCredential('modern');
  const models = oauthModels(credentials, { login: async () => modern });
  await models.login('openai', 'oauth', { prompt: async () => '', notify() {} });
  const reopened = store(native);
  await reopened.restore();
  assert.deepEqual(await reopened.read('openai'), modern);
  assert.deepEqual(reopened.getProviderSnapshot('openai'), { ready: true, connected: true, type: 'oauth' });
  assert.deepEqual(await reopened.list(), [
    { providerId: 'openai', type: 'oauth' }, { providerId: 'google', type: 'api_key' },
  ]);
  assert.doesNotMatch(JSON.stringify(reopened.getSnapshot()), /synthetic|clientId|scopes/);
  await models.logout('openai');
  assert.equal(await store(native).read('openai'), undefined);
  assert.equal((await store(native).read('google')).key, 'synthetic-google-key');
});

test('existing version1 API keys remain compatible and OpenAI can switch authentication methods', async () => {
  const native = backend();
  native.values.set(providerCredentialKey('openai'), JSON.stringify({ version: 1,
    credential: { type: 'api_key', key: 'synthetic-existing', env: { SETTING: 'saved' } } }));
  const credentials = store(native);
  assert.deepEqual(await credentials.read('openai'), { type: 'api_key', key: 'synthetic-existing', env: { SETTING: 'saved' } });
  await oauthModels(credentials).login('openai', 'oauth', { prompt: async () => '', notify() {} });
  assert.equal((await credentials.read('openai')).type, 'oauth');
  await credentials.replaceApiKey('openai', 'synthetic-replacement');
  assert.equal((await store(native).read('openai')).type, 'api_key');
  assert.equal(JSON.parse(native.values.get(providerCredentialKey('openai'))).version, 1);
});

test('deep credential copies isolate original values, returned values, and modifier inputs', async () => {
  const native = backend();
  const credentials = store(native);
  const original = oauthCredential('isolated');
  const saved = await credentials.modify('openai', async () => original);
  original.scopes.push('changed-original');
  original.futureProviderFields.settings.values.push('changed-original');
  saved.scopes.push('changed-result');
  const read = await credentials.read('openai');
  read.futureProviderFields.settings.values.push('changed-read');
  await credentials.modify('openai', async (current) => { current.scopes.push('changed-modifier'); return undefined; });
  assert.deepEqual(await credentials.read('openai'), oauthCredential('isolated', original.expires));
  assert.deepEqual(await store(native).read('openai'), oauthCredential('isolated', original.expires));
});

test('invalid OAuth and non-JSON extension fields never replace the saved credential', async () => {
  const native = backend();
  const credentials = store(native);
  const saved = oauthCredential('kept');
  await credentials.modify('openai', async () => saved);
  const cyclic = {}; cyclic.self = cyclic;
  const invalid = [
    { ...saved, access: '' }, { ...saved, refresh: ' ' }, { ...saved, expires: NaN },
    { ...saved, expires: 0 }, { ...saved, expires: Infinity }, { ...saved, scopes: [undefined] },
    { ...saved, unexpected: () => 'synthetic-secret' }, { ...saved, unexpected: new Date() },
    { ...saved, unexpected: cyclic }, { ...saved, unexpected: 1n },
  ];
  for (const value of invalid) {
    await assert.rejects(credentials.modify('openai', async () => value), assertSanitized);
    assert.deepEqual(await credentials.read('openai'), saved);
  }
});

test('SDK API-key credentials can contain only provider environment configuration', async () => {
  const native = backend();
  const credentials = store(native);
  const credential = { type: 'api_key', env: { AWS_PROFILE: 'example-profile' } };
  await credentials.modify('custom-provider', async () => credential);
  assert.deepEqual(await store(native).read('custom-provider'), credential);
  assert.deepEqual((await credentials.list()).find((entry) => entry.providerId === 'custom-provider'),
    { providerId: 'custom-provider', type: 'api_key' });
});

test('real Pi concurrent auth resolution refreshes once under the per-provider credential lock', { timeout: 3_000 }, async (t) => {
  const native = backend();
  const credentials = store(native);
  await credentials.modify('openai', async () => oauthCredential('expired', Date.now() - 1_000));
  const gate = Promise.withResolvers();
  const started = Promise.withResolvers();
  t.after(() => gate.resolve());
  let refreshCalls = 0;
  const models = oauthModels(credentials, { refresh: async (current) => {
    refreshCalls++;
    assert.equal(current.refresh, 'synthetic-refresh-expired');
    started.resolve(); await gate.promise;
    return oauthCredential('rotated');
  } });
  const requests = Array.from({ length: 8 }, () => models.getAuth('openai'));
  await started.promise;
  assert.equal(refreshCalls, 1);
  await credentials.replaceApiKey('google', 'synthetic-independent');
  gate.resolve();
  for (const result of await Promise.all(requests)) assert.equal(result.auth.apiKey, 'synthetic-access-rotated');
  assert.equal(refreshCalls, 1);
  assert.equal((await store(native).read('openai')).refresh, 'synthetic-refresh-rotated');
});

test('failed OAuth persistence retries the rotated result without reusing a spent refresh token', async () => {
  const native = backend();
  const credentials = store(native);
  await credentials.modify('openai', async () => oauthCredential('spent', Date.now() - 1_000));
  let refreshCalls = 0;
  const models = oauthModels(credentials, { refresh: async () => {
    refreshCalls++;
    assert.equal(refreshCalls, 1, 'the previous refresh token can be consumed only once');
    return oauthCredential('pending');
  } });
  const set = native.setItemAsync;
  native.setItemAsync = async () => { throw new Error('synthetic-secret locked keychain'); };
  await assert.rejects(models.getAuth('openai'), assertSanitized);
  assert.equal(credentials.getProviderSnapshot('openai').connected, false);
  await assert.rejects(models.getAuth('openai'), assertSanitized);
  assert.equal(refreshCalls, 1);
  assert.equal((await store(native).read('openai')).refresh, 'synthetic-refresh-spent');
  native.setItemAsync = set;
  assert.equal((await models.getAuth('openai')).auth.apiKey, 'synthetic-access-pending');
  assert.equal(refreshCalls, 1);
  assert.equal((await store(native).read('openai')).refresh, 'synthetic-refresh-pending');
  assert.equal(credentials.getProviderSnapshot('openai').connected, true);
});

test('logout clears a pending OAuth save without first retrying it', async () => {
  const native = backend();
  const credentials = store(native);
  await credentials.modify('openai', async () => oauthCredential('before'));
  const set = native.setItemAsync;
  native.setItemAsync = async () => { throw new Error('synthetic-secret locked write'); };
  await assert.rejects(credentials.modify('openai', async () => oauthCredential('pending')), assertSanitized);
  await credentials.delete('openai');
  native.setItemAsync = set;
  await credentials.restore();
  assert.equal(await credentials.read('openai'), undefined);
  assert.equal(await store(native).read('openai'), undefined);
});

test('cancelled ordinary modifiers do not persist results and retain their locks until completion', { timeout: 3_000 }, async (t) => {
  const native = backend();
  const credentials = store(native);
  const before = oauthCredential('before');
  await credentials.modify('openai', async () => before);
  const gate = Promise.withResolvers();
  const started = Promise.withResolvers();
  t.after(() => gate.resolve());
  const controller = new AbortController();
  const pending = credentials.modify('openai', async () => {
    started.resolve(); await gate.promise; return oauthCredential('cancelled');
  }, { signal: controller.signal });
  const rejected = assert.rejects(pending, isAbort);
  await started.promise;
  controller.abort(); await rejected;
  let inspected = false;
  const after = credentials.modify('openai', async (current) => { inspected = true; assert.deepEqual(current, before); return undefined; });
  await turn();
  assert.equal(inspected, false);
  gate.resolve(); await after;
  assert.deepEqual(await store(native).read('openai'), before);
});

test('pre-aborted operations do not access storage and queued cancellation does not invoke its callback', { timeout: 3_000 }, async (t) => {
  const native = backend();
  let accesses = 0;
  const get = native.getItemAsync;
  native.getItemAsync = async (...args) => { accesses++; return get(...args); };
  const credentials = store(native);
  const controller = new AbortController(); controller.abort();
  const options = { signal: controller.signal };
  await assert.rejects(credentials.read('openai', options), isAbort);
  await assert.rejects(credentials.list(options), isAbort);
  await assert.rejects(credentials.modify('openai', async () => { assert.fail('Must not invoke'); }, options), isAbort);
  await assert.rejects(credentials.delete('openai', options), isAbort);
  assert.equal(accesses, 0);
  const gate = Promise.withResolvers(); const started = Promise.withResolvers();
  t.after(() => gate.resolve());
  const active = credentials.modify('openai', async () => { started.resolve(); await gate.promise; return oauthCredential('active'); });
  await started.promise;
  const queuedController = new AbortController();
  const queued = credentials.modify('openai', async () => { assert.fail('Must not invoke'); }, { signal: queuedController.signal });
  const rejected = assert.rejects(queued, isAbort);
  queuedController.abort(); await rejected;
  gate.resolve(); await active;
  assert.equal((await credentials.read('openai')).refresh, 'synthetic-refresh-active');
});

test('only typed policy-approved terminal failures invalidate credentials without deadlocking Pi', { timeout: 3_000 }, async () => {
  const native = backend();
  const permanent = new Error('Synthetic session expired');
  const credentials = store(native, { openai: { isPermanentAuthError: (error) => {
    const visited = new Set();
    while (error instanceof Error && !visited.has(error)) {
      if (error === permanent) return true;
      visited.add(error); error = error.cause;
    }
    return false;
  } } });
  const original = oauthCredential('revoked', Date.now() - 1_000);
  await credentials.modify('openai', async () => original);
  for (const failure of [new Error('Network unavailable'), Object.assign(new Error('invalid_grant'), { code: 'invalid_grant' })]) {
    await assert.rejects(credentials.modify('openai', async () => { throw failure; }), (error) => error === failure);
    assert.deepEqual(await store(native).read('openai'), original);
  }
  const models = oauthModels(credentials, { refresh: async () => { throw permanent; } });
  await assert.rejects(models.getAuth('openai'), (error) => error.cause === permanent);
  assert.equal(credentials.getProviderSnapshot('openai').connected, false);
  assert.match(credentials.getProviderSnapshot('openai').error, /session expired/);
  assert.equal(credentials.getProviderSnapshot('openai').retryable, undefined, 'an expired session needs a new sign-in');
  assert.equal(await store(native).read('openai'), undefined);
  assert.equal(await models.getAuth('openai'), undefined);
});

test('fresh SDK login can explicitly replace invalid saved OAuth data while reads preserve it', async () => {
  const native = backend();
  const raw = JSON.stringify({ version: 99, credential: oauthCredential('future') });
  native.values.set(providerCredentialKey('openai'), raw);
  const credentials = store(native);
  await assert.rejects(credentials.read('openai'), /could not be restored/);
  assert.equal(native.values.get(providerCredentialKey('openai')), raw);
  await oauthModels(credentials).login('openai', 'oauth', { prompt: async () => '', notify() {} });
  assert.equal((await store(native).read('openai')).access, 'synthetic-access-login');
});

test('secret-only token refresh preserves snapshot identity and never publishes credential fields', async () => {
  const native = backend();
  const credentials = store(native);
  await credentials.restore();
  await credentials.modify('openai', async () => oauthCredential('first'));
  const before = credentials.getSnapshot();
  const access = credentials.getProviderSnapshot('openai');
  let changes = 0;
  const unsubscribe = credentials.subscribe(() => changes++);
  await credentials.modify('openai', async () => oauthCredential('second'));
  assert.equal(credentials.getSnapshot(), before);
  assert.equal(credentials.getProviderSnapshot('openai'), access);
  assert.equal(changes, 0);
  assert.doesNotMatch(JSON.stringify(credentials.getSnapshot()), /synthetic|clientId|scopes/);
  unsubscribe();
});

test('provider validation rejects malformed OAuth on restore and save while allowing explicit reconnection or API keys', async () => {
  const policy = { openai: { validate(credential) {
    if (credential.type !== 'oauth') return;
    if (typeof credential.clientId !== 'string' || !credential.clientId.trim() ||
        !Array.isArray(credential.scopes) || !credential.scopes.includes('chatgpt.tokens.use.direct')) {
      throw new Error('Synthetic incomplete provider grant.');
    }
  } } };
  for (const malformed of [
    { ...oauthCredential('missing-client'), clientId: undefined },
    { ...oauthCredential('blank-client'), clientId: ' ' },
    { ...oauthCredential('missing-scopes'), scopes: undefined },
    { ...oauthCredential('missing-grant'), scopes: ['openid'] },
  ]) {
    const native = backend();
    const raw = JSON.stringify({ version: 1, credential: malformed });
    native.values.set(providerCredentialKey('openai'), raw);
    const credentials = store(native, policy);
    await assert.rejects(credentials.restoreProvider('openai'), /could not be restored/);
    assert.equal(native.values.get(providerCredentialKey('openai')), raw, 'restore preserves invalid persisted data');
    assert.equal(credentials.getProviderSnapshot('openai').connected, false);
    await oauthModels(credentials).login('openai', 'oauth', { prompt: async () => '', notify() {} });
    const connected = await credentials.read('openai');
    await assert.rejects(credentials.modify('openai', async () => malformed), /incomplete provider grant/);
    assert.deepEqual(await credentials.read('openai'), connected, 'invalid replacements never change the saved account');
    await credentials.replaceApiKey('openai', 'synthetic-key');
    assert.equal((await store(native, policy).read('openai')).type, 'api_key');
  }
});
