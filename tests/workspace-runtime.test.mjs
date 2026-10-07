import assert from 'node:assert/strict';
import test from 'node:test';
import { installBashBrowserHooks } from './helpers/bash-browser-hooks.mjs';
import { createNodeSqliteConnection } from './helpers/node-sqlite.mjs';

const hooks = installBashBrowserHooks();
test.after(() => hooks.deregister());
const { createExpoSqliteDatabase } = await import('../src/pi/storage/expo-sqlite.ts');
const { WorkspaceRuntime } = await import('../src/pi/workspace/runtime.ts');

const { BACKGROUND_CONTEXT, withAbortSignal } = await import('@earendil-works/chord/context');
const { createWorkspaceExecutionEnv, acquireWorkspaceExecutionScope } = await import('../src/pi/workspace/execution-env.ts');
const context = BACKGROUND_CONTEXT;
function value(result) { assert.equal(result.ok, true, result.error?.message); return result.value; }


function runtime(t) {
  const manager = new WorkspaceRuntime(async () => createExpoSqliteDatabase(createNodeSqliteConnection()));
  t.after(() => manager.close());
  return manager;
}

test('a generic invocation seals its persistent and temporary files after returning', async (t) => {
  const manager = runtime(t);
  let previous;
  await manager.run('seal', undefined, async (invocation) => {
    previous = invocation;
    await invocation.files.writeFile('/saved', 'persistent');
    await invocation.mounted.writeFile('/tmp/temporary', 'temporary');
  });
  await assert.rejects(previous.files.writeFile('/late', 'forbidden'), /invocation has ended/);
  await assert.rejects(previous.mounted.writeFile('/tmp/late', 'forbidden'), /invocation has ended/);
  await manager.run('seal', undefined, async ({ files, mounted }) => {
    assert.equal(await files.readFile('/saved'), 'persistent');
    assert.equal(await files.exists('/late'), false);
    assert.equal(await mounted.readFile('/tmp/temporary'), 'temporary');
    assert.equal(await mounted.exists('/tmp/late'), false);
  });
});

test('local cancellation seals writes while its owner can return an explicit result', async (t) => {
  const manager = runtime(t);
  const reason = new Error('local operation limit');
  const result = await manager.run('local', undefined, async ({ files, abort, signal }) => {
    await files.writeFile('/saved', 'before');
    abort(reason);
    assert.equal(signal.reason, reason);
    await assert.rejects(files.writeFile('/late', 'forbidden'), (error) => error === reason);
    return { interrupted: true };
  });
  assert.deepEqual(result, { interrupted: true });
  await assert.rejects(manager.run('local', undefined, async ({ abort, signal }) => {
    abort(reason);
    signal.throwIfAborted();
  }), (error) => error === reason);
});

test('caller cancellation rejects queued work before execution and releases the queue', async (t) => {
  const manager = runtime(t);
  let release;
  let started;
  const admitted = new Promise((resolve) => { started = resolve; });
  const holding = manager.run('queued', undefined, async () => {
    started();
    await new Promise((resolve) => { release = resolve; });
  });
  await admitted;
  const controller = new AbortController();
  let executed = false;
  const queued = manager.run('queued', controller.signal, async () => { executed = true; });
  const reason = new Error('cancel queued operation');
  controller.abort(reason);
  const rejected = assert.rejects(queued, (error) => error === reason);
  release();
  await holding;
  await rejected;
  assert.equal(executed, false);
  assert.equal(await manager.run('queued', undefined, async () => 'next'), 'next');
});


test('metadata-only local environment resolution acquires no execution resources', async () => {
  let opens = 0;
  const manager = new WorkspaceRuntime(async () => { opens++; throw new Error('must stay lazy'); });
  const env = createWorkspaceExecutionEnv(manager, 'metadata', '/workspace/project');
  assert.equal(env.cwd, '/workspace/project');
  assert.equal(value(await env.absolutePath('notes', context)), '/workspace/project/notes');
  assert.equal(value(await env.joinPath(['one', '..', 'two'], context)), 'two');
  await manager.close();
  assert.equal(opens, 0);
  assert.equal((await env.writeFile('late', 'forbidden', context)).error.code, 'aborted');
  assert.equal(opens, 0);
});

