import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { registerHooks, stripTypeScriptTypes } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { BACKGROUND_CONTEXT } from '@earendil-works/chord/context';
import { openaiProvider } from '@earendil-works/pi-ai/providers/openai';
import { AgentDoc, Harness, StorageRejected, createRegistry } from '@earendil-works/pi-durable';
import { SqliteStorage } from '@earendil-works/pi-durable/storage/sqlite';
import { createExpoSqliteDatabase } from '../src/pi/storage/expo-sqlite.ts';
import { readChat, watchChat } from './helpers/chat-view.mjs';
import { createNodeSqliteConnection } from './helpers/node-sqlite.mjs';
import { additionTool, controlledReply, scriptedModels } from './helpers/scripted-models.mjs';

// Node runs the actual app service; this resolves and transforms app TypeScript
// as Metro does. No harness, storage, or conversation mocks.
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
const { DurableChatService } = await import('../src/pi/chat-service.ts');
const { ChatMetadataDoc } = await import('../src/pi/chat-metadata.ts');
hooks.deregister();

async function fixture(t, { configureStorage } = {}) {
  const directory = await mkdtemp(join(tmpdir(), 'pi-durable-chat-'));
  const filename = join(directory, 'chat.sqlite');
  const services = new Set();
  t.after(async () => {
    await Promise.allSettled([...services].map((service) => service.close()));
    await rm(directory, { recursive: true, force: true });
  });
  const openStorage = async () => {
    const storage = await SqliteStorage.open(createExpoSqliteDatabase(createNodeSqliteConnection(filename)));
    configureStorage?.(storage);
    return storage;
  };
  return {
    openStorage,
    async open(models, options = {}) {
      const storage = await openStorage();
      const service = await DurableChatService.open({ storage, models, extensions: [additionTool], ...options });
      services.add(service);
      return service;
    },
    async close(service) {
      await service.close();
      services.delete(service);
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

function textOf(conversation) {
  return conversation.messages.map(({ text, tool }) => [text, tool?.output].filter(Boolean).join(' ')).join('\n');
}

const users = (conversation) => conversation.messages.filter(({ role }) => role === 'user');

/** A second API-key provider whose connection the test controls. */
function addProvider(provider, id, access = { connected: true }) {
  const base = provider.models.getProvider('anthropic');
  const model = { ...base.getModels()[0], provider: id, id: `${id}-model`, name: `${id} model` };
  provider.models.setProvider({ ...base, id, name: id, getModels: () => [model],
    auth: { apiKey: {
      name: `${id} key`,
      check: async () => access.connected ? { type: 'api_key' } : undefined,
      resolve: async () => access.connected ? { auth: { apiKey: `${id}-key` } } : undefined,
    } },
  });
  return { model: { provider: id, modelId: model.id }, thinkingLevel: 'high' };
}

test('a sent message streams its answer into the open chat, runs a tool, and keeps its row IDs', { timeout: 10_000 }, async (t) => {
  const file = await fixture(t);
  const started = Promise.withResolvers();
  let active;
  const provider = scriptedModels([
    (request) => { active = controlledReply(request); started.resolve(); return active.stream; },
    { chunks: ['The answer is ', '42.'] },
  ]);
  const service = await file.open(provider.models);
  const id = await service.createChat();
  const chat = await watchChat(service, id);
  t.after(chat.close);
  const submission = await service.send(id, 'Add 19 and 23.');
  await started.promise;
  active.text('Adding now.');
  await until(() => chat.conversation.messages.some(({ streaming, text }) => streaming && text.includes('Adding now.')),
    'a committed partial reaches the open chat before the provider finishes');
  const streamingId = chat.conversation.messages.find(({ streaming }) => streaming).id;
  assert.equal(chat.conversation.busy, true);
  active.finish({ tool: { a: 19, b: 23 } });
  assert.equal((await service.waitForSubmission(submission)).status, 'done');
  await until(() => !chat.conversation.busy && textOf(chat.conversation).includes('42.'), 'the open chat settles');
  const conversation = chat.conversation;
  assert.match(textOf(conversation), /The answer is 42\./);
  const tool = conversation.messages.find(({ tool }) => tool?.name === 'add_numbers');
  assert.equal(tool.tool.status, 'completed');
  assert.deepEqual(JSON.parse(tool.tool.output), { sum: 42 });
  assert.ok(conversation.messages.every(({ streaming }) => !streaming), 'settled entries replace live partials');
  assert.equal(conversation.messages.find(({ text }) => text === 'Adding now.').id, streamingId,
    'the saved assistant keeps its streaming row ID');
  assert.equal(users(conversation).length, 1);
  assert.equal(provider.requests.length, 2);
  const toolResult = provider.requests[1].context.messages.find(({ role }) => role === 'toolResult');
  assert.deepEqual(JSON.parse(toolResult.content[0].text), { sum: 42 });
  for (const { options } of provider.requests) {
    assert.equal(options.transport, 'sse');
    assert.equal(options.apiKey, 'test-only-key');
  }
  assert.deepEqual(await readChat(service, id), conversation, 'opening the chat again shows the same rows');
});

test('the open chat never shows a streamed partial beside its saved answer', { timeout: 10_000 }, async (t) => {
  const file = await fixture(t);
  const started = Promise.withResolvers();
  let active;
  const provider = scriptedModels([
    { chunks: ['An earlier answer.'] },
    (request) => { active = controlledReply(request); started.resolve(); return active.stream; },
  ]);
  const service = await file.open(provider.models);
  const id = await service.createChat();
  await service.waitForSubmission(await service.send(id, 'An earlier question.'));
  const view = service.chat(id, { transcript: true });
  const shown = [];
  const close = view.subscribe(() => {
    const conversation = view.getSnapshot().conversation;
    if (conversation) shown.push(conversation.messages.filter(({ role }) => role === 'assistant'));
  });
  t.after(close);
  await until(() => shown.length > 0, 'the chat loads');
  const submission = await service.send(id, 'Stream the next answer.');
  await started.promise;
  for (const chunk of ['First. ', 'Second. ', 'Third.']) {
    active.text(chunk);
    await new Promise((resolve) => setTimeout(resolve, 120));
  }
  active.finish();
  await service.waitForSubmission(submission);
  await until(() => shown.at(-1).length === 2 && !shown.at(-1)[1].streaming, 'the answer is saved');
  assert.ok(shown.some((rows) => rows.at(-1)?.streaming), 'the answer streamed into the open chat');
  for (const rows of shown) {
    assert.ok(rows.length <= 2, `one row per answer, saw ${rows.map(({ id, streaming }) => `${id}${streaming ? '*' : ''}`)}`);
  }
});

test('a retried request shows one answer, and a failure that is not retried stays visible', { timeout: 15_000 }, async (t) => {
  const file = await fixture(t);
  const provider = scriptedModels([
    (request) => {
      const attempt = controlledReply(request);
      attempt.text('Half an ans');
      attempt.finish({ error: 'fetch failed: network connection lost' });
      return attempt.stream;
    },
    { chunks: ['Half an answer, now complete.'] },
    { error: 'Scripted provider refusal' },
  ]);
  const service = await file.open(provider.models);
  const id = await service.createChat();
  const chat = await watchChat(service, id);
  t.after(chat.close);
  const submission = await service.send(id, 'Question');
  await until(() => chat.conversation.retrying, 'the chat shows that it will retry');
  assert.deepEqual(chat.conversation.messages.filter(({ role }) => role === 'assistant'), [],
    'a failed attempt is not shown while the retry waits');
  assert.equal((await service.waitForSubmission(submission)).status, 'done');
  await until(() => !chat.conversation.busy && !chat.conversation.retrying, 'the retried answer settles');
  const answers = chat.conversation.messages.filter(({ role }) => role === 'assistant');
  assert.deepEqual(answers.map(({ text, error }) => [text, error]), [['Half an answer, now complete.', undefined]]);
  assert.equal(provider.requests.length, 2);
  await service.waitForSubmission(await service.send(id, 'Ask again.'));
  await until(() => !!chat.conversation.error, 'the failure settles');
  const after = chat.conversation.messages.filter(({ role }) => role === 'assistant');
  assert.deepEqual(after.map(({ text, error }) => [text, error]),
    [['Half an answer, now complete.', undefined], ['', 'Scripted provider refusal']]);
  assert.deepEqual(await readChat(service, id), chat.conversation, 'reopening the chat shows the same rows');
});

test('a send whose list update fails still resolves, reports it, and the next send clears the report', { timeout: 10_000 }, async (t) => {
  let storage;
  let rejectListUpdate;
  const file = await fixture(t, { configureStorage(opened) {
    storage = opened;
    const commit = opened.commit.bind(opened);
    // Reject only the chat-list update that follows an admitted message, leaving the session usable.
    opened.commit = (writes, context) => {
      if (rejectListUpdate !== undefined && writes.some((write) => write.type === 'document.change' && write.id === rejectListUpdate)) {
        rejectListUpdate = undefined;
        return Promise.reject(new StorageRejected('Injected chat list failure'));
      }
      return commit(writes, context);
    };
  } });
  const service = await file.open(scriptedModels([{ chunks: ['First answer.'] }, { chunks: ['Second answer.'] }]).models);
  const id = await service.createChat();
  rejectListUpdate = (await storage.findDocument({ kind: ChatMetadataDoc.definition.kind,
    scope: { kind: 'conversation', conversationId: id } }, 'current', BACKGROUND_CONTEXT)).id;
  const first = await service.send(id, 'First question.');
  assert.equal(rejectListUpdate, undefined, 'the list update was attempted and rejected');
  assert.match(service.getSnapshot().error, /Injected chat list failure/);
  assert.equal((await service.waitForSubmission(first)).status, 'done', 'the admitted message is still answered');
  await service.waitForSubmission(await service.send(id, 'Second question.'));
  assert.equal(service.getSnapshot().error, undefined);
  assert.equal(service.getSnapshot().chats[0].preview, 'Second question.');
  assert.equal(users(await readChat(service, id)).length, 2, 'neither message was sent twice');
});

test('chat identity, title, preview, archive state and transcript survive reopening and support followup', { timeout: 10_000 }, async (t) => {
  const file = await fixture(t);
  const firstProvider = scriptedModels([{ chunks: ['Remembered blue.'] }]);
  const first = await file.open(firstProvider.models);
  const id = await first.createChat();
  const archivedId = await first.createChat();
  const submission = await first.send(id, 'Remember my favorite color is blue.');
  await first.waitForSubmission(submission);
  assert.equal(first.getSnapshot().chats[0].title, 'Remember my favorite color is blue.',
    'an untitled chat is named after its first message');
  await first.renameChat(id, 'Favorite color');
  await first.archiveChat(archivedId);
  const previousMessages = (await readChat(first, id)).messages;
  await file.close(first);

  const secondProvider = scriptedModels([{ chunks: ['Your favorite color is blue.'] }]);
  const second = await file.open(secondProvider.models);
  assert.equal(secondProvider.requests.length, 0, 'opening stored history does not dispatch model work');
  const reopened = await readChat(second, id);
  assert.equal(reopened.title, 'Favorite color');
  assert.deepEqual(reopened.messages, previousMessages);
  assert.deepEqual(second.getSnapshot().chats.map((chat) => [chat.id, chat.title, chat.preview]),
    [[id, 'Favorite color', 'Remember my favorite color is blue.']], 'archived chats leave the list');
  await second.waitForSubmission(await second.send(id, 'What is my favorite color?'));
  const requestText = JSON.stringify(secondProvider.requests[0].context.messages);
  assert.match(requestText, /Remember my favorite color is blue/);
  assert.match(requestText, /Remembered blue/);
  assert.match(requestText, /What is my favorite color/);
  const followup = await readChat(second, id);
  assert.equal(users(followup).length, 2);
  assert.match(textOf(followup), /Your favorite color is blue/);
  assert.equal(second.getSnapshot().chats[0].preview, 'What is my favorite color?', 'the list previews the latest message');
});

test('the chat list opens without reading any transcript', { timeout: 10_000 }, async (t) => {
  let unreadable = false;
  const file = await fixture(t, { configureStorage(storage) {
    const scan = storage.scanEntries.bind(storage);
    storage.scanEntries = (...args) => unreadable ? Promise.reject(new Error('Transcript unavailable')) : scan(...args);
  } });
  const first = await file.open(scriptedModels([{ chunks: ['Saved.'] }]).models);
  const id = await first.createChat();
  await first.waitForSubmission(await first.send(id, 'Keep this chat in the list.'));
  await file.close(first);
  unreadable = true;
  const second = await file.open(scriptedModels([]).models);
  assert.deepEqual(second.getSnapshot().chats.map((chat) => [chat.id, chat.title, chat.preview]),
    [[id, 'Keep this chat in the list.', 'Keep this chat in the list.']]);
  const chat = await watchChat(second, id);
  t.after(chat.close);
  assert.equal(chat.status, 'failed', 'only opening the chat reads its transcript');
});

test('a retried requestId returns the persisted submission without another user entry or model call', { timeout: 10_000 }, async (t) => {
  const file = await fixture(t);
  const provider = scriptedModels([{ chunks: ['Once.'] }]);
  const first = await file.open(provider.models);
  const id = await first.createChat();
  const original = await first.send(id, 'Please answer once.', 'stable-request-id');
  await first.waitForSubmission(original);
  await file.close(first);
  const afterRestart = scriptedModels([]);
  const second = await file.open(afterRestart.models);
  const retried = await second.send(id, 'Please answer once.', 'stable-request-id');
  assert.equal(retried, original);
  assert.equal((await second.waitForSubmission(retried)).status, 'done');
  assert.equal(users(await readChat(second, id)).length, 1);
  assert.equal(afterRestart.requests.length, 0);
});

test('cancelling live work persists cancellation and keeps partial output without restarting on reopen', { timeout: 10_000 }, async (t) => {
  const file = await fixture(t);
  const started = Promise.withResolvers();
  let active;
  const provider = scriptedModels([(request) => {
    active = controlledReply(request); started.resolve(); return active.stream;
  }]);
  const first = await file.open(provider.models);
  const id = await first.createChat();
  const chat = await watchChat(first, id);
  const submission = await first.send(id, 'Begin a long answer.');
  await started.promise;
  active.text('Saved partial answer.');
  await until(() => textOf(chat.conversation).includes('Saved partial answer.'), 'partial is committed before cancellation');
  const partialId = chat.conversation.messages.find(({ streaming }) => streaming).id;
  await first.cancel(id);
  const settled = await first.waitForSubmission(submission);
  assert.equal(settled.status, 'unanswered');
  assert.equal(settled.reason, 'aborted');
  assert.equal(active.signal.aborted, true);
  await until(() => chat.conversation.messages.some(({ text }) => text === 'Response stopped'), 'the stop notice shows');
  assert.equal(chat.conversation.busy, false);
  assert.match(textOf(chat.conversation), /Saved partial answer/);
  assert.equal(chat.conversation.messages.find(({ interrupted }) => interrupted).id, partialId);
  chat.close();
  await file.close(first);
  const resumedProvider = scriptedModels([]);
  const second = await file.open(resumedProvider.models);
  const reopened = await readChat(second, id);
  assert.equal(reopened.busy, false);
  assert.match(textOf(reopened), /Saved partial answer/);
  assert.equal(reopened.messages.find(({ interrupted }) => interrupted).id, partialId,
    'an interrupted assistant keeps the same row ID after SQLite reopen');
  assert.equal(reopened.messages.at(-1).text, 'Response stopped');
  assert.equal((await second.waitForSubmission(submission)).reason, 'aborted');
  assert.equal(resumedProvider.requests.length, 0);
});

test('provider failure is a persisted unanswered submission, not a completed answer or retry loop', { timeout: 10_000 }, async (t) => {
  const file = await fixture(t);
  const provider = scriptedModels([{ error: 'Scripted durable provider failure' }]);
  const first = await file.open(provider.models);
  const id = await first.createChat();
  const submission = await first.send(id, 'This request will fail.');
  const result = await first.waitForSubmission(submission);
  assert.equal(result.status, 'unanswered');
  assert.equal(result.reason, 'model_error');
  assert.match(JSON.stringify(result.detail), /Scripted durable provider failure/);
  assert.equal(provider.requests.length, 1);
  const failed = await readChat(first, id);
  assert.equal(failed.busy, false);
  assert.match(failed.error, /Scripted durable provider failure/);
  await file.close(first);
  const second = await file.open(scriptedModels([]).models);
  const persisted = await second.waitForSubmission(submission);
  assert.equal(persisted.status, 'unanswered');
  assert.match(JSON.stringify(persisted.detail), /Scripted durable provider failure/);
  assert.match((await readChat(second, id)).error, /Scripted durable provider failure/);
});

test('new chats reuse the last-used model or a connected default and need a connection', { timeout: 10_000 }, async (t) => {
  const file = await fixture(t);
  const provider = scriptedModels([{ chunks: ['Answered through ChatGPT.'] }], { authenticated: false });
  const transport = provider.models.getProvider('anthropic');
  const openai = openaiProvider();
  provider.models.setProvider({ ...openai, stream: transport.stream, streamSimple: transport.streamSimple,
    auth: { apiKey: openai.auth.apiKey, oauth: {
      name: 'Synthetic ChatGPT',
      login: async () => ({ type: 'oauth', access: 'synthetic-access', refresh: 'synthetic-refresh',
        expires: Date.now() + 3_600_000 }),
      refresh: async () => { throw new Error('An unexpired test credential must not refresh.'); },
      toAuth: async (credential) => ({ apiKey: credential.access }),
    } } });
  const newChat = { preferredProvider: 'openai', models: { openai: 'gpt-6-sol', anthropic: 'claude-sonnet-5-5' } };
  const service = await file.open(provider.models, { newChat });
  await assert.rejects(service.createChat(), /Connect a provider in Account/);
  assert.deepEqual(service.getSnapshot().chats, []);

  provider.auth.authenticated = true;
  const keyOnly = await service.createChat();
  assert.deepEqual((await readChat(service, keyOnly)).settings,
    { model: { provider: 'anthropic', modelId: 'claude-sonnet-5-5' }, thinkingLevel: 'low' },
    'an API-key-only user gets that provider default at its lowest supported effort');
  await service.archiveChat(keyOnly);

  await provider.models.login('openai', 'oauth', { prompt: async () => '', notify() {} });
  const first = await service.createChat();
  assert.deepEqual((await readChat(service, first)).settings,
    { model: { provider: 'openai', modelId: 'gpt-6-sol' }, thinkingLevel: 'off' },
    'ChatGPT is preferred over a provider listed earlier, so native web search applies');
  await service.waitForSubmission(await service.send(first, 'Answer on the first send.'));
  assert.match(textOf(await readChat(service, first)), /Answered through ChatGPT/);
  assert.equal(provider.requests[0].options.apiKey, 'synthetic-access');

  const chosen = { model: { provider: 'anthropic', modelId: 'claude-sonnet-5' }, thinkingLevel: 'high' };
  await service.updateSettings(first, chosen);
  const second = await service.createChat();
  assert.deepEqual((await readChat(service, second)).settings, chosen, 'a new chat continues with the last-used model');

  provider.auth.authenticated = false;
  const third = await service.createChat();
  assert.deepEqual((await readChat(service, third)).settings.model, { provider: 'openai', modelId: 'gpt-6-sol' },
    'a last-used model whose provider is disconnected falls back to a connected default');
});

test('signed-out sends cannot create failed model work or change the conversation transcript', { timeout: 10_000 }, async (t) => {
  const file = await fixture(t);
  const provider = scriptedModels([]);
  const service = await file.open(provider.models);
  const id = await service.createChat();
  provider.auth.authenticated = false;
  const before = (await readChat(service, id)).messages;
  await assert.rejects(service.send(id, 'Do not admit this while signed out.'), /sign in/i);
  const after = await readChat(service, id);
  assert.deepEqual(after.messages, before);
  assert.equal(after.busy, false);
  assert.equal(provider.requests.length, 0);
});

test('a chat closed mid-answer resumes the same input when the app opens again', { timeout: 10_000 }, async (t) => {
  const file = await fixture(t);
  const started = Promise.withResolvers();
  let active;
  const firstProvider = scriptedModels([(request) => {
    active = controlledReply(request); started.resolve(); return active.stream;
  }]);
  const first = await file.open(firstProvider.models);
  const id = await first.createChat();
  const chat = await watchChat(first, id);
  const submission = await first.send(id, 'Recover this request.', 'recover-request');
  await started.promise;
  active.text('Before restart.');
  await until(() => textOf(chat.conversation).includes('Before restart.'), 'the partial is stored');
  chat.close();
  await file.close(first);
  assert.equal(active.signal.aborted, true, 'closing interrupts the transport without settling the durable input');

  const secondProvider = scriptedModels([{ chunks: ['Recovered answer.'] }]);
  const second = await file.open(secondProvider.models);
  const settled = await second.waitForSubmission(submission);
  assert.equal(settled.status, 'done');
  assert.equal(secondProvider.requests.length, 1);
  const conversation = await readChat(second, id);
  assert.equal(conversation.busy, false);
  assert.equal(users(conversation).length, 1);
  assert.match(textOf(conversation), /Recovered answer/);
  assert.ok(conversation.messages.find(({ text }) => text === 'Before restart.').interrupted,
    'the cut-off partial stays visible as interrupted');
});

test('recovered work whose provider is disconnected fails visibly without blocking another chat', { timeout: 10_000 }, async (t) => {
  const file = await fixture(t);
  const started = Promise.withResolvers();
  const firstProvider = scriptedModels([(request) => { started.resolve(); return controlledReply(request).stream; }]);
  const disconnected = addProvider(firstProvider, 'future-provider');
  const first = await file.open(firstProvider.models);
  const recovered = await first.createChat();
  const other = await first.createChat();
  await first.updateSettings(recovered, disconnected);
  const pending = await first.send(recovered, 'Recover me after reopening.');
  await started.promise;
  await file.close(first);

  const secondProvider = scriptedModels([{ chunks: ['The other chat answered.'] }]);
  addProvider(secondProvider, 'future-provider', { connected: false });
  const second = await file.open(secondProvider.models);
  await second.waitForSubmission(await second.send(other, 'Answer while the other provider is disconnected.'));
  assert.match(textOf(await readChat(second, other)), /The other chat answered/);
  const failure = await second.waitForSubmission(pending);
  assert.equal(failure.status, 'unanswered');
  const failed = await readChat(second, recovered);
  assert.equal(failed.busy, false);
  assert.match(failed.error, /future-provider/, 'the disconnected chat shows why it stopped');
  assert.equal(secondProvider.requests.length, 1, 'no request is sent without credentials');
});

test('separate conversations run independently and cancelling one leaves the other answer intact', { timeout: 10_000 }, async (t) => {
  const file = await fixture(t);
  const started = Promise.withResolvers();
  const provider = scriptedModels([
    (request) => { const response = controlledReply(request); started.resolve(); return response.stream; },
    { chunks: ['Second chat answer.'] },
  ]);
  const service = await file.open(provider.models);
  const first = await service.createChat();
  const second = await service.createChat();
  const pending = await service.send(first, 'Keep the first chat running.');
  await started.promise;
  await service.waitForSubmission(await service.send(second, 'Answer in the second chat.'));
  assert.ok(!JSON.stringify(provider.requests[1].context).includes('Keep the first chat running'));
  assert.equal((await readChat(service, first)).busy, true);
  assert.equal((await readChat(service, second)).busy, false);
  await service.cancel(first);
  assert.equal((await service.waitForSubmission(pending)).reason, 'aborted');
  assert.match(textOf(await readChat(service, second)), /Second chat answer/);
});

test('reused provider tool call IDs create distinct stable history rows across conversation turns', { timeout: 10_000 }, async (t) => {
  const file = await fixture(t);
  // Each scripted tool message uses addition-1, as providers may reuse IDs in
  // later requests. Stored entry identity must keep the rendered rows unique.
  const provider = scriptedModels([
    { tool: { a: 19, b: 23 } }, { chunks: ['First sum is 42.'] },
    { tool: { a: 1, b: 2 } }, { chunks: ['Second sum is 3.'] },
  ]);
  const first = await file.open(provider.models);
  const id = await first.createChat();
  await first.waitForSubmission(await first.send(id, 'Add 19 and 23.'));
  await first.waitForSubmission(await first.send(id, 'Now add 1 and 2.'));
  const tools = (await readChat(first, id)).messages.filter(({ tool }) => tool);
  assert.equal(tools.length, 2);
  assert.equal(new Set(tools.map(({ id }) => id)).size, 2, 'React list keys are unique across persisted tool rows');
  assert.deepEqual(tools.map(({ tool }) => JSON.parse(tool.output).sum), [42, 3]);
  assert.ok(tools.every(({ tool }) => tool.status === 'completed'));
  await file.close(first);
  const second = await file.open(scriptedModels([]).models);
  assert.deepEqual((await readChat(second, id)).messages.filter(({ tool }) => tool), tools);
});

test('an assistant error with no content remains in chat history after a successful followup and reopen', { timeout: 10_000 }, async (t) => {
  const file = await fixture(t);
  const provider = scriptedModels([
    { error: 'First attempt failed before producing text.' },
    { chunks: ['The followup succeeded.'] },
  ]);
  const first = await file.open(provider.models);
  const id = await first.createChat();
  await first.waitForSubmission(await first.send(id, 'First attempt.'));
  await first.waitForSubmission(await first.send(id, 'Try again.'));
  const conversation = await readChat(first, id);
  assert.equal(conversation.error, undefined, 'the latest successful run clears the current error banner');
  const failure = conversation.messages.find(({ role, error }) => role === 'assistant'
    && error === 'First attempt failed before producing text.');
  assert.ok(failure, 'a failed prior response remains visible even though it had no text');
  assert.match(textOf(conversation), /The followup succeeded/);
  await file.close(first);
  const second = await file.open(scriptedModels([]).models);
  assert.deepEqual((await readChat(second, id)).messages.find(({ id }) => id === failure.id), failure);
});

test('a partial tool keeps its row key when it commits, executes, and reloads from SQLite', { timeout: 10_000 }, async (t) => {
  const file = await fixture(t);
  const started = Promise.withResolvers();
  let active;
  let request;
  const provider = scriptedModels([
    (value) => { request = value; active = controlledReply(value); started.resolve(); return active.stream; },
    { chunks: ['The tool returned 42.'] },
  ]);
  const service = await file.open(provider.models);
  const id = await service.createChat();
  const chat = await watchChat(service, id);
  t.after(chat.close);
  const submission = await service.send(id, 'Use the addition tool.');
  await started.promise;
  const partial = {
    role: 'assistant', content: [{ type: 'toolCall', id: 'addition-1', name: 'add_numbers', arguments: { a: 19, b: 23 } }],
    api: request.model.api, provider: request.model.provider, model: request.model.id,
    timestamp: Date.now(), stopReason: 'toolUse',
    usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
  };
  active.stream.push({ type: 'toolcall_delta', contentIndex: 0, delta: JSON.stringify(partial.content[0].arguments), partial });
  await until(() => chat.conversation.messages.some(({ tool }) => tool?.name === 'add_numbers'), 'the tool partial is persisted');
  const liveTool = chat.conversation.messages.find(({ tool }) => tool);
  assert.equal(liveTool.tool.status, 'running');
  active.finish({ tool: { a: 19, b: 23 } });
  await service.waitForSubmission(submission);
  await until(() => !chat.conversation.busy, 'the answer settles');
  const settledTool = chat.conversation.messages.find(({ tool }) => tool);
  assert.equal(settledTool.id, liveTool.id);
  assert.equal(settledTool.tool.status, 'completed');
  assert.equal(JSON.parse(settledTool.tool.output).sum, 42);
  chat.close();
  await file.close(service);
  const reopened = await file.open(scriptedModels([]).models);
  assert.deepEqual((await readChat(reopened, id)).messages.find(({ tool }) => tool), settledTool);
});

test('a compaction summary shows as a notice, keeps earlier messages, and never becomes the preview', { timeout: 10_000 }, async (t) => {
  const file = await fixture(t);
  const first = await file.open(scriptedModels([{ chunks: ['First answer.'] }, { chunks: ['Second answer.'] }]).models);
  const id = await first.createChat();
  await first.waitForSubmission(await first.send(id, 'First question.'));
  await first.waitForSubmission(await first.send(id, 'Second question.'));
  const before = await readChat(first, id);
  await file.close(first);
  // The app compacts only long chats. Compact this one through the SDK with a tiny recent window.
  const summarizer = scriptedModels([{ chunks: ['A summary of the first exchange.'] }]);
  const harness = await Harness.open(await file.openStorage(), {
    models: summarizer.models, registry: createRegistry(), settings: { compaction: { keepRecentTokens: 1 } },
  }, BACKGROUND_CONTEXT);
  try {
    const conversation = await harness.conversation(id, BACKGROUND_CONTEXT);
    const task = await conversation.compact(undefined, BACKGROUND_CONTEXT);
    const { outcome } = (await harness.waitForTask(task, BACKGROUND_CONTEXT)).state;
    assert.equal(outcome.status, 'completed', JSON.stringify(outcome));
    const placed = await (await harness.submission(outcome.result.submissionId, BACKGROUND_CONTEXT)).wait(BACKGROUND_CONTEXT);
    assert.equal(placed.status, 'done');
    const view = await conversation.viewState(BACKGROUND_CONTEXT);
    const active = view.value.entries.length;
    view.dispose();
    assert.ok(active < 5, 'the active context no longer holds the summarized messages');
  } finally { await harness.close(BACKGROUND_CONTEXT); }

  const provider = scriptedModels([{ chunks: ['Third answer.'] }]);
  const service = await file.open(provider.models);
  const compacted = await readChat(service, id);
  assert.deepEqual(users(compacted).map(({ text }) => text), ['First question.', 'Second question.']);
  assert.match(textOf(compacted), /First answer\.[\s\S]*Second answer\./, 'messages before the summary stay visible');
  assert.deepEqual(compacted.messages.filter(({ role }) => role === 'notice').map(({ text }) => text),
    ['Earlier messages summarized']);
  assert.ok(!JSON.stringify(compacted.messages).includes('A summary of the first exchange'));
  assert.deepEqual(compacted.messages.filter(({ role }) => role !== 'notice').map(({ id }) => id),
    before.messages.map(({ id }) => id), 'existing rows keep their IDs');
  assert.equal(service.getSnapshot().chats[0].preview, 'Second question.');
  await service.waitForSubmission(await service.send(id, 'Third question.'));
  const requestText = JSON.stringify(provider.requests[0].context.messages);
  assert.match(requestText, /A summary of the first exchange/, 'the model sees the summary');
  const continued = await readChat(service, id);
  assert.deepEqual(users(continued).map(({ text }) => text), ['First question.', 'Second question.', 'Third question.']);
  assert.match(textOf(continued), /Third answer/);
});

test('provider, model and supported effort persist per chat and control the next request after reopen', { timeout: 10_000 }, async (t) => {
  const file = await fixture(t);
  const initial = scriptedModels([{ chunks: ['Original provider.'] }]);
  const first = await file.open(initial.models);
  const id = await first.createChat();
  const other = await first.createChat();
  const otherSettings = (await readChat(first, other)).settings;
  await first.waitForSubmission(await first.send(id, 'Remember the earlier turn.'));
  const original = initial.models.getProvider('anthropic');
  const customModel = { ...original.getModels()[0], provider: 'future-provider', id: 'future-model', name: 'Future Model' };
  initial.models.setProvider({ ...original, id: 'future-provider', name: 'Future Provider', getModels: () => [customModel] });
  const selected = { model: { provider: 'future-provider', modelId: 'future-model' }, thinkingLevel: 'high' };
  const before = await readChat(first, id);
  await first.updateSettings(id, selected);
  const after = await readChat(first, id);
  assert.deepEqual(after.settings, selected);
  assert.deepEqual(after.messages, before.messages, 'settings changes keep the transcript');
  assert.deepEqual((await readChat(first, other)).settings, otherSettings, 'other chats keep independent choices');
  assert.equal(initial.requests.length, 1, 'saving settings never makes a model request');
  await file.close(first);

  const next = scriptedModels([{ chunks: ['New provider remembered.'] }]);
  next.models.setProvider({ ...next.models.getProvider('anthropic'), id: 'future-provider', name: 'Future Provider',
    getModels: () => [customModel] });
  const second = await file.open(next.models);
  assert.deepEqual((await readChat(second, id)).settings, selected);
  assert.deepEqual((await readChat(second, other)).settings, otherSettings);
  await second.waitForSubmission(await second.send(id, 'Continue with my saved settings.'));
  assert.equal(next.requests[0].model.provider, 'future-provider');
  assert.equal(next.requests[0].model.id, 'future-model');
  assert.equal(next.requests[0].options.reasoning, 'high');
  assert.match(JSON.stringify(next.requests[0].context.messages), /Remember the earlier turn/);
});

test('settings reject unavailable models, unsupported effort and in-flight or recovered work without partial writes', { timeout: 10_000 }, async (t) => {
  const file = await fixture(t);
  const started = Promise.withResolvers();
  const provider = scriptedModels([(request) => { const reply = controlledReply(request); started.resolve(); return reply.stream; }]);
  const first = await file.open(provider.models);
  const id = await first.createChat();
  const original = (await readChat(first, id)).settings;
  const selected = { model: { provider: 'anthropic', modelId: 'claude-sonnet-5-5' }, thinkingLevel: 'high' };
  await assert.rejects(first.updateSettings(id, { ...selected, thinkingLevel: 'off' }), /reasoning|effort|support/i);
  await assert.rejects(first.updateSettings(id, { ...selected, model: { provider: 'missing', modelId: 'missing' } }),
    /available|provider/i);
  assert.deepEqual((await readChat(first, id)).settings, original);
  await first.send(id, 'Keep running.');
  await started.promise;
  await assert.rejects(first.updateSettings(id, selected), /pending response/i);
  assert.deepEqual((await readChat(first, id)).settings, original);
  await file.close(first);
  const resumed = Promise.withResolvers();
  const second = await file.open(scriptedModels([(request) => {
    const reply = controlledReply(request); resumed.resolve(); return reply.stream;
  }]).models);
  assert.equal((await readChat(second, id)).busy, true, 'recovered work continues after reopening');
  await assert.rejects(second.updateSettings(id, selected), /pending response/i);
  await resumed.promise;
  assert.deepEqual((await readChat(second, id)).settings, original);
  await second.cancel(id);
  await second.updateSettings(id, selected);
  assert.deepEqual((await readChat(second, id)).settings, selected);
});

test('unregistered saved providers survive reopening and block sends until explicitly changed', { timeout: 10_000 }, async (t) => {
  const file = await fixture(t);
  const provider = scriptedModels([]);
  const base = provider.models.getProvider('anthropic');
  provider.models.setProvider({ ...base, id: 'removed-provider', name: 'Removed provider',
    getModels: () => [{ ...base.getModels()[0], provider: 'removed-provider', id: 'saved-model' }] });
  const first = await file.open(provider.models);
  const id = await first.createChat();
  const settings = { model: { provider: 'removed-provider', modelId: 'saved-model' }, thinkingLevel: 'low' };
  await first.updateSettings(id, settings);
  await file.close(first);
  const next = scriptedModels([]);
  const second = await file.open(next.models);
  assert.deepEqual((await readChat(second, id)).settings, settings, 'catalog changes do not rewrite saved choices');
  await assert.rejects(second.send(id, 'Do not silently select another model.'), /provider|available/i);
  assert.equal((await readChat(second, id)).messages.length, 0);
  assert.equal(next.requests.length, 0);
});

test('updating existing SDK agent settings preserves unrelated fields and reads legacy omitted effort', { timeout: 10_000 }, async (t) => {
  const file = await fixture(t);
  const provider = scriptedModels([]);
  const harness = await Harness.open(await file.openStorage(), { models: provider.models, registry: createRegistry(),
    async conversationCreated(tx, conversation) { (await tx.doc(ChatMetadataDoc, conversation.id)).createdAt = Date.now(); },
  }, BACKGROUND_CONTEXT);
  const chat = await harness.createConversation({ ownership: { kind: 'ownerless' },
    agent: { model: { provider: 'anthropic', modelId: 'claude-sonnet-5' }, instructions: 'Preserve this instruction.' },
  }, BACKGROUND_CONTEXT);
  await harness.close(BACKGROUND_CONTEXT);
  const service = await file.open(provider.models);
  assert.equal((await readChat(service, chat.id)).settings.thinkingLevel, 'off');
  await service.updateSettings(chat.id, { model: { provider: 'anthropic', modelId: 'claude-sonnet-5-5' }, thinkingLevel: 'max' });
  await file.close(service);
  const verify = await Harness.open(await file.openStorage(), { models: provider.models, registry: createRegistry() }, BACKGROUND_CONTEXT);
  try {
    const agent = await verify.snapshot(AgentDoc, chat.id, BACKGROUND_CONTEXT);
    assert.equal(agent.instructions, 'Preserve this instruction.');
    assert.equal(agent.model.modelId, 'claude-sonnet-5-5');
    assert.equal(agent.thinkingLevel, 'max');
  } finally { await verify.close(BACKGROUND_CONTEXT); }
});

test('credential-specific model availability is checked before creating durable model work', { timeout: 10_000 }, async (t) => {
  const file = await fixture(t);
  const provider = scriptedModels([]);
  const base = provider.models.getProvider('anthropic');
  provider.models.setProvider({ ...base, filterModels: () => [] });
  const service = await file.open(provider.models);
  const id = await service.createChat();
  await assert.rejects(service.send(id, 'Do not send an inaccessible model.'), /not available for this account/i);
  const conversation = await readChat(service, id);
  assert.equal(conversation.messages.length, 0);
  assert.equal(conversation.busy, false);
  assert.equal(provider.requests.length, 0);
});
