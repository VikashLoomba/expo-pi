import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import test from 'node:test';
import { scriptedModels } from './helpers/scripted-models.mjs';
import { integrationDatabase, toolRound } from './helpers/bash-integration.mjs';
import { installBashBrowserHooks } from './helpers/bash-browser-hooks.mjs';

const hooks = installBashBrowserHooks();
test.after(() => hooks.deregister());
const { DurableChatService } = await import('../src/pi/chat-service.ts');
const { WorkspaceDoc } = await import('../src/pi/workspace/document.ts');
const { WorkspaceFileSystem, DEFAULT_WORKSPACE_LIMITS } = await import('../src/pi/workspace/filesystem/index.ts');
const answer = { chunks: ['Done.'] };
const rows = (service, id) => service.getConversation(id).messages.filter((message) => message.tool);

async function run(service, id) {
  const submission = await service.send(id, 'Perform the requested workspace operation.');
  assert.equal((await service.waitForSubmission(submission)).status, 'done');
  return rows(service, id);
}

test('registered file tools preserve final symlinks, hard links and physical symlink/.. paths', { timeout: 15_000 }, async (t) => {
  const file = await integrationDatabase(t, DurableChatService);
  const provider = scriptedModels([toolRound([
    { name: 'bash', arguments: { command: "mkdir -p a/sub b; printf 'start\n' > a/file; ln a/file hard; ln -s /workspace/a/file file-link; ln -s /workspace/a/sub b/link" } },
    { name: 'read', arguments: { path: 'b/link/../file' } },
    { name: 'write', arguments: { path: 'file-link', content: 'through final symlink\n' } },
    { name: 'edit', arguments: { path: 'hard', edits: [{ oldText: 'final symlink', newText: 'shared inode' }] } },
    { name: 'read', arguments: { path: '/workspace/a/file' } },
    { name: 'write', arguments: { path: 'b/link/../created', content: 'physical parent' } },
    { name: 'read', arguments: { path: 'file-link/' } },
    { name: 'write', arguments: { path: 'file-link/', content: 'must not replace the referent' } },
    { name: 'bash', arguments: { command: 'cat a/file; cat a/created; test ! -e b/created; readlink file-link' } },
  ]), answer]);
  const service = await file.open(provider.models);
  const tools = await run(service, await service.createChat());
  assert.deepEqual(tools.map(({ tool }) => tool.status), [
    'completed', 'completed', 'completed', 'completed', 'completed', 'completed', 'error', 'error', 'completed',
  ]);
  assert.equal(tools[1].tool.output, 'start\n');
  assert.equal(tools[4].tool.output, 'through shared inode\n');
  assert.match(tools[8].tool.output, /through shared inode\nphysical parent\/workspace\/a\/file/);
});

test('read reports unsupported images and decodes other bytes while edit rejects invalid UTF-8', { timeout: 15_000 }, async (t) => {
  const file = await integrationDatabase(t, DurableChatService);
  const png = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=';
  const provider = scriptedModels([toolRound([
    { name: 'bash', arguments: { command: `printf '${png}' | base64 -d > image.png; printf AP9B | base64 -d > bytes.bin` } },
    { name: 'read', arguments: { path: 'image.png' } },
    { name: 'read', arguments: { path: 'bytes.bin' } },
    { name: 'edit', arguments: { path: 'bytes.bin', edits: [{ oldText: 'A', newText: 'X' }] } },
    { name: 'bash', arguments: { command: 'base64 bytes.bin' } },
  ]), answer]);
  const service = await file.open(provider.models);
  const tools = await run(service, await service.createChat());
  assert.equal(tools[1].tool.status, 'error');
  assert.match(tools[1].tool.output, /image\/png.*not supported/);
  assert.equal(tools[2].tool.output, '\0\ufffdA');
  assert.equal(tools[2].tool.status, 'completed');
  assert.equal(tools[3].tool.status, 'error');
  assert.match(tools[4].tool.output, /AP9B/);
  const imageResult = provider.requests[1].context.messages.find((message) => message.role === 'toolResult' && message.toolName === 'read');
  assert.ok(imageResult.content.every((part) => part.type === 'text'), 'unsupported images do not turn into attachments');
});

