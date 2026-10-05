import assert from 'node:assert/strict';
import test from 'node:test';
import { BACKGROUND_CONTEXT, withAbortSignal } from '@earendil-works/chord/context';
import { createEditTool } from '@earendil-works/pi-durable/tools';
import { installBashBrowserHooks } from './helpers/bash-browser-hooks.mjs';
import { createNodeSqliteConnection } from './helpers/node-sqlite.mjs';

const hooks = installBashBrowserHooks();
test.after(() => hooks.deregister());
const { createExpoSqliteDatabase } = await import('../src/pi/storage/expo-sqlite.ts');
const { WorkspaceFileSystem } = await import('../src/pi/workspace/filesystem/index.ts');
const { BoundedSystemFs } = await import('../src/pi/workspace/bounded-system-fs.ts');
const { createMountedFileSystem } = await import('../src/pi/workspace/mounted-filesystem.ts');
const { EditExecutionEnv, EditBudgetError, EDIT_BUDGET } = await import('../src/pi/workspace/edit-budget.ts');
const { WorkspaceExecutionEnv } = await import('../src/pi/workspace/execution-env.ts');
const context = BACKGROUND_CONTEXT;

async function workspace(t, controller = new AbortController()) {
  const database = createExpoSqliteDatabase(createNodeSqliteConnection());
  t.after(() => database.close());
  const files = await WorkspaceFileSystem.open(database, 'edit-budget', { mountPath: '/workspace' });
  const system = new BoundedSystemFs();
  await system.mkdir('/tmp');
  const signal = controller.signal;
  const mounted = createMountedFileSystem(system, files, signal);
  return { mounted, signal, files };
}

async function edit(invocation, original, edits, limits) {
  await invocation.mounted.writeFile('/workspace/file', original);
  const env = new EditExecutionEnv(invocation, edits, { ...EDIT_BUDGET, ...limits });
  try { return await createEditTool().execute({ path: '/workspace/file', edits }, { env }, context); }
  finally { await env.cleanup(context); }
}

test('guarded edit preserves all SDK BOM, line ending, fuzzy and EOF semantics', async (t) => {
  const invocation = await workspace(t);
  for (const [original, oldText, newText] of [
    ['one\ntwo\n', 'two', 'last'],
    ['\ufeffone\r\ntwo\r\n', 'two', 'last'],
    ['\ufeffone', 'one', '\ufefftwo'],
    ['one', 'one', '\ufefftwo'],
    ['\ufeff\ufeffone', 'one', 'two'],
    ['one\rtwo\r', 'two', 'last'],
    ['one\r\ntwo\nlast\r', 'two', 'middle'],
    ['start\n“alpha”  \nend', '"alpha"', 'beta'],
    ['éà漢字\noriginal\n', 'original', '変更'],
    ['no final newline', 'final', 'trailing'],
    [`${'a'.repeat(8191)}😀tail`, '😀', '🦊'],
  ]) {
    const edits = [{ oldText, newText }];
    const guarded = await edit(invocation, original, edits);
    const guardedBytes = await invocation.mounted.readFileBuffer('/workspace/file');
    await invocation.mounted.writeFile('/workspace/file', original);
    const baseline = new WorkspaceExecutionEnv(invocation);
    const unguarded = await createEditTool().execute({ path: '/workspace/file', edits }, { env: baseline }, context);
    await baseline.cleanup(context);
    assert.deepEqual(await invocation.mounted.readFileBuffer('/workspace/file'), guardedBytes, JSON.stringify(original));
    assert.deepEqual(guarded, unguarded, 'preflight does not change the SDK output');
  }
});

test('a targeted edit in a full 8 MiB file remains available', { timeout: 15_000 }, async (t) => {
  const invocation = await workspace(t);
  const original = Array.from({ length: 65_536 }, (_, i) => `${String(i).padStart(8, '0')} ${'x'.repeat(118)}\n`).join('');
  assert.equal(Buffer.byteLength(original), 8 * 1024 * 1024);
  const start = 32_768 * 128;
  const oldText = original.slice(start, start + 256);
  const newText = `${oldText.slice(0, 100)}y${oldText.slice(101)}`;
  const result = await edit(invocation, original, [{ oldText, newText }]);
  assert.match(result.details.diff, /y/);
  const actual = await invocation.mounted.readFile('/workspace/file');
  assert.equal(actual.length, original.length);
  assert.equal(actual, original.slice(0, start) + newText + original.slice(start + 256));
});

