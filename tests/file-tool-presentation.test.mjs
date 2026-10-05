import assert from 'node:assert/strict';
import test from 'node:test';
import { installBashBrowserHooks } from './helpers/bash-browser-hooks.mjs';
const hooks = installBashBrowserHooks();
test.after(() => hooks.deregister());
const { fileToolPresentation, withFileToolDetails } = await import('../src/chat/file-tool-presentation.ts');
const { projectChat } = await import('../src/pi/chat-projection.ts');

function state() {
  return {
    metadata: { title: 'Tools', createdAt: 1, archived: false },
    settings: { model: { provider: 'openai-codex', modelId: 'gpt-6-sol' }, thinkingLevel: 'off' },
    entries: new Map([[1, { id: 1, model: [{ role: 'assistant', timestamp: 1,
      content: [{ type: 'toolCall', id: 'edit-call', name: 'edit', arguments: { path: 'notes', edits: [{ oldText: 'old', newText: 'new' }] } }] }] }]]),
    live: { tools: [{ callId: 'edit-call', name: 'edit', status: 'running', details: { diff: '- old\n+ new', firstChangedLine: 2 } }] },
    native: { responses: {} }, nativeLive: {}, unsettled: new Set(), abortRequested: new Set(),
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

test('live details and details-only updates reach immutable rows and unchanged rows are reused', () => {
  const cached = state();
  const first = projectChat('1', cached, undefined, true);
  const row = first.conversation.messages[0];
  assert.equal(row.tool.file.diff, '- old\n+ new');
  assert.equal(row.tool.file.firstChangedLine, 2);
  assert.equal(row.tool.args, '', 'file input is a typed summary instead of duplicate raw content');
  const same = projectChat('1', { ...cached, committed: first.committed }, first.conversation, true);
  assert.equal(same.conversation.messages[0], row);
  cached.live.tools[0].details = { diff: '- old\n+ newer', firstChangedLine: 3 };
  const changed = projectChat('1', { ...cached, committed: first.committed }, first.conversation, true);
  assert.notEqual(changed.conversation.messages[0], row);
  assert.equal(changed.conversation.messages[0].tool.file.diff, '- old\n+ newer');
});

test('committed result details survive a fresh projection and retain the patch artifact path', () => {
  const cached = state();
  cached.live = {};
  cached.entries.set(2, { id: 2, model: [{ role: 'toolResult', toolCallId: 'edit-call', toolName: 'edit', timestamp: 2,
    content: [{ type: 'text', text: 'Edited notes.' }], isError: false,
    details: { diff: '- old\n+ new', diffTruncated: true, firstChangedLine: 2, patchPath: '/workspace/.tool-output/full.patch' } }] });
  const first = projectChat('1', cached, undefined, false).conversation;
  const reopened = projectChat('1', structuredClone(cached), undefined, false).conversation;
  assert.deepEqual(reopened.messages, first.messages);
  assert.equal(reopened.messages[0].tool.status, 'completed');
  assert.equal(reopened.messages[0].tool.file.patchPath, '/workspace/.tool-output/full.patch');
});
