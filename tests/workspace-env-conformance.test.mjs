import assert from 'node:assert/strict';
import test from 'node:test';
import { BACKGROUND_CONTEXT } from '@earendil-works/chord/context';
import { createEnvConformance } from '@earendil-works/pi-durable/testing';
import { installBashBrowserHooks } from './helpers/bash-browser-hooks.mjs';
import { createNodeSqliteConnection } from './helpers/node-sqlite.mjs';

const hooks = installBashBrowserHooks();
test.after(() => hooks.deregister());
const { createExpoSqliteDatabase } = await import('../src/pi/storage/expo-sqlite.ts');
const { WorkspaceRuntime } = await import('../src/pi/workspace/runtime.ts');
const { createWorkspaceExecutionEnv } = await import('../src/pi/workspace/execution-env.ts');
const assertions = {
  ok: assert.ok, strictEqual: assert.strictEqual, deepEqual: assert.deepStrictEqual,
  partialDeepEqual: assert.partialDeepStrictEqual,
  greaterThan: (actual, expected) => assert.ok(actual > expected),
  rejects: (operation, messageIncludes) => assert.rejects(operation, (error) => error.message.includes(messageIncludes)),
};
let nextWorkspace = 0;
const cases = createEnvConformance({
  assertions,
  // These are the engine's actual supported shell/symlink capabilities.
  shell: ['sh', '-c'], symlinks: true,
  withEnv: async (use) => {
    const runtime = new WorkspaceRuntime(async () => createExpoSqliteDatabase(createNodeSqliteConnection()));
    const env = createWorkspaceExecutionEnv(runtime, `conformance-${++nextWorkspace}`);
    try { await use(env); }
    finally { await env.cleanup(BACKGROUND_CONTEXT); await runtime.close(); }
  },
});
for (const entry of cases) {
  if (entry.name.startsWith('watch ')) {
    // Execute every upstream case. The first watch request must truthfully fail
    // with the documented capability error; no unrelated failure is accepted.
    test(`upstream limitation: ${entry.name}`, { timeout: entry.timeoutMs }, async (t) => {
      await assert.rejects(entry.run(), (error) => error.code === 'not_supported'
        && error.message === 'The local virtual filesystem does not provide reliable change notifications.');
      t.diagnostic('Unsupported upstream watch case; not counted as full environment conformance.');
    });
  } else {
    test(`upstream: ${entry.name}`, { timeout: entry.timeoutMs }, entry.run);
  }
}
