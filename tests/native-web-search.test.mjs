import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { registerHooks, stripTypeScriptTypes } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { BACKGROUND_CONTEXT } from '@earendil-works/chord/context';
import { Harness, createRegistry, defineExtension, hook, CompactionTask } from '@earendil-works/pi-durable';
import { SqliteStorage } from '@earendil-works/pi-durable/storage/sqlite';
import { createExpoSqliteDatabase } from '../src/pi/storage/expo-sqlite.ts';
import { createNodeSqliteConnection } from './helpers/node-sqlite.mjs';
import { MODEL_ID, SUBSCRIPTION_TOKEN, responsesModels as realResponsesModels, reasoningItem, searchItem, textItem, until } from './helpers/openai-responses.mjs';

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
    if (url.startsWith(sourceRoot) && url.endsWith('.ts')) return {
      shortCircuit: true, format: 'module', source: stripTypeScriptTypes(readFileSync(new URL(url), 'utf8'), {
        mode: 'transform', sourceMap: false, sourceUrl: url,
      }),
    };
    return nextLoad(url, context);
  },
});
test.after(() => hooks.deregister());
const { DurableChatService } = await import('../src/pi/chat-service.ts');
const { createNativeWebSearchBridge, NativeResponsesDoc } = await import('../src/pi/native-web-search/durable.ts');
const { withNativeWebSearch } = await import('../src/pi/native-web-search/provider.ts');
const { bindNativeWebSearch } = await import('../src/pi/native-web-search/bindings.ts');
const context = BACKGROUND_CONTEXT;
const settings = { model: { provider: 'openai', modelId: MODEL_ID }, thinkingLevel: 'medium' };
const responsesModels = (steps, options = {}) => realResponsesModels(steps, { ...options, wrapProvider: withNativeWebSearch });

async function fixture(t) {
  const directory = await mkdtemp(join(tmpdir(), 'pi-native-search-'));
  const filename = join(directory, 'chat.sqlite');
  const openHandles = new Set();
  t.after(async () => {
    await Promise.allSettled([...openHandles].map(({ close }) => close()));
    await rm(directory, { recursive: true, force: true });
  });
  async function storage() { return SqliteStorage.open(createExpoSqliteDatabase(createNodeSqliteConnection(filename))); }
  return {
    async open(provider) {
      const db = await storage();
      const service = await DurableChatService.open({ storage: db, models: provider.models, platform: 'ios' });
      const result = { service, db, async close() { await service.close(); openHandles.delete(result); } };
      openHandles.add(result);
      return result;
    },
    async harness(provider, { extensions = [], compaction = {} } = {}) {
      const db = await storage();
      const bridge = createNativeWebSearchBridge(provider.models);
      const registry = createRegistry();
      registry.install(bridge.extension);
      for (const extension of extensions) registry.install(extension);
      const harness = await Harness.open(db, { models: bridge.models, registry,
        settings: { stream: { transport: 'sse', maxRetries: 0 }, retry: { enabled: false, maxRetries: 0 },
          compaction: { backgroundTokens: 0, ...compaction } } }, context);
      bridge.attach(harness);
      const result = { harness, db, async close() { await harness.close(context); openHandles.delete(result); } };
      openHandles.add(result);
      return result;
    },
  };
}

async function newChat(service) {
  const id = await service.createChat();
  await service.updateSettings(id, settings);
  return id;
}

async function records(db, id) {
  const found = await db.findDocument({ kind: NativeResponsesDoc.definition.kind,
    scope: { kind: 'conversation', conversationId: Number(id) } }, 'current', context);
  return found ? Object.values((await db.document(found.id, 'current', context)).value.responses) : [];
}

function searchRows(service, id) { return service.getConversation(id).messages.filter((row) => row.webSearch); }
function assertReplay(body, output) {
  const ids = new Set(output.map((item) => item.id));
  const replay = body.input.filter((item) => ids.has(item.id));
  assert.deepEqual(replay, output, 'All original output items replay once, in order and without data loss');
  for (const item of output) assert.equal(body.input.filter((value) => value.id === item.id).length, 1);
}