test('direct methods, cwd views and successive tool scopes share one temporary namespace', async (t) => {
  const manager = runtime(t);
  const env = createWorkspaceExecutionEnv(manager, 'retained');
  const temp = value(await env.createTempFile(undefined, context));
  value(await env.writeFile(temp, 'direct state', context));
  assert.equal(value(await env.readTextFile(temp, context)), 'direct state');
  const reader = value(await env.openBinaryReader(temp, undefined, context));
  const scope = await acquireWorkspaceExecutionScope(env, context);
  assert.equal(scope.env.id, env.id);
  assert.equal(value(await scope.env.readTextFile(temp, scope.context)), 'direct state');
  value(await scope.env.writeFile(temp, 'updated by tool', scope.context));
  value(await scope.env.writeFile('/tmp/tool-only', 'one tool', scope.context));
  await scope.release();
  assert.equal(value(await env.readTextFile(temp, context)), 'updated by tool');
  assert.equal(new TextDecoder().decode(value(await reader.read(0, 100, context))), 'updated by tool');
  await reader.close(context);
  const next = await acquireWorkspaceExecutionScope(env, context);
  assert.equal(value(await next.env.readTextFile('/tmp/tool-only', next.context)), 'one tool');
  await next.release();
  const otherCwd = createWorkspaceExecutionEnv(manager, 'retained', '/workspace/project');
  assert.equal(otherCwd.id, env.id);
  assert.equal(value(await otherCwd.readTextFile(temp, context)), 'updated by tool');
  value(await otherCwd.writeFile('/tmp/from-other-cwd', 'same namespace', context));
  assert.equal(value(await env.readTextFile('/tmp/from-other-cwd', context)), 'same namespace');
  await env.cleanup(context);
  assert.equal((await env.readTextFile(temp, context)).error.code, 'aborted');
  assert.equal(value(await otherCwd.readTextFile(temp, context)), 'updated by tool');
});

test('temporary namespaces are isolated between workspaces and runtime owners', async (t) => {
  const manager = runtime(t);
  const first = createWorkspaceExecutionEnv(manager, 'first');
  const second = createWorkspaceExecutionEnv(manager, 'second');
  const anotherOwner = createWorkspaceExecutionEnv(runtime(t), 'first');
  assert.notEqual(first.id, second.id);
  assert.notEqual(first.id, anotherOwner.id);
  value(await first.writeFile('/tmp/same-name', 'first workspace', context));
  assert.equal(value(await second.exists('/tmp/same-name', context)), false);
  assert.equal(value(await anotherOwner.exists('/tmp/same-name', context)), false);
  value(await second.writeFile('/tmp/same-name', 'second workspace', context));
  assert.equal(value(await first.readTextFile('/tmp/same-name', context)), 'first workspace');
});

test('the temporary byte limit is shared across tool scopes and released by removal', async (t) => {
  const env = createWorkspaceExecutionEnv(runtime(t), 'temporary-quota');
  const first = await env.acquire(context);
  value(await first.env.writeFile('/tmp/retained', new Uint8Array(3 * 1024 * 1024), first.context));
  await first.release();
  const second = await env.acquire(context);
  const rejected = await second.env.writeFile('/tmp/over-budget', new Uint8Array(2 * 1024 * 1024), second.context);
  assert.equal(rejected.ok, false);
  assert.match(rejected.error.message, /memory|storage|limit/i);
  value(await second.env.remove('/tmp/retained', undefined, second.context));
  value(await second.env.writeFile('/tmp/over-budget', new Uint8Array(2 * 1024 * 1024), second.context));
  await second.release();
  assert.equal(value(await env.fileInfo('/tmp/over-budget', context)).size, 2 * 1024 * 1024);
});

test('whole-tool scope excludes other workspace work and exec reuses the lease', async (t) => {
  const manager = runtime(t);
  const env = createWorkspaceExecutionEnv(manager, 'atomic');
  value(await env.writeFile('counter', 'initial', context));
  const scope = await acquireWorkspaceExecutionScope(env, context);
  let entered = false;
  const later = manager.run('atomic', undefined, async ({ files }) => { entered = true; return files.readFile('/counter'); });
  const output = [];
  value(await scope.env.exec('printf edited > counter; cat counter', { onOutput: (text) => output.push(text) }, scope.context));
  assert.deepEqual(output, ['edited']);
  assert.equal(entered, false);
  await scope.release();
  assert.equal(await later, 'edited');
});