test('input and replacement count are rejected before any file access', async (t) => {
  const invocation = await workspace(t);
  assert.throws(() => new EditExecutionEnv(invocation, []), EditBudgetError);
  assert.throws(() => new EditExecutionEnv(invocation,
    Array.from({ length: EDIT_BUDGET.maxEdits + 1 }, () => ({ oldText: 'a', newText: 'b' }))), /between 1 and/);
  assert.throws(() => new EditExecutionEnv(invocation,
    [{ oldText: 'a', newText: '😀'.repeat(EDIT_BUDGET.maxInputBytes / 4 + 1) }]), /input budget/);
  assert.deepEqual(await invocation.mounted.readdir('/workspace'), []);
});

for (const [name, original, edits, limits, error] of [
  ['normalization expansion', '\ufdfa'.repeat(100), [{ oldText: '\ufdfa', newText: 'new' }], { maxNormalizedUnits: 200 }, /normalization/],
  ['line arrays', 'x\n'.repeat(20), [{ oldText: 'x', newText: 'new' }], { maxLines: 10 }, /line-processing/],
  ['repeat count allocation', 'x'.repeat(100), [{ oldText: 'x', newText: 'new' }], { maxOccurrenceSlots: 10 }, /surrounding text/],
  ['whitespace pattern', ' '.repeat(100), [{ oldText: '   ', newText: 'new' }], { maxOccurrenceSlots: 10 }, /surrounding text/],
  ['weighted matching work', 'x'.repeat(100), [{ oldText: 'x', newText: 'y' }, { oldText: 'z', newText: 'w' }], { maxMatchUnits: 150 }, /normalization/],
  ['diff distance', 'a\nb\nc\nd\n', [{ oldText: 'a\nb\nc\nd\n', newText: 'w\nx\ny\nz\n' }], { maxDiffDistance: 2 }, /diff work budget/],
  ['long-line materialization', `${'x'.repeat(4000)}target`, [{ oldText: 'target', newText: 'changed' }], { maxDetailsBytes: 4096 }, /large diff/],
  ['proposed bytes', 'a', [{ oldText: 'a', newText: '😀😀😀' }], { maxFileBytes: 10 }, /file-size/],
]) test(`${name} rejects before filesystem mutation`, async (t) => {
  const invocation = await workspace(t);
  await assert.rejects(edit(invocation, original, edits, limits), (cause) => cause instanceof EditBudgetError && error.test(cause.message));
  assert.deepEqual(await invocation.mounted.readFileBuffer('/workspace/file'), new TextEncoder().encode(original));
});

test('small widely separated edits are measured by edit distance, not span', async (t) => {
  const invocation = await workspace(t);
  const original = Array.from({ length: 2000 }, (_, i) => `line ${i}\n`).join('');
  const result = await edit(invocation, original,
    [{ oldText: 'line 1\n', newText: 'first change\n' }, { oldText: 'line 1998\n', newText: 'last change\n' }],
    { maxDiffDistance: 4 });
  assert.match(result.details.patch, /first change/);
  assert.match(result.details.patch, /last change/);
});

test('ambiguity, overlap and empty patterns retain Pi validation failures and leave bytes unchanged', async (t) => {
  const invocation = await workspace(t);
  for (const [original, edits, error] of [
    ['same same', [{ oldText: 'same', newText: 'other' }], /occurrences/],
    ['abcdef', [{ oldText: 'abc', newText: '1' }, { oldText: 'bcde', newText: '2' }], /overlap/],
    ['original', [{ oldText: '', newText: 'new' }], /must not be empty/],
  ]) {
    await assert.rejects(edit(invocation, original, edits), error);
    assert.equal(await invocation.mounted.readFile('/workspace/file'), original);
  }
});