test('bound provider composes caller hooks and preserves replacement request fields', { timeout: 10_000 }, async () => {
  const output = [reasoningItem(), searchItem(), textItem()];
  const provider = responsesModels([(exchange) => { exchange.created(); exchange.complete(output); }]);
  const controller = new AbortController();
  const saves = [];
  bindNativeWebSearch(controller.signal, {
    record: { requestId: 'hooks-request', taskId: 101, provider: 'openai', model: MODEL_ID,
      status: 'in_progress', output: [], events: [] },
    history: [], save: async (record) => { saves.push(structuredClone(record)); },
  });
  const observed = [];
  let payloadCalls = 0;
  const result = await provider.models.completeSimple(provider.models.getModel('openai', MODEL_ID), {
    messages: [{ role: 'user', content: 'Direct bound request', timestamp: 1 }],
  }, { signal: controller.signal, reasoning: 'medium',
    onPayload(payload) {
      payloadCalls++;
      assert.ok(payload.tools.some((tool) => tool.type === 'web_search'), 'Caller sees native fields before deciding the final request');
      return { ...payload, include: [...payload.include, 'message.output_text.logprobs'],
        metadata: { caller: 'retained' }, tools: [...payload.tools, { type: 'function', name: 'caller_tool',
          description: 'Existing tool', parameters: { type: 'object', properties: {} } }] };
    },
    onProviderStreamEvent(event) { observed.push(structuredClone(event)); },
  });
  assert.equal(result.stopReason, 'stop');
  assert.equal(payloadCalls, 1);
  assert.deepEqual(provider.requests[0].body.metadata, { caller: 'retained' });
  assert.deepEqual(provider.requests[0].body.tools.map((tool) => tool.type), ['web_search', 'function']);
  assert.deepEqual(new Set(provider.requests[0].body.include), new Set([
    'reasoning.encrypted_content', 'message.output_text.logprobs', 'web_search_call.action.sources', 'web_search_call.results',
  ]));
  assert.deepEqual(observed.map((event) => event.type), ['response.created', 'response.completed']);
  assert.deepEqual(saves.at(-1).output, output);
});

test('caller payload replacement has the last word after historical native replay is assembled', { timeout: 10_000 }, async () => {
  const output = [reasoningItem('rs_hook_history'), searchItem('ws_hook_history'), textItem('History', 'msg_hook_history', [])];
  const provider = responsesModels([
    (exchange) => { exchange.created('resp_hook_history'); exchange.complete(output, { id: 'resp_hook_history' }); },
    [textItem('Next', 'msg_hook_next', [])],
  ]);
  const model = provider.models.getModel('openai', MODEL_ID);
  const user = { role: 'user', content: 'First', timestamp: 1 };
  const firstController = new AbortController();
  let firstRecord;
  bindNativeWebSearch(firstController.signal, { record: { requestId: 'hook-first', taskId: 201,
    provider: 'openai', model: MODEL_ID, status: 'in_progress', output: [], events: [] }, history: [],
  save: async (value) => { firstRecord = structuredClone(value); } });
  const first = await provider.models.completeSimple(model, { messages: [user] }, { signal: firstController.signal });
  const nextController = new AbortController();
  bindNativeWebSearch(nextController.signal, { record: { requestId: 'hook-second', taskId: 202,
    provider: 'openai', model: MODEL_ID, status: 'in_progress', output: [], events: [] }, history: [firstRecord], save: async () => {} });
  await provider.models.completeSimple(model, { messages: [user, first, { role: 'user', content: 'Next', timestamp: 2 }] }, {
    signal: nextController.signal,
    onPayload(payload) {
      assertReplay(payload, output);
      return { ...payload, input: [...payload.input, { role: 'developer', content: 'Caller final input edit' }],
        metadata: { finalHook: true } };
    },
  });
  assertReplay(provider.requests[1].body, output);
  assert.deepEqual(provider.requests[1].body.input.at(-1), { role: 'developer', content: 'Caller final input edit' });
  assert.equal(provider.requests[1].body.metadata.finalHook, true);
});

test('unbound provider requests remain ordinary Pi requests and do not enable native search', { timeout: 10_000 }, async () => {
  const provider = responsesModels([[textItem('Ordinary response')]]);
  await provider.models.completeSimple(provider.models.getModel('openai', MODEL_ID), {
    messages: [{ role: 'user', content: 'No durable generation scope', timestamp: 1 }],
  });
  assert.ok(!provider.requests[0].body.tools?.some((tool) => tool.type === 'web_search'));
  assert.ok(!provider.requests[0].body.include?.includes('web_search_call.action.sources'));
});

