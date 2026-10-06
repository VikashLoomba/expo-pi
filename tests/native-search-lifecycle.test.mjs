import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { BACKGROUND_CONTEXT as context } from '@earendil-works/chord/context';
import { createModels } from '@earendil-works/pi-ai';
import { Harness, createRegistry } from '@earendil-works/pi-durable';
import { SqliteStorage } from '@earendil-works/pi-durable/storage/sqlite';
import { createExpoSqliteDatabase } from '../src/pi/storage/expo-sqlite.ts';
import { installBashBrowserHooks } from './helpers/bash-browser-hooks.mjs';
import { createNodeSqliteConnection } from './helpers/node-sqlite.mjs';
import { MODEL_ID, searchItem, sourceFact } from './helpers/openai-responses.mjs';

const hooks = installBashBrowserHooks();
test.after(() => hooks.deregister());
const { persistNativeResponse } = await import('../src/pi/native-web-search/persistence.ts');
const { NativeResponsesDoc, SearchObservationsDoc } = await import('../src/pi/native-web-search/documents.ts');
const { SearchObservationEntry, SearchObservationChangeEntry, persistSearchObservations } = await import('../src/pi/native-web-search/observations.ts');
const { editSearchTurn } = await import('../src/pi/native-web-search/edits.ts');
const { captureRequestOrigin } = await import('../src/pi/native-web-search/lifecycle.ts');
const { utf8ByteLength, isSearchEvidenceMessage } = await import('../src/pi/native-web-search/budget.ts');

async function fixture(t) {
  const directory = await mkdtemp(join(tmpdir(), 'pi-search-lifecycle-'));
  const storage = await SqliteStorage.open(createExpoSqliteDatabase(createNodeSqliteConnection(join(directory, 'chat.sqlite'))));
  const harness = await Harness.open(storage, { models: createModels(), registry: createRegistry() }, context);
  t.after(async () => { await harness.close(context); await rm(directory, { recursive: true, force: true }); });
  const conversation = await harness.createConversation({ ownership: { kind: 'ownerless' } }, context);
  const input = await conversation.commit((tx) => tx.appendEntry(conversation.id, {
    kind: 'pi.user', model: [{ role: 'user', content: 'Research the observatory.', timestamp: 1 }],
  }), context);
  const record = {
    requestId: 'lifecycle-request', taskId: 11, responseId: 'resp_lifecycle', provider: 'openai',
    model: MODEL_ID, status: 'in_progress', cutoff: input.id, originEntryId: input.id,
    output: [searchItem('ws_lifecycle')], events: [],
  };
  const save = (value = record) => conversation.commit((tx) => persistNativeResponse(tx, conversation.id, value), context);
  return { harness, conversation, record, save, input };
}

const text = (view) => JSON.stringify(view.messages);
const observations = (view) => view.entries.filter((entry) => SearchObservationEntry.is(entry));
const changes = (view) => view.entries.filter((entry) => SearchObservationChangeEntry.is(entry));
const enrich = (record, fact = 'The calibrated interval is now 81 seconds.') => ({ ...structuredClone(record),
  output: record.output.map((item) => ({ ...structuredClone(item), results: [{ ...item.results[0], snippet: fact }] })),
});

async function appendAnswer(conversation, record, content = [{ type: 'text', text: 'The research is complete.' }]) {
  return conversation.commit((tx) => tx.appendEntry(conversation.id, {
    kind: 'pi.assistant', model: [{ role: 'assistant', provider: 'openai', api: 'openai-responses', model: MODEL_ID,
      responseId: record.responseId, content, timestamp: 2,
      stopReason: 'stop', usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } }],
  }), context);
}

test('request origins ignore observation user messages and remain stable through local tool rounds', async (t) => {
  const { conversation, record, save, input } = await fixture(t);
  await save();
  const answer = await appendAnswer(conversation, record);
  assert.equal(await conversation.commit((tx) => captureRequestOrigin(tx, conversation.id, answer.id), context), input.id);
  const next = await conversation.commit((tx) => tx.appendEntry(conversation.id, {
    kind: 'pi.user', model: [{ role: 'user', content: 'A different logical turn.', timestamp: 4 }],
  }), context);
  assert.equal(await conversation.commit((tx) => captureRequestOrigin(tx, conversation.id, next.id), context), next.id);
  assert.equal(await conversation.commit((tx) => captureRequestOrigin(tx, conversation.id, answer.id), context), input.id,
    'A pinned older request cannot adopt a later user submission');
  await conversation.reset('Fresh context without a genuine user submission.', context);
  const last = (await conversation.entries({}, 1, undefined, context)).items[0];
  assert.equal(await conversation.commit((tx) => captureRequestOrigin(tx, conversation.id, last.id), context), undefined);
});

