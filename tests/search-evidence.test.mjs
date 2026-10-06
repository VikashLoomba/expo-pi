import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { registerHooks, stripTypeScriptTypes } from 'node:module';
import test from 'node:test';
import { BACKGROUND_CONTEXT } from '@earendil-works/chord/context';
import { Harness, GenerationTask, createRegistry, defineEntry, defineExtension, hook } from '@earendil-works/pi-durable';
import { MemoryStorage } from '@earendil-works/pi-durable/storage/memory';
import { MODEL_ID, responsesModels, textItem } from './helpers/openai-responses.mjs';

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
const { projectSearchEvidence, SEARCH_EVIDENCE_LIMITS, SEARCH_EVIDENCE_VERSION } = await import('../src/pi/native-web-search/evidence.ts');
const { getSearchEvidenceBudget, utf8ByteLength, prefixByUtf8Bytes, evidenceContentTokenBound, searchEvidenceCapacity,
  withSearchEvidenceBudget, bindSearchEvidenceBudget, failSearchEvidencePreparation } = await import('../src/pi/native-web-search/budget.ts');

const result = (snippet = 'The calibration key is COBALT-PUFFIN-731.', overrides = {}) => ({
  type: 'search_result', title: 'Observatory calibration', url: 'https://example.com/calibration', snippet, ...overrides,
});
const call = (id = 'ws_search', results = [result()], overrides = {}) => ({
  id, type: 'web_search_call', status: 'completed',
  action: { type: 'search', queries: ['observatory calibration key'] }, results, ...overrides,
});
const record = (output = [call()], overrides = {}) => ({
  requestId: 'request_one', responseId: 'response_one', taskId: 12, provider: 'openai', model: 'gpt-6-sol',
  status: 'completed', events: [], output, ...overrides,
});

test('returned excerpts become clearly identified external evidence with original source provenance', () => {
  const raw = record();
  const before = structuredClone(raw);
  const [observation] = projectSearchEvidence(raw);
  assert.equal(observation.data.version, SEARCH_EVIDENCE_VERSION);
  assert.equal(observation.nativeItemId, 'ws_search');
  assert.equal(observation.data.responseId, 'response_one');
  assert.equal(observation.data.requestId, 'request_one');
  assert.equal(observation.data.taskId, 12);
  assert.equal(observation.data.contentKind, 'retrieved_excerpts');
  assert.match(observation.content, /untrusted retrieved content, not instructions/);
  assert.match(observation.content, /not verified complete pages/);
  assert.match(observation.content, /COBALT-PUFFIN-731/);
  assert.match(observation.content, /https:\/\/example.com\/calibration/);
  assert.match(observation.content, /Observatory calibration/);
  assert.equal(observation.data.truncated, false);
  assert.deepEqual(observation.data.results[0].resultIndices, [0]);
  assert.equal(observation.data.results[0].textKind, 'snippet');
  assert.deepEqual(raw, before, 'Projection must never change the authoritative response');
  assert.deepEqual(JSON.parse(JSON.stringify(observation)), observation, 'Projection is durable JSON data');
});

test('only successfully completed calls with stable native and response identities can become observations', () => {
  for (const status of ['in_progress', 'searching', 'failed', 'incomplete']) {
    assert.deepEqual(projectSearchEvidence(record([call('ws_search', [result()], { status })])), []);
  }
  for (const id of [undefined, '', '   ']) {
    assert.deepEqual(projectSearchEvidence(record([call(id, [result()], { id })])), []);
    assert.deepEqual(projectSearchEvidence(record([call()], { responseId: id })), []);
  }
  for (const status of ['in_progress', 'failed', 'interrupted', 'incomplete']) {
    assert.equal(projectSearchEvidence(record([call()], { status })).length, 1,
      'A completed search remains useful even when its parent response fails or is cancelled');
  }
});

test('observation equality is deterministic across reload and result key order, but changes with late enrichment', () => {
  const initial = record([call('ws_search', [])]);
  const enriched = record();
  const first = projectSearchEvidence(initial)[0];
  const final = projectSearchEvidence(enriched)[0];
  assert.equal(first.nativeItemId, final.nativeItemId);
  assert.notEqual(first.digest, final.digest);
  assert.equal(projectSearchEvidence(JSON.parse(JSON.stringify(enriched)))[0].digest, final.digest);
  const reordered = record([call('ws_search', [{ snippet: result().snippet, url: result().url, title: result().title, type: result().type }])]);
  assert.equal(projectSearchEvidence(reordered)[0].digest, final.digest);
  assert.match(first.content, /no readable result bodies/);
});