test('native persistence failures terminate the provider stream with an actionable error', { timeout: 10_000 }, async () => {
  const provider = responsesModels([(exchange) => { exchange.created(); exchange.complete([searchItem(), textItem()]); }]);
  const controller = new AbortController();
  let attempts = 0;
  bindNativeWebSearch(controller.signal, { record: { requestId: 'storage-failure', taskId: 301,
    provider: 'openai', model: MODEL_ID, status: 'in_progress', output: [], events: [] }, history: [],
  save: async () => { attempts++; throw new Error('Synthetic database internals must remain private'); } });
  const result = await provider.models.completeSimple(provider.models.getModel('openai', MODEL_ID), {
    messages: [{ role: 'user', content: 'Fail safely', timestamp: 1 }],
  }, { signal: controller.signal });
  assert.equal(result.stopReason, 'error');
  assert.match(result.errorMessage, /Could not save the native search response/);
  assert.doesNotMatch(result.errorMessage, /database internals/);
  assert.equal(provider.requests.length, 1);
  assert.ok(attempts > 0);
});

test('official SDK replay strips output provenance without changing the raw SQLite archive', { timeout: 10_000 }, async (t) => {
  const file = await fixture(t);
  const output = [reasoningItem('rs_provenance'), searchItem('ws_provenance'), textItem('A parsed answer', 'msg_provenance', [])];
  for (const item of output) item.created_by = { type: 'response', id: 'resp_provenance' };
  output[2].content[0].parsed = { mustNotReplay: true };
  const provider = responsesModels([output, [textItem('Follow up', 'msg_next', [])]]);
  const { service, db } = await file.open(provider);
  const id = await newChat(service);
  await service.waitForSubmission(await service.send(id, 'Store raw output.'));
  assert.deepEqual((await records(db, id))[0].output, output);
  await service.waitForSubmission(await service.send(id, 'Replay it.'));
  const replay = provider.requests[1].body.input.filter((item) => output.some((original) => original.id === item.id));
  assert.equal(replay.length, output.length);
  assert.ok(replay.every((item) => !Object.hasOwn(item, 'created_by')));
  assert.equal(replay[0].encrypted_content, output[0].encrypted_content);
  assert.ok(!Object.hasOwn(replay[2].content[0], 'parsed'));
  assert.deepEqual((await records(db, id))[0].output, output, 'Replay normalization never mutates the archive');
});

