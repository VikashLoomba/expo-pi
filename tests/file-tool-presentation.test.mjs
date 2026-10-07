import assert from 'node:assert/strict';
import test from 'node:test';
import { installBashBrowserHooks } from './helpers/bash-browser-hooks.mjs';
const hooks = installBashBrowserHooks();
test.after(() => hooks.deregister());
const { fileToolPresentation, withFileToolDetails } = await import('../src/chat/file-tool-presentation.ts');
const { projectMessages } = await import('../src/pi/chat-projection.ts');

function state() {
  return {
    id: 1,
    metadata: { title: 'Tools', createdAt: 1, archived: false },
    agent: { model: { provider: 'openai', modelId: 'gpt-6-sol' }, thinkingLevel: 'off' },
    entries: [{ id: 1, model: [{ role: 'assistant', timestamp: 1,
      content: [{ type: 'toolCall', id: 'edit-call', name: 'edit', arguments: { path: 'notes', edits: [{ oldText: 'old', newText: 'new' }] } }] }] }],
    live: { tools: [{ callId: 'edit-call', name: 'edit', status: 'running', details: { diff: '- old\n+ new', firstChangedLine: 2 } }] },
    native: { responses: {} }, nativeLive: {},
  };
}

test('file summaries validate arguments and count UTF-8 bytes without retaining file content', () => {
  assert.equal(fileToolPresentation('read', { path: 'notes', offset: 3, limit: 2 }).summary, '2 lines from line 3');
  assert.equal(fileToolPresentation('read', { path: 'notes', offset: 1.5 }), undefined);
  const write = fileToolPresentation('write', { path: 'notes', content: '😀世界' });
  assert.equal(write.summary, '10 UTF-8 bytes');
  assert.equal(JSON.stringify(write).includes('😀'), false);
  assert.equal(fileToolPresentation('edit', { path: 'notes', oldText: 'a', newText: 'b' }).summary, '1 replacement');
  assert.equal(fileToolPresentation('edit', { path: 'notes', edits: '[{"oldText":"a","newText":"b"}]' }).summary, '1 replacement');
  assert.equal(fileToolPresentation('bash', { command: 'cat notes' }), undefined);
  assert.equal(fileToolPresentation('read', { path: 123 }), undefined);
  assert.equal(fileToolPresentation('edit', { path: 'notes', edits: [{}] }), undefined);
  assert.equal(fileToolPresentation('edit', { path: 'notes', oldText: 'old' }), undefined);
  assert.equal(fileToolPresentation('edit', { path: 'notes', edits: [{ oldText: 'a', newText: 'b' }], oldText: 'c', newText: 'd' }), undefined);
});

test('historical malformed or oversized details cannot inject arbitrary presentation values', () => {
  const base = fileToolPresentation('edit', { path: 'notes', edits: [{ oldText: 'old', newText: 'new' }] });
  assert.deepEqual(withFileToolDetails(base, null), base);
  const details = withFileToolDetails(base, { diff: 'x'.repeat(24575) + '😀tail', firstChangedLine: -1,
    patchPath: 'https://example.com/file', diffTruncated: false });
  assert.equal(details.diff.length, 24575);
  assert.equal(details.diffTruncated, true);
  assert.equal(details.firstChangedLine, undefined);
  assert.equal(details.patchPath, undefined);
});

test('live details and details-only updates reach the tool row without changing earlier rows', () => {
  const cached = state();
  const row = projectMessages(cached, cached.entries)[0];
  assert.equal(row.tool.file.diff, '- old\n+ new');
  assert.equal(row.tool.file.firstChangedLine, 2);
  assert.equal(row.tool.args, '', 'file input is a typed summary instead of duplicate raw content');
  cached.live.tools[0].details = { diff: '- old\n+ newer', firstChangedLine: 3 };
  const changed = projectMessages(cached, cached.entries)[0];
  assert.equal(changed.id, row.id);
  assert.equal(changed.tool.file.diff, '- old\n+ newer');
  assert.equal(row.tool.file.diff, '- old\n+ new', 'an earlier projection is not mutated');
});

test('committed result details survive a fresh projection, and an old patch path is not shown', () => {
  const cached = state();
  cached.live = {};
  cached.entries.push({ id: 2, model: [{ role: 'toolResult', toolCallId: 'edit-call', toolName: 'edit', timestamp: 2,
    content: [{ type: 'text', text: 'Edited notes.' }], isError: false,
    details: { diff: '- old\n+ new', diffTruncated: true, firstChangedLine: 2, patchPath: '/workspace/.tool-output/full.patch' } }] });
  const first = projectMessages(cached, cached.entries);
  const copy = structuredClone(cached);
  const reopened = projectMessages(copy, copy.entries);
  assert.deepEqual(reopened, first);
  assert.equal(reopened[0].tool.status, 'completed');
  assert.equal(reopened[0].tool.file.diffTruncated, true);
  assert.equal('patchPath' in reopened[0].tool.file, false);
});
