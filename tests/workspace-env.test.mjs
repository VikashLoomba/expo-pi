import assert from 'node:assert/strict';
import test from 'node:test';
import { BACKGROUND_CONTEXT, withAbortSignal } from '@earendil-works/chord/context';
import { createEditTool, createReadTool, createWriteTool } from '@earendil-works/pi-durable/tools';
import { installBashBrowserHooks } from './helpers/bash-browser-hooks.mjs';
import { createNodeSqliteConnection } from './helpers/node-sqlite.mjs';

const hooks = installBashBrowserHooks();
test.after(() => hooks.deregister());
const { createExpoSqliteDatabase } = await import('../src/pi/storage/expo-sqlite.ts');
const { WorkspaceFileSystem } = await import('../src/pi/workspace/filesystem/index.ts');
const { BoundedSystemFs } = await import('../src/pi/workspace/bounded-system-fs.ts');
const { createMountedFileSystem } = await import('../src/pi/workspace/mounted-filesystem.ts');
const { WorkspaceExecutionEnv } = await import('../src/pi/workspace/execution-env.ts');
const context = BACKGROUND_CONTEXT;
const encoder = new TextEncoder();

function value(result) {
  assert.equal(result.ok, true, result.error?.message);
  return result.value;
}

async function environment(t, limits) {
  const database = createExpoSqliteDatabase(createNodeSqliteConnection());
  const files = await WorkspaceFileSystem.open(database, 'environment', { mountPath: '/workspace', limits });
  const system = new BoundedSystemFs();
  await system.mkdir('/tmp');
  const controller = new AbortController();
  const mounted = createMountedFileSystem(system, files, controller.signal);
  const env = new WorkspaceExecutionEnv({ files, system, mounted, signal: controller.signal });
  t.after(async () => { await env.cleanup(context); await database.close(); });
  return { files, mounted, env, controller };
}

test('the real Pi factories share nested files through the mounted adapter', async (t) => {
  const { env, mounted } = await environment(t);
  const api = { env };
  await createWriteTool().execute({ path: 'nested/notes.txt', content: 'first\nsecond\n' }, api, context);
  assert.equal(await mounted.readFile('/workspace/nested/notes.txt'), 'first\nsecond\n');
  const edited = await createEditTool().execute({ path: '/workspace/nested/notes.txt', edits: [
    { oldText: 'first', newText: 'updated' }, { oldText: 'second', newText: 'last' },
  ] }, api, context);
  assert.match(edited.details.diff, /updated/);
  assert.match(edited.details.patch, /notes\.txt/);
  const read = await createReadTool().execute({ path: 'nested/notes.txt', offset: 2, limit: 1 }, api, context);
  assert.equal(read.content[0].text, 'last');
});

test('path anchoring preserves physical symlink traversal and mounted aliases', async (t) => {
  const { env, mounted, files } = await environment(t);
  await mounted.mkdir('/workspace/one/sub', { recursive: true });
  await mounted.mkdir('/workspace/two');
  await mounted.symlink('../one/sub', '/workspace/two/link');
  assert.equal(value(await env.absolutePath('two/link/../value', context)), '/workspace/two/link/../value');
  value(await env.writeFile('two/link/../value', 'physical', context));
  assert.equal(await files.readFile('/one/value'), 'physical');
  assert.equal(value(await env.canonicalPath('two/link/../value', context)), '/workspace/one/value');
  assert.equal(value(await env.joinPath(['/workspace/missing/new', '..'], context)), '/workspace/missing');
  await mounted.symlink('/workspace/one', '/workspace/alias');
  await createWriteTool().execute({ path: 'alias/deep/new', content: 'through alias' }, { env }, context);
  assert.equal(await files.readFile('/one/deep/new'), 'through alias');
  await mounted.link('/workspace/one/value', '/workspace/hard');
  value(await env.writeFile('hard', 'same inode', context));
  assert.equal(await files.readFile('/one/value'), 'same inode');
  await mounted.symlink('/tmp/transient', '/workspace/temporary-link');
  value(await env.writeFile('temporary-link', 'temporary', context));
  assert.equal(await mounted.readFile('/tmp/transient'), 'temporary');
});