test('native search streams before text, preserves full terminal metadata, and replays after SQLite reopen', { timeout: 15_000 }, async (t) => {
  const file = await fixture(t);
  const started = Promise.withResolvers();
  let live;
  const output = [reasoningItem('rs_before', 'opaque-before'), searchItem(), reasoningItem('rs_after', 'opaque-after'), textItem()];
  const provider = responsesModels([(exchange) => { live = exchange; exchange.created('resp_search'); started.resolve(); }]);
  const first = await file.open(provider);
  const id = await newChat(first.service);
  const submission = await first.service.send(id, 'Research this with native search.');
  await started.promise;
  live.emit('response.output_item.added', { output_index: 1, item: { id: 'ws_search', type: 'web_search_call', status: 'in_progress' } });
  live.emit('response.web_search_call.in_progress', { output_index: 1, item_id: 'ws_search' });
  live.emit('response.web_search_call.searching', { output_index: 1, item_id: 'ws_search' });
  await until(() => searchRows(first.service, id).some((row) => row.webSearch.calls.some((call) => call.status === 'running')),
    'Native search activity must reach the app before any text or reasoning summary');
  const partial = searchRows(first.service, id)[0];
  assert.equal(partial.text, '');
  assert.equal(partial.streaming, true);
  // The terminal response is authoritative even when the stream omitted output_item.done.
  live.complete(output, { id: 'resp_search', future_response_field: { retained: true } });
  assert.equal((await first.service.waitForSubmission(submission)).status, 'done');
  const raw = await records(first.db, id);
  assert.equal(raw.length, 1);
  assert.equal(raw[0].status, 'completed');
  assert.deepEqual(raw[0].output, output);
  assert.deepEqual(raw[0].response.future_response_field, { retained: true });
  assert.ok(raw[0].events.some((event) => event.type === 'response.web_search_call.searching'));
  const final = searchRows(first.service, id)[0];
  assert.equal(final.id, partial.id, 'A native-only streaming row retains identity when the answer commits');
  assert.equal(final.text, 'A sourced answer.');
  assert.equal(!!final.streaming, false);
  assert.equal(final.webSearch.calls[0].status, 'completed');
  assert.equal(final.webSearch.citations[0].url, 'https://openai.com/research/');
  assert.equal(final.webSearch.sources[0].url, 'https://openai.com/research/');
  assert.doesNotMatch(JSON.stringify(final), /opaque-before|opaque-after|encrypted_content|future_search_field/,
    'Raw provider state and encrypted reasoning must not enter UI projections');
  const request = provider.requests[0];
  assert.equal(request.url, 'https://api.openai.com/v1/responses');
  assert.equal(request.headers.get('authorization'), `Bearer ${SUBSCRIPTION_TOKEN}`);
  assert.equal(request.headers.get('chatgpt-account-id'), null);
  assert.equal(request.body.store, false);
  assert.equal(request.body.stream, true);
  assert.equal(request.body.tools.filter((tool) => tool.type === 'web_search').length, 1);
  const declaredTools = [...request.body.tools, ...request.body.input.filter((item) => item.type === 'additional_tools').flatMap((item) => item.tools)];
  assert.ok(declaredTools.some((tool) => tool.type === 'function' && tool.name === 'add_numbers'),
    'Existing app tools survive in the request tools or Pi additional_tools items');
  assert.ok(request.body.include.includes('web_search_call.action.sources'));
  assert.ok(request.body.include.includes('reasoning.encrypted_content'));
  assert.equal(request.body.max_output_tokens, undefined);
  const savedRows = first.service.getConversation(id).messages;
  await first.close();
  const nextProvider = responsesModels([[textItem('Follow-up answer.', 'msg_followup', [])]]);
  const reopened = await file.open(nextProvider);
  assert.deepEqual(reopened.service.getConversation(id).messages, savedRows);
  assert.equal(nextProvider.requests.length, 0, 'Opening history never starts a new search');
  await reopened.service.waitForSubmission(await reopened.service.send(id, 'Use those findings.'));
  assertReplay(nextProvider.requests[0].body, output);
});

test('interleaved native search and a local function round preserve original call ordering', { timeout: 15_000 }, async (t) => {
  const file = await fixture(t);
  const functionCall = { id: 'fc_add', type: 'function_call', status: 'completed', call_id: 'call_add',
    name: 'add_numbers', arguments: '{"a":19,"b":23}' };
  const output = [reasoningItem(), searchItem(), textItem('Checking the total.', 'msg_commentary', []), functionCall];
  output[2].phase = 'commentary';
  const provider = responsesModels([
    (exchange) => { exchange.created('resp_tools'); output.forEach((item, index) => exchange.item(item, index)); exchange.complete(output, { id: 'resp_tools' }); },
    [textItem('The researched total is 42.', 'msg_total')],
  ]);
  const { service, db } = await file.open(provider);
  const id = await newChat(service);
  assert.equal((await service.waitForSubmission(await service.send(id, 'Search and add 19 and 23.'))).status, 'done');
  assert.equal(provider.requests.length, 2, 'Only the client function requires another model round');
  assertReplay(provider.requests[1].body, output);
  const input = provider.requests[1].body.input;
  const result = input.find((item) => item.type === 'function_call_output');
  assert.equal(result.call_id, 'call_add');
  assert.match(result.output, /"sum":42/);
  assert.ok(input.indexOf(result) > input.findIndex((item) => item.id === 'fc_add'));
  assert.equal(service.getConversation(id).messages.filter((row) => row.tool).length, 1);
  assert.equal((await records(db, id)).length, 2);
});

test('terminal-only additional text and citations extend an already normalized assistant message', { timeout: 10_000 }, async (t) => {
  const file = await fixture(t);
  const first = textItem('First part. ', 'msg_first_part', []);
  first.phase = 'commentary';
  const last = textItem('Second part.', 'msg_second_part', [{ type: 'url_citation', start_index: 0, end_index: 12,
    url: 'https://openai.com/research/', title: 'Second source' }]);
  const output = [first, searchItem('ws_between'), last];
  const provider = responsesModels([(exchange) => {
    exchange.created('resp_multiple_parts');
    exchange.item(first, 0);
    exchange.complete(output, { id: 'resp_multiple_parts' });
  }]);
  const { service } = await file.open(provider);
  const id = await newChat(service);
  await service.waitForSubmission(await service.send(id, 'A multi-message search answer.'));
  const row = searchRows(service, id)[0];
  assert.equal(row.text, 'First part. Second part.');
  assert.equal(row.webSearch.citations[0].startIndex, 12);
  assert.equal(row.webSearch.citations[0].endIndex, 24);
});