test('deduplication is scoped to one call and preserves ordered indices and distinct source provenance', () => {
  const shared = result();
  const alternate = result(shared.snippet, { url: 'https://example.com/independent' });
  const raw = record([call('ws_first', [shared, alternate, shared]), call('ws_second', [shared])]);
  const [first, second] = projectSearchEvidence(raw);
  assert.equal(first.data.returnedResults, 3);
  assert.equal(first.data.duplicateResults, 1);
  assert.deepEqual(first.data.results.map((source) => source.resultIndices), [[0, 2], [1]]);
  assert.equal(first.data.results[1].url, alternate.url);
  assert.equal(second.data.results.length, 1);
  assert.notEqual(first.digest, second.digest);
  assert.ok(first.content.indexOf(shared.url) < first.content.indexOf(alternate.url));
});

test('field extraction accepts known text shapes and never exposes arbitrary or encrypted provider data', () => {
  const raw = record([
    { type: 'reasoning', id: 'rs_opaque', encrypted_content: 'NEVER-EXPOSE-OPAQUE' },
    call('ws_search', [
      result('', { text: 'Plain returned text.' }),
      result('', { content: 'Returned content string.' }),
      result('', { content: [{ type: 'text', text: 'Block one.' }, { type: 'output_text', text: 'Block two.' },
        { type: 'reasoning', text: 'NEVER-EXPOSE-REASONING' }] }),
      { title: 'Metadata only', url: 'https://example.com/no-excerpt', encrypted_content: 'NEVER-EXPOSE-OPAQUE' },
      { encrypted_content: 'NEVER-EXPOSE-OPAQUE' }, null, 42,
    ], { encrypted_content: 'NEVER-EXPOSE-OPAQUE', future: { text: 'NEVER-EXPOSE-UNKNOWN' } }),
  ]);
  const [observation] = projectSearchEvidence(raw);
  assert.equal(observation.data.outputIndex, 1);
  assert.deepEqual(observation.data.results.map((source) => source.textKind), ['text', 'content', 'content', 'none']);
  assert.equal(observation.data.results[2].text, 'Block one.\nBlock two.');
  assert.equal(observation.data.unreadableResults, 3);
  assert.doesNotMatch(JSON.stringify(observation), /NEVER-EXPOSE/);
});

test('ordinary research spanning roughly 98k characters in four calls is preserved without clipping', () => {
  const output = Array.from({ length: 4 }, (_, index) => call(`ws_${index}`, [result(`${index}:` + 'a'.repeat(24_498))]));
  const projections = projectSearchEvidence(record(output));
  assert.equal(projections.length, 4);
  assert.equal(projections.reduce((sum, projection) => sum + projection.data.retainedCharacters, 0), 98_000);
  assert.ok(projections.every((projection) => !projection.data.truncated));
});

test('distinct readable fields survive together while repeated aliases do not duplicate the excerpt', () => {
  const [observation] = projectSearchEvidence(record([call('ws_mixed', [
    result('A short preview.', { text: 'An additional fact in the returned text.', content: 'A short preview.' }),
    result('Identical body.', { text: 'Identical body.' }),
  ])]));
  assert.equal(observation.data.results[0].textKind, 'mixed');
  assert.match(observation.data.results[0].text, /A short preview/);
  assert.match(observation.data.results[0].text, /additional fact/);
  assert.equal(observation.data.results[0].text.match(/A short preview/g).length, 1);
  assert.equal(observation.data.results[1].text, 'Identical body.');
});