test('strict text decoding preserves all BOMs, CRLF, valid replacement characters and astral text', async (t) => {
  const { env, mounted } = await environment(t);
  for (const text of ['', 'hello', '\uFEFFhello', '\uFEFF\uFEFFhello', '\uFFFD', '𝄞 😀 世界\r\nlast']) {
    const bytes = encoder.encode(text);
    await mounted.writeFile('/workspace/text', bytes);
    assert.equal(value(await env.readTextFile('text', context)), text);
    assert.deepEqual(value(await env.readBinaryFile('text', context)), bytes);
  }
  await mounted.writeFile('/workspace/bom', encoder.encode('\uFEFFone\r\ntwo\r\n'));
  await createEditTool().execute({ path: 'bom', edits: [{ oldText: 'two', newText: '😀' }] }, { env }, context);
  assert.deepEqual(await mounted.readFileBuffer('/workspace/bom'), encoder.encode('\uFEFFone\r\n😀\r\n'));
});

test('invalid UTF-8 is rejected without changing the file, while binary reads retain every byte', async (t) => {
  const { env, mounted } = await environment(t);
  const malformed = [[0x80], [0xc0, 0xaf], [0xe2, 0x82], [0xed, 0xa0, 0x80], [0xf4, 0x90, 0x80, 0x80], [0xff]];
  for (const suffix of malformed) {
    const bytes = Uint8Array.from([0xef, 0xbb, 0xbf, 0x61, ...suffix]);
    await mounted.writeFile('/workspace/binary', bytes);
    const result = await env.readTextFile('binary', context);
    assert.equal(result.ok, false);
    assert.equal(result.error.code, 'invalid');
    await assert.rejects(createEditTool().execute({ path: 'binary', edits: [{ oldText: 'a', newText: 'b' }] }, { env }, context));
    assert.deepEqual(await mounted.readFileBuffer('/workspace/binary'), bytes);
    assert.deepEqual(value(await env.readBinaryFile('binary', context)), bytes);
  }
});

test('expected filesystem failures remain typed and quota failures retain original bytes', async (t) => {
  const { env, mounted } = await environment(t, { maxFileBytes: 32, maxTotalBytes: 48 });
  assert.equal((await env.readBinaryFile('missing', context)).error.code, 'not_found');
  value(await env.createDir('directory', undefined, context));
  assert.equal((await env.readBinaryFile('directory', context)).error.code, 'is_directory');
  value(await env.writeFile('kept', 'original', context));
  const tooBig = await env.writeFile('kept', 'x'.repeat(33), context);
  assert.equal(tooBig.ok, false);
  assert.match(tooBig.error.message, /limit|EFBIG/);
  assert.equal(await mounted.readFile('/workspace/kept'), 'original');
  value(await env.writeFile('other', 'y'.repeat(32), context));
  const full = await env.writeFile('kept', 'z'.repeat(20), context);
  assert.equal(full.ok, false);
  assert.match(full.error.message, /quota|limit|ENOSPC/);
  assert.equal(await mounted.readFile('/workspace/kept'), 'original');
  for (const path of ['file:///private/secret', 'content://private/file', 'a\0b', 'a\\b']) {
    assert.equal((await env.writeFile(path, 'forbidden', context)).error.code, 'invalid');
  }
});

test('file metadata, directories, append, rename and remove use the same virtual namespace', async (t) => {
  const { env, mounted } = await environment(t);
  value(await env.writeFile('a/file', 'one', context));
  value(await env.appendFile('a/file', 'two', context));
  assert.equal(value(await env.readTextFile('a/file', context)), 'onetwo');
  await mounted.symlink('missing', '/workspace/a/dangling');
  assert.equal(value(await env.fileInfo('a/dangling', context)).kind, 'symlink');
  assert.equal(value(await env.exists('a/dangling', context)), true);
  const entries = value(await env.listDir('a', context));
  assert.deepEqual(entries.map((entry) => [entry.name, entry.kind]).sort(), [['dangling', 'symlink'], ['file', 'file']]);
  value(await env.renameFile('a/file', 'a/moved', context));
  assert.equal(value(await env.exists('a/file', context)), false);
  assert.equal(value(await env.fileInfo('a/moved', context)).size, 6);
  value(await env.remove('a', { recursive: true }, context));
  assert.equal(value(await env.exists('a', context)), false);
});

test('trailing separators retain directory requirements without creating a file-shaped target', async (t) => {
  const { env, mounted } = await environment(t);
  const failed = await env.writeFile('missing-file/', 'must not write', context);
  assert.equal(failed.ok, false);
  assert.equal(await mounted.exists('/workspace/missing-file'), false);
  value(await env.createDir('real-directory', undefined, context));
  await mounted.symlink('real-directory', '/workspace/directory-link');
  assert.equal(value(await env.fileInfo('directory-link', context)).kind, 'symlink');
  assert.equal(value(await env.fileInfo('directory-link/', context)).kind, 'directory');
  assert.equal((await env.writeFile('directory-link/', 'must not write', context)).ok, false);
});

