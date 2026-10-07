import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { BACKGROUND_CONTEXT } from '@earendil-works/chord/context';
import { createEnvConformance } from '@earendil-works/pi-durable/testing';
import { installBashBrowserHooks } from './helpers/bash-browser-hooks.mjs';
import { nodeWorkspaces } from './helpers/node-workspaces.mjs';

const hooks = installBashBrowserHooks();
test.after(() => hooks.deregister());
const { WorkspaceExecutionEnv } = await import('../src/pi/workspace/execution-env.ts');

const assertions = {
  ok: assert.ok, strictEqual: assert.strictEqual, deepEqual: assert.deepStrictEqual,
  partialDeepEqual: assert.partialDeepStrictEqual,
  greaterThan: (actual, expected) => assert.ok(actual > expected),
  rejects: (operation, messageIncludes) => assert.rejects(operation, (error) => error.message.includes(messageIncludes)),
};
let next = 0;
async function withEnv(use) {
  const directory = await mkdtemp(join(tmpdir(), 'pi-workspace-conformance-'));
  const id = `conformance-${++next}`;
  try { await use(new WorkspaceExecutionEnv(nodeWorkspaces(directory).workspace(id), id)); }
  finally { await rm(directory, { recursive: true, force: true }); }
}
// pi-durable's own cases. The shell's `ln -s` cannot create links in the workspace, so the symlink cases are off.
const cases = createEnvConformance({ assertions, withEnv, shell: ['sh', '-c'], symlinks: false });
for (const entry of cases) {
  // The workspace cannot watch files; one check below covers that instead of each watch case.
  const skip = entry.name.startsWith('watch ') ? 'The workspace reports watch as not supported.' : false;
  test(`upstream: ${entry.name}`, { timeout: entry.timeoutMs, skip }, entry.run);
}

test('watch reports not supported', async () => {
  await withEnv(async (env) => {
    const watcher = await env.watch([{ path: '.' }], () => {}, BACKGROUND_CONTEXT);
    assert.equal(watcher.ok, false);
    assert.equal(watcher.error.code, 'not_supported');
  });
});