test('reader calls take short leases and follow in-place edits and renamed original files', async (t) => {
  const manager = runtime(t);
  const env = createWorkspaceExecutionEnv(manager, 'readers');
  for (const base of ['/workspace', '/tmp']) {
    const path = `${base}/original`;
    value(await env.writeFile(path, 'initial', context));
    const reader = value(await env.openBinaryReader(path, undefined, context));
    value(await env.writeFile(path, 'updated content', context));
    assert.equal(new TextDecoder().decode(value(await reader.read(0, 100, context))), 'updated content');
    assert.equal(value(await reader.info(context)).size, 15);
    value(await env.renameFile(path, `${base}/renamed`, context));
    value(await env.writeFile(path, 'replacement', context));
    value(await env.appendFile(`${base}/renamed`, '!', context));
    assert.equal(new TextDecoder().decode(value(await reader.read(0, 100, context))), 'updated content!');
    assert.equal(value(await reader.info(context)).size, 16);
    // A still-open reader cannot monopolize the workspace queue.
    await manager.run('readers', undefined, async ({ files }) => { await files.writeFile('/another', 'proceeded'); });
    await reader.close(context);
    await reader.close(context);
    assert.equal((await reader.read(0, 1, context)).error.code, 'invalid');
  }
});

test('owner shutdown closes active direct readers and drains commands without late mutation', async (t) => {
  const manager = runtime(t);
  const env = createWorkspaceExecutionEnv(manager, 'shutdown');
  value(await env.writeFile('saved', 'data', context));
  const reader = value(await env.openBinaryReader('saved', undefined, context));
  const running = env.exec('sleep 1; printf forbidden > late', undefined, context);
  await new Promise((resolve) => setTimeout(resolve, 20));
  await manager.close();
  assert.equal((await running).error.code, 'aborted');
  assert.equal((await reader.read(0, 1, context)).error.code, 'aborted');
  await env.cleanup(context);
  await env.cleanup(context);
});

test('scope boundary preserves caller cancellation identity and awaits release', async (t) => {
  const manager = runtime(t);
  const env = createWorkspaceExecutionEnv(manager, 'scope-cancel');
  const controller = new AbortController();
  const scope = await acquireWorkspaceExecutionScope(env, withAbortSignal(controller.signal, context));
  const reason = Object.assign(new Error('ENOENT: caller cancellation'), { code: 'ENOENT' });
  controller.abort(reason);
  assert.equal((await scope.env.writeFile('late', 'forbidden', scope.context)).error.code, 'aborted');
  await assert.rejects(scope.release(), (error) => error === reason);
  assert.equal(value(await env.exists('late', context)), false);
});

test('cleanup of one direct consumer does not stop another environment', async (t) => {
  const manager = runtime(t);
  const one = createWorkspaceExecutionEnv(manager, 'shared');
  const two = createWorkspaceExecutionEnv(manager, 'shared');
  value(await one.writeFile('saved', 'shared persistent file', context));
  const first = value(await one.createTempFile(undefined, context));
  await one.cleanup(context);
  assert.equal(value(await two.readTextFile('saved', context)), 'shared persistent file');
  assert.equal(value(await two.exists(first, context)), true);
  assert.equal(value(await two.exec(['printf', '%s', 'still alive'], undefined, context)).exitCode, 0);
});

test('shell cwd/env, stream identity and spill file follow the direct environment lifetime', async (t) => {
  const manager = runtime(t);
  const env = createWorkspaceExecutionEnv(manager, 'shell-options');
  value(await env.createDir('project', undefined, context));
  const chunks = [];
  const executed = value(await env.exec('printf "%s:%s" "$VALUE" "$HOME"; printf err >&2; pwd', {
    cwd: 'project', env: { VALUE: 'literal $value' }, inheritEnv: false,
    spill: { afterBytes: 1, afterLines: 1 },
    onOutput: (text, _context, info) => chunks.push([info.stream, text, info.skipped]),
  }, context));
  assert.deepEqual(chunks, [['stdout', 'literal $value:/workspace/project\n', undefined], ['stderr', 'err', undefined]]);
  assert.equal(value(await env.readTextFile(executed.spillPath, context)), 'literal $value:/workspace/project\nerr');
  assert.equal(value(await env.exec('exit 7', undefined, context)).exitCode, 7);
  const callbackError = await env.exec('printf value', { onOutput: () => { throw new Error('callback failed'); } }, context);
  assert.equal(callbackError.error.code, 'callback_error');
});

