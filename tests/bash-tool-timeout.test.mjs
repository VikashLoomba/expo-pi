import assert from 'node:assert/strict';
import test from 'node:test';
import { BACKGROUND_CONTEXT, withAbortSignal } from '@earendil-works/chord/context';
import { installBashBrowserHooks } from './helpers/bash-browser-hooks.mjs';
import { createNodeSqliteConnection } from './helpers/node-sqlite.mjs';

const hooks = installBashBrowserHooks();
test.after(() => hooks.deregister());
const { createExpoSqliteDatabase } = await import('../src/pi/storage/expo-sqlite.ts');
const { WorkspaceRuntime } = await import('../src/pi/workspace/runtime.ts');
const { createWorkspaceExecutionEnv, acquireWorkspaceExecutionScope } = await import('../src/pi/workspace/execution-env.ts');
const { presentOutput, BashOutput } = await import('../src/pi/bash/output.ts');
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const runBash = async (manager, id, signal, execute) => {
  const env = createWorkspaceExecutionEnv(manager, id);
  const scope = await acquireWorkspaceExecutionScope(env, signal ? withAbortSignal(signal, BACKGROUND_CONTEXT) : BACKGROUND_CONTEXT);
  try { return await execute(scope.env, scope.context); }
  finally { await scope.release(); }
};
function value(result) { assert.equal(result.ok, true, result.error?.message); return result.value; }

function runtime(t) {
  const manager = new WorkspaceRuntime(async () => createExpoSqliteDatabase(createNodeSqliteConnection()));
  t.after(() => manager.close());
  return manager;
}

test('a local deadline returns a typed timeout after sealing command writes and preserving earlier mutations', async (t) => {
  const manager = runtime(t);
  await runBash(manager, 'deadline', undefined, async (env, context) => {
    // Allow interpreter setup and the initial SQLite commit under the full parallel suite.
    // The two-second sleep still puts the forbidden write well beyond the real deadline.
    const result = await env.exec('printf admitted > before; sleep 2; printf forbidden > after', { timeout: 0.5 }, context);
    assert.equal(result.error.code, 'timeout');
    assert.match(result.error.message, /Output produced before interruption may be unavailable/);
  });
  await runBash(manager, 'deadline', undefined, async (env, context) => {
    assert.equal(value(await env.readTextFile('before', context)), 'admitted');
    assert.equal(value(await env.exists('after', context)), false);
  });
});

test('caller cancellation wins at the scope boundary even when the command deadline already expired', async (t) => {
  const manager = runtime(t);
  const controller = new AbortController();
  const reason = new Error('explicit user cancellation');
  await assert.rejects(runBash(manager, 'cancel', controller.signal, async (env, context) => {
    assert.equal((await env.exec('sleep 0.1', { timeout: 0.005 }, context)).error.code, 'timeout');
    controller.abort(reason);
    return 'must not be returned';
  }), (error) => error === reason);
});

test('owner shutdown overrides a handled command timeout and prevents subsequent writes', async (t) => {
  const manager = runtime(t);
  await assert.rejects(runBash(manager, 'closing', undefined, async (env, context) => {
    assert.equal((await env.exec('sleep 0.1', { timeout: 0.005 }, context)).error.code, 'timeout');
    manager.stop();
    assert.equal((await env.writeFile('late', 'forbidden', context)).error.code, 'aborted');
    return { exitCode: 124 };
  }), /Chat runtime closed during workspace execution/);
});

test('ending execution removes its deadline while presentation remains cancellable', async (t) => {
  const manager = runtime(t);
  await runBash(manager, 'format', undefined, async (env, context) => {
    value(await env.exec('printf done', { timeout: 0.5 }, context));
    await delay(550);
    assert.equal(context.abortSignal.aborted, false, 'completed command does not time out during presentation');
    value(await env.writeFile('spill', 'formatted output', context));
  });
  const reason = new Error('cancel during presentation');
  const controller = new AbortController();
  await assert.rejects(runBash(manager, 'format', controller.signal, async (env, context) => {
    value(await env.exec('printf done', { timeout: 1 }, context));
    controller.abort(reason);
    assert.equal(context.abortSignal.reason, reason);
    assert.equal((await env.writeFile('late', 'forbidden', context)).error.code, 'aborted');
  }), (error) => error === reason);
});

test('expired output preserves bounded text and status without admitting spill filesystem operations', async () => {
  const forbiddenArtifacts = new Proxy({}, { get() { throw new Error('Expired invocation touched filesystem'); } });
  const output = new BashOutput(false);
  output.stdout.append('🌍'.repeat(20_000));
  output.stderr.append('Timed out; files may have changed.');
  const result = await presentOutput(output, 124, BACKGROUND_CONTEXT, forbiddenArtifacts, { allowSpill: false });
  assert.equal(result.details.exitCode, 124);
  assert.equal(result.details.truncated, true);
  assert.equal(result.details.outputFiles, undefined);
  assert.match(result.text, /no additional output files/);
  assert.match(result.text, /files may have changed/);
  assert.doesNotMatch(result.text, /�/);
  assert.ok(new TextEncoder().encode(result.text).length < 30 * 1024);
});
