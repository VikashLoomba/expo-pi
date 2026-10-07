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
import { readChat, watchChat } from './helpers/chat-view.mjs';
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

async function fixture(t, provider, { beforeOpen, configureStorage, credentials } = {}) {
  const directory = await mkdtemp(join(tmpdir(), 'pi-chat-runtime-'));
  const filename = join(directory, 'chat.sqlite');
  const connections = new Set();
  const runtimes = new Set();
  const metrics = { opens: 0, active: 0, maxActive: 0 };
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
        await native.closeAsync();
        connections.delete(native);
        metrics.active--;
      },
    });
    const storage = await SqliteStorage.open(adapter);
    configureStorage?.(storage);
    return storage;
  };
  const create = () => {
    const runtime = new ChatRuntime({ models: provider.models, openStorage, credentials });
    runtimes.add(runtime);
    return runtime;
  };
  t.after(async () => {
    await Promise.allSettled([...runtimes].map((runtime) => runtime.close()));
    await Promise.allSettled([...connections].map((native) => native.closeAsync()));
    await rm(directory, { recursive: true, force: true });
  });
  return {
    runtime: create(), metrics,
    /** Close this runtime as app teardown does and open the next process's runtime on the same database. */
    async restart(runtime) {
      await runtime.close();
      const next = create();
      await next.open();
      return next;
    },
    async submissions(id) {
      assert.equal(metrics.active, 0, 'inspect stored records only while the runtime connection is closed');
      const storage = await SqliteStorage.open(createExpoSqliteDatabase(createNodeSqliteConnection(filename)));
      try {
        return (await storage.scanSubmissions({ conversationId: id }, 100, undefined, BACKGROUND_CONTEXT)).items;
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

const textOf = (conversation) => conversation.messages.map(({ text }) => text).join('\n');
const users = (conversation) => conversation.messages.filter(({ role }) => role === 'user');

/** Wait until the open chat shows `text` and has settled. */
async function answered(runtime, id, text) {
  const chat = await watchChat(runtime, id);
  try {
    await until(() => !chat.conversation.busy && textOf(chat.conversation).includes(text), `the chat shows ${text}`);
    return chat.conversation;
  } finally { chat.close(); }
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
async function oauthProvider(script) {
  const scripted = scriptedModels(script);
  const credentials = new InMemoryCredentialStore();
  const previous = { type: 'api_key', key: 'synthetic-previous-api-key' };
  await credentials.modify('openai', async () => previous);
  const mutations = [];
  const modify = credentials.modify.bind(credentials);
  credentials.modify = (id, action, options) => modify(id, async (current) => {
    const next = await action(current);
    if (id === 'openai' && next?.access !== current?.access && next?.type === 'oauth') mutations.push(next);
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

test('signing in with ChatGPT keeps the open chat readable and its next request uses the new account', { timeout: 10_000 }, async (t) => {
  const provider = await oauthProvider([{ chunks: ['Answered with the API key.'] }, { chunks: ['Answered with ChatGPT.'] }]);
  const { runtime } = await fixture(t, provider);
  await runtime.open();
  const id = await createOpenAIChat(runtime, provider);
  const chat = await watchChat(runtime, id);
  t.after(chat.close);
  await runtime.send(id, 'Use the saved API key.');
  await until(() => !chat.conversation.busy && textOf(chat.conversation).includes('Answered with the API key.'),
    'the first answer arrives');
  const signingIn = runtime.login('openai', loginInteraction());
  await provider.entered.promise;
  assert.equal(runtime.getSnapshot().ready, true, 'chats stay open while the browser sign-in runs');
  assert.match(textOf(chat.conversation), /Answered with the API key/);
  provider.release.resolve();
  await signingIn;
  assert.equal(provider.mutations.length, 1);
  await runtime.send(id, 'Use ChatGPT now.');
  await until(() => !chat.conversation.busy && textOf(chat.conversation).includes('Answered with ChatGPT.'),
    'the open chat shows the answer from the new account');
  assert.equal(provider.requests[0].options.apiKey, provider.previous.key);
  assert.equal(provider.requests[1].options.apiKey, provider.result.access);
  assert.equal(users(chat.conversation).length, 2);
});

test('cancelling OAuth preserves the previous credential and late browser completion cannot replace it', { timeout: 10_000 }, async (t) => {
  const provider = await oauthProvider([{ chunks: ['Still using the saved API key.'] }]);
  const { runtime } = await fixture(t, provider);
  await runtime.open();
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
  await answered(runtime, id, 'Still using the saved API key.');
  assert.equal(provider.requests[0].options.apiKey, provider.previous.key);
});

test('sign-out aborts pending OAuth and a late provider result cannot recreate the removed connection', { timeout: 10_000 }, async (t) => {
  const provider = await oauthProvider([]);
  const { runtime } = await fixture(t, provider);
  await runtime.open();
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
  await assert.rejects(runtime.send(id, 'Do not restore a signed-out account.'), /Sign in or connect OpenAI/);
  assert.equal(provider.requests.length, 0);
});

test('a selected provider works while another is disconnected and settings survive reopening', async (t) => {
  const provider = scriptedModels([{ chunks: ['Answered through the selected provider.'] }], { authenticated: false });
  const settings = addFutureProvider(provider);
  const credentials = observableCredentials(provider);
  credentials.getProviderSnapshot = (providerId) => providerId === 'future-provider'
    ? { ready: true, connected: true } : { ready: true, connected: false };
  const { runtime, restart } = await fixture(t, provider, { credentials });
  await runtime.open();
  const id = await runtime.createChat();
  await runtime.updateSettings(id, settings);
  assert.deepEqual((await readChat(runtime, id)).settings, settings);
  await runtime.send(id, 'Use the selected provider.');
  await answered(runtime, id, 'Answered through the selected provider.');
  assert.equal(provider.requests[0].model.provider, 'future-provider');
  assert.equal(provider.requests[0].options.reasoning, 'high');
  const reopened = await restart(runtime);
  assert.deepEqual((await readChat(reopened, id)).settings, settings);
});

test('a disconnected provider in one recovered chat does not block sending in another', { timeout: 10_000 }, async (t) => {
  const started = Promise.withResolvers();
  const provider = scriptedModels([
    (request) => { started.resolve(); return controlledReply(request).stream; },
    { chunks: ['The primary chat answered.'] },
  ]);
  const access = { connected: true };
  const settings = addFutureProvider(provider, access);
  const { runtime, restart } = await fixture(t, provider);
  await runtime.open();
  const primary = await runtime.createChat();
  const future = await runtime.createChat();
  await runtime.updateSettings(future, settings);
  await runtime.send(future, 'Future provider pending input.');
  await started.promise;
  access.connected = false;
  const reopened = await restart(runtime);
  await reopened.send(primary, 'Answer while the other provider is disconnected.');
  await answered(reopened, primary, 'The primary chat answered.');
  const chat = await watchChat(reopened, future);
  t.after(chat.close);
  await until(() => !chat.conversation.busy && !!chat.conversation.error, 'the recovered chat fails visibly');
  assert.match(chat.conversation.error, /future-provider/);
  assert.equal(provider.requests.length, 2, 'the disconnected provider sends no request');
});

test('failed provider removal cannot be bypassed by disconnecting another account', async (t) => {
  const provider = scriptedModels([]);
  addFutureProvider(provider);
  const { runtime } = await fixture(t, provider);
  await runtime.open();
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
  assert.equal(runtime.getSnapshot().error, undefined, 'the removal failure clears after a successful retry');
});

test('signing out keeps chats readable, and signing in again continues the same chat', { timeout: 10_000 }, async (t) => {
  const provider = scriptedModels([{ chunks: ['Before signing out.'] }, { chunks: ['After signing in again.'] }]);
  logoutProvider(provider);
  const { runtime } = await fixture(t, provider);
  await runtime.open();
  const id = await runtime.createChat();
  const chat = await watchChat(runtime, id);
  t.after(chat.close);
  await runtime.send(id, 'Save this conversation.');
  await until(() => !chat.conversation.busy && textOf(chat.conversation).includes('Before signing out.'), 'first answer');
  const before = structuredClone(chat.conversation.messages);
  await runtime.signOut('anthropic');
  assert.equal(runtime.getSnapshot().ready, true);
  assert.deepEqual(chat.conversation.messages, before, 'the open chat still shows its history');
  await assert.rejects(runtime.send(id, 'Cannot run while signed out.'), /sign in/i);
  assert.equal(provider.requests.length, 1);
  provider.auth.authenticated = true;
  await runtime.send(id, 'Signed in again.');
  await until(() => !chat.conversation.busy && textOf(chat.conversation).includes('After signing in again.'),
    'the chat continues after signing in again');
  assert.equal(provider.requests.length, 2);
});

test('closing the app mid-answer and opening it again finishes the same persisted input once', { timeout: 10_000 }, async (t) => {
  const started = Promise.withResolvers();
  let active;
  const provider = scriptedModels([
    (request) => { active = controlledReply(request); started.resolve(); return active.stream; },
    { chunks: ['Recovered on reopen.'] },
  ]);
  const { runtime, metrics, restart, submissions } = await fixture(t, provider);
  await runtime.open();
  const id = await runtime.createChat();
  const chat = await watchChat(runtime, id);
  await runtime.send(id, 'Remember this pending input.');
  await started.promise;
  active.text('Started before closing.');
  await until(() => textOf(chat.conversation).includes('Started before closing.'), 'the partial commits before closing');
  chat.close();
  await runtime.close();
  assert.equal(active.signal.aborted, true);
  assert.equal(runtime.getSnapshot().ready, false);
  const before = await submissions(id);
  assert.equal(before.length, 1);
  assert.equal(before[0].status, 'placed');
  const reopened = await restart(runtime);
  const conversation = await answered(reopened, id, 'Recovered on reopen.');
  assert.equal(provider.requests.length, 2);
  assert.equal(users(conversation).length, 1);
  await reopened.close();
  const after = await submissions(id);
  assert.equal(after.length, 1);
  assert.equal(after[0].id, before[0].id);
  assert.equal(after[0].status, 'done');
  assert.equal(metrics.maxActive, 1);
});

test('open, close and open again never own two database connections', { timeout: 10_000 }, async (t) => {
  const opening = Promise.withResolvers();
  const release = Promise.withResolvers();
  const provider = scriptedModels([], { authenticated: false });
  const { runtime, metrics } = await fixture(t, provider, {
    async beforeOpen(count) { if (count === 1) { opening.resolve(); await release.promise; } },
  });
  const first = runtime.open();
  await opening.promise;
  const closing = runtime.close();
  const again = runtime.open();
  release.resolve();
  await Promise.all([first, closing, again]);
  assert.equal(runtime.getSnapshot().ready, true);
  assert.equal(metrics.active, 1);
  assert.equal(metrics.maxActive, 1);
  assert.equal(metrics.opens, 2);
  assert.equal(provider.requests.length, 0);
  await runtime.close();
  assert.equal(metrics.active, 0);
});

test('signed-out users can reopen and read existing chats without dispatching any model request', { timeout: 10_000 }, async (t) => {
  const provider = scriptedModels([{ chunks: ['Saved before signout.'] }]);
  const { runtime, restart } = await fixture(t, provider);
  logoutProvider(provider);
  await runtime.open();
  const id = await runtime.createChat();
  await runtime.send(id, 'Save this conversation.');
  const messages = structuredClone((await answered(runtime, id, 'Saved before signout.')).messages);
  await runtime.signOut('anthropic');
  const reopened = await restart(runtime);
  assert.equal(reopened.getSnapshot().ready, true);
  assert.ok(reopened.getSnapshot().chats.some((chat) => chat.id === id));
  assert.deepEqual((await readChat(reopened, id)).messages, messages);
  assert.equal(provider.requests.length, 1);
});

test('partial response updates reach the open chat while the list previews the sent message', { timeout: 10_000 }, async (t) => {
  const started = Promise.withResolvers();
  let active;
  const provider = scriptedModels([(request) => {
    active = controlledReply(request); started.resolve(); return active.stream;
  }]);
  const { runtime } = await fixture(t, provider);
  await runtime.open();
  const id = await runtime.createChat();
  const chat = await watchChat(runtime, id);
  t.after(chat.close);
  await runtime.send(id, 'Stream the answer.');
  await started.promise;
  active.text('Partial text.');
  await until(() => chat.conversation.messages.some(({ streaming, text }) => streaming && text === 'Partial text.'),
    'the partial reaches the open chat');
  assert.equal(runtime.getSnapshot().chats.find((summary) => summary.id === id).preview, 'Stream the answer.');
  active.finish();
  await until(() => !chat.conversation.busy, 'the streamed reply settles');
  assert.equal(chat.conversation.messages.at(-1).text, 'Partial text.');
});

test('chat controls report work, failures, renames and archiving', { timeout: 10_000 }, async (t) => {
  const started = Promise.withResolvers();
  let active;
  const provider = scriptedModels([(request) => {
    active = controlledReply(request); started.resolve(); return active.stream;
  }]);
  const { runtime, restart } = await fixture(t, provider);
  await runtime.open();
  const id = await runtime.createChat();
  const controls = await watchChat(runtime, id, { transcript: false });
  t.after(controls.close);
  assert.equal(controls.conversation.busy, false);
  assert.deepEqual(controls.conversation.messages, [], 'controls alone never read the transcript');
  await runtime.send(id, 'Stream a response that fails.');
  await started.promise;
  await until(() => controls.conversation.busy, 'the chat is working');
  active.text('Partial one.');
  active.finish({ error: 'A useful provider failure.' });
  await until(() => controls.conversation.error === 'A useful provider failure.', 'the failure reaches the controls');
  assert.equal(controls.conversation.busy, false);
  await runtime.renameChat(id, 'Updated header');
  await until(() => controls.conversation.title === 'Updated header', 'the rename reaches the controls');
  await runtime.archiveChat(id);
  const reopened = await restart(runtime);
  assert.equal(reopened.getSnapshot().chats.some((chat) => chat.id === id), false);
  assert.equal((await readChat(reopened, id)).title, 'Updated header', 'an archived chat still opens by its ID');
});

test('an open failure releases the acquired database and a later open can retry', { timeout: 10_000 }, async (t) => {
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
  await assert.rejects(runtime.open(), /Injected conversation read failure/);
  assert.equal(metrics.active, 0);
  assert.equal(runtime.getSnapshot().ready, false);
  assert.match(runtime.getSnapshot().error, /Injected conversation read failure/);
  await runtime.open();
  assert.equal(metrics.active, 1);
  assert.equal(metrics.maxActive, 1);
  assert.equal(runtime.getSnapshot().ready, true);
  assert.equal(runtime.getSnapshot().error, undefined);
});

test('credential restoration completes independently of failed SQLite startup and runs once', { timeout: 10_000 }, async (t) => {
  const provider = scriptedModels([]);
  const credentials = observableCredentials(provider);
  const release = Promise.withResolvers();
  credentials.beforeRestore = () => release.promise;
  const { runtime } = await fixture(t, provider, {
    credentials, beforeOpen(count) { if (count === 1) throw new Error('Injected SQLite open failure'); },
  });
  await assert.rejects(runtime.open(), /SQLite open failure/);
  assert.equal(credentials.restores, 1);
  assert.equal(credentials.getProviderSnapshot('anthropic').ready, false);
  release.resolve();
  await until(() => credentials.getProviderSnapshot('anthropic').ready,
    'account restoration finishes despite the database error');
  assert.equal(credentials.getProviderSnapshot('anthropic').connected, true);
  await runtime.open();
  assert.equal(runtime.getSnapshot().ready, true);
  assert.equal(credentials.restores, 1, 'retrying the database does not reload credentials');
  assert.equal(provider.requests.length, 0);
});

test('an initial secure-storage error keeps chat history available and explicit retry restores the connection', { timeout: 10_000 }, async (t) => {
  const provider = scriptedModels([{ chunks: ['Connected after unlocking.'] }]);
  const modelId = provider.models.getModels('anthropic')[0].id;
  const selected = { model: { provider: 'anthropic', modelId }, thinkingLevel: 'high' };
  addFutureProvider(provider);
  const credentials = observableCredentials(provider);
  credentials.restoreError = 'Could not restore your saved provider credentials. Unlock this device and try again.';
  const { runtime } = await fixture(t, provider, { credentials });
  await runtime.open();
  assert.equal(runtime.getSnapshot().ready, true);
  await until(() => credentials.getProviderSnapshot('anthropic').ready, 'restoration reports its failure');
  // The locked provider cannot start a chat; another connected provider can, and history stays editable.
  const id = await runtime.createChat();
  await runtime.updateSettings(id, selected);
  await runtime.renameChat(id, 'Available while locked');
  await assert.rejects(runtime.send(id, 'Do not admit before authentication.'), /Unlock this device/);
  const locked = await readChat(runtime, id);
  assert.deepEqual(locked.messages, []);
  assert.equal(locked.title, 'Available while locked');
  credentials.restoreError = undefined;
  await runtime.retryAuth('anthropic');
  assert.equal(credentials.restores, 2);
  await runtime.send(id, 'Now authentication works.');
  await answered(runtime, id, 'Connected after unlocking.');
  assert.equal(provider.requests.length, 1);
});

test('a transient auth refresh failure occurs before durable admission and a retry preserves the credential', { timeout: 10_000 }, async (t) => {
  const provider = scriptedModels([{ chunks: ['Retried successfully.'] }]);
  const credentials = observableCredentials(provider);
  const { runtime, restart, submissions } = await fixture(t, provider, { credentials });
  await runtime.open();
  const id = await runtime.createChat();
  const getAuth = provider.models.getAuth.bind(provider.models);
  let failRefresh = true;
  provider.models.getAuth = async (...args) => {
    if (failRefresh) throw new Error('OpenAI token request failed (HTTP 503). Please try again.');
    return getAuth(...args);
  };
  await assert.rejects(runtime.send(id, 'Do not create a failed durable input.'), /HTTP 503/);
  assert.equal(runtime.getSnapshot().ready, true, 'a failed refresh does not close readable history');
  assert.equal(credentials.getProviderSnapshot('anthropic').connected, true);
  assert.equal(provider.requests.length, 0);
  assert.deepEqual((await readChat(runtime, id)).messages, []);
  await runtime.close();
  assert.deepEqual(await submissions(id), []);
  const reopened = await restart(runtime);
  failRefresh = false;
  await reopened.send(id, 'Send after the connection recovers.');
  await answered(reopened, id, 'Retried successfully.');
  assert.equal(provider.requests.length, 1);
});