for (const [name, original, oldText] of [
  ['repeated exact prefixes', 'a'.repeat(64 * 1024), `${'a'.repeat(4096)}b`],
  ['NFKC composition prefixes', 'e\u0301'.repeat(32_768), `${'é'.repeat(4096)}X`],
  ['smart-quote prefixes', '\u2019'.repeat(32_768), `${"'".repeat(4096)}X`],
  ['Unicode minus prefixes', '\u2212'.repeat(32_768), `${'-'.repeat(4096)}X`],
  ['Unicode space prefixes', '\u3000'.repeat(32_768), `${' '.repeat(4096)}X`],
  ['whitespace-only first pattern line', '\n'.repeat(43_000), `${' '.repeat(100)}\n${'a'.repeat(4096)}X`],
]) test(`native search work rejects ${name} before Pi matching`, async (t) => {
  const invocation = await workspace(t);
  await invocation.mounted.writeFile('/workspace/file', original);
  const env = new EditExecutionEnv(invocation, [{ oldText, newText: 'replacement' }]);
  try {
    // Exercise the read admission itself: an SDK indexOf/split must never see this source.
    await assert.rejects(env.readTextFile('/workspace/file', context),
      (cause) => cause instanceof EditBudgetError && /text-search work budget/.test(cause.message));
    assert.deepEqual(await invocation.mounted.readFileBuffer('/workspace/file'), new TextEncoder().encode(original));
  } finally { await env.cleanup(context); }
});

for (const stage of ['read', 'write']) for (const owner of ['caller', 'invocation']) {
  test(`${owner} cancellation during cooperative ${stage} admission preserves its reason and original bytes`, async (t) => {
    const invocationController = new AbortController();
    const invocation = await workspace(t, invocationController);
    const caller = new AbortController();
    const executionContext = withAbortSignal(caller.signal, context);
    const original = `${'x'.repeat(256 * 1024)}${'Z'.repeat(128)}`;
    const proposed = `${original.slice(0, -1)}Y`;
    await invocation.mounted.writeFile('/workspace/file', original);
    const env = new EditExecutionEnv(invocation, [{ oldText: 'Z'.repeat(128), newText: `${'Z'.repeat(127)}Y` }]);
    try {
      if (stage === 'write') assert.equal((await env.readTextFile('/workspace/file', executionContext)).ok, true);
      const reason = owner === 'caller' ? null : { reason: 'cooperative invocation stop' };
      const controller = owner === 'caller' ? caller : invocationController;
      const stopped = new Promise((resolve) => setTimeout(() => { controller.abort(reason); resolve(); }, 0));
      const operation = stage === 'read'
        ? createEditTool().execute({ path: '/workspace/file', edits: [{ oldText: 'Z'.repeat(128), newText: `${'Z'.repeat(127)}Y` }] }, { env }, executionContext)
        : env.writeFile('/workspace/file', proposed, executionContext);
      await assert.rejects(operation, (cause) => cause === reason);
      await stopped;
      await new Promise((resolve) => setTimeout(resolve, 5));
      // The physical workspace remains readable when cancellation seals mounted access.
      assert.equal(await invocation.files.readFile('/file'), original);
    } finally { await env.cleanup(context); }
  });
}

test('cleanup during a cooperative scan prevents the environment from returning an admitted read', async (t) => {
  const invocation = await workspace(t);
  const original = `${'x'.repeat(256 * 1024)}${'Z'.repeat(128)}`;
  await invocation.mounted.writeFile('/workspace/file', original);
  const env = new EditExecutionEnv(invocation, [{ oldText: 'Z'.repeat(128), newText: 'Y'.repeat(128) }]);
  const closed = new Promise((resolve, reject) => setTimeout(() => { env.cleanup(context).then(resolve, reject); }, 0));
  await assert.rejects(env.readTextFile('/workspace/file', context),
    (cause) => cause.code === 'aborted' && /closed/.test(cause.message));
  await closed;
  assert.equal(await invocation.files.readFile('/file'), original);
});