test('oversized results receive honest per-result and call budgets while complete raw text stays unchanged', () => {
  const huge = '😀\\"\n'.repeat(50_000);
  const raw = record([call('ws_large', Array.from({ length: 12 }, (_, index) => result(huge + index,
    { url: `https://example.com/${index}` })))]);
  const before = structuredClone(raw);
  const [observation] = projectSearchEvidence(raw);
  assert.ok(observation.content.length <= SEARCH_EVIDENCE_LIMITS.callCharacters);
  assert.equal(observation.data.renderedCharacters, observation.content.length);
  assert.equal(observation.data.truncated, true);
  assert.ok(observation.data.omittedResults > 0);
  assert.ok(observation.data.retainedCharacters < observation.data.originalCharacters);
  assert.ok(observation.data.results.every((source) => source.retainedCharacters <= SEARCH_EVIDENCE_LIMITS.resultCharacters));
  assert.ok(observation.data.results.every((source) => !/[\uD800-\uDBFF]$/.test(source.text)));
  assert.match(observation.content, /Some returned material is shortened, omitted, or unreadable/);
  assert.deepEqual(raw, before);
  const changed = structuredClone(raw);
  changed.output[0].results.at(-1).snippet += 'Later fact outside the retained excerpt.';
  assert.notEqual(projectSearchEvidence(changed)[0].digest, observation.digest,
    'Late enrichment outside rendered limits must still change observation equality');
});

test('oversized provenance is bounded too and marked as shortened', () => {
  const [observation] = projectSearchEvidence(record([call('ws_metadata', [result('Known fact.', {
    title: 'title'.repeat(10_000), url: 'https://example.com/' + 'x'.repeat(10_000),
  })], { action: { type: 'search', queries: ['q'.repeat(300_000)] } })]));
  assert.ok(observation.content.length <= SEARCH_EVIDENCE_LIMITS.callCharacters);
  assert.equal(observation.data.metadataTruncated, true);
  assert.equal(observation.data.results[0].metadataTruncated, true);
  assert.equal(observation.data.results[0].text, 'Known fact.');
  assert.match(observation.content, /provenance shortened/);
});

test('model budgets scale independently and cap aggregate UTF-8 text and message framing across many searches', () => {
  for (const window of [4_096, 8_192, 32_768, 128_000, 1_048_576]) {
    const budget = getSearchEvidenceBudget(window);
    const raw = record(Array.from({ length: 60 }, (_, index) => call(`ws_${index}`, [result('研😀'.repeat(30_000))])),
      { evidenceBudgetBytes: budget.maxBytes });
    const observations = projectSearchEvidence(raw);
    const bytes = observations.reduce((sum, observation) => sum + utf8ByteLength(observation.content), 0);
    const bound = observations.reduce((sum, observation) => sum + evidenceContentTokenBound(observation.content), 0);
    assert.ok(bytes <= budget.maxBytes, `${window}: aggregate ${bytes} exceeds ${budget.maxBytes}`);
    assert.ok(bound <= budget.reserveTokens, `${window}: framing was not reserved`);
    assert.ok(observations.length <= budget.maxCalls);
    assert.ok(observations.length > 0);
    assert.equal(observations[0].data.responseOmittedCalls, 60 - observations.length);
    assert.match(observations[0].content, /omitted|responseOmittedCalls/);
    assert.ok(budget.reserveTokens <= window / 4);
  }
  assert.ok(getSearchEvidenceBudget(1_048_576).maxBytes > 98_000);
});

test('UTF-8 accounting covers Unicode and keeps complete scalar boundaries without native APIs', () => {
  for (const value of ['', 'ascii', 'é', '研究', '😀', '\uD800', 'é研😀ascii']) {
    assert.equal(utf8ByteLength(value), new TextEncoder().encode(value).length);
    for (let limit = 0; limit <= 16; limit++) {
      const prefix = prefixByUtf8Bytes(value, limit);
      assert.ok(utf8ByteLength(prefix) <= limit);
      if (value !== '\uD800') assert.ok(!/[\uD800-\uDBFF]$/.test(prefix));
    }
  }
});

const capacityModel = (contextWindow = 8_192) => ({ id: 'test', provider: 'openai', api: 'openai-responses', contextWindow });
const zeroCost = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 };
const assistant = (totalTokens) => ({ role: 'assistant', provider: 'openai', api: 'openai-responses', model: 'test',
  content: [{ type: 'text', text: 'Found it.' }], stopReason: 'stop', timestamp: 2,
  usage: { input: totalTokens, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens, cost: zeroCost } });

