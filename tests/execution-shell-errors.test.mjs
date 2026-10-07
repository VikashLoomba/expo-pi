import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { BACKGROUND_CONTEXT } from '@earendil-works/chord/context';
import { installBashBrowserHooks } from './helpers/bash-browser-hooks.mjs';
import { nodeWorkspaces } from './helpers/node-workspaces.mjs';

const hooks = installBashBrowserHooks();
test.after(() => hooks.deregister());
const { WorkspaceExecutionEnv } = await import('../src/pi/workspace/execution-env.ts');
const context = BACKGROUND_CONTEXT;
const command = 'printf once >> marker';

test('commands that cannot start fail with typed errors before running anything', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'pi-shell-errors-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const env = new WorkspaceExecutionEnv(nodeWorkspaces(root).workspace('errors'), 'errors');
  for (const [program, options, code] of [
    [[], undefined, 'spawn_error'],
    [['not-a-supported-program'], undefined, 'spawn_error'],
    [command, { cwd: '/workspace/missing' }, 'spawn_error'],
    [command, { timeout: 0 }, 'timeout'],
  ]) {
    const result = await env.exec(program, options, context);
    assert.equal(result.ok, false);
    assert.equal(result.error.code, code, JSON.stringify(program));
  }
  const marker = await env.exists('marker', context);
  assert.equal(marker.ok && marker.value, false);
});

test('an output callback failure is reported as a callback error after the command ran', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'pi-shell-errors-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const env = new WorkspaceExecutionEnv(nodeWorkspaces(root).workspace('errors'), 'errors');
  const result = await env.exec(`${command}; printf out`, {
    onOutput() { throw new Error('consumer failed'); },
  }, context);
  assert.equal(result.ok, false);
  assert.equal(result.error.code, 'callback_error');
  const marker = await env.readTextFile('marker', context);
  assert.equal(marker.ok && marker.value, 'once');
});