test('the stock read tool pages persistent content through bounded SQL ranges', async (t) => {
  const ranges = [];
  const fullBodies = [];
  const database = createExpoSqliteDatabase(createNodeSqliteConnection());
  const instrumented = {
    ...database,
    transaction: (execute) => database.transaction((sql) => execute({
      ...sql,
      get: async (query, ...parameters) => {
        if (/SELECT data FROM inodes/.test(query)) fullBodies.push(query);
        if (/substr\(data,\?,\?\)/.test(query)) ranges.push(parameters[1]);
        return sql.get(query, ...parameters);
      },
    })),
  };
  const manager = new WorkspaceRuntime(async () => instrumented);
  t.after(() => manager.close());
  const env = createWorkspaceExecutionEnv(manager, 'bounded-read');
  value(await env.writeFile('large.txt', Array.from({ length: 30_000 }, (_, n) => `line-${n}`).join('\n'), context));
  const { createReadTool } = await import('@earendil-works/pi-durable/tools');
  const result = await createReadTool().execute({ path: 'large.txt', offset: 20_001, limit: 2 }, { env, outputWindow: undefined }, context);
  assert.match(result.content[0].text, /line-20000\nline-20001/);
  assert.equal(fullBodies.length, 0);
  assert.ok(ranges.length > 2, 'header, line scan, and selected range were read independently');
  assert.ok(ranges.every((length) => length <= 65536), 'no SQL read materializes the whole file');
});

test('a failed temporary removal does not freeze an open reader into a stale snapshot', async (t) => {
  const manager = runtime(t);
  const env = createWorkspaceExecutionEnv(manager, 'failed-temp-remove');
  value(await env.writeFile('/tmp/dir/file', 'before', context));
  const reader = value(await env.openBinaryReader('/tmp/dir/file', undefined, context));
  assert.equal((await env.remove('/tmp/dir', undefined, context)).ok, false);
  value(await env.writeFile('/tmp/dir/file', 'after', context));
  assert.equal(new TextDecoder().decode(value(await reader.read(0, 100, context))), 'after');
  value(await env.remove('/tmp/dir/file', undefined, context));
  value(await env.writeFile('/tmp/dir/file', 'replacement', context));
  assert.equal(new TextDecoder().decode(value(await reader.read(0, 100, context))), 'after');
  await reader.close(context);
});

test('persistent opened readers retain their inode through atomic replacement, hard links and final unlink', async (t) => {
  const database = createExpoSqliteDatabase(createNodeSqliteConnection());
  const manager = new WorkspaceRuntime(async () => database);
  t.after(() => manager.close());
  const env = createWorkspaceExecutionEnv(manager, 'inode-retention');
  value(await env.writeFile('old', 'original', context));
  const reader = value(await env.openBinaryReader('old', undefined, context));
  const secondReader = value(await env.openBinaryReader('old', undefined, context));
  value(await env.exec(['ln', 'old', 'alias'], undefined, context));
  value(await env.writeFile('new', 'replacement', context));
  value(await env.renameFile('new', 'old', context));
  assert.equal(value(await env.readTextFile('old', context)), 'replacement');
  assert.equal(new TextDecoder().decode(value(await reader.read(0, 100, context))), 'original');
  value(await env.appendFile('alias', '!', context));
  assert.equal(value(await reader.info(context)).size, 9);
  assert.equal(new TextDecoder().decode(value(await reader.read(0, 100, context))), 'original!');
  value(await env.remove('alias', undefined, context));
  assert.equal(value(await reader.info(context)).size, 9);
  assert.equal(new TextDecoder().decode(value(await reader.read(0, 100, context))), 'original!');
  const usage = () => database.get('SELECT bytes,inode_count FROM workspaces WHERE id=?', 'inode-retention');
  assert.equal((await usage()).bytes, 20, 'unlinked open bytes remain counted against quotas');
  const { WorkspaceFileSystem } = await import('../src/pi/workspace/filesystem/index.ts');
  await WorkspaceFileSystem.copyWorkspace(database, 'inode-retention', 'inode-copy');
  assert.equal((await database.get('SELECT bytes FROM workspaces WHERE id=?', 'inode-copy')).bytes, 11,
    'copying a workspace does not clone files owned only by open handles');
  await reader.close(context);
  assert.equal((await usage()).bytes, 20, 'another open handle still owns the inode');
  await secondReader.close(context);
  await secondReader.close(context);
  assert.equal((await usage()).bytes, 11, 'the final close reclaims only the unlinked inode');
  assert.equal((await usage()).inode_count, 2, 'root plus replacement remain');
  assert.equal(value(await env.readTextFile('old', context)), 'replacement');
});

