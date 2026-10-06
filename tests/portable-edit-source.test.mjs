import assert from 'node:assert/strict';
import { mkdtemp, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { BACKGROUND_CONTEXT, withAbortSignal } from '@earendil-works/chord/context';
import { NodeExecutionEnv } from '@earendil-works/pi-durable/env/node';
import { installBashBrowserHooks } from './helpers/bash-browser-hooks.mjs';

const hooks = installBashBrowserHooks();
test.after(() => hooks.deregister());
const { EditExecutionEnv, EDIT_BUDGET } = await import('../src/pi/workspace/edit-budget.ts');
const { createWorkspaceFileTools } = await import('../src/pi/workspace/file-tools.ts');
const context = BACKGROUND_CONTEXT;
const edits = [{ oldText: 'target-line', newText: 'changed-line' }];

async function fixture(t) {
  const directory = await mkdtemp(join(tmpdir(), 'pi-portable-edit-'));
  const backend = new NodeExecutionEnv({ cwd: directory });
  t.after(async () => { await backend.cleanup(context); await rm(directory, { recursive: true, force: true }); });
  const metrics = { reads: [], closes: 0, writes: 0, wholeReads: 0 };
  const open = backend.openBinaryReader.bind(backend);
  backend.openBinaryReader = async (...args) => {
    const result = await open(...args);
    if (!result.ok) return result;
    const read = result.value.read.bind(result.value);
    const close = result.value.close.bind(result.value);
    result.value.read = async (offset, length, current) => {
      const part = await read(offset, length, current);
      metrics.reads.push({ offset, length, received: part.ok ? part.value.length : 0 });
      return part;
    };
    result.value.close = async (current) => { metrics.closes++; return close(current); };
    return result;
  };
  const write = backend.writeFile.bind(backend);
  backend.writeFile = async (...args) => { metrics.writes++; return write(...args); };
  backend.readTextFile = backend.readBinaryFile = async () => {
    metrics.wholeReads++;
    throw new Error('Portable edit admission must not materialize a backend whole-file read.');
  };
  const { tools, wraps } = createWorkspaceFileTools({});
  let tool = tools.find(({ name }) => name === 'edit');
  for (const wrapper of wraps) tool = wrapper.wrap(tool);
  return { backend, metrics, path: join(directory, 'source.txt'),
    execute: () => tool.execute({ path: 'source.txt', edits }, { env: backend, outputWindow: undefined }, context) };
}

test('portable registered edit rejects malformed UTF-8 without rewriting unrelated bytes', async (t) => {
  const { path, execute, metrics } = await fixture(t);
  for (const invalid of [
    [0xff], [0x80], [0xc0, 0xaf], [0xed, 0xa0, 0x80], [0xf4, 0x90, 0x80, 0x80], [0xe2, 0x82],
  ]) {
    const original = Buffer.concat([Buffer.from('target-line\n'), Buffer.from(invalid)]);
    await writeFile(path, original);
    await assert.rejects(execute(), /invalid|UTF-8/i);
    assert.deepEqual(await readFile(path), original);
  }
  assert.equal(metrics.writes, 0);
  assert.equal(metrics.wholeReads, 0);
  assert.equal(metrics.closes, 6);
});

test('portable registered edit preserves repeated BOMs, CRLF, replacement characters and astral text', async (t) => {
  const { path, execute, metrics } = await fixture(t);
  const original = '\ufeff\ufefffirst � 😀\r\ntarget-line\r\nlast\r\n';
  await writeFile(path, original);
  const result = await execute();
  assert.equal(result.isError ?? false, false);
  assert.deepEqual(await readFile(path), Buffer.from(original.replace('target-line', 'changed-line')));
  assert.equal(metrics.wholeReads, 0);
  assert.equal(metrics.writes, 1);
  assert.equal(metrics.closes, 1);
});

test('bounded portable source reads preserve every valid UTF-8 split at the 64 KiB boundary', async (t) => {
  const { backend, path, metrics } = await fixture(t);
  for (const scalar of ['é', '漢', '😀', '\ufeff', '�']) {
    for (let prefixBytes = 1; prefixBytes < Buffer.byteLength(scalar); prefixBytes++) {
      const original = `${'x'.repeat(65_536 - prefixBytes)}${scalar}\r\ntarget-line\r\n`;
      await writeFile(path, original);
      const policy = new EditExecutionEnv(backend, edits);
      try {
        const result = await policy.readTextFile(path, context);
        assert.equal(result.ok, true, result.error?.message);
        assert.equal(result.value, original, `${scalar}: ${prefixBytes} leading bytes in preceding chunk`);
      } finally { await policy.cleanup(context); }
    }
  }
  // A complete BOM at the beginning of a later chunk must also remain literal text.
  const boundaryBom = `${'x'.repeat(65_536)}\ufeff\ufefftarget-line`;
  await writeFile(path, boundaryBom);
  const result = await new EditExecutionEnv(backend, edits).readTextFile(path, context);
  assert.equal(result.ok, true, result.error?.message);
  assert.equal(result.value, boundaryBom);
  assert.ok(metrics.reads.every(({ length }) => length <= 65_536));
  assert.equal(metrics.wholeReads, 0);
});

test('an incomplete or malformed UTF-8 sequence at a read boundary is rejected and closes its reader', async (t) => {
  const { backend, path, metrics } = await fixture(t);
  for (const tail of [[0xe2, 0x82], [0xe2, 0x28, 0xa1], [0xf0, 0x80, 0x80, 0x80]]) {
    const original = Buffer.concat([Buffer.from('target-line\n'), Buffer.alloc(65_536 - 13, 'x'), Buffer.from(tail)]);
    await writeFile(path, original);
    const policy = new EditExecutionEnv(backend, edits);
    const result = await policy.readTextFile(path, context);
    assert.equal(result.ok, false);
    assert.equal(result.error.code, 'invalid');
    assert.match(result.error.message, /valid UTF-8/);
    await policy.cleanup(context);
    assert.deepEqual(await readFile(path), original);
  }
  assert.equal(metrics.closes, 3);
  assert.equal(metrics.writes, 0);
});

test('growth after opened-file info is bounded to the edit ceiling plus one byte before rejection', async (t) => {
  const { backend, path, metrics } = await fixture(t);
  await writeFile(path, 'target-line');
  const grown = Buffer.alloc(EDIT_BUDGET.maxFileBytes + 1024 * 1024, 'x');
  const open = backend.openBinaryReader.bind(backend);
  backend.openBinaryReader = async (...args) => {
    const result = await open(...args);
    assert.equal(result.ok, true);
    const info = result.value.info.bind(result.value);
    result.value.info = async (current) => {
      const original = await info(current);
      await writeFile(path, grown); // External writer grows the same opened file after its small size was read.
      return original;
    };
    return result;
  };
  const policy = new EditExecutionEnv(backend, edits);
  await assert.rejects(policy.readTextFile(path, context), /edit file-size limit/);
  assert.equal(metrics.reads.reduce((sum, { received }) => sum + received, 0), EDIT_BUDGET.maxFileBytes + 1);
  assert.ok(metrics.reads.every(({ length }) => length <= 65_536));
  assert.equal(metrics.wholeReads, 0);
  assert.equal(metrics.writes, 0);
  assert.equal(metrics.closes, 1);
  assert.deepEqual(await readFile(path), grown);
  await policy.cleanup(context);
});

test('source admission keeps reading the opened file if its pathname is replaced after info', async (t) => {
  const { backend, path, metrics } = await fixture(t);
  await writeFile(path, 'original target-line');
  const open = backend.openBinaryReader.bind(backend);
  backend.openBinaryReader = async (...args) => {
    const result = await open(...args);
    assert.equal(result.ok, true);
    const info = result.value.info.bind(result.value);
    result.value.info = async (current) => {
      const original = await info(current);
      await rename(path, `${path}.original`);
      await writeFile(path, 'replacement at the old pathname');
      return original;
    };
    return result;
  };
  const policy = new EditExecutionEnv(backend, edits);
  const result = await policy.readTextFile(path, context);
  assert.equal(result.ok, true, result.error?.message);
  assert.equal(result.value, 'original target-line');
  assert.equal(await readFile(path, 'utf8'), 'replacement at the old pathname');
  assert.equal(metrics.closes, 1);
  assert.equal(metrics.wholeReads, 0);
  await policy.cleanup(context);
});

test('exact source-size limits accept complete scalars and reject one extra byte', async (t) => {
  const { backend, path, metrics } = await fixture(t);
  const original = 'target-line 😀';
  const bytes = Buffer.byteLength(original);
  await writeFile(path, original);
  const accepted = new EditExecutionEnv(backend, edits, { ...EDIT_BUDGET, maxFileBytes: bytes });
  assert.equal((await accepted.readTextFile(path, context)).value, original);
  await accepted.cleanup(context);
  const rejected = new EditExecutionEnv(backend, edits, { ...EDIT_BUDGET, maxFileBytes: bytes - 1 });
  await assert.rejects(rejected.readTextFile(path, context), /file-size limit/);
  await rejected.cleanup(context);
  assert.equal(metrics.closes, 2);
  assert.equal(metrics.wholeReads, 0);
});

for (const phase of ['open', 'info', 'read']) test(`caller cancellation after ${phase} preserves its reason and closes the opened reader`, async (t) => {
  const { backend, path, metrics } = await fixture(t);
  await writeFile(path, 'target-line');
  const controller = new AbortController();
  const reason = { cancelled: phase };
  const current = withAbortSignal(controller.signal, context);
  const open = backend.openBinaryReader.bind(backend);
  backend.openBinaryReader = async (...args) => {
    const result = await open(...args);
    assert.equal(result.ok, true);
    if (phase === 'open') controller.abort(reason);
    else {
      const operation = result.value[phase].bind(result.value);
      result.value[phase] = async (...parameters) => {
        const result = await operation(...parameters);
        controller.abort(reason);
        return result;
      };
    }
    const close = result.value.close.bind(result.value);
    result.value.close = async (closingContext) => {
      assert.equal(closingContext.abortSignal, undefined, 'reader closure must not inherit the cancelled signal');
      return close(closingContext);
    };
    return result;
  };
  const policy = new EditExecutionEnv(backend, edits);
  await assert.rejects(policy.readTextFile(path, current), (cause) => cause === reason);
  assert.equal(metrics.closes, 1);
  assert.equal(metrics.writes, 0);
  await policy.cleanup(context);
});