for (const targetKind of ['user', 'final-assistant', 'legacy-final-assistant']) {
  test(`${targetKind} editing invalidates the entire multi-round turn while preserving the next turn`, async (t) => {
    const { conversation, record, save, input } = await fixture(t);
    const original = { ...record };
    if (targetKind === 'legacy-final-assistant') delete original.originEntryId;
    await save(original);
    await appendAnswer(conversation, original, [{ type: 'toolCall', id: 'call_round', name: 'measure', arguments: {} }]);
    const toolResult = await conversation.commit((tx) => tx.appendEntry(conversation.id, {
      kind: 'pi.tool-result', model: [{ role: 'toolResult', toolCallId: 'call_round', toolName: 'measure',
        content: [{ type: 'text', text: 'First-turn local tool measurement: 81.' }], isError: false, timestamp: 3 }],
    }), context);
    const second = { ...original, requestId: 'second-round-request', responseId: 'resp_second_round', taskId: 12,
      cutoff: toolResult.id, output: [searchItem('ws_second_round')] };
    await save(second);
    const finalAnswer = await appendAnswer(conversation, second);
    const next = await conversation.commit((tx) => tx.appendEntry(conversation.id, {
      kind: 'pi.user', model: [{ role: 'user', content: 'Research the neighbouring observatory.', timestamp: 5 }],
    }), context);
    const nextRecord = { ...original, requestId: 'next-turn-request', responseId: 'resp_next_turn', taskId: 13,
      cutoff: next.id, originEntryId: next.id, output: [searchItem('ws_next_turn')] };
    await save(nextRecord); await appendAnswer(conversation, nextRecord);

    const edit = targetKind === 'user' ? { target: input.id, action: 'omit' }
      : { target: finalAnswer.id, action: 'replace', messages: [{ ...finalAnswer.model[0],
        content: [{ type: 'text', text: 'This replacement supersedes the original research turn.' }] }] };
    await conversation.commit((tx) => editSearchTurn(tx, conversation.id, edit), context);
    // A late *new* native item from the edited turn must be blocked too.
    await save({ ...second, output: [...second.output, searchItem('ws_late_new_item')] });
    const view = await conversation.context(context);
    assert.doesNotMatch(text(view), /ws_lifecycle observatory|ws_second_round observatory|ws_late_new_item observatory|First-turn local tool measurement/);
    assert.ok(text(view).includes(sourceFact('ws_next_turn')));
    if (targetKind !== 'user') assert.match(text(view), /This replacement supersedes the original research turn/);
    else assert.doesNotMatch(text(view), /Research the observatory\./);
  });
}