test('cleanup drains inode release before owner close and reopen preserves only named files', async (t) => {
  const { mkdtemp, rm } = await import('node:fs/promises');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const directory = await mkdtemp(join(tmpdir(), 'pi-open-inodes-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const filename = join(directory, 'workspace.sqlite');
  let database = createExpoSqliteDatabase(createNodeSqliteConnection(filename));
  let manager = new WorkspaceRuntime(async () => database);
  let env = createWorkspaceExecutionEnv(manager, 'inode-reopen');
  value(await env.writeFile('removed', 'opened bytes', context));
  value(await env.writeFile('kept', 'persistent', context));
  const reader = value(await env.openBinaryReader('removed', undefined, context));
  value(await env.remove('removed', undefined, context));
  assert.equal(value(await reader.info(context)).size, 12);
  // Independent close may be in progress when the environment/owner closes.
  const closingReader = reader.close(context);
  await manager.close();
  await closingReader;
  database = createExpoSqliteDatabase(createNodeSqliteConnection(filename));
  manager = new WorkspaceRuntime(async () => database);
  t.after(() => manager.close());
  env = createWorkspaceExecutionEnv(manager, 'inode-reopen');
  assert.equal(value(await env.readTextFile('kept', context)), 'persistent');
  assert.equal(value(await env.exists('removed', context)), false);
  const usage = await database.get('SELECT bytes,inode_count FROM workspaces WHERE id=?', 'inode-reopen');
  assert.deepEqual({ ...usage }, { bytes: 10, inode_count: 2 });
});

test('environment cleanup awaits an independently closing reader whose inode release is still admitted', async (t) => {
  const native = createNodeSqliteConnection();
  const originalRun = native.runAsync;
  let holdRelease = false;
  let admitted;
  let release;
  const entered = new Promise((resolve) => { admitted = resolve; });
  const gate = new Promise((resolve) => { release = resolve; });
  native.runAsync = async (query, parameters) => {
    if (holdRelease && query.startsWith('DELETE FROM inodes')) { admitted(); await gate; }
    return originalRun(query, parameters);
  };
  const manager = new WorkspaceRuntime(async () => createExpoSqliteDatabase(native));
  t.after(async () => { release(); await manager.close(); });
  const env = createWorkspaceExecutionEnv(manager, 'closing-reader');
  value(await env.writeFile('opened', 'bytes', context));
  const reader = value(await env.openBinaryReader('opened', undefined, context));
  value(await env.remove('opened', undefined, context));
  holdRelease = true;
  const closingReader = reader.close(context);
  await entered;
  let cleaned = false;
  const cleanup = env.cleanup(context).then(() => { cleaned = true; });
  await new Promise((resolve) => setTimeout(resolve, 10));
  assert.equal(cleaned, false, 'cleanup must wait for the already-started reader close');
  release();
  await closingReader;
  await cleanup;
  assert.equal(cleaned, true);
});

test('facade cleanup cancels queued scope acquisition and awaits its queue settlement', async (t) => {
  const manager = runtime(t);
  const env = createWorkspaceExecutionEnv(manager, 'queued-scope-cleanup');
  let entered;
  let unblock;
  const ready = new Promise((resolve) => { entered = resolve; });
  const gate = new Promise((resolve) => { unblock = resolve; });
  t.after(() => unblock());
  const blocking = manager.run('queued-scope-cleanup', undefined, async () => { entered(); await gate; });
  await ready;
  const acquiring = env.acquire(context);
  const rejected = assert.rejects(acquiring, /environment is closed/);
  let cleaned = false;
  const cleanup = env.cleanup(context).then(() => { cleaned = true; });
  await new Promise((resolve) => setTimeout(resolve, 10));
  assert.equal(cleaned, false, 'cleanup must await the admitted queued acquisition');
  unblock();
  await blocking;
  await rejected;
  await cleanup;
  assert.equal((await env.writeFile('late', 'forbidden', context)).error.code, 'aborted');
  await manager.run('queued-scope-cleanup', undefined, async ({ files }) => {
    assert.equal(await files.exists('/late'), false);
    await files.writeFile('/next', 'queue released');
  });
});

test('facade cleanup seals delivered scopes and drains their commands before returning', async (t) => {
  const manager = runtime(t);
  const env = createWorkspaceExecutionEnv(manager, 'active-scope-cleanup');
  const scope = await env.acquire(context);
  const running = scope.env.exec('sleep 1; printf forbidden > late', undefined, scope.context);
  await new Promise((resolve) => setTimeout(resolve, 10));
  await env.cleanup(context);
  assert.equal((await running).error.code, 'aborted');
  assert.equal((await scope.env.writeFile('after-cleanup', 'forbidden', scope.context)).error.code, 'aborted');
  await assert.rejects(scope.release(), /environment is closed/);
  await manager.run('active-scope-cleanup', undefined, async ({ files }) => {
    assert.equal(await files.exists('/late'), false);
    assert.equal(await files.exists('/after-cleanup'), false);
  });
});

test('cancellation after scope admission but before delivery releases the lease and preserves the reason', async (t) => {
  const manager = runtime(t);
  const env = createWorkspaceExecutionEnv(manager, 'scope-delivery-cancel');
  const controller = new AbortController();
  const reason = new Error('cancel after runtime admission');
  const acquire = manager.acquire.bind(manager);
  manager.acquire = async (...args) => {
    const lease = await acquire(...args);
    controller.abort(reason);
    return lease;
  };
  await assert.rejects(env.acquire(withAbortSignal(controller.signal, context)), (error) => error === reason);
  manager.acquire = acquire;
  const next = await env.acquire(context);
  value(await next.env.writeFile('next', 'admitted after canceled acquisition', next.context));
  await next.release();
});

test('canceled binary-reader allocations release every inode pin and reader slot before returning', async (t) => {
  const database = createExpoSqliteDatabase(createNodeSqliteConnection());
  const manager = new WorkspaceRuntime(async () => database);
  t.after(() => manager.close());
  const env = createWorkspaceExecutionEnv(manager, 'cancel-reader-allocation');
  value(await env.writeFile('opened', 'original', context));
  const { WorkspaceFileSystem } = await import('../src/pi/workspace/filesystem/index.ts');
  const retain = WorkspaceFileSystem.prototype.retainOpenedInode;
  let controller;
  WorkspaceFileSystem.prototype.retainOpenedInode = async function (...args) {
    const release = await retain.apply(this, args);
    controller.abort(new Error('cancel after inode retention'));
    return release;
  };
  try {
    for (let attempt = 0; attempt < 64; attempt++) {
      controller = new AbortController();
      assert.equal((await env.openBinaryReader('opened', undefined, withAbortSignal(controller.signal, context))).error.code, 'aborted');
    }
  } finally { WorkspaceFileSystem.prototype.retainOpenedInode = retain; }
  const reader = value(await env.openBinaryReader('opened', undefined, context));
  await reader.close(context);
  value(await env.remove('opened', undefined, context));
  const usage = await database.get('SELECT bytes,inode_count FROM workspaces WHERE id=?', 'cancel-reader-allocation');
  assert.deepEqual({ ...usage }, { bytes: 0, inode_count: 1 }, 'no canceled opener retains its unlinked inode');
});

test('reader delivery rollback covers directory handles and binary handles after lease completion', async (t) => {
  const manager = runtime(t);
  const env = createWorkspaceExecutionEnv(manager, 'cancel-reader-delivery');
  value(await env.writeFile('opened', 'bytes', context));
  const run = manager.run.bind(manager);
  for (const kind of ['binary', 'directory']) {
    let controller;
    manager.run = (id, signal, work, ...rest) => run(id, signal, async (invocation) => {
      const result = await work(invocation);
      controller.abort(new Error('cancel after reader allocation and before lease delivery'));
      return result;
    }, ...rest);
    try {
      for (let attempt = 0; attempt < 64; attempt++) {
        controller = new AbortController();
        const readContext = withAbortSignal(controller.signal, context);
        const result = kind === 'binary' ? await env.openBinaryReader('opened', undefined, readContext) : await env.openDirReader('.', readContext);
        assert.equal(result.error.code, 'aborted');
      }
    } finally { manager.run = run; }
    const reader = value(kind === 'binary' ? await env.openBinaryReader('opened', undefined, context) : await env.openDirReader('.', context));
    await reader.close(context);
  }
});

test('text-reader delivery cancellation closes the binary handle it had already acquired', async (t) => {
  const manager = runtime(t);
  const env = createWorkspaceExecutionEnv(manager, 'cancel-text-reader');
  value(await env.writeFile('opened', 'first\nsecond', context));
  const openBinary = env.openBinaryReader.bind(env);
  let controller;
  env.openBinaryReader = async (...args) => {
    const opened = await openBinary(...args);
    controller.abort(new Error('cancel between binary and text-reader delivery'));
    return opened;
  };
  try {
    for (let attempt = 0; attempt < 64; attempt++) {
      controller = new AbortController();
      assert.equal((await env.openTextLineReader('opened', withAbortSignal(controller.signal, context))).error.code, 'aborted');
    }
  } finally { env.openBinaryReader = openBinary; }
  const reader = value(await env.openTextLineReader('opened', context));
  assert.deepEqual(value(await reader.readLine(context)), { text: 'first', terminated: true });
  await reader.close(context);
});

test('aborted temporary-reader allocation closes its backing handle before returning', async (t) => {
  const manager = runtime(t);
  const env = createWorkspaceExecutionEnv(manager, 'cancel-temp-reader');
  value(await env.writeFile('/tmp/opened', 'bytes', context));
  const { BoundedSystemFs } = await import('../src/pi/workspace/bounded-system-fs.ts');
  const open = BoundedSystemFs.prototype.openReadHandle;
  let controller;
  let closed = 0;
  BoundedSystemFs.prototype.openReadHandle = async function (...args) {
    const handle = await open.apply(this, args);
    controller.abort(new Error('cancel after temporary reader allocation'));
    return { ...handle, close: async () => { closed++; await handle.close(); } };
  };
  try {
    for (let attempt = 0; attempt < 64; attempt++) {
      controller = new AbortController();
      assert.equal((await env.openBinaryReader('/tmp/opened', undefined, withAbortSignal(controller.signal, context))).error.code, 'aborted');
      assert.equal(closed, attempt + 1, 'backing handles are rolled back before each open settles');
    }
  } finally { BoundedSystemFs.prototype.openReadHandle = open; }
  const reader = value(await env.openBinaryReader('/tmp/opened', undefined, context));
  await reader.close(context);
});

for (const shutdown of ['facade', 'runtime']) for (const queuedKind of ['scope', 'direct write']) {
  test(`${shutdown} cleanup releases its held scope while draining a queued ${queuedKind}`, async () => {
    const database = createExpoSqliteDatabase(createNodeSqliteConnection());
    const manager = new WorkspaceRuntime(async () => database);
    const workspaceId = `owned-scope-drain-${shutdown}-${queuedKind}`;
    const env = createWorkspaceExecutionEnv(manager, workspaceId);
    const first = await env.acquire(context);
    value(await first.env.writeFile('before', 'retained', first.context));
    const queued = queuedKind === 'scope'
      ? env.acquire(context).then(() => assert.fail('a canceled acquisition must not deliver a scope'), (error) => error)
      : env.writeFile('late', 'forbidden', context);
    let timer;
    try {
      const cleaning = shutdown === 'facade' ? env.cleanup(context) : manager.close();
      await Promise.race([
        cleaning,
        new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('cleanup is waiting for a scope it still owns')), 1000); }),
      ]);
      const result = await queued;
      if (queuedKind === 'scope') assert.match(result.message, /closed/);
      else assert.equal(result.error.code, 'aborted');
      assert.equal((await first.env.writeFile('after-cleanup', 'forbidden', first.context)).error.code, 'aborted');
      if (shutdown === 'facade') {
        await manager.run(workspaceId, undefined, async ({ files }) => {
          assert.equal(await files.readFile('/before'), 'retained');
          assert.equal(await files.exists('/late'), false);
          assert.equal(await files.exists('/after-cleanup'), false);
        });
      }
    } finally {
      clearTimeout(timer);
      // A regression still releases the deliberately held lease, so the test
      // reports its assertion failure instead of hanging the entire runner.
      await first.release().catch(() => {});
      await queued;
      await manager.close();
    }
  });
}
