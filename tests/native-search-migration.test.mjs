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

const hooks = installBashBrowserHooks();
test.after(() => hooks.deregister());
const { migrateSearchObservations } = await import('../src/pi/native-web-search/migration.ts');
const { NativeResponsesDoc, SearchObservationsDoc } = await import('../src/pi/native-web-search/documents.ts');
const { SearchObservationEntry, observationKey, persistSearchObservations } = await import('../src/pi/native-web-search/observations.ts');

async function fixture(t) {
  const directory = await mkdtemp(join(tmpdir(), 'pi-search-migration-'));
  const filename = join(directory, 'chat.sqlite');
  const handles = new Set();
  t.after(async () => {
    await Promise.allSettled([...handles].map((harness) => harness.close(context)));
    await rm(directory, { recursive: true, force: true });
  });
  async function open() {
    const storage = await SqliteStorage.open(createExpoSqliteDatabase(createNodeSqliteConnection(filename)));
    const harness = await Harness.open(storage, { models: createModels(), registry: createRegistry() }, context);
    handles.add(harness);
    return harness;
  }
  const harness = await open();
  const conversation = await harness.createConversation({ ownership: { kind: 'ownerless' } }, context);
  return { harness, conversation, open, async close(value) { await value.close(context); handles.delete(value); } };
}

const usage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } };

function searchItem(id, fact) {
  return { id, type: 'web_search_call', status: 'completed', action: { type: 'search', queries: ['release date'] },
    results: [{ type: 'search_result', title: 'Release announcement', url: 'https://example.com/release', snippet: fact }] };
}

async function legacy(harness, conversation, label = 'old', override = {}) {
  const fact = `The source-only migration fact is ${label}-cobalt-73.`;
  const message = { role: 'assistant', api: 'openai-responses', provider: 'openai', model: 'gpt-6-astra',
    responseId: `response-${label}`, stopReason: 'stop', timestamp: 20,
    content: [{ type: 'text', text: `A ${label} answer that omits the source fact.` }], usage };
  const record = { requestId: `request-${label}`, taskId: 1, responseId: message.responseId, provider: 'openai',
    model: message.model, status: 'completed', normalizedContent: JSON.stringify(message.content),
    output: [searchItem(`search-${label}`, fact)], events: [], ...override };
  const { entry, inputEntry } = await harness.commit(async (tx) => {
    const inputEntry = await tx.appendEntry(conversation.id, { kind: 'pi.user', model: [{ role: 'user', content: `Research ${label}.`, timestamp: 10 }] });
    const answer = await tx.appendEntry(conversation.id, { kind: 'test.answer', model: [message] });
    (await tx.doc(NativeResponsesDoc, conversation.id)).responses[record.requestId] = JSON.parse(JSON.stringify(record));
    return { entry: answer, inputEntry };
  }, context);
  return { entry, inputEntry, record, message, fact };
}

const modelText = (view) => JSON.stringify(view.messages);
const observations = (view) => view.entries.filter((entry) => SearchObservationEntry.is(entry));

test('legacy snippets become canonical context once and survive SQLite reopen without changing raw history', async (t) => {
  const file = await fixture(t);
  const { harness, conversation } = file;
  const original = await legacy(harness, conversation);
  const before = structuredClone(await harness.snapshot(NativeResponsesDoc, conversation.id, context));
  assert.doesNotMatch(modelText(await conversation.context(context)), /old-cobalt-73/);
  const migrated = await migrateSearchObservations(harness, conversation.id, context);
  assert.equal(migrated.report.observationsAdded, 1);
  assert.equal(migrated.report.recordsMigrated, 1);
  assert.match(JSON.stringify(migrated.messages), /old-cobalt-73/);
  assert.doesNotMatch(JSON.stringify(migrated.report), /cobalt|example\.com/);
  assert.match(modelText(await conversation.context(context)), /old-cobalt-73/);
  assert.deepEqual(await harness.snapshot(NativeResponsesDoc, conversation.id, context), before);
  const index = await harness.snapshot(SearchObservationsDoc, conversation.id, context);
  assert.equal(index.observations[observationKey(original.record.requestId, 'search-old')].sourceEntryId, original.entry.id);

  const repeated = await migrateSearchObservations(harness, conversation.id, context);
  assert.equal(repeated.report.observationsAdded, 0);
  assert.deepEqual(repeated.messages, []);
  assert.equal(observations(await conversation.context(context)).length, 1);
  await file.close(harness);
  const reopened = await file.open();
  const restored = await reopened.conversation(conversation.id, context);
  assert.match(modelText(await restored.context(context)), /old-cobalt-73/);
  assert.equal((await migrateSearchObservations(reopened, conversation.id, context)).report.observationsAdded, 0);
});

