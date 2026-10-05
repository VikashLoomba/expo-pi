import assert from 'node:assert/strict';
import test from 'node:test';
import { installBashBrowserHooks } from './helpers/bash-browser-hooks.mjs';
import { createNodeSqliteConnection } from './helpers/node-sqlite.mjs';

const hooks = installBashBrowserHooks();
test.after(() => hooks.deregister());
const { createExpoSqliteDatabase } = await import('../src/pi/storage/expo-sqlite.ts');
const { WorkspaceRuntime } = await import('../src/pi/workspace/runtime.ts');
const { withBashDeadline } = await import('../src/pi/bash/execution.ts');
const { presentOutput } = await import('../src/pi/bash/output.ts');
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const runBash = (manager, id, signal, timeoutMs, execute) =>
  manager.run(id, signal, (invocation) => withBashDeadline(invocation, timeoutMs, execute));

function runtime(t) {
  const manager = new WorkspaceRuntime(async () => createExpoSqliteDatabase(createNodeSqliteConnection()));
  t.after(() => manager.close());
  return manager;
}

test('a local deadline may return its bounded result after sealing and draining filesystem writes', async (t) => {
  const manager = runtime(t);
  const result = await runBash(manager, 'deadline', undefined, 15, async ({ files, signal, finishExecution }) => {
    await files.writeFile('/before', 'admitted');
    await delay(25);
    assert.equal(signal.aborted, true);
    assert.equal(finishExecution(), true);
    await assert.rejects(files.writeFile('/after', 'forbidden'), /timed out/);
    return { exitCode: 124, stdout: 'retained result', stderr: 'may have changed files' };
  });
  assert.equal(result.exitCode, 124);
  await runBash(manager, 'deadline', undefined, 100, async ({ files, finishExecution }) => {
    assert.equal(await files.readFile('/before'), 'admitted');
    assert.equal(await files.exists('/after'), false);
    finishExecution();
  });
});

test('caller cancellation wins even when the local deadline already expired', async (t) => {
  const manager = runtime(t);
  const controller = new AbortController();
  const reason = new Error('explicit user cancellation');
  await assert.rejects(runBash(manager, 'cancel', controller.signal, 5, async ({ finishExecution }) => {
    await delay(15);
    assert.equal(finishExecution(), true);
    controller.abort(reason);
    return 'must not be returned';
  }), (error) => error === reason);
});

test('an unfinished local deadline propagates and shutdown overrides a handled timeout', async (t) => {
  const manager = runtime(t);
  await assert.rejects(runBash(manager, 'unfinished', undefined, 5, async () => {
    await delay(15);
    return 'deadline was not handled';
  }), /Bash timed out/);
  await assert.rejects(runBash(manager, 'closing', undefined, 5, async ({ finishExecution }) => {
    await delay(15);
    assert.equal(finishExecution(), true);
    manager.stop();
    return { exitCode: 124 };
  }), /Chat runtime closed during workspace execution/);
});

test('ending execution removes its deadline while presentation remains cancellable', async (t) => {
  const manager = runtime(t);
  await runBash(manager, 'format', undefined, 20, async ({ files, signal, finishExecution }) => {
    assert.equal(finishExecution(), false);
    await delay(35);
    assert.equal(signal.aborted, false, 'a completed command does not time out during presentation');
    await files.writeFile('/spill', 'formatted output');
  });
  const reason = new Error('cancel during presentation');
  const controller = new AbortController();
  await assert.rejects(runBash(manager, 'format', controller.signal, 100, async ({ signal, finishExecution }) => {
    finishExecution();
    controller.abort(reason);
    assert.equal(signal.reason, reason);
  }), (error) => error === reason);
});

test('expired output preserves bounded text and status without admitting spill filesystem operations', async () => {
  const forbiddenFilesystem = new Proxy({}, { get() { throw new Error('Expired invocation touched filesystem'); } });
  const result = await presentOutput(forbiddenFilesystem, {
    stdout: '🌍'.repeat(20_000), stderr: 'Timed out; files may have changed.', exitCode: 124,
  }, { allowSpill: false });
  assert.equal(result.details.exitCode, 124);
  assert.equal(result.details.truncated, true);
  assert.equal(result.details.outputFiles, undefined);
  assert.match(result.text, /no additional output files/);
  assert.match(result.text, /files may have changed/);
  assert.doesNotMatch(result.text, /�/);
  assert.ok(new TextEncoder().encode(result.text).length < 30 * 1024);
});