test('real workspace quota failures preserve the original file through registered write and edit', { timeout: 20_000 }, async (t) => {
  const file = await integrationDatabase(t, DurableChatService);
  const provider = scriptedModels([toolRound([
    { name: 'write', arguments: { path: 'kept', content: 'expanded original' } },
    { name: 'edit', arguments: { path: 'kept', edits: [{ oldText: 'original', newText: 'expanded original' }] } },
    { name: 'read', arguments: { path: 'kept' } },
  ]), answer]);
  const service = await file.open(provider.models);
  const id = await service.createChat();
  const identity = await file.workspace(service, id, WorkspaceDoc);
  const database = await file.openWorkspaceDatabase();
  try {
    const files = await WorkspaceFileSystem.open(database, identity.id, { mountPath: '/workspace' });
    const original = 'original';
    await files.writeFile('/kept', original);
    const chunk = new Uint8Array(DEFAULT_WORKSPACE_LIMITS.maxFileBytes).fill(120);
    let remaining = DEFAULT_WORKSPACE_LIMITS.maxTotalBytes - original.length;
    for (let index = 0; remaining; index++) {
      const count = Math.min(remaining, chunk.length);
      await files.writeFile(`/reserved-${index}`, chunk.subarray(0, count));
      remaining -= count;
    }
    await files.drain();
  } finally { await database.close(); }
  const tools = await run(service, id);
  assert.deepEqual(tools.map(({ tool }) => tool.status), ['error', 'error', 'completed']);
  assert.match(tools[0].tool.output, /ENOSPC|quota|limit/i);
  assert.equal(tools[2].tool.output, 'original');
});

test('temporary paths and links share state across tools and reset only when the service reopens', { timeout: 15_000 }, async (t) => {
  const file = await integrationDatabase(t, DurableChatService);
  const provider = scriptedModels([toolRound([
    { name: 'write', arguments: { path: '/tmp/transient', content: 'shared temporary file' } },
    { name: 'read', arguments: { path: '/tmp/transient' } },
    { name: 'bash', arguments: { command: 'ln -s /tmp/through-link /workspace/temp-link' } },
    { name: 'write', arguments: { path: 'temp-link', content: 'shared through link' } },
    { name: 'read', arguments: { path: 'temp-link' } },
    { name: 'write', arguments: { path: 'persistent', content: 'retained' } },
  ]), answer]);
  const first = await file.open(provider.models);
  const id = await first.createChat();
  const tools = await run(first, id);
  assert.ok(tools.every(({ tool }) => tool.status === 'completed'));
  assert.equal(tools[1].tool.output, 'shared temporary file');
  assert.equal(tools[4].tool.output, 'shared through link');
  await file.close(first);
  const second = await file.open(scriptedModels([toolRound([
    { name: 'read', arguments: { path: 'persistent' } },
    { name: 'bash', arguments: { command: 'test ! -e /tmp/transient && test ! -e /tmp/through-link && readlink temp-link' } },
  ]), answer]).models);
  const reopened = (await run(second, id)).slice(-2);
  assert.equal(reopened[0].tool.output, 'retained');
  assert.match(reopened[1].tool.output, /\/tmp\/through-link/);
});

test('full edit patch survives transcript and SQLite reopen and is readable by read and bash', { timeout: 20_000 }, async (t) => {
  const file = await integrationDatabase(t, DurableChatService);
  const original = `before:${'x'.repeat(15_000)}\n`;
  const replacement = `after:${'y'.repeat(15_000)}\n`;
  const provider = scriptedModels([toolRound([
    { name: 'write', arguments: { path: 'large-edit.txt', content: original } },
    { name: 'edit', arguments: { path: 'large-edit.txt', edits: [{ oldText: original, newText: replacement }] } },
  ]), answer]);
  const first = await file.open(provider.models);
  const id = await first.createChat();
  const edited = (await run(first, id)).at(-1);
  assert.equal(edited.tool.status, 'completed');
  assert.equal(edited.tool.file.diffTruncated, true);
  const patchPath = edited.tool.file.patchPath;
  assert.match(patchPath, /^\/workspace\/\.edit-output\/.+\.patch$/);
  const modelResult = provider.requests[1].context.messages.find((message) => message.role === 'toolResult' && message.toolName === 'edit');
  assert.equal(modelResult.details.patchPath, patchPath);
  assert.ok(Buffer.byteLength(JSON.stringify(modelResult.details)) <= 64 * 1024);
  await file.close(first);
  const next = scriptedModels([toolRound([
    { name: 'read', arguments: { path: patchPath } },
    { name: 'bash', arguments: { command: `wc -c < '${patchPath}'; sha256sum '${patchPath}'` } },
  ]), answer]);
  const second = await file.open(next.models);
  const persistedEdit = rows(second, id).find(({ tool }) => tool.name === 'edit');
  assert.deepEqual(persistedEdit.tool.file, edited.tool.file, 'projection restores the same bounded diff and artifact path');
  const results = (await run(second, id)).slice(-2);
  assert.equal(results[0].tool.status, 'completed');
  const patch = results[0].tool.output;
  assert.match(patch, /--- large-edit\.txt\n\+\+\+ large-edit\.txt/);
  assert.ok(patch.includes(`-${original}`));
  assert.ok(patch.includes(`+${replacement}`));
  assert.match(results[1].tool.output, new RegExp(String(Buffer.byteLength(patch))));
  assert.match(results[1].tool.output, new RegExp(createHash('sha256').update(patch).digest('hex')));
});
