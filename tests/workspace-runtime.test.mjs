import assert from 'node:assert/strict';
import test from 'node:test';
import { installBashBrowserHooks } from './helpers/bash-browser-hooks.mjs';
import { createNodeSqliteConnection } from './helpers/node-sqlite.mjs';

const hooks = installBashBrowserHooks();
test.after(() => hooks.deregister());
const { createExpoSqliteDatabase } = await import('../src/pi/storage/expo-sqlite.ts');
const { WorkspaceRuntime } = await import('../src/pi/workspace/runtime.ts');

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
    assert.equal(await mounted.exists('/tmp/temporary'), false);
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
