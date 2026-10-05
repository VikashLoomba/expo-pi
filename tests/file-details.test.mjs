import assert from 'node:assert/strict';
import test from 'node:test';
import { installBashBrowserHooks } from './helpers/bash-browser-hooks.mjs';
import { createNodeSqliteConnection } from './helpers/node-sqlite.mjs';

const hooks = installBashBrowserHooks();
test.after(() => hooks.deregister());
const { createExpoSqliteDatabase } = await import('../src/pi/storage/expo-sqlite.ts');
const { WorkspaceFileSystem } = await import('../src/pi/workspace/filesystem/index.ts');
const { BoundedSystemFs } = await import('../src/pi/workspace/bounded-system-fs.ts');
const { createMountedFileSystem } = await import('../src/pi/workspace/mounted-filesystem.ts');
const { finalizeEditResult, EDIT_PRESENTATION_LIMITS } = await import('../src/pi/workspace/file-details.ts');

async function workspace(t, limits) {
  const database = createExpoSqliteDatabase(createNodeSqliteConnection());
  t.after(() => database.close());
  const files = await WorkspaceFileSystem.open(database, 'details', { mountPath: '/workspace', limits });
  const system = new BoundedSystemFs();
  await system.mkdir('/tmp');
  const controller = new AbortController();
  const mounted = createMountedFileSystem(system, files, controller.signal);
  return { mounted, signal: controller.signal, controller };
}

const result = (diff, patch) => ({ content: [{ type: 'text', text: 'Successfully replaced one block.' }],
  details: { diff, patch, firstChangedLine: 7 } });

test('small edit details stay inline with stable typed metadata', async (t) => {
  const invocation = await workspace(t);
  const finalized = await finalizeEditResult(result('-7 old\n+7 new', '-old\n+new'), invocation);
  assert.deepEqual(finalized.details, { diff: '-7 old\n+7 new', diffTruncated: false, patchBytes: 9,
    patch: '-old\n+new', firstChangedLine: 7 });
  assert.deepEqual(await invocation.mounted.readdir('/workspace'), []);
});

test('large patches persist exactly while preview, model summary and JSON details stay bounded', async (t) => {
  const invocation = await workspace(t);
  const patch = `${'--- path\n+++ path\n'}${'+😀\0line\n'.repeat(6000)}`;
  const original = result('+7 😀\0changed\n'.repeat(6000), patch);
  original.content[0].text = '😀'.repeat(40_000);
  const finalized = await finalizeEditResult(original, invocation);
  assert.equal(finalized.details.diffTruncated, true);
  assert.match(finalized.details.patchPath, /^\/workspace\/\.edit-output\/.+\.patch$/);
  assert.equal(await invocation.mounted.readFile(finalized.details.patchPath), patch);
  assert.ok(Buffer.byteLength(JSON.stringify(finalized.details)) <= EDIT_PRESENTATION_LIMITS.detailsJsonBytes);
  assert.ok(Buffer.byteLength(finalized.content[0].text) <= EDIT_PRESENTATION_LIMITS.contentBytes);
  assert.ok(Buffer.byteLength(finalized.details.diff) <= EDIT_PRESENTATION_LIMITS.previewBytes);
  assert.doesNotMatch(finalized.details.diff, /�/);
  assert.ok(finalized.diagnostics.some(({ code }) => code === 'edit_patch_saved'));
  assert.ok(finalized.diagnostics.some(({ code }) => code === 'edit_summary_truncated'));
});

test('JSON escape expansion also bounds a single-line preview', async (t) => {
  const invocation = await workspace(t);
  const finalized = await finalizeEditResult(result('\0'.repeat(100_000), 'small patch'), invocation);
  assert.ok(Buffer.byteLength(JSON.stringify(finalized.details)) <= EDIT_PRESENTATION_LIMITS.detailsJsonBytes);
  assert.equal(finalized.details.diffTruncated, true);
  assert.equal(finalized.details.patch, 'small patch');
});

test('quota failure keeps edit success visible and removes the failed empty patch artifact', async (t) => {
  const invocation = await workspace(t, { maxTotalBytes: 1024 });
  await invocation.mounted.writeFile('/workspace/edited', 'the successful edit');
  const finalized = await finalizeEditResult(result('preview', 'p'.repeat(20_000)), invocation);
  assert.equal(finalized.isError, undefined);
  assert.equal(finalized.details.patchUnavailable, true);
  assert.equal(await invocation.mounted.readFile('/workspace/edited'), 'the successful edit');
  assert.deepEqual(await invocation.mounted.readdir('/workspace/.edit-output'), []);
  assert.match(finalized.diagnostics.find(({ code }) => code === 'edit_patch_unavailable').message, /edit succeeded.*could not be saved/);
});

test('a guest-created output symlink cannot redirect patch persistence into temporary files', async (t) => {
  const invocation = await workspace(t);
  await invocation.mounted.mkdir('/tmp/redirect');
  await invocation.mounted.symlink('/tmp/redirect', '/workspace/.edit-output');
  const finalized = await finalizeEditResult(result('preview', 'p'.repeat(20_000)), invocation);
  assert.equal(finalized.details.patchUnavailable, true);
  assert.deepEqual(await invocation.mounted.readdir('/tmp/redirect'), []);
});

test('read output and its continuation diagnostics are never truncated by edit finalization', async (t) => {
  const invocation = await workspace(t);
  const read = { content: [{ type: 'text', text: 'x'.repeat(50 * 1024) }],
    diagnostics: [{ severity: 'info', message: 'Use offset=2001 to continue.' }] };
  assert.equal(await finalizeEditResult(read, invocation), read);
});

test('cancellation retains its identity instead of becoming a patch-saving warning', async (t) => {
  const invocation = await workspace(t);
  const reason = new Error('cancelled by caller');
  invocation.controller.abort(reason);
  await assert.rejects(finalizeEditResult(result('preview', 'p'.repeat(20_000)), invocation), (cause) => cause === reason);
});
