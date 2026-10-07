import assert from 'node:assert/strict';
import test from 'node:test';
import { BACKGROUND_CONTEXT } from '@earendil-works/chord/context';
import { createEnvConformance } from '@earendil-works/pi-durable/testing';
import { installBashBrowserHooks } from './helpers/bash-browser-hooks.mjs';
import { remoteDaemonFixture, remoteDaemonPath } from './helpers/remote-daemon.mjs';

const hooks = installBashBrowserHooks();
test.after(() => hooks.deregister());
const { Connection } = await import('../src/pi/execution/remote/connection.ts');
const { MobileRemoteExecutionEnv } = await import('../src/pi/execution/remote/environment.ts');
const available = await remoteDaemonPath();
const assertions = {
  ok: assert.ok, strictEqual: assert.strictEqual, deepEqual: assert.deepStrictEqual,
  partialDeepEqual: assert.partialDeepStrictEqual,
  greaterThan: (actual, expected) => assert.ok(actual > expected),
  rejects: (operation, messageIncludes) => assert.rejects(operation, (error) => error.message.includes(messageIncludes)),
};
const cases = createEnvConformance({
  assertions, shell: ['sh', '-c'], symlinks: true,
  withEnv: async (use) => {
    const cleanup = [];
    const fixture = await remoteDaemonFixture({ after: (fn) => cleanup.push(fn) });
    const connection = new Connection({ openChannel: fixture.openChannel });
    const env = new MobileRemoteExecutionEnv({ connection, id: 'conformance-mac', cwd: fixture.directory });
    try { await use(env); }
    finally {
      await env.cleanup(BACKGROUND_CONTEXT);
      for (const close of cleanup) await close();
    }
  },
});
for (const entry of cases) {
  test(`remote Pi conformance: ${entry.name}`, {
    timeout: entry.timeoutMs,
    skip: available ? false : 'Install the documented external Pi Env 1.0.4 daemon, or set PI_ENV_DAEMON.',
  }, entry.run);
}
