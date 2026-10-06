import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { registerHooks, stripTypeScriptTypes } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { BACKGROUND_CONTEXT } from '@earendil-works/chord/context';
import { getSupportedThinkingLevels } from '@earendil-works/pi-ai';
import { anthropicProvider } from '@earendil-works/pi-ai/providers/anthropic';
import { Harness, createRegistry, defineExtension, hook, CompactionTask } from '@earendil-works/pi-durable';
import { SqliteStorage } from '@earendil-works/pi-durable/storage/sqlite';
import { createExpoSqliteDatabase } from '../src/pi/storage/expo-sqlite.ts';
import { createNodeSqliteConnection } from './helpers/node-sqlite.mjs';
import { MODEL_ID, SUBSCRIPTION_TOKEN, responsesModels as realResponsesModels, reasoningItem, searchItem, sourceFact, inputText, textItem, until } from './helpers/openai-responses.mjs';

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
const { SearchObservationEntry } = await import('../src/pi/native-web-search/observations.ts');
const { editSearchTurn } = await import('../src/pi/native-web-search/edits.ts');
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
function assertPiContext(body, output, { evidence = true } = {}) {
  assert.equal(body.input.some((item) => item.type === 'web_search_call'), false,
    'Native hosted-call objects are not a substitute for model-readable evidence');
  const ordinaryUserText = inputText(body, 'user');
  for (const original of output) {
    if (original.type === 'web_search_call') {
      if (evidence && original.status === 'completed') {
        const fact = sourceFact(original.id);
        assert.equal(ordinaryUserText.split(fact).length - 1, 1, 'The actual source fact is ordinary input exactly once');
      }
      continue;
    }
    const items = body.input.filter((item) => item.id === original.id);
    assert.equal(items.length, 1, `Pi preserves ${original.type} identity without synthetic boundaries`);
    const item = items[0];
    if (original.type === 'reasoning') assert.equal(item.encrypted_content, original.encrypted_content);
    if (original.type === 'message') {
      assert.equal(item.phase, original.phase);
      assert.equal(item.content.map((part) => part.text ?? part.refusal ?? '').join(''),
        original.content.map((part) => part.text ?? part.refusal ?? '').join(''));
    }
    if (original.type === 'function_call') {
      assert.equal(item.call_id, original.call_id);
      assert.deepEqual(JSON.parse(item.arguments), JSON.parse(original.arguments));
    }
  }
  assert.doesNotMatch(JSON.stringify(body.input), /msg_native_/);
}