test('decomposed combining runs retain their count across scalar and scan boundaries', async (t) => {
  const invocation = await workspace(t);
  for (const marks of ['\u0301'.repeat(32) + '\u0316'.repeat(32), '\uff9e'.repeat(64), '\u{1d165}'.repeat(32)]) {
    const original = `${'x'.repeat(1000)}a${marks}\n${'Z'.repeat(128)}`;
    await invocation.mounted.writeFile('/workspace/file', original);
    const env = new EditExecutionEnv(invocation, [{ oldText: 'Z'.repeat(128), newText: 'Y'.repeat(128) }]);
    assert.equal((await env.readTextFile('/workspace/file', context)).ok, true, '64 decomposed mark units remain admissible');
    await env.cleanup(context);
    await invocation.mounted.writeFile('/workspace/file', original.replace('\n', '\u0301\n'));
    const rejected = new EditExecutionEnv(invocation, [{ oldText: 'Z'.repeat(128), newText: 'Y'.repeat(128) }]);
    await assert.rejects(rejected.readTextFile('/workspace/file', context), /combining-mark run budget/);
    assert.equal(await invocation.mounted.readFile('/workspace/file'), original.replace('\n', '\u0301\n'));
    await rejected.cleanup(context);
  }
});

test('normalization expansion is charged for each edit and summed across oldText patterns', async (t) => {
  const invocation = await workspace(t);
  const original = `${'\ufdfa'.repeat(10)}\n${'Z'.repeat(128)}`;
  await invocation.mounted.writeFile('/workspace/file', original);
  const replacement = { oldText: 'Z'.repeat(128), newText: 'Y'.repeat(128) };
  const limits = { ...EDIT_BUDGET, maxNormalizationExpansionUnits: 250 };
  const admitted = new EditExecutionEnv(invocation, [replacement], limits);
  assert.equal((await admitted.readTextFile('/workspace/file', context)).ok, true);
  await admitted.cleanup(context);
  const repeated = new EditExecutionEnv(invocation, [replacement, replacement], limits);
  await assert.rejects(repeated.readTextFile('/workspace/file', context), /normalization expansion work budget/);
  await repeated.cleanup(context);
  const patterns = new EditExecutionEnv(invocation,
    [{ oldText: '\ufdfa'.repeat(6), newText: 'one' }, { oldText: '\ufdfa'.repeat(6), newText: 'two' }],
    { ...limits, maxNormalizationExpansionUnits: 150 });
  // Missing-file resolution must not run before rejecting excessive aggregate arguments.
  await assert.rejects(patterns.readTextFile('/workspace/missing', context), /normalization expansion work budget/);
  await patterns.cleanup(context);
  assert.equal(await invocation.mounted.readFile('/workspace/file'), original);
});

test('large expanding oldText is admitted cooperatively before any full-string normalization', async (t) => {
  const invocation = await workspace(t);
  const oldText = '\ufdfa'.repeat(Math.floor((EDIT_BUDGET.maxInputBytes - 1) / 3));
  const env = new EditExecutionEnv(invocation, [{ oldText, newText: 'Y' }]);
  await assert.rejects(env.readTextFile('/workspace/missing', context), /normalization expansion work budget/);
  await env.cleanup(context);
  const marks = new EditExecutionEnv(invocation, [{ oldText: `a${'\u0301'.repeat(65)}`, newText: 'Y' }]);
  await assert.rejects(marks.readTextFile('/workspace/missing', context), /combining-mark run budget/);
  await marks.cleanup(context);
});

test('combining work joins decomposed scalar runs across scan boundaries exactly', async (t) => {
  const invocation = await workspace(t);
  const replacement = { oldText: 'Z'.repeat(128), newText: 'Y'.repeat(128) };
  for (const marks of ['\u0301\u0301\u0316', '\u1e69\u0301', '\uff9e\uff9e\uff9e', '\u{1d165}\u0301']) {
    const original = `${'x'.repeat(1022)}a${marks}\n${'Z'.repeat(128)}`;
    await invocation.mounted.writeFile('/workspace/file', original);
    const admitted = new EditExecutionEnv(invocation, [replacement], { ...EDIT_BUDGET, maxCombiningWork: 9 });
    assert.equal((await admitted.readTextFile('/workspace/file', context)).ok, true);
    await admitted.cleanup(context);
    const rejected = new EditExecutionEnv(invocation, [replacement], { ...EDIT_BUDGET, maxCombiningWork: 8 });
    await assert.rejects(rejected.readTextFile('/workspace/file', context), /aggregate Unicode combining work budget/);
    await rejected.cleanup(context);
    assert.equal(await invocation.mounted.readFile('/workspace/file'), original);
  }
});