test('bounded text line readers report termination without a phantom final line and close cleanly', async (t) => {
  const { env } = await environment(t);
  value(await env.writeFile('lines', '\uFEFFone\r\ntwo\nlast', context));
  const reader = value(await env.openTextLineReader('lines', context));
  assert.deepEqual(value(await reader.readLine(context)), { text: '\uFEFFone\r', terminated: true });
  assert.deepEqual(value(await reader.readLine(context)), { text: 'two', terminated: true });
  assert.deepEqual(value(await reader.readLine(context)), { text: 'last', terminated: false });
  assert.equal(value(await reader.readLine(context)), undefined);
  await reader.close(context);
  assert.deepEqual(value(await env.readTextLines('lines', { maxLines: 2 }, context)), ['\uFEFFone\r', 'two']);
  value(await env.writeFile('empty', '', context));
  assert.deepEqual(value(await env.readTextLines('empty', undefined, context)), []);
  value(await env.writeFile('terminated', 'one\n', context));
  assert.deepEqual(value(await env.readTextLines('terminated', undefined, context)), ['one']);
});

test('temporary creation is exclusive and unsupported capabilities never pretend to succeed', async (t) => {
  const { env, mounted } = await environment(t);
  const first = value(await env.createTempFile({ prefix: 'probe-', suffix: '.txt' }, context));
  const second = value(await env.createTempFile({ prefix: 'probe-', suffix: '.txt' }, context));
  assert.notEqual(first, second);
  assert.match(first, /^\/tmp\//);
  assert.equal((await mounted.stat(first)).mode & 0o777, 0o600);
  const directory = value(await env.createTempDir('probe-', context));
  assert.equal((await mounted.stat(directory)).isDirectory, true);
  value(await env.truncateFile(first, 10, context));
  assert.equal(value(await env.fileInfo(first, context)).size, 10);
  value(await env.flushFile(first, context));
  assert.equal(value(await env.exec('echo supported', undefined, context)).exitCode, 0);
  assert.equal((await env.watch([], () => {}, context)).error.code, 'not_supported');
});

test('env cancellation returns typed aborted failures while preserving the cause', async (t) => {
  const { env, controller, mounted } = await environment(t);
  const caller = new AbortController();
  const reason = Object.assign(new Error('ENOENT: cancellation must not become not_found'), { code: 'ENOENT' });
  caller.abort(reason);
  const cancelled = await env.writeFile('late', 'forbidden', withAbortSignal(caller.signal, context));
  assert.equal(cancelled.error.code, 'aborted');
  assert.equal(cancelled.error.cause, reason);
  assert.equal(await mounted.exists('/workspace/late'), false);
  controller.abort(reason);
  assert.equal((await env.exists('missing', context)).error.code, 'aborted');
});

test('cleanup seals environment handles and line readers without deleting persistent files', async (t) => {
  const { env, mounted } = await environment(t);
  value(await env.writeFile('saved', 'one\ntwo', context));
  const reader = value(await env.openTextLineReader('saved', context));
  await env.cleanup(context);
  await env.cleanup(context);
  assert.equal((await env.writeFile('late', 'forbidden', context)).ok, false);
  assert.equal((await reader.readLine(context)).ok, false);
  assert.equal(await mounted.readFile('/workspace/saved'), 'one\ntwo');
});

test('retained unlinked inode bytes remain subject to quotas until the final reader closes', async (t) => {
  const { env } = await environment(t, { maxFileBytes: 32, maxTotalBytes: 48 });
  value(await env.writeFile('opened', 'x'.repeat(32), context));
  const reader = value(await env.openBinaryReader('opened', undefined, context));
  value(await env.remove('opened', undefined, context));
  const full = await env.writeFile('new', 'y'.repeat(32), context);
  assert.equal(full.ok, false);
  assert.match(full.error.message, /limit|ENOSPC/);
  assert.equal(value(await reader.info(context)).size, 32);
  await reader.close(context);
  value(await env.writeFile('new', 'y'.repeat(32), context));
  assert.equal(value(await env.readTextFile('new', context)), 'y'.repeat(32));
});
