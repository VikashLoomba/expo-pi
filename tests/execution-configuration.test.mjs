import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import test from 'node:test';
import { BACKGROUND_CONTEXT } from '@earendil-works/chord/context';
import { AgentDoc, defineExtension, defineTask, LiveDoc } from '@earendil-works/pi-durable';
import { getOrThrow } from '@earendil-works/pi-durable/env';
import { integrationDatabase, until } from './helpers/bash-integration.mjs';
import { installBashBrowserHooks } from './helpers/bash-browser-hooks.mjs';
import { independentExecution, TestExecutionDoc } from './helpers/independent-env.mjs';
import { scriptedModels } from './helpers/scripted-models.mjs';

const hooks = installBashBrowserHooks();
test.after(() => hooks.deregister());
const { DurableChatService } = await import('../src/pi/chat-service.ts');
const context = BACKGROUND_CONTEXT;

for (const scenario of [
  { name: 'running custom task', background: false, abort: false },
  { name: 'background custom task with cancellation still draining', background: true, abort: true },
]) test(`execution selection rejects a ${scenario.name} until its acquired env settles`, { timeout: 15_000 }, async (t) => {
  const started = Promise.withResolvers();
  const release = Promise.withResolvers();
  const Task = defineTask({
    name: 'test.execution-configuration-task', version: 1, initial: () => ({ phase: 'run' }),
    phases: {
      async run(_task, runtime, ctx) {
        const env = await runtime.env(ctx);
        if (!env) throw new Error('Missing selected environment.');
        started.resolve();
        await release.promise;
        ctx.abortSignal?.throwIfAborted();
        getOrThrow(await env.writeFile('before-switch', 'old target finished before switching', ctx));
        await runtime.commit(() => ({ status: 'terminal', outcome: { status: 'completed', result: {} } }), ctx);
      },
    },
    async abort(_task, runtime, ctx) {
      await runtime.commit(() => ({ status: 'terminal', outcome: { status: 'aborted' } }), ctx);
    },
  });
  const file = await integrationDatabase(t, DurableChatService);
  const independent = await independentExecution(file.directory);
  const service = await file.open(scriptedModels([]).models, { execution(local) {
    const composition = independent.decorate(local);
    return { ...composition, extensions: [...composition.extensions,
      defineExtension({ name: 'test.execution-configuration', tasks: [Task] })] };
  } });
  const id = await service.createChat();
  await service.configureExecution(id, { cwd: independent.root }, async (tx, cid) => {
    (await tx.doc(TestExecutionDoc, cid)).kind = 'independent';
  });
  const taskId = await service.harness.commit((tx) => tx.createTask(Task, {}, {
    conversationId: Number(id), ownership: { kind: 'conversation' }, background: scenario.background,
  }), context);
  let updates = 0;
  const switchTarget = () => service.configureExecution(id, { cwd: '/workspace' }, async (tx, cid) => {
    updates++;
    (await tx.doc(TestExecutionDoc, cid)).kind = 'local';
  });
  const unchanged = async () => {
    assert.equal((await service.harness.snapshot(AgentDoc, Number(id), context)).cwd, independent.root);
    assert.equal((await service.harness.snapshot(TestExecutionDoc, Number(id), context)).kind, 'independent');
    assert.equal(updates, 0, 'rejection precedes any application configuration callback');
  };
  let aborting;
  try {
    // The task is live as soon as its commit lands, whether or not it has started running.
    await assert.rejects(switchTarget(), /Wait for execution to stop/);
    await unchanged();
    await started.promise;
    assert.deepEqual(await service.harness.snapshot(LiveDoc, Number(id), context), {},
      'custom tasks are absent from the agent run/compaction projection');
    await assert.rejects(switchTarget(), /Wait for execution to stop/);
    await unchanged();
    if (scenario.abort) {
      aborting = service.harness.abortTask(taskId, context);
      await until(async () => (await service.harness.getTask(taskId, context)).abortRequested,
        'custom task cancellation intent is durably committed');
      assert.notEqual((await service.harness.getTask(taskId, context)).state.status, 'terminal');
      await assert.rejects(switchTarget(), /Wait for execution to stop/);
      await unchanged();
    }
  } finally {
    release.resolve();
    await aborting;
  }
  const settled = await service.harness.waitForTask(taskId, context);
  assert.equal(settled.state.outcome.status, scenario.abort ? 'aborted' : 'completed');
  assert.equal(independent.metrics.cleaned, 0, 'a completed task does not close its borrowed environment');
  if (scenario.abort) await assert.rejects(readFile(join(independent.root, 'before-switch')), { code: 'ENOENT' });
  else assert.equal(await readFile(join(independent.root, 'before-switch'), 'utf8'), 'old target finished before switching');
  await switchTarget();
  assert.equal(updates, 1, 'terminal task receipts do not permanently prevent configuration');
  assert.equal((await service.harness.snapshot(AgentDoc, Number(id), context)).cwd, '/workspace');
  assert.equal((await service.harness.snapshot(TestExecutionDoc, Number(id), context)).kind, 'local');
  await file.close(service);
  assert.ok(independent.metrics.cleaned > 0, 'service shutdown closes the environment owner');
});