test('combining work is weighted by edit count and summed across patterns', async (t) => {
  const invocation = await workspace(t);
  const original = `a\u0301\u0316b\u0301\u0316\n${'Z'.repeat(128)}`;
  await invocation.mounted.writeFile('/workspace/file', original);
  const replacement = { oldText: 'Z'.repeat(128), newText: 'Y'.repeat(128) };
  const limits = { ...EDIT_BUDGET, maxCombiningWork: 12 };
  const admitted = new EditExecutionEnv(invocation, [replacement], limits);
  assert.equal((await admitted.readTextFile('/workspace/file', context)).ok, true);
  await admitted.cleanup(context);
  const repeated = new EditExecutionEnv(invocation, [replacement, replacement], limits);
  await assert.rejects(repeated.readTextFile('/workspace/file', context), /aggregate Unicode combining work budget/);
  await repeated.cleanup(context);
  const patterns = new EditExecutionEnv(invocation,
    [{ oldText: 'a\u0301\u0316', newText: 'one' }, { oldText: 'b\u0301\u0316', newText: 'two' }],
    { ...limits, maxCombiningWork: 7 });
  await assert.rejects(patterns.readTextFile('/workspace/missing', context), /aggregate Unicode combining work budget/);
  await patterns.cleanup(context);
  assert.equal(await invocation.mounted.readFile('/workspace/file'), original);
});

test('many legal combining runs reject before any full-string normalization and retain original bytes', async (t) => {
  const invocation = await workspace(t);
  const run = `a${'\u0315\u0300'.repeat(32)}`;
  const original = `${run.repeat(Math.floor(EDIT_BUDGET.maxCombiningWork / 64 ** 2) + 1)}\n${'Z'.repeat(128)}`;
  await invocation.mounted.writeFile('/workspace/file', original);
  const normalize = String.prototype.normalize;
  let maximumNormalizedLength = 0;
  String.prototype.normalize = function (form) {
    maximumNormalizedLength = Math.max(maximumNormalizedLength, this.length);
    return normalize.call(this, form);
  };
  const env = new EditExecutionEnv(invocation, [{ oldText: 'Z'.repeat(128), newText: 'Y'.repeat(128) }]);
  try {
    assert.equal(maximumNormalizedLength, 0, 'constructor does not normalize');
    await assert.rejects(env.readTextFile('/workspace/file', context), /aggregate Unicode combining work budget/);
    assert.ok(maximumNormalizedLength <= 2, 'only individual Unicode scalars were normalized before rejection');
  } finally {
    String.prototype.normalize = normalize;
    await env.cleanup(context);
  }
  assert.equal(await invocation.mounted.readFile('/workspace/file'), original);
});

test('large multibyte batches also charge source UTF-8 bytes to matching work', async (t) => {
  const invocation = await workspace(t);
  const original = `${'漢'.repeat(100)}\n${'Z'.repeat(128)}`;
  await invocation.mounted.writeFile('/workspace/file', original);
  const replacement = { oldText: 'Z'.repeat(128), newText: 'Y'.repeat(128) };
  const limits = { ...EDIT_BUDGET, maxMatchUnits: 700 };
  assert.ok(original.normalize('NFKD').length * 2 < limits.maxMatchUnits);
  assert.ok(new TextEncoder().encode(original).length * 2 > limits.maxMatchUnits);
  const admitted = new EditExecutionEnv(invocation, [replacement], limits);
  assert.equal((await admitted.readTextFile('/workspace/file', context)).ok, true);
  await admitted.cleanup(context);
  const rejected = new EditExecutionEnv(invocation, [replacement, replacement], limits);
  await assert.rejects(rejected.readTextFile('/workspace/file', context), /normalization and matching work budget/);
  await rejected.cleanup(context);
  assert.equal(await invocation.mounted.readFile('/workspace/file'), original);
});