for (const mode of ['omit', 'replace', 'reset', 'compaction']) {
  test(`migration does not resurrect evidence excluded by ${mode}`, async (t) => {
    const { harness, conversation } = await fixture(t);
    const original = await legacy(harness, conversation);
    if (mode === 'reset') await conversation.reset('Fresh context', context);
    else if (mode === 'compaction') {
      await harness.commit(async (tx) => {
        const recent = await tx.appendEntry(conversation.id, { kind: 'test.input', model: [{ role: 'user', content: 'Recent topic', timestamp: 30 }] });
        await tx.appendEntry(conversation.id, { kind: 'pi.compaction', head: recent.id,
          model: [{ role: 'user', content: 'The old context was summarized.', timestamp: 40 }] });
      }, context);
    } else {
      await harness.commit((tx) => tx.appendEntry(conversation.id, { kind: 'test.edit', edits: [{ target: original.entry.id,
        action: mode, ...(mode === 'replace' ? { messages: [{ ...original.message,
          content: [{ type: 'text', text: 'The original answer has been revised.' }] }] } : {}) }] }), context);
    }
    const migrated = await migrateSearchObservations(harness, conversation.id, context);
    assert.equal(migrated.report.observationsAdded, 0);
    assert.deepEqual(migrated.messages, []);
    assert.doesNotMatch(modelText(await conversation.context(context)), /old-cobalt-73/);
    assert.match(JSON.stringify(await harness.snapshot(NativeResponsesDoc, conversation.id, context)), /old-cobalt-73/);
  });
}

test('a legacy fork backfills only native history visible at its fork point', async (t) => {
  const { harness, conversation } = await fixture(t);
  const first = await legacy(harness, conversation, 'first');
  await legacy(harness, conversation, 'later');
  const child = await conversation.fork(first.entry.id, { ownership: { kind: 'ownerless' } }, context);
  const migrated = await migrateSearchObservations(harness, child.id, context);
  assert.equal(migrated.report.observationsAdded, 1);
  const text = modelText(await child.context(context));
  assert.match(text, /first-cobalt-73/);
  assert.doesNotMatch(text, /later-cobalt-73/);
  assert.doesNotMatch(modelText(await conversation.context(context)), /cobalt-73/);
});

test('a late answer cannot restore a search request that began before the current reset boundary', async (t) => {
  const { harness, conversation } = await fixture(t);
  const original = await legacy(harness, conversation);
  await harness.commit(async (tx) => {
    (await tx.doc(NativeResponsesDoc, conversation.id)).responses[original.record.requestId].cutoff = original.entry.id;
  }, context);
  await conversation.reset('A fresh conversation boundary', context);
  await harness.commit((tx) => tx.appendEntry(conversation.id, {
    kind: 'test.late-answer', model: [original.message],
  }), context);
  const migrated = await migrateSearchObservations(harness, conversation.id, context);
  assert.equal(migrated.report.observationsAdded, 0);
  assert.equal(migrated.report.skipped['outside-context'], 1);
  assert.doesNotMatch(modelText(await conversation.context(context)), /old-cobalt-73/);
});

test('missing association fingerprints and duplicate response identities are reported conservatively', async (t) => {
  const { harness, conversation } = await fixture(t);
  await legacy(harness, conversation, 'missing-id', { responseId: undefined });
  await legacy(harness, conversation, 'missing-content', { normalizedContent: undefined });
  const duplicate = await legacy(harness, conversation, 'duplicate');
  await harness.commit(async (tx) => {
    const doc = await tx.doc(NativeResponsesDoc, conversation.id);
    doc.responses['second-request-with-same-response'] = { ...duplicate.record, requestId: 'second-request-with-same-response' };
  }, context);
  const migrated = await migrateSearchObservations(harness, conversation.id, context);
  assert.equal(migrated.report.observationsAdded, 0);
  assert.equal(migrated.report.skipped['missing-response-id'], 1);
  assert.equal(migrated.report.skipped['missing-normalized-content'], 1);
  assert.equal(migrated.report.skipped['ambiguous-response-id'], 2);
});