test('concurrent chats cannot exchange response metadata or replay history', { timeout: 15_000 }, async (t) => {
  const file = await fixture(t);
  const active = [];
  const provider = responsesModels([
    (exchange) => { active.push(exchange); exchange.created('resp_a'); },
    (exchange) => { active.push(exchange); exchange.created('resp_b'); },
    [textItem('A follow-up', 'msg_a_next', [])],
  ]);
  const { service, db } = await file.open(provider);
  const a = await newChat(service);
  const b = await newChat(service);
  const sendA = await service.send(a, 'Question A');
  await until(() => active.length === 1, 'First chat starts');
  const sendB = await service.send(b, 'Question B');
  await until(() => active.length === 2, 'Second chat starts independently');
  const outA = [searchItem('ws_a'), textItem('Answer A', 'msg_a', [])];
  const outB = [searchItem('ws_b'), textItem('Answer B', 'msg_b', [])];
  active[1].complete(outB, { id: 'resp_b' });
  active[0].complete(outA, { id: 'resp_a' });
  await Promise.all([service.waitForSubmission(sendA), service.waitForSubmission(sendB)]);
  assert.deepEqual((await records(db, a))[0].output, outA);
  assert.deepEqual((await records(db, b))[0].output, outB);
  await service.waitForSubmission(await service.send(a, 'Continue A'));
  assertReplay(provider.requests[2].body, outA);
  assert.ok(!provider.requests[2].body.input.some((item) => item.id === 'ws_b' || item.id === 'msg_b'));
});

test('cancelling a search before text preserves interrupted activity and never restarts after reopen', { timeout: 15_000 }, async (t) => {
  const file = await fixture(t);
  let live;
  const provider = responsesModels([(exchange) => { live = exchange; exchange.created('resp_cancel');
    exchange.emit('response.output_item.added', { output_index: 0, item: { id: 'ws_cancel', type: 'web_search_call', status: 'in_progress' } });
    exchange.emit('response.web_search_call.searching', { output_index: 0, item_id: 'ws_cancel' }); }]);
  const first = await file.open(provider);
  const id = await newChat(first.service);
  const submission = await first.service.send(id, 'Start searching.');
  await until(() => searchRows(first.service, id).length > 0, 'Search-only activity is durably visible');
  await first.service.cancel(id);
  const result = await first.service.waitForSubmission(submission);
  assert.equal(result.status, 'unanswered');
  assert.equal(result.reason, 'aborted');
  assert.equal(live.request.signal.aborted, true);
  const raw = await records(first.db, id);
  assert.equal(raw[0].status, 'interrupted');
  assert.equal(searchRows(first.service, id)[0].webSearch.calls[0].status, 'interrupted');
  await first.close();
  const nextProvider = responsesModels([]);
  const reopened = await file.open(nextProvider);
  await reopened.service.resume();
  assert.equal(nextProvider.requests.length, 0);
  assert.equal(reopened.service.getConversation(id).pending, false);
  assert.equal(searchRows(reopened.service, id)[0].webSearch.calls[0].status, 'interrupted');
});

test('provider terminal failure preserves raw error metadata and settles without retrying', { timeout: 10_000 }, async (t) => {
  const file = await fixture(t);
  const output = [searchItem('ws_failure', { status: 'failed' })];
  const provider = responsesModels([(exchange) => { exchange.created('resp_failure');
    exchange.complete(output, { id: 'resp_failure', status: 'failed', error: { code: 'server_error', message: 'Synthetic search failure' } }); }]);
  const { service, db } = await file.open(provider);
  const id = await newChat(service);
  const result = await service.waitForSubmission(await service.send(id, 'Search will fail.'));
  assert.equal(result.status, 'unanswered');
  assert.equal(provider.requests.length, 1);
  const raw = await records(db, id);
  assert.equal(raw[0].status, 'failed');
  assert.deepEqual(raw[0].output, output);
  assert.equal(raw[0].response.error.message, 'Synthetic search failure');
  assert.equal(searchRows(service, id)[0].webSearch.calls[0].status, 'failed');
});

