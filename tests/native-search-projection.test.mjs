import assert from 'node:assert/strict';
import test from 'node:test';
import { installBashBrowserHooks } from './helpers/bash-browser-hooks.mjs';

const hooks = installBashBrowserHooks();
test.after(() => hooks.deregister());
const { projectChat } = await import('../src/pi/chat-projection.ts');

const evidenceText = 'External source evidence: the unique source fact is cobalt-73.';
const source = { url: 'https://example.com/research', title: 'Research source' };

function observation(id, text = evidenceText) {
  return { id, kind: 'app.openai.search-observation',
    model: [{ role: 'user', content: [{ type: 'text', text }], timestamp: 900 + id }],
    data: { requestId: 'request-search', responseId: 'response-search', nativeItemId: 'search-one' } };
}

function user(id = 1) {
  return { id, kind: 'pi.input', model: [{ role: 'user', content: 'Find the release details.', timestamp: 10 }] };
}

function assistant(id = 5) {
  return { id, kind: 'pi.assistant', model: [{ role: 'assistant', api: 'openai-responses', provider: 'openai',
    model: 'gpt-6-astra', responseId: 'response-search', stopReason: 'stop', timestamp: 30,
    content: [{ type: 'text', text: 'A sourced answer.' }] }] };
}

function native(status = 'completed', answer = true) {
  return { requestId: 'request-search', taskId: 2, responseId: 'response-search', provider: 'openai',
    model: 'gpt-6-astra', status, events: [], response: { created_at: 0.02 },
    output: [
      { id: 'search-one', type: 'web_search_call', status: 'completed',
        action: { type: 'search', queries: ['release details'], sources: [source] },
        results: [{ type: 'search_result', ...source, snippet: evidenceText }] },
      { id: 'reasoning-one', type: 'reasoning', encrypted_content: 'opaque-secret', summary: [] },
      ...(answer ? [{ id: 'answer-one', type: 'message', role: 'assistant', status: 'completed',
        content: [{ type: 'output_text', text: 'A sourced answer.', annotations: [{ type: 'url_citation',
          ...source, start_index: 0, end_index: 16 }] }] }] : []),
    ] };
}

function state(entries, record) {
  return { metadata: { title: '', createdAt: 1, archived: false },
    settings: { model: { provider: 'openai', modelId: 'gpt-6-astra' }, thinkingLevel: 'low' },
    entries: new Map(entries.map((entry) => [entry.id, entry])), live: {},
    native: { responses: record ? { [record.requestId]: record } : {} }, nativeLive: {},
    unsettled: new Set(), abortRequested: new Set() };
}

test('model-facing search evidence cannot appear as a human message, title, or preview', () => {
  const cached = state([observation(3)]);
  const projected = projectChat('1', cached, undefined, false);
  assert.deepEqual(projected.conversation.messages, []);
  assert.equal(projected.conversation.title, 'New chat');
  assert.equal(projected.summary.preview, 'Start a conversation');
  assert.equal(projected.summary.updatedAt, 1);
  assert.equal(cached.entries.get(3).model[0].content[0].text, evidenceText,
    'Projection must not remove evidence from the canonical transcript.');
});

test('an actual user message remains visible even when it quotes the external-evidence label', () => {
  const quoted = user();
  quoted.model[0].content = evidenceText;
  const projected = projectChat('1', state([quoted]), undefined, false);
  assert.equal(projected.conversation.messages.length, 1);
  assert.equal(projected.conversation.messages[0].role, 'user');
  assert.equal(projected.conversation.messages[0].text, evidenceText);
});

test('canonical observations preserve one native activity row and the original answer and citations', () => {
  const cached = state([user(), observation(3), assistant()], native());
  const projected = projectChat('1', cached, undefined, false);
  assert.deepEqual(projected.conversation.messages.map((row) => row.role), ['user', 'assistant']);
  assert.equal(projected.conversation.title, 'Find the release details.');
  assert.equal(projected.summary.preview, 'A sourced answer.');
  assert.equal(projected.summary.updatedAt, 30, 'An evidence timestamp must not reorder the chat list.');
  const answer = projected.conversation.messages[1];
  assert.equal(answer.text, 'A sourced answer.');
  assert.equal(answer.webSearch.calls[0].id, 'search-one');
  assert.equal(answer.webSearch.sources.length, 1);
  assert.equal(answer.webSearch.citations[0].url, source.url);
  assert.doesNotMatch(JSON.stringify(projected.conversation), /cobalt-73|opaque-secret/);
  const reopened = projectChat('1', structuredClone(cached), undefined, false);
  assert.deepEqual(reopened.conversation, projected.conversation);
});

test('a completed observation remains one search activity when its assistant is interrupted', () => {
  const cached = state([user(), observation(3)], native('interrupted', false));
  const projected = projectChat('1', cached, undefined, false);
  assert.deepEqual(projected.conversation.messages.map((row) => row.role), ['user', 'assistant']);
  const activity = projected.conversation.messages[1];
  assert.equal(activity.text, '');
  assert.equal(activity.interrupted, true);
  assert.equal(activity.streaming, false);
  assert.equal(activity.webSearch.calls[0].status, 'completed', 'The received search survived the interrupted answer.');
  assert.deepEqual(activity.webSearch.sources, [source]);
  assert.doesNotMatch(JSON.stringify(projected.conversation), /cobalt-73|opaque-secret/);
});

test('native activity identity survives observation commits and a final assistant entry', () => {
  const cached = state([user()], native('in_progress', false));
  cached.live = { run: { taskId: 2, inputs: [] } };
  cached.nativeLive = { requestId: 'request-search', taskId: 2 };
  const initial = projectChat('1', cached, undefined, true);
  const initialActivity = initial.conversation.messages[1];
  assert.equal(initialActivity.streaming, true);

  cached.entries.set(3, observation(3));
  const observed = projectChat('1', cached, initial.conversation, true);
  assert.equal(observed.conversation.messages.length, 2);
  assert.equal(observed.conversation.messages[1].id, initialActivity.id);

  cached.entries.set(5, assistant());
  cached.native.responses['request-search'] = native();
  cached.live = {};
  cached.nativeLive = {};
  const completed = projectChat('1', cached, observed.conversation, true);
  assert.equal(completed.conversation.messages.length, 2);
  assert.equal(completed.conversation.messages[1].id, initialActivity.id);
  assert.equal(completed.conversation.messages[1].webSearch.calls[0].id, initialActivity.webSearch.calls[0].id);
  assert.equal(completed.conversation.messages[1].streaming, false);
});

test('immutable observation enrichment does not duplicate activity or expose either source body', () => {
  const cached = state([user(), observation(3), assistant()], native());
  const first = projectChat('1', cached, undefined, false);
  const correction = observation(7, 'External source evidence: a later enriched source fact.');
  correction.kind = 'app.openai.search-observation-change';
  correction.edits = [{ target: 3, action: 'omit' }];
  cached.entries.set(correction.id, correction);
  const next = projectChat('1', cached, first.conversation, false);
  assert.equal(next.conversation, first.conversation, 'Model-context enrichment alone leaves presentation unchanged.');
  assert.equal(next.conversation.messages.length, 2);
  assert.doesNotMatch(JSON.stringify(next.conversation), /cobalt-73|later enriched/);
});
