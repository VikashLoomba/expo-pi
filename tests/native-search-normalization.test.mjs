import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { registerHooks, stripTypeScriptTypes } from 'node:module';
import test from 'node:test';
import { MODEL_ID, responsesModels, reasoningItem, searchItem, textItem } from './helpers/openai-responses.mjs';

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
const { withNativeWebSearch } = await import('../src/pi/native-web-search/provider.ts');
const { bindNativeWebSearch } = await import('../src/pi/native-web-search/bindings.ts');
const { normalizeNativeResponse } = await import('../src/pi/native-web-search/normalization.ts');
const user = (content, timestamp = 1) => ({ role: 'user', content, timestamp });

function scope(model = MODEL_ID) {
  const controller = new AbortController();
  const saved = [];
  bindNativeWebSearch(controller.signal, {
    record: { requestId: 'normalization-request', taskId: 1, provider: 'openai', model,
      status: 'in_progress', output: [], events: [] },
    save: async (value) => { saved.push(structuredClone(value)); },
  });
  return { signal: controller.signal, saved };
}

test('terminal-only native output becomes ordinary Pi blocks and Pi replays opaque state and local tool pairing', async () => {
  const call = { id: 'fc_sum', type: 'function_call', status: 'completed', call_id: 'call_sum',
    name: 'add_numbers', arguments: '{"a":19,"b":23}' };
  const commentary = { ...textItem('Checking.', 'msg_commentary', []), phase: 'commentary' };
  const raw = [reasoningItem(), searchItem(), commentary, call];
  const provider = responsesModels([raw, [textItem('Done.', 'msg_done', [])]], { wrapProvider: withNativeWebSearch });
  const model = provider.models.getModel('openai', MODEL_ID);
  const firstScope = scope();
  const first = await provider.models.completeSimple(model, { messages: [user('Search and add.')] }, firstScope);
  assert.equal(first.stopReason, 'toolUse');
  assert.deepEqual(first.content.map((block) => block.type), ['thinking', 'text', 'toolCall']);
  assert.deepEqual(JSON.parse(first.content[0].thinkingSignature), raw[0]);
  assert.deepEqual(JSON.parse(first.content[1].textSignature), { v: 1, id: commentary.id, phase: 'commentary' });
  assert.deepEqual(first.content[2].arguments, { a: 19, b: 23 });
  assert.equal(firstScope.saved.at(-1).normalizedContent, JSON.stringify(first.content));
  assert.deepEqual(firstScope.saved.at(-1).output, raw, 'Original hosted output remains in the archive');

  const evidence = user('External source excerpt: the cobalt beacon flashes every 47 seconds.', 2);
  await provider.models.completeSimple(model, { messages: [user('Search and add.'), evidence, first,
    { role: 'toolResult', toolCallId: 'call_sum|fc_sum', toolName: 'add_numbers',
      content: [{ type: 'text', text: '42' }], isError: false, timestamp: 3 }, user('Continue.', 4)] }, scope());
  const input = provider.requests[1].body.input;
  assert.match(JSON.stringify(input), /cobalt beacon flashes every 47 seconds/);
  assert.deepEqual(input.find((item) => item.type === 'reasoning'), raw[0]);
  assert.equal(input.find((item) => item.id === commentary.id).phase, 'commentary');
  assert.equal(input.filter((item) => item.type === 'function_call').length, 1);
  assert.equal(input.find((item) => item.type === 'function_call_output').call_id, 'call_sum');
  assert.equal(input.some((item) => item.type === 'web_search_call'), false, 'Hosted snippets use canonical evidence, not raw input splicing');
  assert.doesNotMatch(JSON.stringify(input), /msg_native_/);
});