test('incomplete native output retains its status and remains replayable on a follow-up', { timeout: 10_000 }, async (t) => {
  const file = await fixture(t);
  const output = [reasoningItem('rs_incomplete'), searchItem('ws_incomplete', { status: 'incomplete' }),
    textItem('A partial researched answer.', 'msg_incomplete', [])];
  const provider = responsesModels([
    (exchange) => { exchange.created('resp_incomplete'); exchange.complete(output, { id: 'resp_incomplete', status: 'incomplete',
      incomplete_details: { reason: 'max_output_tokens' } }); },
    [textItem('Continued', 'msg_continued', [])],
  ]);
  const { service, db } = await file.open(provider);
  const id = await newChat(service);
  await service.waitForSubmission(await service.send(id, 'Start a search answer.'));
  const raw = (await records(db, id))[0];
  assert.equal(raw.status, 'incomplete');
  assert.deepEqual(raw.output, output);
  assert.equal(raw.response.incomplete_details.reason, 'max_output_tokens');
  assert.equal(searchRows(service, id)[0].webSearch.calls[0].status, 'interrupted');
  await service.waitForSubmission(await service.send(id, 'Continue.'));
  assertReplay(provider.requests[1].body, output);
});

test('an interrupted transport is retained on shutdown and recovery starts a fresh request for the same submission', { timeout: 15_000 }, async (t) => {
  const file = await fixture(t);
  const firstProvider = responsesModels([(exchange) => {
    exchange.created('resp_unfinished');
    exchange.emit('response.output_item.added', { output_index: 0, item: { id: 'ws_unfinished', type: 'web_search_call', status: 'in_progress' } });
    exchange.emit('response.web_search_call.searching', { output_index: 0, item_id: 'ws_unfinished' });
  }]);
  const first = await file.open(firstProvider);
  const id = await newChat(first.service);
  const submission = await first.service.send(id, 'Resume after shutdown.');
  await until(() => searchRows(first.service, id).length > 0, 'Unfinished search was committed');
  const previous = (await records(first.db, id))[0];
  await first.close();
  const completed = [searchItem('ws_recovered'), textItem('Recovered answer', 'msg_recovered', [])];
  const nextProvider = responsesModels([(exchange) => { exchange.created('resp_recovered'); exchange.complete(completed, { id: 'resp_recovered' }); }]);
  const reopened = await file.open(nextProvider);
  assert.equal(nextProvider.requests.length, 0);
  assert.equal(reopened.service.getConversation(id).pending, true);
  await reopened.service.resume();
  assert.equal((await reopened.service.waitForSubmission(submission)).status, 'done');
  assert.equal(nextProvider.requests.length, 1);
  assert.ok(!nextProvider.requests[0].body.input.some((item) => item.id === 'ws_unfinished'));
  const recovered = await records(reopened.db, id);
  assert.equal(recovered.length, 2);
  assert.equal(recovered.find((record) => record.requestId === previous.requestId).status, 'interrupted');
  const fresh = recovered.find((record) => record.requestId !== previous.requestId);
  assert.equal(fresh.taskId, previous.taskId);
  assert.equal(fresh.status, 'completed');
  assert.deepEqual(fresh.output, completed);
});

test('reset and fork use only native outputs within the active durable history', { timeout: 15_000 }, async (t) => {
  const file = await fixture(t);
  const old = [reasoningItem('rs_old'), searchItem('ws_old'), textItem('Old answer', 'msg_old', [])];
  const later = [searchItem('ws_later'), textItem('Later answer', 'msg_later', [])];
  const provider = responsesModels([old, later, [textItem('Fork answer', 'msg_fork', [])], [textItem('Reset answer', 'msg_reset', [])]]);
  const { harness } = await file.harness(provider);
  const parent = await harness.createConversation({ ownership: { kind: 'ownerless' }, agent: settings }, context);
  await (await parent.submit({ type: 'input', content: 'Old question' }, context)).wait(context);
  const entries = await parent.entries({}, 100, undefined, context);
  const forkPoint = entries.items.find((entry) => entry.model?.some((message) => message.role === 'assistant'));
  assert.ok(forkPoint);
  await (await parent.submit({ type: 'input', content: 'Later question' }, context)).wait(context);
  const child = await parent.fork(forkPoint.id, { ownership: { kind: 'ownerless' }, agent: settings }, context);
  await (await child.submit({ type: 'input', content: 'Fork follow-up' }, context)).wait(context);
  assertReplay(provider.requests[2].body, old);
  assert.ok(!provider.requests[2].body.input.some((item) => item.id === 'ws_later'));
  await child.reset('Start fresh', context);
  await (await child.submit({ type: 'input', content: 'After reset' }, context)).wait(context);
  assert.ok(!provider.requests[3].body.input.some((item) => item.type === 'web_search_call' || item.id === 'rs_old'),
    'Raw persistence cannot resurrect items removed by a context reset');
});

