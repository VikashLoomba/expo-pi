import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { registerHooks, stripTypeScriptTypes } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { BACKGROUND_CONTEXT } from '@earendil-works/chord/context';
import { Harness, LiveDoc, createRegistry } from '@earendil-works/pi-durable';
import { SqliteStorage } from '@earendil-works/pi-durable/storage/sqlite';
import { createExpoSqliteDatabase } from '../src/pi/storage/expo-sqlite.ts';
import { createNodeSqliteConnection } from './helpers/node-sqlite.mjs';
import { controlledReply, scriptedModels } from './helpers/scripted-models.mjs';

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
const { ChatMetadataDoc, DurableChatService } = await import('../src/pi/chat-service.ts');
hooks.deregister();

async function fixture(t) {
  const directory = await mkdtemp(join(tmpdir(), 'pi-durable-chat-'));
  const filename = join(directory, 'chat.sqlite');
  const services = new Set();
  t.after(async () => {
    await Promise.allSettled([...services].map((service) => service.close()));
    await rm(directory, { recursive: true, force: true });
  });
  const openStorage = () => SqliteStorage.open(createExpoSqliteDatabase(createNodeSqliteConnection(filename)));
  return {
    openStorage,
    async open(models) {
      const storage = await openStorage();
      const service = await DurableChatService.open({ storage, models, platform: 'ios' });
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

test('durable chat publishes committed streaming state, executes a tool, and persists the answer', { timeout: 10_000 }, async (t) => {
  const file = await fixture(t);
  const started = Promise.withResolvers();
  let active;
  const provider = scriptedModels([
    (request) => { active = controlledReply(request); started.resolve(); return active.stream; },
    { chunks: ['The answer is ', '42.'] },
  ]);
  const service = await file.open(provider.models);
  const id = await service.createChat();
  const observed = [];
  const unsubscribe = service.subscribe(() => {
    const value = service.getConversation(id);
    if (value) observed.push(structuredClone(value));
  });
  t.after(unsubscribe);
  const submission = await service.send(id, 'Add 19 and 23.');
  await started.promise;
  active.text('Adding now.');
  await until(() => service.getConversation(id).messages.some(({ streaming, text }) => streaming && text.includes('Adding now.')),
    'a committed partial assistant message reaches the app before the provider finishes');
  const streamingId = service.getConversation(id).messages.find(({ streaming }) => streaming).id;
  assert.equal(service.getConversation(id).busy, true);
  active.finish({ tool: { a: 19, b: 23 } });
  assert.equal((await service.waitForSubmission(submission)).status, 'done');
  const conversation = service.getConversation(id);
  assert.equal(conversation.busy, false);
  assert.equal(conversation.pending, false);
  assert.match(textOf(conversation), /The answer is 42\./);
  const tool = conversation.messages.find(({ tool }) => tool?.name === 'add_numbers');
  assert.ok(tool);
  assert.equal(tool.tool.status, 'completed');
  assert.deepEqual(JSON.parse(tool.tool.output), { sum: 42, platform: 'ios', runtime: 'on-device' });
  assert.ok(observed.some(({ messages }) => messages.some(({ streaming }) => streaming)));
  assert.ok(conversation.messages.every(({ streaming }) => !streaming), 'settled entries replace live partials');
  assert.equal(conversation.messages.find(({ text }) => text === 'Adding now.').id, streamingId,
    'the committed assistant keeps its streaming row identity');
  for (let index = 1; index < observed.length; index++) {
    assert.notDeepEqual(observed[index], observed[index - 1], 'task-only checkpoints do not republish an unchanged conversation');
  }
  assert.equal(conversation.messages.filter(({ role }) => role === 'user').length, 1);
  assert.equal(provider.requests.length, 2);
  const toolResult = provider.requests[1].context.messages.find(({ role }) => role === 'toolResult');
  assert.deepEqual(JSON.parse(toolResult.content[0].text), JSON.parse(tool.tool.output));
  for (const { options } of provider.requests) {
    assert.equal(options.transport, 'sse');
    assert.equal(options.maxRetries, 0);
    assert.equal(options.timeoutMs, 60_000);
    assert.equal(options.apiKey, 'test-only-key');
  }
});

test('chat identity, title, archive state and transcript survive reopening and support followup', { timeout: 10_000 }, async (t) => {
  const file = await fixture(t);
  const firstProvider = scriptedModels([{ chunks: ['Remembered blue.'] }]);
  const first = await file.open(firstProvider.models);
  const id = await first.createChat();
  const archivedId = await first.createChat();
  const submission = await first.send(id, 'Remember my favorite color is blue.');
  await first.waitForSubmission(submission);
  await first.renameChat(id, 'Favorite color');
  await first.archiveChat(archivedId);
  const previousMessages = first.getConversation(id).messages;
  await file.close(first);

  const secondProvider = scriptedModels([{ chunks: ['Your favorite color is blue.'] }]);
  const second = await file.open(secondProvider.models);
  assert.equal(secondProvider.requests.length, 0, 'opening stored history does not dispatch model work');
  assert.equal(second.getConversation(id).title, 'Favorite color');
  assert.deepEqual(second.getConversation(id).messages, previousMessages);
  assert.ok(second.getSnapshot().chats.some((chat) => chat.id === id));
  assert.ok(!second.getSnapshot().chats.some((chat) => chat.id === archivedId));
  await second.waitForSubmission(await second.send(id, 'What is my favorite color?'));
  const requestText = JSON.stringify(secondProvider.requests[0].context.messages);
  assert.match(requestText, /Remember my favorite color is blue/);
  assert.match(requestText, /Remembered blue/);
  assert.match(requestText, /What is my favorite color/);
  assert.equal(second.getConversation(id).messages.filter(({ role }) => role === 'user').length, 2);
  assert.match(textOf(second.getConversation(id)), /Your favorite color is blue/);
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
  assert.equal(second.getConversation(id).messages.filter(({ role }) => role === 'user').length, 1);
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
  const submission = await first.send(id, 'Begin a long answer.');
  await started.promise;
  active.text('Saved partial answer.');
  await until(() => textOf(first.getConversation(id)).includes('Saved partial answer.'), 'partial is committed before cancellation');
  const partialId = first.getConversation(id).messages.find(({ streaming }) => streaming).id;
  await first.cancel(id);
  const settled = await first.waitForSubmission(submission);
  assert.equal(settled.status, 'unanswered');
  assert.equal(settled.reason, 'aborted');
  assert.equal(active.signal.aborted, true);
  assert.equal(first.getConversation(id).busy, false);
  assert.match(textOf(first.getConversation(id)), /Saved partial answer/);
  assert.equal(first.getConversation(id).messages.find(({ interrupted }) => interrupted).id, partialId);
  await file.close(first);
  const resumedProvider = scriptedModels([]);
  const second = await file.open(resumedProvider.models);
  await second.resume();
  assert.equal(second.getConversation(id).busy, false);
  assert.equal(second.getConversation(id).pending, false);
  assert.match(textOf(second.getConversation(id)), /Saved partial answer/);
  assert.equal(second.getConversation(id).messages.find(({ interrupted }) => interrupted).id, partialId,
    'an interrupted assistant keeps the same row identity after SQLite reopen');
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
  assert.equal(first.getConversation(id).busy, false);
  assert.match(first.getConversation(id).error, /Scripted durable provider failure/);
  await file.close(first);
  const second = await file.open(scriptedModels([]).models);
  const persisted = await second.waitForSubmission(submission);
  assert.equal(persisted.status, 'unanswered');
  assert.match(JSON.stringify(persisted.detail), /Scripted durable provider failure/);
  assert.match(second.getConversation(id).error, /Scripted durable provider failure/);
});

test('signed-out sends cannot create failed model work or change the conversation transcript', { timeout: 10_000 }, async (t) => {
  const file = await fixture(t);
  const provider = scriptedModels([], { authenticated: false });
  const service = await file.open(provider.models);
  const id = await service.createChat();
  const before = service.getConversation(id).messages;
  await assert.rejects(service.send(id, 'Do not admit this while signed out.'), /sign in/i);
  assert.deepEqual(service.getConversation(id).messages, before);
  assert.equal(service.getConversation(id).busy, false);
  assert.equal(provider.requests.length, 0);
});

test('unfinished work survives close and stays pending while signed out, then resumes the same input after auth', { timeout: 10_000 }, async (t) => {
  const file = await fixture(t);
  const started = Promise.withResolvers();
  let active;
  const firstProvider = scriptedModels([(request) => {
    active = controlledReply(request); started.resolve(); return active.stream;
  }]);
  const first = await file.open(firstProvider.models);
  const id = await first.createChat();
  const submission = await first.send(id, 'Recover this request.', 'recover-request');
  await started.promise;
  active.text('Before restart.');
  await until(() => textOf(first.getConversation(id)).includes('Before restart.'), 'the interrupted partial is stored');
  await file.close(first);
  assert.equal(active.signal.aborted, true, 'close interrupts the current transport without aborting its durable task');

  const secondProvider = scriptedModels([{ chunks: ['Recovered answer.'] }], { authenticated: false });
  const second = await file.open(secondProvider.models);
  assert.equal(secondProvider.requests.length, 0);
  assert.equal(second.getConversation(id).pending, true);
  await assert.rejects(second.resume(), /sign in/i);
  await new Promise((resolve) => setTimeout(resolve, 25));
  assert.equal(secondProvider.requests.length, 0, 'no unauthenticated scheduler dispatch');
  assert.equal(second.getConversation(id).pending, true, 'sign-in absence does not fail the recovered work');
  secondProvider.auth.authenticated = true;
  await second.resume();
  const settled = await second.waitForSubmission(submission);
  assert.equal(settled.status, 'done');
  assert.equal(secondProvider.requests.length, 1);
  const conversation = second.getConversation(id);
  assert.equal(conversation.pending, false);
  assert.equal(conversation.busy, false);
  assert.equal(conversation.messages.filter(({ role }) => role === 'user').length, 1);
  assert.match(textOf(conversation), /Recovered answer/);
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
  assert.equal(service.getConversation(first).busy, true);
  assert.equal(service.getConversation(second).busy, false);
  await service.cancel(first);
  assert.equal((await service.waitForSubmission(pending)).reason, 'aborted');
  assert.match(textOf(service.getConversation(second)), /Second chat answer/);
});

test('waiting for a recovered submission enables the scheduler and updates pending to busy without explicit resume', { timeout: 10_000 }, async (t) => {
  const file = await fixture(t);
  const firstStarted = Promise.withResolvers();
  const firstProvider = scriptedModels([(request) => {
    const response = controlledReply(request); firstStarted.resolve(); return response.stream;
  }]);
  const first = await file.open(firstProvider.models);
  const id = await first.createChat();
  const submission = await first.send(id, 'Continue after reopening.');
  await firstStarted.promise;
  await file.close(first);

  const secondStarted = Promise.withResolvers();
  let active;
  const secondProvider = scriptedModels([(request) => {
    active = controlledReply(request); secondStarted.resolve(); return active.stream;
  }]);
  const second = await file.open(secondProvider.models);
  assert.equal(second.getConversation(id).pending, true);
  const wait = second.waitForSubmission(submission);
  void wait.catch(() => {});
  await secondStarted.promise;
  assert.equal(second.getConversation(id).pending, false);
  assert.equal(second.getConversation(id).busy, true);
  active.text('Finished after direct wait.');
  active.finish();
  assert.equal((await wait).status, 'done');
  assert.equal(second.getConversation(id).busy, false);
});

test('hydration reads every page of conversations, transcript entries, and submission outcomes', { timeout: 30_000 }, async (t) => {
  const file = await fixture(t);
  const provider = scriptedModels([
    ...Array.from({ length: 101 }, (_, index) => ({ chunks: [`Answer ${index}.`] })),
    { error: 'Latest paginated failure' },
  ]);
  const first = await file.open(provider.models);
  const ids = [];
  for (let index = 0; index < 101; index++) ids.push(await first.createChat());
  const lastChat = ids.at(-1);
  let lastSubmission;
  for (let index = 0; index < 102; index++) {
    lastSubmission = await first.send(lastChat, `Message ${index}.`);
    await first.waitForSubmission(lastSubmission);
  }
  const before = structuredClone(first.getConversation(lastChat));
  assert.equal(before.messages.filter(({ role }) => role === 'user').length, 102);
  assert.ok(before.error, 'the final submission records a visible failure');
  await file.close(first);

  const noRequests = scriptedModels([]);
  const second = await file.open(noRequests.models);
  assert.equal(second.getSnapshot().chats.length, 101);
  assert.deepEqual(new Set(second.getSnapshot().chats.map(({ id }) => id)), new Set(ids));
  assert.deepEqual(second.getConversation(lastChat).messages, before.messages);
  assert.equal(second.getConversation(lastChat).error, before.error, 'the latest outcome is after the first submissions page');
  assert.equal((await second.waitForSubmission(lastSubmission)).status, 'unanswered');
  assert.equal(noRequests.requests.length, 0);
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
  const tools = first.getConversation(id).messages.filter(({ tool }) => tool);
  assert.equal(tools.length, 2);
  assert.equal(new Set(tools.map(({ id }) => id)).size, 2, 'React list keys are unique across persisted tool rows');
  assert.deepEqual(tools.map(({ tool }) => JSON.parse(tool.output).sum), [42, 3]);
  assert.ok(tools.every(({ tool }) => tool.status === 'completed'));
  await file.close(first);
  const second = await file.open(scriptedModels([]).models);
  assert.deepEqual(second.getConversation(id).messages.filter(({ tool }) => tool), tools);
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
  const conversation = first.getConversation(id);
  assert.equal(conversation.error, undefined, 'the latest successful run clears the current error banner');
  const failure = conversation.messages.find(({ role, error }) => role === 'assistant' && error === 'First attempt failed before producing text.');
  assert.ok(failure, 'a failed prior response remains visible even though it had no text');
  assert.match(textOf(conversation), /The followup succeeded/);
  await file.close(first);
  const second = await file.open(scriptedModels([]).models);
  assert.deepEqual(second.getConversation(id).messages.find(({ id }) => id === failure.id), failure);
});

test('a persisted queued input remains pending without a live run and can be durably withdrawn', { timeout: 10_000 }, async (t) => {
  const file = await fixture(t);
  const started = Promise.withResolvers();
  let active;
  const provider = scriptedModels([(request) => {
    active = controlledReply(request); started.resolve(); return active.stream;
  }]);
  // The app rejects new input while busy. Seed a valid queued-only recovery
  // state through the public durable API, as another durable client can write.
  const harness = await Harness.open(await file.openStorage(), {
    models: provider.models, registry: createRegistry(),
    settings: { retry: { enabled: false }, compaction: { enabled: false } },
    async conversationCreated(tx, conversation) {
      (await tx.doc(ChatMetadataDoc, conversation.id)).createdAt = Date.now();
    },
  }, BACKGROUND_CONTEXT);
  let id;
  let queuedId;
  try {
    const conversation = await harness.createConversation({ ownership: { kind: 'ownerless' },
      agent: { model: { provider: 'openai-codex', modelId: 'gpt-6-sol' } },
    }, BACKGROUND_CONTEXT);
    id = String(conversation.id);
    const first = await conversation.submit({ type: 'input', content: 'First attempt.' }, BACKGROUND_CONTEXT);
    await started.promise;
    const queued = await conversation.submit({ type: 'input', content: 'Queued followup.' }, BACKGROUND_CONTEXT);
    queuedId = String(queued.id);
    active.finish({ error: 'First run failed.' });
    assert.equal((await first.wait(BACKGROUND_CONTEXT)).status, 'unanswered');
    assert.equal((await queued.status(BACKGROUND_CONTEXT)).status, 'queued');
    assert.equal((await harness.snapshot(LiveDoc, conversation.id, BACKGROUND_CONTEXT)).run, undefined);
  } finally { await harness.close(BACKGROUND_CONTEXT); }

  const reopenedProvider = scriptedModels([], { authenticated: false });
  const service = await file.open(reopenedProvider.models);
  assert.equal(service.getConversation(id).pending, true);
  assert.equal(service.getConversation(id).busy, false);
  await assert.rejects(service.archiveChat(id), /Stop the response/);
  await service.cancel(id);
  assert.equal((await service.waitForSubmission(queuedId)).reason, 'aborted');
  assert.equal(service.getConversation(id).pending, false);
  assert.equal(service.getConversation(id).busy, false);
  assert.equal(reopenedProvider.requests.length, 0);
});

test('streaming and entry commits reuse unchanged historical rows and chat summaries', { timeout: 10_000 }, async (t) => {
  const file = await fixture(t);
  const started = Promise.withResolvers();
  let active;
  const provider = scriptedModels([
    { chunks: ['An earlier answer.'] },
    (request) => { active = controlledReply(request); started.resolve(); return active.stream; },
  ]);
  const service = await file.open(provider.models);
  const otherId = await service.createChat();
  const id = await service.createChat();
  await service.waitForSubmission(await service.send(id, 'An earlier question.'));
  const history = service.getConversation(id).messages;
  const otherConversation = service.getConversation(otherId);
  const otherSummary = service.getSnapshot().chats.find((chat) => chat.id === otherId);
  const submission = await service.send(id, 'Stream the next answer.');
  await started.promise;
  const list = service.getSnapshot();
  active.text('First paragraph.');
  await until(() => service.getConversation(id).messages.some(({ streaming, text }) => streaming && text === 'First paragraph.'),
    'the first partial is durably published');
  const firstPartial = service.getConversation(id);
  const partialId = firstPartial.messages.at(-1).id;
  for (let index = 0; index < history.length; index++) assert.equal(firstPartial.messages[index], history[index]);
  assert.equal(service.getSnapshot(), list, 'streaming does not invalidate the unchanged chat-list snapshot');

  active.text('\n\nSecond paragraph.');
  await until(() => service.getConversation(id).messages.at(-1).text.includes('Second paragraph.'), 'the next partial is published');
  const nextPartial = service.getConversation(id);
  assert.notEqual(nextPartial, firstPartial);
  assert.equal(nextPartial.messages.at(-1).id, partialId);
  assert.equal(firstPartial.messages.at(-1).text, 'First paragraph.', 'published snapshots remain immutable');
  for (let index = 0; index < nextPartial.messages.length - 1; index++) {
    assert.equal(nextPartial.messages[index], firstPartial.messages[index], 'unchanged transcript rows retain object identity');
  }
  await service.renameChat(id, 'A stable title');
  assert.equal(service.getConversation(id).messages, nextPartial.messages, 'metadata-only edits retain the transcript array');
  active.finish();
  await service.waitForSubmission(submission);
  const finished = service.getConversation(id);
  assert.equal(finished.messages.at(-1).id, partialId);
  assert.equal(finished.messages.at(-1).streaming, false);
  for (let index = 0; index < finished.messages.length - 1; index++) {
    assert.equal(finished.messages[index], nextPartial.messages[index], 'committing the answer preserves earlier rows');
  }
  assert.equal(service.getConversation(otherId), otherConversation);
  assert.equal(service.getSnapshot().chats.find((chat) => chat.id === otherId), otherSummary,
    'an unrelated saved-chat row keeps its memoization identity');
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
  await until(() => service.getConversation(id).messages.some(({ tool }) => tool?.name === 'add_numbers'), 'the tool partial is persisted');
  const liveTool = service.getConversation(id).messages.find(({ tool }) => tool);
  active.finish({ tool: { a: 19, b: 23 } });
  await service.waitForSubmission(submission);
  const settledTool = service.getConversation(id).messages.find(({ tool }) => tool);
  assert.equal(settledTool.id, liveTool.id);
  assert.equal(settledTool.tool.status, 'completed');
  assert.equal(liveTool.tool.status, 'running', 'updating a tool does not mutate the previous snapshot');
  assert.equal(JSON.parse(settledTool.tool.output).sum, 42);
  await file.close(service);
  const reopened = await file.open(scriptedModels([]).models);
  assert.deepEqual(reopened.getConversation(id).messages.find(({ tool }) => tool), settledTool);
});

test('provider, model and supported effort persist per chat and control the next request after reopen', { timeout: 10_000 }, async (t) => {
  const file = await fixture(t);
  const initial = scriptedModels([{ chunks: ['Original provider.'] }]);
  const first = await file.open(initial.models);
  const id = await first.createChat();
  const other = await first.createChat();
  const otherSettings = first.getConversation(other).settings;
  await first.waitForSubmission(await first.send(id, 'Remember the earlier turn.'));
  const original = initial.models.getProvider('openai-codex');
  const customModel = { ...original.getModels()[0], provider: 'future-provider', id: 'future-model', name: 'Future Model' };
  initial.models.setProvider({ ...original, id: 'future-provider', name: 'Future Provider', getModels: () => [customModel] });
  const selected = { model: { provider: 'future-provider', modelId: 'future-model' }, thinkingLevel: 'high' };
  const before = first.getConversation(id);
  const list = first.getSnapshot();
  await first.updateSettings(id, selected);
  assert.deepEqual(first.getConversation(id).settings, selected);
  assert.equal(first.getConversation(id).messages, before.messages, 'settings commits preserve transcript identity');
  assert.equal(first.getSnapshot(), list, 'settings commits do not rebuild the chat list');
  assert.deepEqual(first.getConversation(other).settings, otherSettings, 'other chats keep independent choices');
  assert.equal(initial.requests.length, 1, 'saving settings never makes a model request');
  await file.close(first);

  const next = scriptedModels([{ chunks: ['New provider remembered.'] }]);
  next.models.setProvider({ ...next.models.getProvider('openai-codex'), id: 'future-provider', name: 'Future Provider', getModels: () => [customModel] });
  const second = await file.open(next.models);
  assert.deepEqual(second.getConversation(id).settings, selected);
  assert.deepEqual(second.getConversation(other).settings, otherSettings);
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
  const original = first.getConversation(id).settings;
  const selected = { model: { provider: 'openai-codex', modelId: 'gpt-6-astra' }, thinkingLevel: 'high' };
  await assert.rejects(first.updateSettings(id, { ...selected, thinkingLevel: 'off' }), /reasoning|effort|support/i);
  await assert.rejects(first.updateSettings(id, { ...selected, model: { provider: 'missing', modelId: 'missing' } }), /available|provider/i);
  assert.deepEqual(first.getConversation(id).settings, original);
  await first.send(id, 'Keep running.');
  await started.promise;
  await assert.rejects(first.updateSettings(id, selected), /pending response/i);
  assert.deepEqual(first.getConversation(id).settings, original);
  await file.close(first);
  const second = await file.open(scriptedModels([]).models);
  assert.equal(second.getConversation(id).pending, true);
  await assert.rejects(second.updateSettings(id, selected), /pending response/i);
  assert.deepEqual(second.getConversation(id).settings, original);
  await second.cancel(id);
  await second.updateSettings(id, selected);
  assert.deepEqual(second.getConversation(id).settings, selected);
});

test('unregistered saved providers survive reopening and block sends until explicitly changed', { timeout: 10_000 }, async (t) => {
  const file = await fixture(t);
  const provider = scriptedModels([]);
  const base = provider.models.getProvider('openai-codex');
  provider.models.setProvider({ ...base, id: 'removed-provider', name: 'Removed provider',
    getModels: () => [{ ...base.getModels()[0], provider: 'removed-provider', id: 'saved-model' }] });
  const first = await file.open(provider.models);
  const id = await first.createChat();
  const settings = { model: { provider: 'removed-provider', modelId: 'saved-model' }, thinkingLevel: 'low' };
  await first.updateSettings(id, settings);
  await file.close(first);
  const next = scriptedModels([]);
  const second = await file.open(next.models);
  assert.deepEqual(second.getConversation(id).settings, settings, 'catalog changes do not rewrite saved choices');
  await assert.rejects(second.send(id, 'Do not silently select another model.'), /provider|available/i);
  assert.equal(second.getConversation(id).messages.length, 0);
  assert.equal(next.requests.length, 0);
});

test('updating existing SDK agent settings preserves unrelated fields and reads legacy omitted effort', { timeout: 10_000 }, async (t) => {
  const { AgentDoc } = await import('@earendil-works/pi-durable');
  const file = await fixture(t);
  const provider = scriptedModels([]);
  const harness = await Harness.open(await file.openStorage(), { models: provider.models, registry: createRegistry(),
    async conversationCreated(tx, conversation) { (await tx.doc(ChatMetadataDoc, conversation.id)).createdAt = Date.now(); },
  }, BACKGROUND_CONTEXT);
  const chat = await harness.createConversation({ ownership: { kind: 'ownerless' },
    agent: { model: { provider: 'openai-codex', modelId: 'gpt-6-sol' }, instructions: 'Preserve this instruction.' },
  }, BACKGROUND_CONTEXT);
  const id = String(chat.id);
  await harness.close(BACKGROUND_CONTEXT);
  const service = await file.open(provider.models);
  assert.equal(service.getConversation(id).settings.thinkingLevel, 'off');
  await service.updateSettings(id, { model: { provider: 'openai-codex', modelId: 'gpt-6-astra' }, thinkingLevel: 'max' });
  await file.close(service);
  const verify = await Harness.open(await file.openStorage(), { models: provider.models, registry: createRegistry() }, BACKGROUND_CONTEXT);
  try {
    const agent = await verify.snapshot(AgentDoc, chat.id, BACKGROUND_CONTEXT);
    assert.equal(agent.instructions, 'Preserve this instruction.');
    assert.equal(agent.model.modelId, 'gpt-6-astra');
    assert.equal(agent.thinkingLevel, 'max');
  } finally { await verify.close(BACKGROUND_CONTEXT); }
});

test('offline cancellation of a removed provider is durable and never dispatches another pending chat', { timeout: 10_000 }, async (t) => {
  const file = await fixture(t);
  const started = [Promise.withResolvers(), Promise.withResolvers()];
  const initial = scriptedModels(started.map((signal) => (request) => {
    const reply = controlledReply(request);
    signal.resolve(reply);
    return reply.stream;
  }));
  const base = initial.models.getProvider('openai-codex');
  initial.models.setProvider({ ...base, id: 'removed-provider', name: 'Removed provider',
    getModels: () => [{ ...base.getModels()[0], provider: 'removed-provider', id: 'saved-model' }] });
  const first = await file.open(initial.models);
  const cancelled = await first.createChat();
  const other = await first.createChat();
  await first.updateSettings(cancelled, { model: { provider: 'removed-provider', modelId: 'saved-model' }, thinkingLevel: 'high' });
  const cancelledSubmission = await first.send(cancelled, 'Cancel me while offline.');
  const cancelledReply = await started[0].promise;
  cancelledReply.text('Keep this partial.');
  const otherSubmission = await first.send(other, 'Preserve my pending request.');
  await started[1].promise;
  await until(() => textOf(first.getConversation(cancelled)).includes('Keep this partial.'), 'partial response is committed');
  await file.close(first);

  const signedOut = scriptedModels([], { authenticated: false });
  const second = await file.open(signedOut.models);
  assert.equal(second.getConversation(cancelled).pending, true);
  await assert.rejects(second.resume(), /provider|available|connect|sign in/i);
  await second.cancel(cancelled);
  assert.equal(second.getConversation(cancelled).pending, false, 'durable abort intent releases the settings UI');
  assert.equal(second.getConversation(cancelled).busy, false);
  assert.equal(second.getConversation(other).pending, true, 'another provider stays safely paused');
  assert.equal(signedOut.requests.length, 0);
  assert.match(textOf(second.getConversation(cancelled)), /Keep this partial/);
  assert.ok(second.getConversation(cancelled).messages.find(({ text }) => text === 'Keep this partial.').interrupted);
  const selection = { model: { provider: 'openai-codex', modelId: 'gpt-6-sol' }, thinkingLevel: 'high' };
  await second.updateSettings(cancelled, selection);
  await file.close(second);

  const reconnect = scriptedModels([{ chunks: ['Other response resumed.'] }, { chunks: ['A fresh answer.'] }], { authenticated: false });
  const third = await file.open(reconnect.models);
  assert.equal(third.getConversation(cancelled).pending, false, 'the abort mark survives a process restart');
  assert.deepEqual(third.getConversation(cancelled).settings, selection);
  assert.equal(third.getConversation(other).pending, true);
  await assert.rejects(third.resume(), /connect|sign in/i);
  assert.equal(reconnect.requests.length, 0);
  reconnect.auth.authenticated = true;
  await third.resume();
  assert.equal((await third.waitForSubmission(cancelledSubmission)).reason, 'aborted');
  assert.equal((await third.waitForSubmission(otherSubmission)).status, 'done');
  assert.equal(reconnect.requests.length, 1, 'cleanup does not replay the cancelled request');
  await third.waitForSubmission(await third.send(cancelled, 'Start a fresh request.'));
  assert.equal(reconnect.requests.length, 2);
  assert.equal(reconnect.requests[1].options.reasoning, 'high');
});

test('settings cannot change the provider while send is awaiting its credential admission', { timeout: 10_000 }, async (t) => {
  const file = await fixture(t);
  const checking = Promise.withResolvers();
  const release = Promise.withResolvers();
  const started = Promise.withResolvers();
  const provider = scriptedModels([(request) => {
    const reply = controlledReply(request); started.resolve(reply); return reply.stream;
  }]);
  const originalCheck = provider.models.checkAuth.bind(provider.models);
  let hold = true;
  provider.models.checkAuth = async (...args) => {
    if (hold) { hold = false; checking.resolve(); await release.promise; }
    return originalCheck(...args);
  };
  const service = await file.open(provider.models);
  const id = await service.createChat();
  const original = service.getConversation(id).settings;
  const sending = service.send(id, 'Use the admitted model.');
  await checking.promise;
  const update = service.updateSettings(id, { model: { provider: 'openai-codex', modelId: 'gpt-6-astra' }, thinkingLevel: 'high' });
  const rejected = assert.rejects(update, /pending response/i);
  release.resolve();
  const submission = await sending;
  const reply = await started.promise;
  await rejected;
  assert.deepEqual(service.getConversation(id).settings, original);
  assert.equal(provider.requests[0].model.id, original.model.modelId);
  reply.finish();
  await service.waitForSubmission(submission);
});

test('credential-specific model availability is checked before creating durable model work', { timeout: 10_000 }, async (t) => {
  const file = await fixture(t);
  const provider = scriptedModels([]);
  const base = provider.models.getProvider('openai-codex');
  provider.models.setProvider({ ...base, filterModels: () => [] });
  const service = await file.open(provider.models);
  const id = await service.createChat();
  await assert.rejects(service.send(id, 'Do not send an inaccessible model.'), /not available for this account/i);
  assert.equal(service.getConversation(id).messages.length, 0);
  assert.equal(service.getConversation(id).busy, false);
  assert.equal(provider.requests.length, 0);
});

test('a new send drains an offline cancellation before using changed model settings', { timeout: 10_000 }, async (t) => {
  const file = await fixture(t);
  const started = Promise.withResolvers();
  const initial = scriptedModels([(request) => {
    const reply = controlledReply(request); started.resolve(); return reply.stream;
  }]);
  const first = await file.open(initial.models);
  const id = await first.createChat();
  const stoppedSubmission = await first.send(id, 'Stop the original response.');
  await started.promise;
  await file.close(first);
  const next = scriptedModels([{ chunks: ['The replacement model answered.'] }]);
  const second = await file.open(next.models);
  await second.cancel(id);
  await second.updateSettings(id, { model: { provider: 'openai-codex', modelId: 'gpt-6-astra' }, thinkingLevel: 'max' });
  await second.waitForSubmission(await second.send(id, 'Use the replacement model.'));
  assert.equal((await second.waitForSubmission(stoppedSubmission)).reason, 'aborted');
  assert.equal(next.requests.length, 1);
  assert.equal(next.requests[0].model.id, 'gpt-6-astra');
  assert.equal(next.requests[0].options.reasoning, 'max');
});

test('cancellation submitted during credential admission cannot miss the pending send', { timeout: 10_000 }, async (t) => {
  const file = await fixture(t);
  const checking = Promise.withResolvers();
  const release = Promise.withResolvers();
  const provider = scriptedModels([(request) => controlledReply(request).stream]);
  const originalCheck = provider.models.checkAuth.bind(provider.models);
  let hold = true;
  provider.models.checkAuth = async (...args) => {
    if (hold) { hold = false; checking.resolve(); await release.promise; }
    return originalCheck(...args);
  };
  const service = await file.open(provider.models);
  const id = await service.createChat();
  const sending = service.send(id, 'Cancel this pending admission.');
  await checking.promise;
  const cancel = service.cancel(id);
  release.resolve();
  const submission = await sending;
  await cancel;
  assert.equal((await service.waitForSubmission(submission)).reason, 'aborted');
  assert.equal(service.getConversation(id).busy, false);
  assert.equal(service.getConversation(id).pending, false);
});