test('terminal reconciliation adds omitted final text without duplicating streamed text or replaying UI deltas', async () => {
  const first = { ...textItem('First part. ', 'msg_first', []), phase: 'commentary' };
  const last = textItem('Second part.', 'msg_last', []);
  const provider = responsesModels([(exchange) => {
    exchange.created(); exchange.item(first, 0);
    exchange.complete([first, searchItem(), last]);
  }], { wrapProvider: withNativeWebSearch });
  const model = provider.models.getModel('openai', MODEL_ID);
  const state = scope();
  const stream = provider.models.streamSimple(model, { messages: [user('Search.')] }, state);
  const events = [];
  for await (const event of stream) events.push(event.type);
  const result = await stream.result();
  assert.deepEqual(result.content.map((block) => block.text), ['First part. ', 'Second part.']);
  assert.equal(events.filter((type) => type === 'text_end').length, 1);
  assert.equal(events.filter((type) => type === 'done').length, 1);
  assert.equal(JSON.parse(result.content[1].textSignature).phase, 'final_answer');
});

test('ordinary completed streams preserve signatures and original reported usage without duplicating blocks', async () => {
  const raw = [reasoningItem(), searchItem(), textItem()];
  const step = (exchange) => {
    exchange.created(); raw.forEach((item, index) => exchange.item(item, index)); exchange.complete(raw);
  };
  const base = responsesModels([step]);
  const adapted = responsesModels([step], { wrapProvider: withNativeWebSearch });
  const messages = { messages: [user('Search.')] };
  const expected = await base.models.completeSimple(base.models.getModel('openai', MODEL_ID), messages);
  const actual = await adapted.models.completeSimple(adapted.models.getModel('openai', MODEL_ID), messages, scope());
  assert.deepEqual(actual.content, expected.content);
  assert.deepEqual(actual.usage, expected.usage);
  assert.equal(actual.stopReason, expected.stopReason);
});

test('opaque reasoning remains same-model only while explicit evidence survives model changes', async () => {
  const provider = responsesModels([[reasoningItem(), textItem()], [textItem('Next.', 'msg_next', [])]], {
    wrapProvider: withNativeWebSearch,
  });
  const model = provider.models.getModel('openai', MODEL_ID);
  const first = await provider.models.completeSimple(model, { messages: [user('Search.')] }, scope());
  await provider.models.completeSimple({ ...model, id: 'test-other-model' }, {
    messages: [user('External source excerpt: cobalt flashes every 47 seconds.'), first, user('Continue.', 2)],
  }, scope('test-other-model'));
  assert.equal(provider.requests[1].body.input.some((item) => item.type === 'reasoning'), false);
  assert.match(JSON.stringify(provider.requests[1].body.input), /cobalt flashes every 47 seconds/);
  assert.equal(provider.requests[1].body.input.some((item) => item.id === 'msg_search'), false);
});

test('reconciliation preserves incomplete status and never turns an aborted or failed response into success', async () => {
  const raw = [reasoningItem(), textItem('A partial answer.', 'msg_partial', [])];
  const provider = responsesModels([(exchange) => exchange.complete(raw, {
    status: 'incomplete', incomplete_details: { reason: 'max_output_tokens' },
  })], { wrapProvider: withNativeWebSearch });
  const model = provider.models.getModel('openai', MODEL_ID);
  const state = scope();
  const result = await provider.models.completeSimple(model, { messages: [user('Search.')] }, state);
  assert.equal(result.stopReason, 'length');
  assert.equal(result.rawStopReason, 'incomplete.max_output_tokens');
  assert.equal(result.content[1].text, 'A partial answer.');
  for (const stopReason of ['aborted', 'error']) {
    const failed = { ...result, stopReason, errorMessage: 'Transport interrupted' };
    assert.equal(await normalizeNativeResponse(model, { messages: [] }, failed, state.saved.at(-1)), failed);
  }
  const incompleteEnvelope = { ...state.saved.at(-1), status: 'completed',
    output: [{ ...textItem('', 'msg_unfinished', []), status: 'in_progress' }] };
  assert.equal(await normalizeNativeResponse(model, { messages: [] }, result, incompleteEnvelope), result);
  assert.equal(await normalizeNativeResponse(model, { messages: [] }, result, {
    ...incompleteEnvelope, output: [],
  }), result, 'An empty envelope cannot erase existing normalized partial text');
});