test('capacity guard sees evidence before the latest low-usage assistant and adapts after a model switch', async () => {
  const content = projectSearchEvidence(record([call('ws_capacity', [result('x'.repeat(12_000))])]))[0].content;
  const context = { messages: [{ role: 'user', content, timestamp: 1 }, assistant(50),
    { role: 'user', content: 'Use the evidence.', timestamp: 3 }] };
  assert.equal(searchEvidenceCapacity(capacityModel(1_048_576), context).overflow, false);
  const small = searchEvidenceCapacity(capacityModel(), context);
  assert.equal(small.overflow, true);
  assert.equal(small.evidenceMessages, 1);
  assert.ok(small.estimatedTokens > 12_000);
  assert.equal(searchEvidenceCapacity(capacityModel(), { messages: [assistant(50)] }).overflow, false);
  const nearLimit = { messages: [{ role: 'user', content, timestamp: 1 }, assistant(102_000)] };
  assert.equal(searchEvidenceCapacity(capacityModel(128_000), nearLimit).overflow, true,
    'Evidence missing from measured usage must be added even when ordinary token usage exceeds its character estimate');
});

test('only bound generation requests are gated; model catalog and unbound compactor delegation stay unchanged', async () => {
  const model = capacityModel();
  const provider = {};
  const delegated = [];
  const ordinaryStream = {};
  const models = { getModel: () => model, getProvider: () => provider,
    streamSimple: (...args) => { delegated.push(args); return ordinaryStream; },
    completeSimple: () => 'compactor-delegated' };
  const wrapped = withSearchEvidenceBudget(models);
  assert.equal(wrapped.getModel(), model);
  assert.equal(wrapped.getProvider(), provider);
  assert.equal(wrapped.completeSimple(), 'compactor-delegated');
  const content = projectSearchEvidence(record([call('ws_capacity', [result('x'.repeat(12_000))])]))[0].content;
  const context = { messages: [{ role: 'user', content, timestamp: 1 }, assistant(50)] };
  assert.equal(wrapped.streamSimple(model, context), ordinaryStream);
  const controller = new AbortController();
  bindSearchEvidenceBudget(controller.signal);
  const guarded = wrapped.streamSimple(model, context, { signal: controller.signal });
  const failed = await guarded.result();
  assert.equal(failed.stopReason, 'error');
  assert.match(failed.errorMessage, /context_length_exceeded/);
  assert.equal(failed.usage.totalTokens, 0);
  assert.equal(delegated.length, 1, 'An overflowing generation never invokes its provider');
  assert.equal(wrapped.streamSimple(model, { messages: [assistant(50)] }, { signal: controller.signal }), ordinaryStream);
  assert.equal(delegated.length, 2, 'A normal generation without canonical evidence is unaffected');
});