test('context edits cannot restore the original native answer through its retained response ID', { timeout: 10_000 }, async (t) => {
  const file = await fixture(t);
  const output = [reasoningItem('rs_edit'), searchItem('ws_edit'), textItem('Original answer that was replaced', 'msg_edit', [])];
  const provider = responsesModels([
    (exchange) => { exchange.created('resp_edit'); output.forEach((item, index) => exchange.item(item, index)); exchange.complete(output, { id: 'resp_edit' }); },
    [textItem('Follow up', 'msg_after_edit', [])],
  ]);
  const { harness } = await file.harness(provider);
  const conversation = await harness.createConversation({ ownership: { kind: 'ownerless' }, agent: settings }, context);
  await (await conversation.submit({ type: 'input', content: 'Original question' }, context)).wait(context);
  const history = await conversation.entries({}, 100, undefined, context);
  const entry = history.items.find((candidate) => candidate.model?.some((message) => message.role === 'assistant'));
  const original = entry.model.find((message) => message.role === 'assistant');
  const edited = { ...original, content: [{ type: 'text', text: 'The revised context supersedes the original answer.' }] };
  assert.equal(edited.responseId, 'resp_edit');
  await conversation.commit((tx) => tx.appendEntry(conversation.id, {
    kind: 'test.context-replacement', edits: [{ target: entry.id, action: 'replace', messages: [edited] }],
  }), context);
  await (await conversation.submit({ type: 'input', content: 'Continue from the revision.' }, context)).wait(context);
  const next = provider.requests[1].body.input;
  assert.match(JSON.stringify(next), /The revised context supersedes the original answer/);
  assert.doesNotMatch(JSON.stringify(next), /Original answer that was replaced/);
  assert.ok(!next.some((item) => ['rs_edit', 'ws_edit', 'msg_edit'].includes(item.id)));
  const archive = await harness.snapshot(NativeResponsesDoc, conversation.id, context);
  assert.deepEqual(Object.values(archive.responses).find((record) => record.responseId === 'resp_edit').output, output,
    'A context replacement changes replay without destroying the original raw record');
});

test('compaction excludes archived raw search items from future model context while retaining their archive', { timeout: 15_000 }, async (t) => {
  const file = await fixture(t);
  const first = [reasoningItem('rs_compacted'), searchItem('ws_compacted'), textItem('Long historical answer '.repeat(50), 'msg_compacted', [])];
  const recent = [textItem('Recent answer', 'msg_recent', [])];
  const provider = responsesModels([first, recent, [textItem('After compaction', 'msg_after_compact', [])]]);
  const summaries = [];
  const extension = defineExtension({ name: 'test-compact-without-network', hooks: [hook(CompactionTask, {
    beforeCompact(value) { summaries.push(value); return { summary: 'The older search was summarized.' }; },
  })] });
  const { harness } = await file.harness(provider, { extensions: [extension], compaction: { keepRecentTokens: 1 } });
  const conversation = await harness.createConversation({ ownership: { kind: 'ownerless' }, agent: settings }, context);
  await (await conversation.submit({ type: 'input', content: 'First question' }, context)).wait(context);
  await (await conversation.submit({ type: 'input', content: 'Recent question' }, context)).wait(context);
  const task = await conversation.compact(undefined, context);
  await harness.waitForTask(task, context);
  await conversation.waitForIdle(context);
  assert.equal(summaries.length, 1);
  await (await conversation.submit({ type: 'input', content: 'After compaction' }, context)).wait(context);
  assert.ok(!provider.requests[2].body.input.some((item) => item.id === 'ws_compacted' || item.id === 'rs_compacted'));
  const archive = await harness.snapshot(NativeResponsesDoc, conversation.id, context);
  assert.ok(Object.values(archive.responses).some((record) => record.output.some((item) => item.id === 'ws_compacted')),
    'Compaction changes replay context, not retained raw provider history');
});
