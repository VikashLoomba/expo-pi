import assert from 'node:assert/strict';
import test from 'node:test';
import { BACKGROUND_CONTEXT } from '@earendil-works/chord/context';
import { AgentDoc, defineExtension, defineTask } from '@earendil-works/pi-durable';
import { integrationDatabase, until } from './helpers/bash-integration.mjs';
import { installBashBrowserHooks } from './helpers/bash-browser-hooks.mjs';
import { scriptedModels } from './helpers/scripted-models.mjs';
const hooks = installBashBrowserHooks();
test.after(() => hooks.deregister());
const { DurableChatService } = await import('../src/pi/chat-service.ts');
const { ExecutionTargetDoc } = await import('../src/pi/execution/document.ts');
const context = BACKGROUND_CONTEXT;
const local = { target: { kind: 'local' }, cwd: '/workspace' };
const remote = { target: { kind: 'ssh', machineId: 'mac' }, cwd: '/Users/test/project' };

test('committed execution choice and cwd project atomically, reopen, rewind on fork and inherit in owned chats', async (t) => {
  const Owned = defineTask({ name: 'test.selection-owned', version: 1, initial: () => ({ phase: 'run' }), phases: {
    async run(task, runtime, ctx) {
      await runtime.commit(async (tx) => {
        const child = await tx.createConversation({ ownership: { kind: 'task', taskId: task.id } });
        return { status: 'running', checkpoint: { phase: 'finish', id: child.id } };
      }, ctx);
    },
    async finish(task, runtime, ctx) { await runtime.commit(() => ({ status: 'terminal', outcome: { status: 'completed', result: { id: task.state.checkpoint.id } } }), ctx); },
  }, async abort(_task, runtime, ctx) { await runtime.commit(() => ({ status: 'terminal', outcome: { status: 'aborted' } }), ctx); } });
  const file = await integrationDatabase(t, DurableChatService);
  const options = { execution: (execution) => ({ ...execution, extensions: [defineExtension({ name: 'test.selection', tasks: [Owned] })] }) };
  const service = await file.open(scriptedModels([]).models, options);
  const id = await service.createChat();
  assert.deepEqual(service.getConversation(id).execution, local);
  const parent = await service.harness.conversation(Number(id), context);
  const before = await parent.commit((tx) => tx.appendEntry(parent.id, { kind: 'test.local', data: {} }), context);
  const observed = [];
  const unsubscribe = service.subscribe(() => observed.push(structuredClone(service.getConversation(id).execution)));
  await service.updateExecution(id, remote);
  await until(() => service.getConversation(id).execution.target.kind === 'ssh', 'committed projection');
  const after = await parent.commit((tx) => tx.appendEntry(parent.id, { kind: 'test.remote', data: {} }), context);
  unsubscribe();
  assert.ok(observed.length);
  assert.ok(observed.every((value) => JSON.stringify(value) === JSON.stringify(local) || JSON.stringify(value) === JSON.stringify(remote)), 'no torn target/cwd projection');
  const historical = await parent.fork(before.id, { ownership: { kind: 'ownerless' } }, context);
  const current = await parent.fork(after.id, { ownership: { kind: 'ownerless' } }, context);
  await until(() => service.getConversation(String(current.id))?.execution.cwd === remote.cwd, 'fork hydration');
  assert.deepEqual(service.getConversation(String(historical.id)).execution, local);
  assert.deepEqual(service.getConversation(String(current.id)).execution, remote);
  const taskId = await parent.commit((tx) => tx.createTask(Owned, {}, { ownership: { kind: 'conversation' } }), context);
  await service.resume();
  const owned = (await service.harness.waitForTask(taskId, context)).state.outcome;
  assert.equal(owned.status, 'completed');
  assert.deepEqual(await service.harness.snapshot(ExecutionTargetDoc, owned.result.id, context), remote.target);
  assert.equal((await service.harness.snapshot(AgentDoc, owned.result.id, context)).cwd, remote.cwd);
  await file.close(service);
  const reopened = await file.open(scriptedModels([]).models, options);
  assert.deepEqual(reopened.getConversation(id).execution, remote);
  assert.deepEqual(reopened.getConversation(String(historical.id)).execution, local);
  await reopened.updateExecution(id, local);
  assert.deepEqual(await reopened.harness.snapshot(ExecutionTargetDoc, Number(id), context), local.target, 'switching local removes machineId');
  assert.equal(file.metrics.opened, 0, 'configuration never opens a filesystem');
});

test('invalid selection/cwd leaves both committed values unchanged', async (t) => {
  const file = await integrationDatabase(t, DurableChatService);
  const service = await file.open(scriptedModels([]).models);
  const id = await service.createChat();
  for (const selection of [{ ...remote, cwd: 'relative' }, { target: { kind: 'ssh', machineId: '' }, cwd: '/' }, { ...local, cwd: '/tmp' }, { ...local, cwd: '/workspace/../outside' }]) {
    await assert.rejects(async () => service.updateExecution(id, selection));
    assert.deepEqual(service.getConversation(id).execution, local);
  }
});
