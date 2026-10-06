import assert from 'node:assert/strict';
import test from 'node:test';
import { integrationDatabase, toolReply, until } from './helpers/bash-integration.mjs';
import { installBashBrowserHooks } from './helpers/bash-browser-hooks.mjs';
import { scriptedModels } from './helpers/scripted-models.mjs';
import { independentExecution, TestExecutionDoc } from './helpers/independent-env.mjs';

const hooks = installBashBrowserHooks();
test.after(() => hooks.deregister());
const { DurableChatService } = await import('../src/pi/chat-service.ts');
const { ChatRuntime } = await import('../src/chat/chat-runtime.ts');

test('runtime cancellation drain does not hold unrelated chat admission and backgrounding still drains', { timeout: 15_000 }, async (t) => {
  const file = await integrationDatabase(t, DurableChatService);
  const independent = await independentExecution(file.directory);
  independent.behavior.holdCancelledDrain = true;
  const provider = scriptedModels([
    toolReply('bash', { command: 'fixture:wait' }),
    toolReply('bash', { command: 'printf RUNTIME_LOCAL_PROGRESS' }), { chunks: ['Done.'] }, { chunks: ['Retried.'] },
  ]);
  const runtime = new ChatRuntime({ models: provider.models, platform: 'ios',
    openStorage: file.openStorage, openWorkspaceDatabase: file.openWorkspaceDatabase,
    execution: independent.decorate });
  t.after(async () => { independent.releaseDrain(); await runtime.deactivate(); });
  await runtime.activate();
  const external = await runtime.createChat();
  const local = await runtime.createChat();
  await runtime.service.configureExecution(external, { cwd: independent.root }, async (tx, id) => {
    (await tx.doc(TestExecutionDoc, id)).kind = 'independent';
  });
  await runtime.send(external, 'Wait for cancellation.');
  await until(() => independent.metrics.active === 1, 'independent exec started');
  const cancelling = runtime.cancel(external);
  cancelling.catch(() => {});
  let background;
  let retry;
  let settings;
  try {
    await until(() => independent.metrics.aborted === 1, 'cancellation reached environment');
    retry = runtime.send(external, 'Retry after the environment drains.');
    // Attach the rejection handler before deliberately closing its owning service.
    retry.catch(() => {});
    settings = runtime.updateSettings(external, runtime.getConversation(external).settings);
    settings.catch(() => {});
    const sent = runtime.send(local, 'Run the local chat.');
    await Promise.race([sent, new Promise((_, reject) => setTimeout(() => reject(new Error('Runtime lifecycle queue held by environment drain.')), 1500))]);
    await until(() => runtime.getConversation(local)?.messages.some((row) => row.tool?.output.includes('RUNTIME_LOCAL_PROGRESS')), 'local execution completed while external drain held');
    assert.equal(independent.metrics.active, 1);
    let backgroundDone = false;
    background = runtime.deactivate().then(() => { backgroundDone = true; });
    await new Promise((resolve) => setTimeout(resolve, 30));
    assert.equal(backgroundDone, false, 'background shutdown awaits admitted external work');
    assert.equal(runtime.getSnapshot().ready, false, 'backgrounding stops new admission immediately');
    await assert.rejects(runtime.send(local, 'No admission after backgrounding.'), /Return to the app/);
  } finally {
    independent.releaseDrain();
    await cancelling.catch((error) => { assert.match(String(error), /closed/); });
    await retry?.catch((error) => { assert.match(String(error), /closed|Return to the app|not active/i); });
    await settings?.catch((error) => { assert.match(String(error), /closed/); });
    await background;
  }
});