test('prepared request scope and cutoff restrict backfill without admitting newer or absent source turns', async (t) => {
  const { harness, conversation } = await fixture(t);
  const first = await legacy(harness, conversation, 'first');
  const second = await legacy(harness, conversation, 'second');
  const migrated = await migrateSearchObservations(harness, conversation.id, context,
    { messages: [first.message], cutoff: first.entry.id });
  assert.equal(migrated.report.observationsAdded, 1);
  assert.equal(migrated.report.skipped['beyond-cutoff'], 1);
  assert.match(JSON.stringify(migrated.messages), /first-cobalt-73/);
  assert.doesNotMatch(JSON.stringify(migrated.messages), /second-cobalt-73/);
  const absent = await migrateSearchObservations(harness, conversation.id, context,
    { messages: [first.message], cutoff: second.entry.id });
  assert.equal(absent.report.skipped['outside-request'], 1);
  assert.doesNotMatch(modelText(await conversation.context(context)), /second-cobalt-73/);
});

test('a recovered request receives startup-backfilled evidence after its cutoff once without appending duplicates', async (t) => {
  const { harness, conversation } = await fixture(t);
  const original = await legacy(harness, conversation);
  const request = { messages: [original.message], cutoff: original.entry.id };
  await migrateSearchObservations(harness, conversation.id, context);
  const recovered = await migrateSearchObservations(harness, conversation.id, context, request);
  assert.equal(recovered.report.observationsAdded, 0);
  assert.equal(recovered.report.observationsForwarded, 1);
  assert.match(JSON.stringify(recovered.messages), /old-cobalt-73/);
  const supplied = await migrateSearchObservations(harness, conversation.id, context,
    { ...request, messages: [...request.messages, ...recovered.messages] });
  assert.deepEqual(supplied.messages, []);
  assert.equal(observations(await conversation.context(context)).length, 1);
});

test('a request cannot receive a previously backfilled observation after that observation is omitted', async (t) => {
  const { harness, conversation } = await fixture(t);
  const original = await legacy(harness, conversation);
  await migrateSearchObservations(harness, conversation.id, context);
  const observation = observations(await conversation.context(context))[0];
  await harness.commit((tx) => tx.appendEntry(conversation.id, { kind: 'test.edit',
    edits: [{ target: observation.id, action: 'omit' }] }), context);
  const migrated = await migrateSearchObservations(harness, conversation.id, context,
    { messages: [original.message], cutoff: original.entry.id });
  assert.equal(migrated.report.observationsAdded, 0);
  assert.deepEqual(migrated.messages, []);
  assert.doesNotMatch(modelText(await conversation.context(context)), /old-cobalt-73/);
});

test('backfill adds missing search items without rewriting already-indexed evidence', async (t) => {
  const { harness, conversation } = await fixture(t);
  const original = await legacy(harness, conversation);
  await harness.commit((tx) => persistSearchObservations(tx, conversation.id, original.record,
    { sourceEntryId: original.entry.id }), context);
  const before = structuredClone(await harness.snapshot(SearchObservationsDoc, conversation.id, context));
  await harness.commit(async (tx) => {
    const doc = await tx.doc(NativeResponsesDoc, conversation.id);
    doc.responses[original.record.requestId].output = [searchItem('search-old', 'A changed previously indexed fact.'),
      searchItem('search-new', 'The previously missing fact is jade-49.')];
  }, context);
  const migrated = await migrateSearchObservations(harness, conversation.id, context);
  assert.equal(migrated.report.observationsAdded, 1);
  const after = await harness.snapshot(SearchObservationsDoc, conversation.id, context);
  assert.deepEqual(after.observations[observationKey(original.record.requestId, 'search-old')],
    before.observations[observationKey(original.record.requestId, 'search-old')]);
  const text = modelText(await conversation.context(context));
  assert.match(text, /old-cobalt-73/);
  assert.match(text, /jade-49/);
  assert.doesNotMatch(text, /changed previously indexed/);
});

test('an edit racing the context snapshot is rechecked before any backfill commits', async (t) => {
  const { harness, conversation } = await fixture(t);
  const original = await legacy(harness, conversation);
  let raced = false;
  const guarded = { conversation: harness.conversation.bind(harness), snapshot: harness.snapshot.bind(harness),
    async commit(change, callContext) {
      if (!raced) {
        raced = true;
        await harness.commit((tx) => tx.appendEntry(conversation.id, { kind: 'test.concurrent-edit',
          edits: [{ target: original.entry.id, action: 'omit' }] }), context);
      }
      return harness.commit(change, callContext);
    } };
  const migrated = await migrateSearchObservations(guarded, conversation.id, context);
  assert.equal(raced, true);
  assert.equal(migrated.report.observationsAdded, 0);
  assert.equal(migrated.report.skipped['no-active-assistant'], 1);
  assert.doesNotMatch(modelText(await conversation.context(context)), /old-cobalt-73/);
});

