import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { registerHooks, stripTypeScriptTypes } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { BACKGROUND_CONTEXT } from '@earendil-works/chord/context';
import { createModels, InMemoryCredentialStore } from '@earendil-works/pi-ai';
import { openaiProvider } from '@earendil-works/pi-ai/providers/openai';
import { SqliteStorage } from '@earendil-works/pi-durable/storage/sqlite';
import { createExpoSqliteDatabase } from '../src/pi/storage/expo-sqlite.ts';
import { createNodeSqliteConnection } from './helpers/node-sqlite.mjs';
import { controlledReply, scriptedModels } from './helpers/scripted-models.mjs';

const sourceRoot = new URL('../src/', import.meta.url).href;
const hooks = registerHooks({
  resolve(specifier, context, nextResolve) {
    if (context.parentURL?.startsWith(sourceRoot) && specifier.startsWith('.')) {
      try { return nextResolve(specifier, context); }
      catch (error) {
        if (!['ERR_MODULE_NOT_FOUND', 'ERR_UNSUPPORTED_DIR_IMPORT'].includes(error.code)) throw error;
        return nextResolve(`${specifier}.ts`, context);
      }
    }
    return nextResolve(specifier, context);
  },
  load(url, context, nextLoad) {
    if (url.startsWith(sourceRoot) && url.endsWith('.ts')) {
      return { shortCircuit: true, format: 'module', source: stripTypeScriptTypes(readFileSync(new URL(url), 'utf8'), {
        mode: 'transform', sourceMap: false, sourceUrl: url,
      }) };
    }
    return nextLoad(url, context);
  },
});
const { ChatRuntime } = await import('../src/chat/chat-runtime.ts');
hooks.deregister();

async function fixture(t, provider, { beforeOpen, configureStorage, failClose, credentials } = {}) {
  const directory = await mkdtemp(join(tmpdir(), 'pi-chat-runtime-'));
  const filename = join(directory, 'chat.sqlite');
  const connections = new Set();
  const metrics = { opens: 0, active: 0, maxActive: 0, events: [] };
  const openStorage = async () => {
    metrics.opens++;
    await beforeOpen?.(metrics.opens);
    const native = createNodeSqliteConnection(filename);
    connections.add(native);
    metrics.active++;
    metrics.maxActive = Math.max(metrics.maxActive, metrics.active);
    const adapter = createExpoSqliteDatabase({
      ...native,
      async closeAsync() {
        if (failClose?.()) throw new Error('Injected native close failure');
        await native.closeAsync();
        connections.delete(native);
        metrics.active--;
        metrics.events.push('database.closed');
      },
    });
    const storage = await SqliteStorage.open(adapter);
    configureStorage?.(storage);
    return storage;
  };
  const runtime = new ChatRuntime({ models: provider.models, openStorage, platform: 'ios', credentials });
  t.after(async () => {
    await runtime.deactivate().catch(() => {});
    await Promise.allSettled([...connections].map((native) => native.closeAsync()));
    await rm(directory, { recursive: true, force: true });
  });
  return {
    runtime, metrics,
    async submissions(id) {
      assert.equal(metrics.active, 0, 'inspect stored records only while the runtime connection is closed');
      const storage = await SqliteStorage.open(createExpoSqliteDatabase(createNodeSqliteConnection(filename)));
      try {
        return (await storage.scanSubmissions({ conversationId: Number(id) }, 100, undefined, BACKGROUND_CONTEXT)).items;
      } finally { await storage.close(BACKGROUND_CONTEXT); }
    },
  };
}