test('bound provider composes caller hooks and preserves replacement request fields', { timeout: 10_000 }, async () => {
  const output = [reasoningItem(), searchItem(), textItem()];
  const provider = responsesModels([(exchange) => { exchange.created(); exchange.complete(output); }]);
  const controller = new AbortController();
  const saves = [];
  bindNativeWebSearch(controller.signal, {
    record: { requestId: 'hooks-request', taskId: 101, provider: 'openai', model: MODEL_ID,
      status: 'in_progress', output: [], events: [] },
    save: async (record) => { saves.push(structuredClone(record)); },
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

test('caller payload replacement retains the last word after Pi converts historical signatures', { timeout: 10_000 }, async () => {
  const output = [reasoningItem('rs_hook_history'), searchItem('ws_hook_history'), textItem('History', 'msg_hook_history', [])];
  const provider = responsesModels([
    (exchange) => { exchange.created('resp_hook_history'); exchange.complete(output, { id: 'resp_hook_history' }); },
    [textItem('Next', 'msg_hook_next', [])],
  ]);
  const model = provider.models.getModel('openai', MODEL_ID);
  const user = { role: 'user', content: 'First', timestamp: 1 };
  const firstController = new AbortController();
  bindNativeWebSearch(firstController.signal, { record: { requestId: 'hook-first', taskId: 201,
    provider: 'openai', model: MODEL_ID, status: 'in_progress', output: [], events: [] }, save: async () => {} });
  const first = await provider.models.completeSimple(model, { messages: [user] }, { signal: firstController.signal });
  const nextController = new AbortController();
  bindNativeWebSearch(nextController.signal, { record: { requestId: 'hook-second', taskId: 202,
    provider: 'openai', model: MODEL_ID, status: 'in_progress', output: [], events: [] }, save: async () => {} });
  await provider.models.completeSimple(model, { messages: [user, first, { role: 'user', content: 'Next', timestamp: 2 }] }, {
    signal: nextController.signal,
    onPayload(payload) {
      assertPiContext(payload, output, { evidence: false });
      return { ...payload, input: [...payload.input, { role: 'developer', content: 'Caller final input edit' }],
        metadata: { finalHook: true } };
    },
  });
  assertPiContext(provider.requests[1].body, output, { evidence: false });
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
    provider: 'openai', model: MODEL_ID, status: 'in_progress', output: [], events: [] },
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

test('official normalization strips output provenance from Pi signatures without changing the raw SQLite archive', { timeout: 10_000 }, async (t) => {
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
  assert.equal(replay.length, output.length - 1, 'Readable evidence replaces raw hosted calls in input');
  assert.ok(replay.every((item) => !Object.hasOwn(item, 'created_by')));
  assert.equal(replay[0].encrypted_content, output[0].encrypted_content);
  assert.ok(!Object.hasOwn(replay[1].content[0], 'parsed'));
  assertPiContext(provider.requests[1].body, output);
  assert.deepEqual((await records(db, id))[0].output, output, 'Replay normalization never mutates the archive');
});

test('native search streams before text and source-only facts are ordinary input after SQLite reopen', { timeout: 15_000 }, async (t) => {
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
  assertPiContext(nextProvider.requests[0].body, output);
  assert.match(inputText(nextProvider.requests[0].body, 'user'), /External web search evidence/);
  assert.doesNotMatch(final.text, /cobalt beacon/, 'The fact is absent from assistant prose');
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
  assertPiContext(provider.requests[1].body, output);
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
  assertPiContext(provider.requests[2].body, outA);
  assert.ok(!inputText(provider.requests[2].body).includes(sourceFact('ws_b')));
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

test('incomplete search retains activity and opaque state without claiming completed source observations', { timeout: 10_000 }, async (t) => {
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
  assertPiContext(provider.requests[1].body, output);
  assert.ok(!inputText(provider.requests[1].body).includes(sourceFact('ws_incomplete')));
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

test('reset and fork select only canonical source observations within active durable history', { timeout: 15_000 }, async (t) => {
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
  assertPiContext(provider.requests[2].body, old);
  assert.ok(!inputText(provider.requests[2].body).includes(sourceFact('ws_later')));
  assert.ok(!provider.requests[2].body.input.some((item) => item.id === 'ws_later'));
  await child.reset('Start fresh', context);
  await (await child.submit({ type: 'input', content: 'After reset' }, context)).wait(context);
  assert.ok(!provider.requests[3].body.input.some((item) => item.type === 'web_search_call' || item.id === 'rs_old'),
    'Raw persistence cannot resurrect items removed by a context reset');
  assert.ok(!inputText(provider.requests[3].body).includes(sourceFact('ws_old')));
});

test('logical-turn replacement omits its associated source observations while preserving raw history', { timeout: 10_000 }, async (t) => {
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
  await conversation.commit((tx) => editSearchTurn(tx, conversation.id,
    { target: entry.id, action: 'replace', messages: [edited] }), context);
  await (await conversation.submit({ type: 'input', content: 'Continue from the revision.' }, context)).wait(context);
  const next = provider.requests[1].body.input;
  assert.match(JSON.stringify(next), /The revised context supersedes the original answer/);
  assert.doesNotMatch(JSON.stringify(next), /Original answer that was replaced/);
  assert.ok(!next.some((item) => ['rs_edit', 'ws_edit', 'msg_edit'].includes(item.id)));
  assert.ok(!inputText(provider.requests[1].body).includes(sourceFact('ws_edit')));
  const archive = await harness.snapshot(NativeResponsesDoc, conversation.id, context);
  assert.deepEqual(Object.values(archive.responses).find((record) => record.responseId === 'resp_edit').output, output,
    'A context replacement changes replay without destroying the original raw record');
});

test('SQLite reopen retains canonical source-only facts and model changes preserve readable evidence', { timeout: 15_000 }, async (t) => {
  const file = await fixture(t);
  const raw = [reasoningItem('rs_portable'), searchItem('ws_portable'), textItem('I found a calibration bulletin.', 'msg_portable', [])];
  const initial = await file.harness(responsesModels([raw]));
  const conversation = await initial.harness.createConversation({ ownership: { kind: 'ownerless' }, agent: settings }, context);
  await (await conversation.submit({ type: 'input', content: 'Research the observatory.' }, context)).wait(context);
  const before = await conversation.context(context);
  assert.equal(before.entries.filter((entry) => SearchObservationEntry.is(entry)).length, 1);
  assert.equal(before.messages.filter((message) => message.role === 'user' &&
    JSON.stringify(message.content).includes(sourceFact('ws_portable'))).length, 1);
  assert.ok(!before.messages.some((message) => message.role === 'assistant' &&
    JSON.stringify(message.content).includes(sourceFact('ws_portable'))));
  await initial.close();

  const provider = responsesModels([[textItem('Resumed.', 'msg_resume', [])], [textItem('Switched.', 'msg_switch', [])]]);
  const reopened = await file.harness(provider);
  const restored = await reopened.harness.conversation(conversation.id, context);
  assert.deepEqual((await restored.context(context)).messages, before.messages);
  assert.equal(provider.requests.length, 0);
  await (await restored.submit({ type: 'input', content: 'Use the earlier finding.' }, context)).wait(context);
  assertPiContext(provider.requests[0].body, raw);
  await restored.configure({ model: { provider: 'openai', modelId: 'gpt-5' }, thinkingLevel: 'medium' }, context);
  await (await restored.submit({ type: 'input', content: 'Continue with this model.' }, context)).wait(context);
  assert.match(inputText(provider.requests[1].body, 'user'), /ws_portable observatory calibrates its cobalt beacon every 47 seconds/);
  assert.ok(!provider.requests[1].body.input.some((item) => item.id === 'rs_portable'),
    'Opaque reasoning is not sent to another model');
});

test('an assistant-only context edit preserves an independently completed source observation', { timeout: 10_000 }, async (t) => {
  const file = await fixture(t);
  const provider = responsesModels([[searchItem('ws_independent'), textItem('Remove just this answer.', 'msg_independent', [])],
    [textItem('Continued.', 'msg_independent_next', [])]]);
  const { harness } = await file.harness(provider);
  const conversation = await harness.createConversation({ ownership: { kind: 'ownerless' }, agent: settings }, context);
  await (await conversation.submit({ type: 'input', content: 'Search.' }, context)).wait(context);
  const view = await conversation.context(context);
  const assistant = view.entries.find((entry) => entry.kind === 'pi.assistant');
  await conversation.commit((tx) => tx.appendEntry(conversation.id, {
    kind: 'test.omit-answer-only', edits: [{ target: assistant.id, action: 'omit' }],
  }), context);
  await (await conversation.submit({ type: 'input', content: 'Use the independently retained evidence.' }, context)).wait(context);
  assert.ok(inputText(provider.requests[1].body, 'user').includes(sourceFact('ws_independent')));
  assert.doesNotMatch(inputText(provider.requests[1].body), /Remove just this answer/);
});

test('built-in compaction receives source-only facts and a fact-derived summary supports later continuation', { timeout: 15_000 }, async (t) => {
  const file = await fixture(t);
  const first = [reasoningItem('rs_compacted'), searchItem('ws_compacted'), textItem('Long historical answer '.repeat(50), 'msg_compacted', [])];
  const recent = [textItem('Recent answer', 'msg_recent', [])];
  let summarizerInput;
  let summary;
  let continuation;
  const provider = responsesModels([first, recent,
    (exchange, request) => {
      summarizerInput = inputText(request.body);
      assert.match(summarizerInput, /context summarization assistant/);
      // This deterministic synthetic model can retain only facts actually in
      // its request. No beforeCompact summary override supplies hidden evidence.
      const facts = summarizerInput.match(/The ws_compacted observatory calibrates its cobalt beacon every \d+ seconds\./g) ?? [];
      assert.ok(facts.length > 0, 'The real summarizer request must contain the source-only fact');
      summary = `Critical source evidence: ${[...new Set(facts)].join(' ')} Source: https://example.test/observatories/ws_compacted`;
      const item = textItem(summary, 'msg_actual_summary', []);
      exchange.item(item, 0); exchange.complete([item], { id: 'resp_actual_summary' });
    },
    (exchange, request) => {
      const found = inputText(request.body).match(/cobalt beacon every (\d+) seconds/);
      assert.ok(found, 'Post-compaction request must preserve the useful fact');
      continuation = `The retained source says the interval is ${found[1]} seconds.`;
      exchange.complete([textItem(continuation, 'msg_after_compact', [])]);
    },
  ]);
  const summaries = [];
  const extension = defineExtension({ name: 'test-observe-compaction', hooks: [hook(CompactionTask, {
    beforeCompact(value) { summaries.push(value); },
  })] });
  const { harness } = await file.harness(provider, { extensions: [extension], compaction: { keepRecentTokens: 1 } });
  const conversation = await harness.createConversation({ ownership: { kind: 'ownerless' }, agent: settings }, context);
  await (await conversation.submit({ type: 'input', content: 'First question' }, context)).wait(context);
  await (await conversation.submit({ type: 'input', content: 'Recent question' }, context)).wait(context);
  const task = await conversation.compact(undefined, context);
  await harness.waitForTask(task, context);
  await conversation.waitForIdle(context);
  assert.equal(summaries.length, 1);
  assert.ok(JSON.stringify(summaries[0].messages).includes(sourceFact('ws_compacted')));
  assert.ok(summarizerInput.includes(sourceFact('ws_compacted')));
  assert.ok(summary.includes(sourceFact('ws_compacted')));
  const compacted = await conversation.context(context);
  assert.equal(compacted.head.kind, 'pi.compaction');
  assert.ok(!compacted.entries.some((entry) => SearchObservationEntry.is(entry)), 'The old observation is summarized, not kept verbatim');
  await (await conversation.submit({ type: 'input', content: 'What calibration interval did the source report?' }, context)).wait(context);
  assert.equal(continuation, 'The retained source says the interval is 47 seconds.');
  assert.ok(!provider.requests[3].body.input.some((item) => item.id === 'ws_compacted' || item.id === 'rs_compacted'));
  assert.ok(inputText(provider.requests[3].body, 'user').includes(summary));
  const archive = await harness.snapshot(NativeResponsesDoc, conversation.id, context);
  assert.ok(Object.values(archive.responses).some((record) => record.output.some((item) => item.id === 'ws_compacted')),
    'Compaction changes replay context, not retained raw provider history');
});

test('a reopened OpenAI search remains readable through the actual Anthropic request converter', async (t) => {
  const file = await fixture(t);
  const provider = responsesModels([[reasoningItem(), searchItem('ws_anthropic'), textItem('I found a bulletin.')]]);
  const initial = await file.open(provider);
  const id = await newChat(initial.service);
  await initial.service.waitForSubmission(await initial.service.send(id, 'Search for the calibration bulletin.'));
  await initial.close();
  const anthropic = anthropicProvider();
  let requestBody;
  const fetch = async (_url, init) => {
    requestBody = JSON.parse(init.body);
    const text = requestBody.messages.flatMap((message) => typeof message.content === 'string' ? [message.content]
      : message.content.filter((block) => block.type === 'text').map((block) => block.text)).join('\n');
    const fact = sourceFact('ws_anthropic');
    assert.equal(text.split(fact).length - 1, 1);
    assert.doesNotMatch(JSON.stringify(requestBody), /opaque-encrypted-reasoning|web_search_call/);
    const events = [
      { type: 'message_start', message: { id: 'msg_anthropic', type: 'message', role: 'assistant', model: 'test',
        content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 100, output_tokens: 0 } } },
      { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
      { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: `The retained bulletin says: ${fact}` } },
      { type: 'content_block_stop', index: 0 },
      { type: 'message_delta', delta: { stop_reason: 'end_turn', stop_sequence: null }, usage: { output_tokens: 20 } },
      { type: 'message_stop' },
    ];
    return new Response(events.map((event) => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`).join(''), {
      status: 200, headers: { 'content-type': 'text/event-stream' },
    });
  };
  provider.models.setProvider({ ...anthropic, auth: { apiKey: {
    name: 'Synthetic Anthropic', check: async () => ({ type: 'api_key' }),
    resolve: async () => ({ auth: { apiKey: 'synthetic-test-key' } }),
  } }, streamSimple: (model, context, options) => anthropic.streamSimple(model, context, { ...options, fetch }) });
  const reopened = await file.open(provider);
  const model = provider.models.getModels('anthropic')[0];
  await reopened.service.updateSettings(id, { model: { provider: 'anthropic', modelId: model.id },
    thinkingLevel: getSupportedThinkingLevels(model)[0] });
  const completed = await reopened.service.waitForSubmission(await reopened.service.send(id, 'What does the saved bulletin say?'));
  assert.equal(completed.status, 'done');
  assert.ok(requestBody, 'Anthropic serialized the ordinary durable observation');
  assert.match(reopened.service.getConversation(id).messages.at(-1).text, /47 seconds/);
  assert.equal(provider.requests.length, 1, 'Switching provider does not repeat the hosted search');
});