test('logical-turn edits reject foreign and reset-excluded targets without modifying another conversation', async (t) => {
  const { harness, conversation, input } = await fixture(t);
  const other = await harness.createConversation({ ownership: { kind: 'ownerless' } }, context);
  await assert.rejects(other.commit((tx) => editSearchTurn(tx, other.id, { target: input.id, action: 'omit' }), context),
    /not in this conversation's active history/);
  await conversation.reset('A new context.', context);
  await assert.rejects(conversation.commit((tx) => editSearchTurn(tx, conversation.id, { target: input.id, action: 'omit' }), context),
    /not in this conversation's active history/);
});

test('replacing a user submission blocks old requests but allows fresh research for the same logical origin', async (t) => {
  const { conversation, record, save, input } = await fixture(t);
  await save(); await appendAnswer(conversation, record);
  await conversation.commit((tx) => editSearchTurn(tx, conversation.id, { target: input.id, action: 'replace',
    messages: [{ role: 'user', content: 'Research the observatory again with the corrected location.', timestamp: 3 }],
  }), context);
  const cutoff = (await conversation.entries({}, 1, undefined, context)).items[0].id;
  await save({ ...record, output: [...record.output, searchItem('ws_invalidated_late')] });
  const fresh = { ...record, requestId: 'fresh-request-after-edit', responseId: 'resp_fresh_after_edit', cutoff,
    output: [searchItem('ws_fresh_after_edit')] };
  await save(fresh);
  const view = await conversation.context(context);
  assert.doesNotMatch(text(view), /ws_lifecycle observatory|ws_invalidated_late observatory/);
  assert.ok(text(view).includes(sourceFact('ws_fresh_after_edit')));
  assert.match(text(view), /corrected location/);
});

test('editing a newer turn preserves older migrated evidence appended at the transcript tail', async (t) => {
  const { conversation, record, input } = await fixture(t);
  const legacy = { ...record }; delete legacy.originEntryId;
  const oldAnswer = await appendAnswer(conversation, legacy);
  const next = await conversation.commit((tx) => tx.appendEntry(conversation.id, {
    kind: 'pi.user', model: [{ role: 'user', content: 'Research a different location.', timestamp: 3 }],
  }), context);
  // This is the production migration write: evidence appears later physically,
  // but its sourceEntryId still associates it with the original logical turn.
  await conversation.commit((tx) => persistSearchObservations(tx, conversation.id, legacy,
    { sourceEntryId: oldAnswer.id }), context);
  const nextRecord = { ...record, requestId: 'next-request', responseId: 'resp_next', cutoff: next.id,
    originEntryId: next.id, output: [searchItem('ws_next')] };
  await conversation.commit((tx) => persistNativeResponse(tx, conversation.id, nextRecord), context);
  await appendAnswer(conversation, nextRecord);
  await conversation.commit((tx) => editSearchTurn(tx, conversation.id, { target: next.id, action: 'omit' }), context);
  const view = await conversation.context(context);
  assert.ok(text(view).includes(sourceFact('ws_lifecycle')));
  assert.doesNotMatch(text(view), /ws_next observatory|different location/);
  assert.ok(view.messages.some((message) => message.role === 'user' && message.content === input.model[0].content));
});

test('out-of-order completion cannot accumulate more canonical calls or bytes than the aggregate response budget', async (t) => {
  const { harness, conversation, record, save } = await fixture(t);
  const calls = Array.from({ length: 34 }, (_, index) => searchItem(`ws_budget_${index}`, {
    results: [{ title: `Source ${index}`, url: `https://example.test/${index}`,
      snippet: `Search ${index} unique source result. ${'Long retrieved detail. '.repeat(2_000)}` }],
  }));
  const bounded = { ...record, evidenceBudgetBytes: 65_536, output: calls.map((item, index) =>
    index < 32 ? { ...item, status: 'in_progress' } : item) };
  await save(bounded);
  assert.equal((await conversation.context(context)).messages.filter(isSearchEvidenceMessage).length, 2);
  await save({ ...bounded, output: calls });
  const view = await conversation.context(context);
  const messages = view.messages.filter(isSearchEvidenceMessage);
  assert.equal(messages.length, 32);
  assert.ok(messages.reduce((total, message) => total + utf8ByteLength(message.content), 0) <= bounded.evidenceBudgetBytes);
  assert.doesNotMatch(text(view), /Search 32 unique source result|Search 33 unique source result/);
  const references = Object.values((await harness.snapshot(SearchObservationsDoc, conversation.id, context)).observations);
  assert.equal(references.filter((reference) => reference.budgetExcluded).length, 2);
  assert.ok(references.every((reference) => !reference.disabled), 'A budget omission does not masquerade as a user edit');
  const archive = await harness.snapshot(NativeResponsesDoc, conversation.id, context);
  assert.equal(archive.responses[record.requestId].output.length, 34);
});

test('archive, canonical evidence and deduplication index roll back together when their transaction fails', async (t) => {
  const { harness, conversation, record, save } = await fixture(t);
  const before = await conversation.context(context);
  await assert.rejects(conversation.commit(async (tx) => {
    await persistNativeResponse(tx, conversation.id, record);
    throw new Error('Injected failure after staging every search write');
  }, context), /Injected failure/);
  assert.deepEqual((await conversation.context(context)).entries, before.entries);
  assert.equal(await harness.snapshot(NativeResponsesDoc, conversation.id, context), undefined);
  assert.equal(await harness.snapshot(SearchObservationsDoc, conversation.id, context), undefined);
  await save();
  assert.equal(observations(await conversation.context(context)).length, 1);
  assert.deepEqual((await harness.snapshot(NativeResponsesDoc, conversation.id, context)).responses[record.requestId], record);
  assert.equal(Object.keys((await harness.snapshot(SearchObservationsDoc, conversation.id, context)).observations).length, 1);
});

test('duplicate snapshots add no entries while late enrichment replaces the original canonical contribution once', async (t) => {
  const { harness, conversation, record, save } = await fixture(t);
  await save(); await save(structuredClone(record));
  const initial = await conversation.context(context);
  assert.equal(observations(initial).length, 1);
  assert.equal(changes(initial).length, 0);
  const richer = enrich(record);
  await save(richer); await save(structuredClone(richer));
  const updated = await conversation.context(context);
  assert.equal(observations(updated).length, 1);
  assert.equal(changes(updated).length, 1);
  assert.equal(observations(updated)[0].id, observations(initial)[0].id);
  assert.match(text(updated), /now 81 seconds/);
  assert.ok(!text(updated).includes(sourceFact('ws_lifecycle')));
  assert.match(changes(updated)[0].data.evidence.results[0].text, /now 81 seconds/);
  assert.deepEqual((await harness.snapshot(NativeResponsesDoc, conversation.id, context)).responses[record.requestId], richer);

  const distinct = { ...richer, output: [...richer.output, searchItem('ws_distinct')] };
  await save(distinct);
  assert.equal(observations(await conversation.context(context)).length, 2,
    'Different native search identities are not deduplicated together');
});

test('a completed search is durable evidence even when its enclosing assistant fails', async (t) => {
  const { harness, conversation, record, save } = await fixture(t);
  await save({ ...record, status: 'failed', error: 'The assistant transport failed after the search completed.' });
  const view = await conversation.context(context);
  assert.equal(observations(view).length, 1);
  assert.ok(text(view).includes(sourceFact('ws_lifecycle')));
  assert.equal((await harness.snapshot(NativeResponsesDoc, conversation.id, context)).responses[record.requestId].status, 'failed');
});

test('a late completed result after reset updates its archive without adding evidence to the new context', async (t) => {
  const { harness, conversation, record, save } = await fixture(t);
  await save({ ...record, output: [] });
  await conversation.reset('A new task starts here.', context);
  await save({ ...record, status: 'completed' });
  const view = await conversation.context(context);
  assert.equal(observations(view).length, 0);
  assert.ok(!text(view).includes(sourceFact('ws_lifecycle')));
  const history = await conversation.entries({}, 100, undefined, context);
  assert.equal(history.items.filter((entry) => SearchObservationEntry.is(entry)).length, 0);
  assert.equal((await harness.snapshot(NativeResponsesDoc, conversation.id, context)).responses[record.requestId].status, 'completed');
});

test('forks inherit the evidence and archive as of their selected entry, excluding later enrichment and searches', async (t) => {
  const { harness, conversation, record, save } = await fixture(t);
  await save();
  const answer = await appendAnswer(conversation, record);
  await save(enrich(record));
  await save({ ...record, requestId: 'later-request', responseId: 'resp_later', output: [searchItem('ws_later')] });
  const child = await conversation.fork(answer.id, { ownership: { kind: 'ownerless' } }, context);
  const view = await child.context(context);
  assert.equal(observations(view).length, 1);
  assert.ok(text(view).includes(sourceFact('ws_lifecycle')));
  assert.doesNotMatch(text(view), /now 81 seconds|ws_later observatory/);
  const archive = await harness.snapshot(NativeResponsesDoc, child.id, context);
  assert.deepEqual(archive.responses[record.requestId], record);
  assert.equal(archive.responses['later-request'], undefined);
  assert.equal(Object.keys((await harness.snapshot(SearchObservationsDoc, child.id, context)).observations).length, 1);
});

test('logical-turn edits disable evidence so later native enrichment cannot restore it', async (t) => {
  const { harness, conversation, record, save } = await fixture(t);
  await save();
  const answer = await appendAnswer(conversation, record);
  await conversation.commit((tx) => editSearchTurn(tx, conversation.id, { target: answer.id, action: 'omit' }), context);
  await save(enrich(record));
  const view = await conversation.context(context);
  assert.doesNotMatch(text(view), /cobalt beacon|now 81 seconds|The research is complete/);
  assert.equal(Object.values((await harness.snapshot(SearchObservationsDoc, conversation.id, context)).observations)[0].disabled, true);
  assert.match((await harness.snapshot(NativeResponsesDoc, conversation.id, context)).responses[record.requestId].output[0].results[0].snippet,
    /now 81 seconds/);
});

for (const action of ['omit', 'replace']) {
  test(`an explicit observation ${action} remains authoritative after late provider enrichment`, async (t) => {
    const { conversation, record, save } = await fixture(t);
    await save();
    const observation = observations(await conversation.context(context))[0];
    const edit = action === 'omit' ? { target: observation.id, action }
      : { target: observation.id, action, messages: [{ role: 'user', content: 'Redacted external evidence.', timestamp: 3 }] };
    await conversation.commit((tx) => tx.appendEntry(conversation.id, { kind: 'test.deliberate-evidence-edit', edits: [edit] }), context);
    await save(enrich(record));
    const view = await conversation.context(context);
    assert.doesNotMatch(text(view), /cobalt beacon|now 81 seconds/);
    if (action === 'replace') assert.match(text(view), /Redacted external evidence/);
  });
}