async function until(check, description) {
  const deadline = Date.now() + 3_000;
  while (!check()) {
    assert.ok(Date.now() < deadline, description);
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

function logoutProvider(provider, action = () => {}) {
  const logout = provider.models.logout.bind(provider.models);
  provider.models.logout = async (...args) => {
    await action();
    await logout(...args);
    provider.auth.authenticated = false;
  };
}

/** Publishes the scripted provider's access like ProviderCredentialStore; `stored` controls Pi auth. */
function observableCredentials(provider) {
  let access = { ready: false, connected: false };
  const listeners = new Set();
  const credentials = {
    restores: 0,
    restored: { ready: true, connected: provider.auth.authenticated },
    restoreError: undefined,
    beforeRestore: undefined,
    getProviderSnapshot: (providerId) => providerId === 'anthropic' ? access : { ready: true, connected: false },
    get listenerCount() { return listeners.size; },
    subscribe(listener) { listeners.add(listener); return () => listeners.delete(listener); },
    set(state, stored = state.connected) {
      access = { ...state };
      provider.auth.authenticated = stored;
      for (const listener of listeners) listener();
    },
    async restore() {
      credentials.restores++;
      await credentials.beforeRestore?.();
      if (credentials.restoreError) {
        credentials.set({ ...access, ready: true, connected: false, error: credentials.restoreError });
        throw new Error(credentials.restoreError);
      }
      credentials.set(credentials.restored);
    },
  };
  return credentials;
}

function addFutureProvider(provider, access = { connected: true }) {
  const original = provider.models.getProvider('anthropic');
  const model = { ...original.getModels()[0], provider: 'future-provider', id: 'future-model', name: 'Future model' };
  provider.models.setProvider({ ...original, id: 'future-provider', name: 'Future provider', getModels: () => [model],
    auth: { apiKey: {
      name: 'Future key',
      check: async () => access.connected ? { type: 'api_key' } : undefined,
      resolve: async () => access.connected ? { auth: { apiKey: 'test-future-key' } } : undefined,
    } },
  });
  return { model: { provider: 'future-provider', modelId: 'future-model' }, thinkingLevel: 'high' };
}

/** Real Pi auth/storage orchestration, with only browser/network work controlled. */
async function oauthProvider(script, { beforeMutation } = {}) {
  const scripted = scriptedModels(script);
  const credentials = new InMemoryCredentialStore();
  const previous = { type: 'api_key', key: 'synthetic-previous-api-key' };
  await credentials.modify('openai', async () => previous);
  const mutations = [];
  const modify = credentials.modify.bind(credentials);
  credentials.modify = (id, action, options) => modify(id, async (current) => {
    const next = await action(current);
    if (id === 'openai' && next?.access !== current?.access && next?.type === 'oauth') {
      await beforeMutation?.();
      mutations.push(next);
    }
    return next;
  }, options);
  const models = createModels({ credentials, authContext: { env: async () => undefined, fileExists: async () => false } });
  const transport = scripted.models.getProvider('anthropic');
  const base = openaiProvider();
  const entered = Promise.withResolvers();
  const release = Promise.withResolvers();
  const result = { type: 'oauth', access: 'synthetic-new-oauth', refresh: 'synthetic-refresh', expires: Date.now() + 3_600_000 };
  models.setProvider({ ...base, stream: transport.stream, streamSimple: transport.streamSimple,
    auth: { apiKey: base.auth.apiKey, oauth: {
      name: 'Test ChatGPT',
      async login(interaction) { entered.resolve(interaction); await release.promise; return result; },
      async refresh() { throw new Error('Unexpired test credentials must not refresh'); },
      async toAuth(credential) { return { apiKey: credential.access }; },
    } },
  });
  const model = models.getModels('openai')[0];
  return { ...scripted, models, credentials, previous, mutations, result, entered, release,
    settings: { model: { provider: 'openai', modelId: model.id }, thinkingLevel: 'off' } };
}

function loginInteraction(signal) {
  return { signal, async prompt() { throw new Error('This test must not ask for user input'); }, notify() {} };
}

async function createOpenAIChat(runtime, provider) {
  const id = await runtime.createChat();
  await runtime.updateSettings(id, provider.settings);
  return id;
}

test('OAuth replacement closes the active transport before Pi mutates credentials and resumes with the new account', { timeout: 10_000 }, async (t) => {
  let active;
  let metrics;
  const provider = await oauthProvider([
    (request) => { active = controlledReply(request); return active.stream; },
    { chunks: ['Completed using the new account.'] },
  ], { beforeMutation() {
    assert.equal(active.signal.aborted, true, 'no request may retain the previous credential during replacement');
    assert.ok(metrics.events.includes('database.closed'), 'the old durable session closed before credential mutation');
  } });
  const fixtureResult = await fixture(t, provider);
  const { runtime } = fixtureResult;
  metrics = fixtureResult.metrics;
  await runtime.activate();
  const id = await createOpenAIChat(runtime, provider);
  await runtime.send(id, 'Keep this input through account replacement.');
  await until(() => !!active, 'the original request starts');
  const signingIn = runtime.login('openai', loginInteraction());
  await provider.entered.promise;
  assert.equal(active.signal.aborted, true, 'browser interaction starts only after transport shutdown');
  assert.equal(provider.requests.length, 1);
  assert.equal((await fixtureResult.submissions(id))[0].status, 'placed', 'the closed session retains its pending input durably');
  assert.deepEqual(await provider.credentials.read('openai'), provider.previous);
  provider.release.resolve();
  await signingIn;
  await until(() => !runtime.getConversation(id).busy && !runtime.getConversation(id).pending, 'pending work resumes after account replacement');
  assert.equal(provider.mutations.length, 1);
  assert.equal(provider.requests.length, 2);
  assert.equal(provider.requests[0].options.apiKey, provider.previous.key);
  assert.equal(provider.requests[1].options.apiKey, provider.result.access);
  assert.equal(runtime.getConversation(id).messages.filter(({ role }) => role === 'user').length, 1);
  assert.equal(metrics.maxActive, 1);
});

test('cancelling OAuth preserves the previous credential and late browser completion cannot replace it', { timeout: 10_000 }, async (t) => {
  const provider = await oauthProvider([{ chunks: ['Still using the saved API key.'] }]);
  const { runtime } = await fixture(t, provider);
  await runtime.activate();
  const id = await createOpenAIChat(runtime, provider);
  const controller = new AbortController();
  const signingIn = runtime.login('openai', loginInteraction(controller.signal));
  await provider.entered.promise;
  const cancelled = assert.rejects(signingIn, /Cancelled sign-in/);
  controller.abort(new Error('Cancelled sign-in'));
  await cancelled;
  provider.release.resolve();
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(await provider.credentials.read('openai'), provider.previous);
  assert.equal(provider.mutations.length, 0);
  await runtime.send(id, 'Use the previous connection.');
  await until(() => !runtime.getConversation(id).busy, 'the previous API key remains usable');
  assert.equal(provider.requests[0].options.apiKey, provider.previous.key);
});

test('backgrounding and foregrounding during OAuth never dispatch pending work before sign-in settles', { timeout: 10_000 }, async (t) => {
  const provider = await oauthProvider([
    (request) => controlledReply(request).stream,
    { chunks: ['Resumed after signing in.'] },
  ]);
  const { runtime, metrics } = await fixture(t, provider);
  await runtime.activate();
  const id = await createOpenAIChat(runtime, provider);
  await runtime.send(id, 'Keep this work pending while browser sign-in runs.');
  await until(() => provider.requests.length === 1, 'the initial request starts');
  const signingIn = runtime.login('openai', loginInteraction());
  await provider.entered.promise;
  await runtime.deactivate();
  assert.equal(metrics.active, 0);
  await runtime.activate();
  assert.equal(runtime.getSnapshot().ready, true);
  assert.equal(provider.requests.length, 1, 'foreground activation must not resume work while OAuth is pending');
  await assert.rejects(runtime.send(id, 'Do not send while connecting.'), /Finish or cancel sign-in/);
  await assert.rejects(runtime.resume(id), /Finish or cancel sign-in/);
  await runtime.deactivate();
  provider.release.resolve();
  await signingIn;
  assert.equal(provider.requests.length, 1, 'background login completion persists credentials without dispatch');
  assert.equal(metrics.active, 0);
  await runtime.activate();
  await until(() => !runtime.getConversation(id).busy && !runtime.getConversation(id).pending, 'foreground resumes after login completes');
  assert.equal(provider.requests.length, 2);
  assert.equal(metrics.maxActive, 1);
});

test('sign-out aborts pending OAuth and a late provider result cannot recreate the removed connection', { timeout: 10_000 }, async (t) => {
  const provider = await oauthProvider([]);
  const { runtime } = await fixture(t, provider);
  await runtime.activate();
  const id = await createOpenAIChat(runtime, provider);
  const signingIn = runtime.login('openai', loginInteraction());
  const interaction = await provider.entered.promise;
  const aborted = assert.rejects(signingIn, { name: 'AbortError' });
  await runtime.signOut('openai');
  await aborted;
  assert.equal(interaction.signal.aborted, true);
  provider.release.resolve();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(await provider.credentials.read('openai'), undefined);
  assert.equal(provider.mutations.length, 0);
  await runtime.deactivate();
  await runtime.activate();
  await assert.rejects(runtime.send(id, 'Do not restore a signed-out account.'), /Sign in or connect OpenAI/);
  assert.equal(provider.requests.length, 0);
});

test('pending OAuth rejects another sign-in and API-key replacement without changing saved credentials', { timeout: 10_000 }, async (t) => {
  const provider = await oauthProvider([]);
  const { runtime } = await fixture(t, provider);
  await runtime.activate();
  const controller = new AbortController();
  const signingIn = runtime.login('openai', loginInteraction(controller.signal));
  await provider.entered.promise;
  await assert.rejects(runtime.login('openai', loginInteraction()), /Finish or cancel the current sign-in/);
  await assert.rejects(runtime.saveProviderKey('openai', 'synthetic-unwanted-key'), /Finish or cancel sign-in/);
  assert.deepEqual(await provider.credentials.read('openai'), provider.previous);
  const cancelled = assert.rejects(signingIn, { name: 'AbortError' });
  controller.abort();
  await cancelled;
  provider.release.resolve();
  await runtime.saveProviderKey('openai', 'synthetic-intended-key');
  assert.equal((await provider.credentials.read('openai')).key, 'synthetic-intended-key');
});

test('a selected provider works while another is disconnected and settings survive foreground recovery', async (t) => {
  const provider = scriptedModels([{ chunks: ['Answered through the selected provider.'] }], { authenticated: false });
  const settings = addFutureProvider(provider);
  const credentials = observableCredentials(provider);
  credentials.getProviderSnapshot = (providerId) => providerId === 'future-provider'
    ? { ready: true, connected: true } : { ready: true, connected: false };
  const { runtime } = await fixture(t, provider, { credentials });
  await runtime.activate();
  const id = await runtime.createChat();
  await runtime.updateSettings(id, settings);
  assert.deepEqual(runtime.getConversationState(id).settings, settings);
  await runtime.send(id, 'Use the selected provider.');
  await until(() => !runtime.getConversation(id).busy, 'the selected provider completes');
  assert.equal(provider.requests[0].model.provider, 'future-provider');
  assert.equal(provider.requests[0].options.reasoning, 'high');
  await runtime.deactivate();
  await runtime.activate();
  assert.deepEqual(runtime.getConversationState(id).settings, settings);
});

test('one disconnected pending provider prevents unrelated recovered work from dispatching', async (t) => {
  const provider = scriptedModels([(request) => controlledReply(request).stream, (request) => controlledReply(request).stream]);
  const settings = addFutureProvider(provider);
  const { runtime } = await fixture(t, provider);
  await runtime.activate();
  const primary = await runtime.createChat();
  const future = await runtime.createChat();
  await runtime.updateSettings(future, settings);
  await runtime.send(primary, 'Primary pending input.');
  await until(() => provider.requests.length === 1, 'the first provider starts');
  await runtime.send(future, 'Future provider pending input.');
  await until(() => provider.requests.length === 2, 'the second provider starts');
  await runtime.deactivate();
  provider.auth.authenticated = false;
  await runtime.activate();
  assert.equal(runtime.getConversation(primary).pending, true);
  assert.equal(runtime.getConversation(future).pending, true);
  assert.equal(provider.requests.length, 2, 'opening does not dispatch any recovered provider');
  await assert.rejects(runtime.resume(future), /pending responses|Sign in/i);
  assert.equal(provider.requests.length, 2);
});

test('failed provider removal cannot be bypassed by disconnecting another account', async (t) => {
  const provider = scriptedModels([]);
  addFutureProvider(provider);
  const { runtime } = await fixture(t, provider);
  await runtime.activate();
  const logout = provider.models.logout.bind(provider.models);
  let fail = true;
  const attempts = [];
  provider.models.logout = async (id) => {
    attempts.push(id);
    if (fail) throw new Error('Synthetic deletion failure');
    await logout(id);
  };
  await assert.rejects(runtime.signOut('future-provider'), /Could not remove.*Future provider/);
  assert.equal(runtime.getSnapshot().signOutPending, true);
  assert.equal(runtime.getSnapshot().disconnectingProvider, 'future-provider');
  await assert.rejects(runtime.signOut('anthropic'), /Finish disconnecting Future provider/);
  assert.deepEqual(attempts, ['future-provider']);
  fail = false;
  await runtime.signOut('future-provider');
  assert.equal(runtime.getSnapshot().signOutPending, false);
  assert.equal(runtime.getSnapshot().disconnectingProvider, undefined);
});

test('signout closes the running durable session and transport before deleting credentials', { timeout: 10_000 }, async (t) => {
  const started = Promise.withResolvers();
  let active;
  const provider = scriptedModels([(request) => {
    active = controlledReply(request); started.resolve(); return active.stream;
  }]);
  const { runtime, metrics } = await fixture(t, provider);
  logoutProvider(provider, () => {
    assert.equal(active.signal.aborted, true);
    assert.equal(metrics.active, 0);
    metrics.events.push('credentials.deleted');
  });
  await runtime.activate();
  const id = await runtime.createChat();
  await runtime.send(id, 'Keep this task pending when I sign out.');
  await started.promise;
  await runtime.signOut('anthropic');
  assert.deepEqual(metrics.events.slice(0, 2), ['database.closed', 'credentials.deleted']);
  assert.equal(metrics.active, 1, 'signed-out history reopens on one paused connection');
  assert.equal(runtime.getSnapshot().ready, true);
  assert.equal(runtime.getConversation(id).pending, true);
  assert.equal(runtime.getConversationState(id).pending, true);
  assert.equal(provider.requests.length, 1);
  await assert.rejects(runtime.send(id, 'Cannot run while signed out.'), /sign in/i);
  assert.equal(provider.requests.length, 1);
});

test('background close and foreground reopen finish the same persisted input without duplication', { timeout: 10_000 }, async (t) => {
  const started = Promise.withResolvers();
  let active;
  const provider = scriptedModels([
    (request) => { active = controlledReply(request); started.resolve(); return active.stream; },
    { chunks: ['Recovered on foreground.'] },
  ]);
  const { runtime, metrics, submissions } = await fixture(t, provider);
  await runtime.activate();
  const id = await runtime.createChat();
  await runtime.send(id, 'Remember this pending input.');
  await started.promise;
  active.text('Started before background.');
  await until(() => runtime.getConversation(id).messages.some(({ streaming, text }) => streaming && text.includes('Started before')),
    'the partial answer commits before backgrounding');
  await runtime.deactivate();
  assert.equal(active.signal.aborted, true);
  assert.equal(runtime.getSnapshot().ready, false);
  assert.equal(metrics.active, 0);
  const before = await submissions(id);
  assert.equal(before.length, 1);
  assert.equal(before[0].status, 'placed');
  await runtime.activate();
  await until(() => !runtime.getConversation(id).busy && runtime.getConversation(id).messages.some(({ text }) => text === 'Recovered on foreground.'),
    'the recovered generation finishes on foreground');
  assert.equal(provider.requests.length, 2);
  assert.equal(runtime.getConversation(id).messages.filter(({ role }) => role === 'user').length, 1);
  await runtime.deactivate();
  const after = await submissions(id);
  assert.equal(after.length, 1);
  assert.equal(after[0].id, before[0].id);
  assert.equal(after[0].status, 'done');
  assert.equal(metrics.maxActive, 1);
});

test('activate/deactivate/activate races never own two database connections', { timeout: 10_000 }, async (t) => {
  const opening = Promise.withResolvers();
  const release = Promise.withResolvers();
  const provider = scriptedModels([], { authenticated: false });
  const { runtime, metrics } = await fixture(t, provider, {
    async beforeOpen(count) { if (count === 1) { opening.resolve(); await release.promise; } },
  });
  const first = runtime.activate();
  await opening.promise;
  const background = runtime.deactivate();
  const foreground = runtime.activate();
  release.resolve();
  await Promise.all([first, background, foreground]);
  assert.equal(runtime.getSnapshot().ready, true);
  assert.equal(metrics.active, 1);
  assert.equal(metrics.maxActive, 1);
  assert.equal(metrics.opens, 2);
  assert.equal(provider.requests.length, 0);
  await runtime.deactivate();
  assert.equal(metrics.active, 0);
});

test('signed-out users can reopen and read existing chats without dispatching any model request', { timeout: 10_000 }, async (t) => {
  const provider = scriptedModels([{ chunks: ['Saved before signout.'] }]);
  const { runtime } = await fixture(t, provider);
  logoutProvider(provider);
  await runtime.activate();
  const id = await runtime.createChat();
  await runtime.send(id, 'Save this conversation.');
  await until(() => !runtime.getConversation(id).busy, 'the first answer completes');
  const messages = structuredClone(runtime.getConversation(id).messages);
  await runtime.signOut('anthropic');
  await runtime.deactivate();
  await runtime.activate();
  assert.equal(runtime.getSnapshot().ready, true);
  assert.ok(runtime.getSnapshot().chats.some((chat) => chat.id === id));
  assert.deepEqual(runtime.getConversation(id).messages, messages);
  assert.equal(provider.requests.length, 1);
  await assert.rejects(runtime.resume(), /sign in/i);
  assert.equal(provider.requests.length, 1);
});

test('partial response updates notify chat subscribers without invalidating the unchanged chat list snapshot', { timeout: 10_000 }, async (t) => {
  const started = Promise.withResolvers();
  let active;
  const provider = scriptedModels([(request) => {
    active = controlledReply(request); started.resolve(); return active.stream;
  }]);
  const { runtime } = await fixture(t, provider);
  await runtime.activate();
  const id = await runtime.createChat();
  await runtime.send(id, 'Stream the answer.');
  await started.promise;
  const snapshot = runtime.getSnapshot();
  let notifications = 0;
  const unsubscribe = runtime.subscribe(() => { notifications++; });
  t.after(unsubscribe);
  active.text('Partial text.');
  await until(() => runtime.getConversation(id).messages.some(({ streaming, text }) => streaming && text === 'Partial text.'), 'the partial reaches chat subscribers');
  assert.equal(runtime.getSnapshot(), snapshot);
  assert.ok(notifications > 0);
  active.finish();
  await until(() => !runtime.getConversation(id).busy, 'the streamed reply settles');
  assert.notEqual(runtime.getSnapshot(), snapshot, 'the committed assistant answer updates the chat preview');
});

test('conversation control snapshots stay stable across deltas and publish status changes before notifying', { timeout: 10_000 }, async (t) => {
  const started = Promise.withResolvers();
  let active;
  const provider = scriptedModels([(request) => {
    active = controlledReply(request); started.resolve(); return active.stream;
  }]);
  const { runtime } = await fixture(t, provider);
  await runtime.activate();
  const id = await runtime.createChat();
  const idle = runtime.getConversationState(id);
  assert.equal(idle.busy, false);
  assert.equal(runtime.getConversationState(id), idle, 'reading a snapshot never recreates it');
  assert.equal(runtime.getConversationState('missing'), undefined);
  const observed = [];
  const unsubscribe = runtime.subscribe(() => {
    const { messages: _messages, ...expected } = runtime.getConversation(id);
    const state = runtime.getConversationState(id);
    assert.deepEqual(state, expected, 'control fields are updated before subscribers are called');
    observed.push(state);
  });
  t.after(unsubscribe);
  await runtime.send(id, 'Stream a response that fails.');
  await started.promise;
  const busy = runtime.getConversationState(id);
  assert.equal(busy.busy, true);
  assert.notEqual(busy, idle);
  active.text('Partial one.');
  await until(() => runtime.getConversation(id).messages.some(({ text }) => text === 'Partial one.'), 'the first delta is committed');
  assert.equal(runtime.getConversationState(id), busy);
  active.text(' Partial two.');
  await until(() => runtime.getConversation(id).messages.some(({ text }) => text.includes('Partial two.')), 'the next delta is committed');
  assert.equal(runtime.getConversationState(id), busy);
  active.finish({ error: 'A useful provider failure.' });
  await until(() => runtime.getConversationState(id).error === 'A useful provider failure.', 'error status reaches the control snapshot');
  const failed = runtime.getConversationState(id);
  assert.equal(failed.busy, false);
  assert.equal(failed.pending, false);
  assert.notEqual(failed, busy);
  assert.ok(observed.includes(busy));
  assert.ok(observed.includes(failed));
  await runtime.renameChat(id, 'Updated header');
  assert.equal(runtime.getConversationState(id).title, 'Updated header');
  await runtime.archiveChat(id);
  await runtime.deactivate();
  await runtime.activate();
  assert.equal(runtime.getSnapshot().chats.some((chat) => chat.id === id), false);
  assert.equal(runtime.getConversationState(id).title, 'Updated header', 'archived conversation lookups stay consistent after reopen');
});

test('an open failure releases the acquired database and a later activation can retry', { timeout: 10_000 }, async (t) => {
  const provider = scriptedModels([], { authenticated: false });
  let fail = true;
  const { runtime, metrics } = await fixture(t, provider, {
    configureStorage(storage) {
      const scan = storage.scanConversations.bind(storage);
      storage.scanConversations = (...args) => {
        if (fail) { fail = false; return Promise.reject(new Error('Injected conversation read failure')); }
        return scan(...args);
      };
    },
  });
  await assert.rejects(runtime.activate(), /Injected conversation read failure/);
  assert.equal(metrics.active, 0);
  assert.equal(runtime.getSnapshot().ready, false);
  assert.match(runtime.getSnapshot().error, /Injected conversation read failure/);
  await runtime.activate();
  assert.equal(metrics.active, 1);
  assert.equal(metrics.maxActive, 1);
  assert.equal(runtime.getSnapshot().ready, true);
  assert.equal(runtime.getSnapshot().error, undefined);
});

test('a failed close blocks reopening or credential deletion and surfaces a persistent runtime error', { timeout: 10_000 }, async (t) => {
  const provider = scriptedModels([], { authenticated: false });
  let fail = true;
  let logouts = 0;
  const { runtime, metrics } = await fixture(t, provider, {
    failClose() { const result = fail; fail = false; return result; },
  });
  logoutProvider(provider, () => { logouts++; });
  await runtime.activate();
  await assert.rejects(runtime.deactivate(), /could not close/);
  assert.equal(runtime.getSnapshot().ready, false);
  assert.match(runtime.getSnapshot().error, /could not close/);
  await assert.rejects(runtime.activate(), /could not close/);
  await assert.rejects(runtime.signOut('anthropic'), /could not close/);
  assert.equal(metrics.opens, 1, 'an uncertain previous owner is never replaced by another connection');
  assert.equal(logouts, 0);
  assert.match(runtime.getSnapshot().error, /could not close/);
});

for (const [checkNumber, label] of [[1, 'runtime auth check'], [2, 'service resume auth check']]) {
  test(`backgrounding during the ${label} does not restart persisted work`, { timeout: 10_000 }, async (t) => {
    const providerStarted = Promise.withResolvers();
    const provider = scriptedModels([
      (request) => { const response = controlledReply(request); providerStarted.resolve(); return response.stream; },
      { chunks: ['Recovered after returning to the app.'] },
    ]);
    const { runtime, metrics, submissions } = await fixture(t, provider);
    await runtime.activate();
    const id = await runtime.createChat();
    await runtime.send(id, 'Wait for a foreground recovery.');
    await providerStarted.promise;
    await runtime.deactivate();

    const checking = Promise.withResolvers();
    const release = Promise.withResolvers();
    const checkAuth = provider.models.checkAuth.bind(provider.models);
    let checks = 0;
    provider.models.checkAuth = async (...args) => {
      checks++;
      if (checks === checkNumber) { checking.resolve(); await release.promise; }
      return checkAuth(...args);
    };
    const activate = runtime.activate();
    await checking.promise;
    const deactivate = runtime.deactivate();
    release.resolve();
    await Promise.all([activate, deactivate]);
    assert.equal(provider.requests.length, 1, 'no new provider request is dispatched after backgrounding');
    assert.equal(metrics.active, 0);
    assert.equal(runtime.getSnapshot().ready, false);
    assert.equal((await submissions(id))[0].status, 'placed', 'the original input is still recoverable');

    provider.models.checkAuth = checkAuth;
    await runtime.activate();
    await until(() => !runtime.getConversation(id).busy && runtime.getConversation(id).messages.some(({ text }) => text === 'Recovered after returning to the app.'),
      'returning to the foreground resumes the saved request');
    assert.equal(provider.requests.length, 2);
  });
}

test('backgrounding while a send checks auth prevents submission admission and provider dispatch', { timeout: 10_000 }, async (t) => {
  const provider = scriptedModels([]);
  const { runtime, metrics, submissions } = await fixture(t, provider);
  await runtime.activate();
  const id = await runtime.createChat();
  const checking = Promise.withResolvers();
  const release = Promise.withResolvers();
  const checkAuth = provider.models.checkAuth.bind(provider.models);
  provider.models.checkAuth = async (...args) => {
    checking.resolve();
    await release.promise;
    return checkAuth(...args);
  };
  const sending = assert.rejects(runtime.send(id, 'Do not start after backgrounding.'), /Return to the app/);
  await checking.promise;
  const background = runtime.deactivate();
  release.resolve();
  await sending;
  await background;
  assert.equal(provider.requests.length, 0);
  assert.equal(metrics.active, 0);
  assert.deepEqual(await submissions(id), []);
  assert.deepEqual(runtime.getConversation(id).messages, []);
});

test('credential restoration completes independently of failed SQLite startup and runs once across foregrounds', { timeout: 10_000 }, async (t) => {
  const provider = scriptedModels([]);
  const credentials = observableCredentials(provider);
  const release = Promise.withResolvers();
  credentials.beforeRestore = () => release.promise;
  const { runtime } = await fixture(t, provider, {
    credentials, beforeOpen(count) { if (count === 1) throw new Error('Injected SQLite open failure'); },
  });
  await assert.rejects(runtime.activate(), /SQLite open failure/);
  assert.equal(credentials.restores, 1);
  assert.equal(credentials.getProviderSnapshot('anthropic').ready, false);
  release.resolve();
  await until(() => credentials.getProviderSnapshot('anthropic').ready,
    'account restoration finishes despite the database error');
  assert.equal(credentials.getProviderSnapshot('anthropic').connected, true);
  await runtime.activate();
  assert.equal(runtime.getSnapshot().ready, true);
  assert.equal(credentials.listenerCount, 1, 'repeated activation adds no duplicate credential subscription');
  await runtime.deactivate();
  assert.equal(credentials.listenerCount, 0);
  await runtime.activate();
  assert.equal(credentials.restores, 1, 'foregrounding uses the in-memory credential and Pi refresh, not a forced disk reload');
  assert.equal(credentials.listenerCount, 1);
  assert.equal(provider.requests.length, 0);
});

test('an initial secure-storage error keeps chat history available and explicit retry restores the connection', { timeout: 10_000 }, async (t) => {
  const provider = scriptedModels([{ chunks: ['Connected after unlocking.'] }]);
  const modelId = provider.models.getModels('anthropic')[0].id;
  const selected = { model: { provider: 'anthropic', modelId }, thinkingLevel: 'high' };
  addFutureProvider(provider);
  const credentials = observableCredentials(provider);
  credentials.restoreError = 'Could not restore your saved provider credentials. Unlock this device and try again.';
  const { runtime, submissions } = await fixture(t, provider, { credentials });
  await runtime.activate();
  assert.equal(runtime.getSnapshot().ready, true);
  assert.equal(credentials.getProviderSnapshot('anthropic').ready, true);
  // The locked provider cannot start a chat; another connected provider can, and history stays editable.
  const id = await runtime.createChat();
  await runtime.updateSettings(id, selected);
  await runtime.renameChat(id, 'Available while locked');
  await assert.rejects(runtime.send(id, 'Do not admit before authentication.'), /Unlock this device/);
  assert.deepEqual(runtime.getConversation(id).messages, []);
  await runtime.deactivate();
  assert.deepEqual(await submissions(id), []);
  await runtime.activate();
  assert.equal(runtime.getConversation(id).title, 'Available while locked');
  assert.equal(credentials.restores, 1, 'a failed read is retried explicitly, not on every foreground');
  credentials.restoreError = undefined;
  await runtime.retryAuth('anthropic');
  assert.equal(credentials.restores, 2);
  await runtime.send(id, 'Now authentication works.');
  await until(() => !runtime.getConversation(id).busy, 'the request after retry completes');
  assert.equal(provider.requests.length, 1);
});

test('a transient auth refresh failure occurs before durable admission and a retry preserves the credential', { timeout: 10_000 }, async (t) => {
  const provider = scriptedModels([{ chunks: ['Retried successfully.'] }]);
  const credentials = observableCredentials(provider);
  const { runtime, submissions } = await fixture(t, provider, { credentials });
  await runtime.activate();
  const id = await runtime.createChat();
  const getAuth = provider.models.getAuth.bind(provider.models);
  let failRefresh = true;
  provider.models.getAuth = async (...args) => {
    if (failRefresh) throw new Error('OpenAI token request failed (HTTP 503). Please try again.');
    return getAuth(...args);
  };
  await assert.rejects(runtime.send(id, 'Do not create a failed durable input.'), /HTTP 503/);
  assert.equal(runtime.getSnapshot().ready, true);
  assert.equal(credentials.getProviderSnapshot('anthropic').connected, true);
  assert.equal(provider.requests.length, 0);
  assert.deepEqual(runtime.getConversation(id).messages, []);
  await runtime.deactivate();
  assert.deepEqual(await submissions(id), []);
  await runtime.activate();
  assert.equal(runtime.getSnapshot().ready, true, 'failed foreground refresh does not close readable history');
  failRefresh = false;
  await runtime.retryAuth('anthropic');
  await runtime.send(id, 'Send after the connection recovers.');
  await until(() => !runtime.getConversation(id).busy, 'the recovered connection completes a reply');
  assert.equal(provider.requests.length, 1);
});

for (const invalidation of [
  { access: { ready: true, connected: false, error: 'Your provider session expired. Sign in again.' }, stored: false },
  { access: { ready: true, connected: false, type: 'oauth',
    error: 'Could not save your saved provider credentials. Unlock this device and try again.' }, stored: true },
]) {
  test(`credential invalidation pauses an active generation while preserving readable history (credential ${invalidation.stored ? 'retained' : 'removed'})`, { timeout: 10_000 }, async (t) => {
    const started = Promise.withResolvers();
    let active;
    const provider = scriptedModels([
      (request) => { active = controlledReply(request); started.resolve(); return active.stream; },
      { chunks: ['Recovered with a usable credential.'] },
    ]);
    const credentials = observableCredentials(provider);
    const { runtime, metrics } = await fixture(t, provider, { credentials });
    await runtime.activate();
    const id = await runtime.createChat();
    await runtime.send(id, 'Keep this input recoverable.');
    await started.promise;
    active.text('Partial before credential invalidation.');
    await until(() => runtime.getConversation(id).messages.some(({ text }) => text.includes('Partial before')), 'the partial is persisted');
    credentials.set(invalidation.access, invalidation.stored);
    await until(() => metrics.opens === 2 && runtime.getSnapshot().ready, 'the scheduler closes and saved history reopens paused');
    assert.equal(active.signal.aborted, true);
    assert.equal(runtime.getConversation(id).pending, true);
    assert.equal(runtime.getConversation(id).busy, false);
    assert.equal(provider.requests.length, 1);
    await assert.rejects(runtime.resume(), /session expired|Unlock this device/);
    assert.equal(provider.requests.length, 1);
    credentials.restored = { ready: true, connected: true };
    await runtime.retryAuth('anthropic');
    await until(() => !runtime.getConversation(id).busy && !runtime.getConversation(id).pending, 'the original input resumes after an explicit credential retry');
    assert.equal(provider.requests.length, 2);
    assert.equal(runtime.getConversation(id).messages.filter(({ role }) => role === 'user').length, 1);
    assert.equal(metrics.maxActive, 1);
  });
}

test('failed secure deletion retains sign-out intent across foregrounding and send attempts', { timeout: 10_000 }, async (t) => {
  const started = Promise.withResolvers();
  let active;
  const provider = scriptedModels([(request) => {
    active = controlledReply(request); started.resolve(); return active.stream;
  }]);
  const credentials = observableCredentials(provider);
  const { runtime, metrics } = await fixture(t, provider, { credentials });
  let deletes = 0;
  logoutProvider(provider, () => {
    assert.equal(active.signal.aborted, true);
    assert.equal(metrics.active, 0);
    deletes++;
    if (deletes === 1) throw new Error('Injected secure-store deletion failure');
    credentials.set({ ready: true, connected: false });
  });
  await runtime.activate();
  const id = await runtime.createChat();
  await runtime.send(id, 'Remain paused after a failed sign-out.');
  await started.promise;
  const signingOut = runtime.signOut('anthropic');
  assert.equal(runtime.getSnapshot().signOutPending, true, 'sign-out immediately prevents further dispatch');
  await assert.rejects(signingOut, /Retry removal/);
  assert.equal(runtime.getSnapshot().signOutPending, true, 'failed deletion keeps the sign-out intent');
  assert.equal(runtime.getSnapshot().ready, true);
  assert.equal(credentials.getProviderSnapshot('anthropic').connected, true,
    'failed deletion leaves the stored credential intact');
  assert.equal(runtime.getConversation(id).pending, true);
  assert.equal(provider.requests.length, 1);
  await runtime.deactivate();
  await runtime.activate();
  await assert.rejects(runtime.send(id, 'Still blocked.'), /Finish signing out/);
  await assert.rejects(runtime.resume(), /Finish signing out/);
  await assert.rejects(runtime.retryAuth('anthropic'), /Finish signing out/);
  assert.equal(provider.requests.length, 1);
  assert.equal(runtime.getSnapshot().ready, true);
  await runtime.signOut('anthropic');
  assert.equal(runtime.getSnapshot().signOutPending, false);
  assert.equal(runtime.getSnapshot().error, undefined, 'the removal failure notice clears after a successful retry');
  assert.equal(credentials.getProviderSnapshot('anthropic').connected, false);
  await assert.rejects(runtime.resume(), /Sign in/);
  assert.equal(provider.requests.length, 1);
  assert.equal(metrics.maxActive, 1);
});

test('OAuth remains available when SQLite startup fails and reports reopening independently from a committed login', { timeout: 10_000 }, async (t) => {
  const provider = await oauthProvider([{ chunks: ['Connected after chat storage recovered.'] }]);
  let unavailable = true;
  const { runtime, metrics } = await fixture(t, provider, {
    beforeOpen() { if (unavailable) throw new Error('Synthetic SQLite unavailable'); },
  });
  await assert.rejects(runtime.activate(), /Synthetic SQLite unavailable/);
  const signingIn = runtime.login('openai', loginInteraction());
  await provider.entered.promise;
  assert.equal(metrics.opens, 1, 'OAuth does not wait for another database-open attempt');
  assert.equal(metrics.active, 0);
  provider.release.resolve();
  await signingIn;
  assert.deepEqual(await provider.credentials.read('openai'), provider.result, 'committed credentials remain available despite database failure');
  assert.equal(provider.mutations.length, 1);
  assert.equal(metrics.opens, 2, 'chat recovery is attempted after independent OAuth completes');
  assert.equal(runtime.getSnapshot().ready, false);
  assert.match(runtime.getSnapshot().error, /Synthetic SQLite unavailable/);
  assert.equal(provider.requests.length, 0);
  unavailable = false;
  await runtime.activate();
  assert.equal(runtime.getSnapshot().error, undefined);
  const id = await createOpenAIChat(runtime, provider);
  await runtime.send(id, 'Use the saved account after storage recovery.');
  await until(() => !runtime.getConversation(id).busy, 'chat storage recovers without repeating OAuth');
  assert.equal(provider.requests[0].options.apiKey, provider.result.access);
});

test('failed SQLite reopening after OAuth keeps the new account and the original pending input recoverable', { timeout: 10_000 }, async (t) => {
  let active;
  const provider = await oauthProvider([
    (request) => { active = controlledReply(request); return active.stream; },
    { chunks: ['Recovered under the new account.'] },
  ]);
  let failReopen = false;
  const { runtime, metrics } = await fixture(t, provider, {
    beforeOpen() { if (failReopen) throw new Error('Synthetic reopen failure'); },
  });
  await runtime.activate();
  const id = await createOpenAIChat(runtime, provider);
  await runtime.send(id, 'Preserve the original input.');
  await until(() => !!active, 'the old account starts its transport');
  failReopen = true;
  const signingIn = runtime.login('openai', loginInteraction());
  await provider.entered.promise;
  assert.equal(active.signal.aborted, true);
  assert.equal(metrics.active, 0, 'the previous scheduler is fully closed before browser sign-in');
  provider.release.resolve();
  await signingIn;
  assert.equal(provider.requests.length, 1);
  assert.deepEqual(await provider.credentials.read('openai'), provider.result);
  assert.match(runtime.getSnapshot().error, /Synthetic reopen failure/);
  failReopen = false;
  await runtime.activate();
  await until(() => !runtime.getConversation(id).busy && !runtime.getConversation(id).pending, 'the saved input resumes when storage becomes available');
  assert.equal(provider.requests.length, 2);
  assert.equal(provider.requests[1].options.apiKey, provider.result.access);
  assert.equal(runtime.getConversation(id).messages.filter(({ role }) => role === 'user').length, 1);
  assert.equal(metrics.maxActive, 1);
});

test('SQLite recovery failure does not replace an OAuth cancellation error or lock out another attempt', { timeout: 10_000 }, async (t) => {
  const provider = await oauthProvider([]);
  const { runtime } = await fixture(t, provider, {
    beforeOpen() { throw new Error('Synthetic SQLite unavailable'); },
  });
  await assert.rejects(runtime.activate(), /Synthetic SQLite unavailable/);
  const controller = new AbortController();
  const signingIn = runtime.login('openai', loginInteraction(controller.signal));
  await provider.entered.promise;
  const cancelled = assert.rejects(signingIn, /Synthetic user cancellation/);
  controller.abort(new Error('Synthetic user cancellation'));
  await cancelled;
  assert.deepEqual(await provider.credentials.read('openai'), provider.previous);
  assert.match(runtime.getSnapshot().error, /Synthetic SQLite unavailable/);
  provider.release.resolve();
  await new Promise((resolve) => setImmediate(resolve));
  await runtime.login('openai', loginInteraction());
  assert.deepEqual(await provider.credentials.read('openai'), provider.result);
});

test('failure to close a live scheduler still prevents OAuth and keeps the existing close failure gate', { timeout: 10_000 }, async (t) => {
  const provider = await oauthProvider([]);
  const { runtime, metrics } = await fixture(t, provider, { failClose: () => true });
  await runtime.activate();
  let logins = 0;
  const login = provider.models.login.bind(provider.models);
  provider.models.login = (...args) => { logins++; return login(...args); };
  await assert.rejects(runtime.login('openai', loginInteraction()), /Chat storage could not close/);
  assert.equal(logins, 0);
  assert.deepEqual(await provider.credentials.read('openai'), provider.previous);
  assert.equal(provider.mutations.length, 0);
  assert.equal(metrics.opens, 1, 'a second owner cannot open while the previous close is uncertain');
  assert.equal(runtime.getSnapshot().ready, false);
  assert.match(runtime.getSnapshot().error, /Chat storage could not close/);
  await assert.rejects(runtime.login('openai', loginInteraction()), /Chat storage could not close/);
  assert.equal(logins, 0);
});