test('migration preserves an explicit omission notice when actual source text exceeds a tiny pinned budget', async (t) => {
  const { harness, conversation } = await fixture(t);
  await legacy(harness, conversation, 'small', { evidenceBudgetBytes: 512 });
  const migrated = await migrateSearchObservations(harness, conversation.id, context);
  assert.equal(migrated.report.observationsAdded, 1);
  assert.match(JSON.stringify(migrated.messages), /omitted here/);
  assert.doesNotMatch(JSON.stringify(migrated.messages), /small-cobalt-73/);
  assert.match(JSON.stringify(await harness.snapshot(NativeResponsesDoc, conversation.id, context)), /small-cobalt-73/);
});

for (const identity of ['response', 'origin', 'legacy-origin']) {
  test(`migration cannot backfill or forward evidence from a disabled ${identity}`, async (t) => {
    const { harness, conversation } = await fixture(t);
    const original = await legacy(harness, conversation);
    await migrateSearchObservations(harness, conversation.id, context);
    await harness.commit(async (tx) => {
      const index = await tx.doc(SearchObservationsDoc, conversation.id);
      if (identity === 'response') index.disabledResponses = [original.record.responseId];
      else {
        const change = await tx.appendEntry(conversation.id, { kind: 'test.turn-edit-watermark' });
        index.disabledOriginCutoffs = { [original.inputEntry.id]: change.id };
      }
      const archive = await tx.doc(NativeResponsesDoc, conversation.id);
      archive.responses[original.record.requestId].cutoff = original.entry.id;
      archive.responses[original.record.requestId].output.push(searchItem('search-late', 'A late unseen source fact.'));
      if (identity === 'origin') {
        archive.responses[original.record.requestId].originEntryId = original.inputEntry.id;
      }
      // Deliberately retain the answer and evidence: the disabled-turn policy
      // must remain authoritative even before or without their context edits.
    }, context);
    const migrated = await migrateSearchObservations(harness, conversation.id, context,
      { messages: [original.message], cutoff: original.entry.id });
    assert.equal(migrated.report.observationsAdded, 0);
    assert.equal(migrated.report.skipped['disabled-turn'], 1);
    assert.deepEqual(migrated.messages, []);
  });
}

for (const pinned of [false, true]) {
  test(`a logical-turn watermark excludes ${pinned ? 'an older pinned' : 'a legacy unpinned'} source request`, async (t) => {
    const { harness, conversation } = await fixture(t);
    const original = await legacy(harness, conversation);
    await harness.commit(async (tx) => {
      const index = await tx.doc(SearchObservationsDoc, conversation.id);
      const archive = await tx.doc(NativeResponsesDoc, conversation.id);
      const change = await tx.appendEntry(conversation.id, { kind: 'test.turn-edit-watermark' });
      index.disabledOriginCutoffs = { [original.inputEntry.id]: change.id };
      if (pinned) archive.responses[original.record.requestId].cutoff = original.entry.id;
    }, context);
    const migrated = await migrateSearchObservations(harness, conversation.id, context);
    assert.equal(migrated.report.observationsAdded, 0);
    assert.equal(migrated.report.skipped['disabled-turn'], 1);
  });
}

test('a new generation prepared after a user-turn edit can backfill its new search evidence', async (t) => {
  const { harness, conversation } = await fixture(t);
  const original = await legacy(harness, conversation);
  const edit = await harness.commit(async (tx) => {
    const index = await tx.doc(SearchObservationsDoc, conversation.id);
    const change = await tx.appendEntry(conversation.id, { kind: 'test.turn-edit',
      edits: [{ target: original.entry.id, action: 'omit' }] });
    index.disabledOriginCutoffs = { [original.inputEntry.id]: change.id };
    return change;
  }, context);
  const answer = { ...original.message, responseId: 'response-regenerated',
    content: [{ type: 'text', text: 'The regenerated answer omits its new source fact.' }] };
  await harness.commit(async (tx) => {
    const archive = await tx.doc(NativeResponsesDoc, conversation.id);
    await tx.appendEntry(conversation.id, { kind: 'test.regenerated-answer', model: [answer] });
    archive.responses['request-regenerated'] = { ...original.record, requestId: 'request-regenerated',
      responseId: answer.responseId, originEntryId: original.inputEntry.id, cutoff: edit.id,
      normalizedContent: JSON.stringify(answer.content), output: [searchItem('search-regenerated', 'The new source fact is amber-61.')] };
  }, context);
  const migrated = await migrateSearchObservations(harness, conversation.id, context);
  assert.equal(migrated.report.observationsAdded, 1);
  assert.match(modelText(await conversation.context(context)), /amber-61/);
  assert.doesNotMatch(modelText(await conversation.context(context)), /old-cobalt-73/);
});
