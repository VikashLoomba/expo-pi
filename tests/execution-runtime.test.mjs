import assert from 'node:assert/strict';
import test from 'node:test';
import { integrationDatabase, toolReply, until } from './helpers/bash-integration.mjs';
import { installBashBrowserHooks } from './helpers/bash-browser-hooks.mjs';
import { readChat } from './helpers/chat-view.mjs';
import { scriptedModels } from './helpers/scripted-models.mjs';
import { independentExecution, TestExecutionDoc } from './helpers/independent-env.mjs';

const hooks = installBashBrowserHooks();
test.after(() => hooks.deregister());
const { DurableChatService } = await import('../src/pi/chat-service.ts');
const { ChatRuntime } = await import('../src/chat/chat-runtime.ts');

test('a draining cancellation does not hold another chat, and closing the app waits for admitted work', { timeout: 15_000 }, async (t) => {
  const file = await integrationDatabase(t, DurableChatService);
  const independent = await independentExecution(file.directory);
  independent.behavior.holdCancelledDrain = true;
  const provider = scriptedModels([
    toolReply('bash', { command: 'fixture:wait' }),
    toolReply('bash', { command: 'printf RUNTIME_LOCAL_PROGRESS' }), { chunks: ['Done.'] },
  ]);
  const runtime = new ChatRuntime({ models: provider.models,
    openStorage: file.openStorage, workspaces: file.workspaces,
    execution: independent.decorate });
  t.after(async () => { independent.releaseDrain(); await runtime.close(); });
  await runtime.open();
  const external = await runtime.createChat();
  const local = await runtime.createChat();
  await runtime.service.configureExecution(external, { cwd: independent.root }, async (tx, id) => {
    (await tx.doc(TestExecutionDoc, id)).kind = 'independent';
  });
  await runtime.send(external, 'Wait for cancellation.');
  await until(() => independent.metrics.active === 1, 'independent exec started');
  const cancelling = runtime.cancel(external);
  cancelling.catch(() => {});
  let closing;
  try {
    await until(() => independent.metrics.aborted === 1, 'cancellation reached environment');
    // The stopping chat stays busy until its environment drains.
    await assert.rejects(runtime.send(external, 'Retry before the environment drains.'), /busy/);
    const settings = (await readChat(runtime, external)).settings;
    await assert.rejects(runtime.updateSettings(external, settings), /pending response/);
    const sent = runtime.send(local, 'Run the local chat.');
    await Promise.race([sent, new Promise((_, reject) => setTimeout(() => reject(new Error('Local admission waited for an environment drain.')), 1500))]);
    await until(async () => (await readChat(runtime, local)).messages.some((row) => row.tool?.output.includes('RUNTIME_LOCAL_PROGRESS')),
      'local execution completed while external drain held');
    assert.equal(independent.metrics.active, 1);
    let closed = false;
    closing = runtime.close().then(() => { closed = true; });
    await new Promise((resolve) => setTimeout(resolve, 30));
    assert.equal(closed, false, 'closing awaits admitted external work');
    assert.equal(runtime.getSnapshot().ready, false, 'closing stops new admission immediately');
    await assert.rejects(runtime.send(local, 'No admission while closing.'), /opening/);
  } finally {
    independent.releaseDrain();
    await cancelling.catch((error) => { assert.match(String(error), /closed/); });
    await closing;
  }
});
