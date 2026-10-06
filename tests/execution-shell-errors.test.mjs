import assert from 'node:assert/strict';
import test from 'node:test';
import { BACKGROUND_CONTEXT } from '@earendil-works/chord/context';
import { createBashTool, createPowerShellTool } from '@earendil-works/pi-durable/tools';
import { installBashBrowserHooks } from './helpers/bash-browser-hooks.mjs';
import { createNodeSqliteConnection } from './helpers/node-sqlite.mjs';

const hooks = installBashBrowserHooks();
test.after(() => hooks.deregister());
const { createExpoSqliteDatabase } = await import('../src/pi/storage/expo-sqlite.ts');
const { WorkspaceRuntime } = await import('../src/pi/workspace/runtime.ts');
const { createWorkspaceExecutionEnv } = await import('../src/pi/workspace/execution-env.ts');
const context = BACKGROUND_CONTEXT;
const command = "printf once >> marker; printf '%1048576s' x";
function value(result) { assert.equal(result.ok, true, result.error?.message); return result.value; }

async function environment(t) {
  const runtime = new WorkspaceRuntime(async () => createExpoSqliteDatabase(createNodeSqliteConnection()));
  const env = createWorkspaceExecutionEnv(runtime, 'spill-failure');
  t.after(() => runtime.close());
  value(await env.writeFile('/tmp/fill', new Uint8Array(3500 * 1024), context));
  return env;
}

test('spill storage failure after execution reports a completed command and leaves no incomplete artifact', async (t) => {
  const env = await environment(t);
  let outputBytes = 0;
  const result = await env.exec(command, {
    spill: { afterBytes: 1, afterLines: 1 },
    onOutput(text) { outputBytes += Buffer.byteLength(text); },
  }, context);
  assert.equal(result.ok, false);
  assert.equal(result.error.code, 'unknown');
  assert.match(result.error.message, /completed with exit code 0.*output could not be preserved.*ENOSPC/);
  assert.equal(result.error.spillPath, undefined);
  assert.equal(outputBytes, 1024 * 1024);
  assert.equal(value(await env.readTextFile('marker', context)), 'once');
  assert.equal(value(await env.listDir('/tmp', context)).some(({ name }) => name.startsWith('bash-')), false);
});

test('stock bash retains streamed output and reports spill failure without claiming a launch failure', async (t) => {
  const env = await environment(t);
  let received = 0;
  const diagnostics = [];
  await assert.rejects(createBashTool().execute({ command }, {
    env, output(text) { received += Buffer.byteLength(text); }, diagnostic(value) { diagnostics.push(value); },
  }, context), (error) => error.code === 'unknown' && /completed with exit code 0/.test(error.message));
  assert.equal(received, 1024 * 1024);
  assert.deepEqual(diagnostics, [], 'an incomplete spill is never advertised as full output');
  assert.equal(value(await env.readTextFile('marker', context)), 'once');
});

test('stock alternate-command fallback never retries after a command completed but could not spill', async (t) => {
  const env = await environment(t);
  const attempted = [];
  // Adapt the stock multi-form tool to this local shell so its public fallback
  // decision is tested with a real completed mutation and a real storage error.
  const selected = {
    cwd: env.cwd,
    async exec(form, options, current) {
      attempted.push(form[0]);
      return env.exec(command, options, current);
    },
  };
  await assert.rejects(createPowerShellTool({ programs: ['first', 'fallback'] }).execute({ command }, {
    env: selected, output() {}, diagnostic() {},
  }, context), (error) => error.code === 'unknown');
  assert.deepEqual(attempted, ['first']);
  assert.equal(value(await env.readTextFile('marker', context)), 'once');
});

test('actual command admission failures retain spawn_error and do not execute a mutation', async (t) => {
  const env = await environment(t);
  for (const [program, options] of [
    [[], undefined], [['not-a-supported-program'], undefined],
    [command, { cwd: '/workspace/missing' }], [command, { timeout: 0 }],
  ]) {
    const result = await env.exec(program, options, context);
    assert.equal(result.ok, false);
    assert.equal(result.error.code, 'spawn_error');
  }
  assert.equal(value(await env.exists('marker', context)), false);
});