test('real Harness overflow recovery compacts otherwise uncounted evidence and continues using a source-only fact', async (t) => {
  const fact = 'COBALT-PUFFIN-731';
  const content = projectSearchEvidence(record([call('ws_capacity', [result(fact + ' padding'.repeat(1_600))])]))[0].content;
  const seen = [];
  const provider = responsesModels([
    (exchange, request) => {
      seen.push('summary');
      const input = JSON.stringify(request.body.input);
      assert.match(input, /context summarization assistant/);
      const discovered = input.match(/COBALT-PUFFIN-\d+/)?.[0];
      assert.equal(discovered, fact, 'The real summarizer request must receive the source-only fact');
      const summary = `Research found that the observatory calibration key is ${discovered}.`;
      exchange.created('resp_summary'); exchange.item(textItem(summary, 'msg_summary', []), 0);
      exchange.complete([textItem(summary, 'msg_summary', [])], { id: 'resp_summary' });
    },
    (exchange, request) => {
      seen.push('continuation');
      const input = JSON.stringify(request.body.input);
      const remembered = input.match(/COBALT-PUFFIN-\d+/)?.[0];
      assert.equal(remembered, fact, 'The resumed generation must receive the meaningful source-derived summary');
      assert.ok(!input.includes('padding padding'), 'The oversized original evidence has been compacted');
      exchange.created('resp_continuation'); exchange.item(textItem(`The key is ${remembered}.`, 'msg_continuation', []), 0);
      exchange.complete([textItem(`The key is ${remembered}.`, 'msg_continuation', [])], { id: 'resp_continuation' });
    },
  ]);
  // A small isolated test catalog simulates switching from the larger model that
  // captured the evidence. Use the real class instance, including prototype methods.
  const nativeProvider = provider.models.getProvider('openai');
  provider.models.setProvider({ ...nativeProvider,
    getModels: () => nativeProvider.getModels().map((model) => ({ ...model, contextWindow: 8_192 })),
  });
  const catalog = provider.models;
  const registry = createRegistry();
  registry.install(defineExtension({ name: 'test-evidence-budget', hooks: [hook(GenerationTask, {
    beforeRequest(_request, _api, context) { bindSearchEvidenceBudget(context.abortSignal); },
  })] }));
  const harness = await Harness.open(new MemoryStorage(), { models: withSearchEvidenceBudget(catalog), registry,
    settings: { stream: { transport: 'sse', maxRetries: 0 }, retry: { enabled: false },
      compaction: { backgroundTokens: 0, reserveTokens: 1_024, keepRecentTokens: 1 } } }, BACKGROUND_CONTEXT);
  t.after(() => harness.close(BACKGROUND_CONTEXT));
  const conversation = await harness.createConversation({ ownership: { kind: 'ownerless' },
    agent: { model: { provider: 'openai', modelId: MODEL_ID }, thinkingLevel: 'medium' } }, BACKGROUND_CONTEXT);
  const SeedEntry = defineEntry('test.seeded-evidence');
  await harness.commit(async (tx) => {
    await tx.appendEntry(SeedEntry, conversation.id, { model: [{ role: 'user', content: 'Research the calibration key.', timestamp: 1 }] });
    await tx.appendEntry(SeedEntry, conversation.id, { model: [{ role: 'user', content, timestamp: 2 }] });
    await tx.appendEntry(SeedEntry, conversation.id, { model: [{ ...assistant(50), model: MODEL_ID, timestamp: 3 }] });
  }, BACKGROUND_CONTEXT);
  const outcome = await (await conversation.submit({ type: 'input', content: 'What was the exact key?' }, BACKGROUND_CONTEXT)).wait(BACKGROUND_CONTEXT);
  assert.equal(outcome.status, 'done', JSON.stringify({ outcome, seen }));
  assert.deepEqual(seen, ['summary', 'continuation'], 'No overflowing request should reach the transport');
  const entries = await conversation.entries({}, 100, undefined, BACKGROUND_CONTEXT);
  const localFailure = entries.items.flatMap((entry) => entry.model ?? []).find((message) =>
    message.role === 'assistant' && message.errorMessage?.includes('context_length_exceeded'));
  assert.ok(localFailure, 'Pi classified the explicit local overflow before creating its normal compaction task');
  assert.equal(localFailure.usage.totalTokens, 0);
});

test('a real Models instance fails closed across providers until evidence preparation explicitly succeeds', async () => {
  const provider = responsesModels([[textItem('Prepared response.', 'msg_prepared', [])]]);
  const nativeProvider = provider.models.getProvider('openai');
  const originalModel = provider.models.getModel('openai', MODEL_ID);
  provider.models.setProvider({ ...nativeProvider, id: 'other-provider', name: 'Isolated alternate test provider',
    getModels: () => [{ ...originalModel, provider: 'other-provider' }],
  });
  const wrapped = withSearchEvidenceBudget(provider.models);
  const other = wrapped.getModel('other-provider', MODEL_ID);
  assert.equal(other.provider, 'other-provider');
  const controller = new AbortController();
  failSearchEvidencePreparation(controller.signal);
  const context = { messages: [{ role: 'user', content: 'Continue saved research.', timestamp: 1 }] };
  const blocked = await wrapped.streamSimple(other, context, { signal: controller.signal }).result();
  assert.equal(blocked.stopReason, 'error');
  assert.equal(blocked.usage.totalTokens, 0);
  assert.match(blocked.errorMessage, /could not be prepared/);
  assert.doesNotMatch(blocked.errorMessage, /context_length_exceeded/);
  assert.equal(provider.requests.length, 0, 'Preparation failures must never send stale context to another provider');
  bindSearchEvidenceBudget(controller.signal);
  const complete = await wrapped.streamSimple(other, context, { signal: controller.signal }).result();
  assert.equal(complete.stopReason, 'stop');
  assert.equal(provider.requests.length, 1);
});
