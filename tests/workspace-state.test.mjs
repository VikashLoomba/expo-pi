import assert from 'node:assert/strict';
import test from 'node:test';
import { BACKGROUND_CONTEXT } from '@earendil-works/chord/context';
import { getCurrentTools } from '@earendil-works/pi-ai/utils/transcript';
import { AgentDoc, configure, defineDoc, defineExtension, defineTask } from '@earendil-works/pi-durable';
import { readChat } from './helpers/chat-view.mjs';
import { additionTool, scriptedModels } from './helpers/scripted-models.mjs';
import { integrationDatabase, toolReply } from './helpers/bash-integration.mjs';
import { installBashBrowserHooks } from './helpers/bash-browser-hooks.mjs';

const hooks = installBashBrowserHooks();
test.after(() => hooks.deregister());
const { DurableChatService } = await import('../src/pi/chat-service.ts');
const { WorkspaceDoc } = await import('../src/pi/workspace/document.ts');
const context = BACKGROUND_CONTEXT;
const answer = { chunks: ['Done.'] };
const sharedTools = ['bash', 'read', 'write', 'edit'];

async function run(service, id) {
  const submission = await service.send(id, 'Inspect the workspace.');
  assert.equal((await service.waitForSubmission(submission)).status, 'done');
  return (await readChat(service, id)).messages.filter((message) => message.tool).at(-1);
}

function offeredTools(request) {
  return getCurrentTools(request.context.messages).map(({ name }) => name).sort();
}

test('fresh chats use Pi registry defaults without storing redundant capability selections', async (t) => {
  const file = await integrationDatabase(t, DurableChatService);
  const provider = scriptedModels([answer]);
  const service = await file.open(provider.models, { extensions: [additionTool] });
  const id = await service.createChat();
  const agent = await service.harness.snapshot(AgentDoc, Number(id), context);
  assert.equal(agent.extensions, undefined);
  assert.equal(agent.tools, undefined);
  const workspace = await file.workspace(service, id, WorkspaceDoc);
  assert.ok(workspace.id);
  assert.deepEqual(workspace, { id: workspace.id, origin: 'new' });
  await run(service, id);
  assert.deepEqual(offeredTools(provider.requests[0]), ['add_numbers', ...sharedTools].sort());
});

for (const selection of [
  { name: 'exact tool selection', settings: { extensions: ['test-addition', 'local-bash'], tools: ['add_numbers', 'read'] }, expected: ['add_numbers', 'read'] },
  { name: 'tool exclusions', settings: { extensions: { remove: ['unrelated-extension'] }, tools: { remove: ['write', 'edit', 'add_numbers'] } }, expected: ['bash', 'read'] },
  { name: 'extension exclusion', settings: { extensions: { remove: ['local-bash'] }, tools: { remove: [] } }, expected: ['add_numbers'] },
]) test(`reopening retains current workspace identity, settings and ${selection.name}`, { timeout: 15_000 }, async (t) => {
  const file = await integrationDatabase(t, DurableChatService);
  const initial = await file.open(scriptedModels([]).models, { extensions: [additionTool] });
  const id = await initial.createChat();
  const workspace = await file.workspace(initial, id, WorkspaceDoc);
  const parent = await initial.harness.conversation(Number(id), context);
  await parent.commit(async (tx) => {
    await configure(tx, parent.id, { instructions: 'A deliberate selection.', cwd: '/workspace/current' });
    Object.assign(await tx.doc(AgentDoc, parent.id), selection.settings);
  }, context);
  const agent = await initial.harness.snapshot(AgentDoc, parent.id, context);
  await file.close(initial);
  for (let attempt = 0; attempt < 2; attempt++) {
    const provider = scriptedModels([answer]);
    const service = await file.open(provider.models, { extensions: [additionTool] });
    assert.deepEqual(await file.workspace(service, id, WorkspaceDoc), workspace);
    assert.deepEqual(await service.harness.snapshot(AgentDoc, parent.id, context), agent);
    await run(service, id);
    assert.deepEqual(offeredTools(provider.requests[0]), [...selection.expected].sort());
    await file.close(service);
  }
});

test('service-created historical forks start with empty workspaces while parent bytes survive reopening', { timeout: 15_000 }, async (t) => {
  const file = await integrationDatabase(t, DurableChatService);
  const first = await file.open(scriptedModels([toolReply('write', { path: 'parent-file', content: 'parent bytes' }), answer]).models);
  const parentId = await first.createChat();
  await run(first, parentId);
  const parentWorkspace = await file.workspace(first, parentId, WorkspaceDoc);
  const parent = await first.harness.conversation(Number(parentId), context);
  const entries = await parent.entries({}, 100, undefined, context);
  const child = await parent.fork(entries.items.at(-1).id, { ownership: { kind: 'ownerless' } }, context);
  const childWorkspace = await first.harness.snapshot(WorkspaceDoc, child.id, context);
  assert.notEqual(childWorkspace.id, parentWorkspace.id);
  assert.equal(childWorkspace.origin, 'fork');
  await file.close(first);
  const provider = scriptedModels([
    toolReply('read', { path: 'parent-file' }), answer,
    toolReply('read', { path: 'parent-file' }), answer,
  ]);
  const service = await file.open(provider.models);
  const fork = await run(service, child.id);
  assert.equal(fork.tool.status, 'error');
  assert.match(fork.tool.output, /ENOENT/);
  assert.match(JSON.stringify(provider.requests[0].context.messages.filter(({ role }) => role === 'system')), /fork.*empty|inherited.*NOT copied/i);
  assert.equal((await run(service, parentId)).tool.output, 'parent bytes');
  assert.deepEqual(await file.workspace(service, parentId, WorkspaceDoc), parentWorkspace);
  assert.deepEqual(await file.workspace(service, child.id, WorkspaceDoc), childWorkspace);
});

test('Pi preserves historical fork settings and task-owned inheritance while each workspace starts fresh', { timeout: 15_000 }, async (t) => {
  const file = await integrationDatabase(t, DurableChatService);
  const Owned = defineTask({
    name: 'test.workspace-owned-conversation', version: 1, initial: () => ({ phase: 'create' }),
    phases: {
      async create(task, runtime, ctx) {
        await runtime.commit(async (tx) => {
          const child = await tx.createConversation({ ownership: { kind: 'task', taskId: task.id } });
          return { status: 'running', checkpoint: { phase: 'finish', id: child.id } };
        }, ctx);
      },
      async finish(task, runtime, ctx) {
        await runtime.commit(() => ({ status: 'terminal', outcome: { status: 'completed', result: { id: task.state.checkpoint.id } } }), ctx);
      },
    },
    async abort(_task, runtime, ctx) { await runtime.commit(() => ({ status: 'terminal', outcome: { status: 'aborted' } }), ctx); },
  });
  const extension = defineExtension({ name: 'test.workspace-owned', tasks: [Owned] });
  const provider = scriptedModels([answer, answer]);
  const service = await file.open(provider.models, {
    execution: (local) => ({ ...local, extensions: [extension] }), extensions: [additionTool],
  });
  const id = await service.createChat();
  const parent = await service.harness.conversation(Number(id), context);
  const before = await parent.commit(async (tx) => {
    await configure(tx, parent.id, { cwd: '/workspace/first', instructions: 'Historical instructions.' });
    return tx.appendEntry(parent.id, { kind: 'test.first-settings', data: {} });
  }, context);
  const firstAgent = await service.harness.snapshot(AgentDoc, parent.id, context);
  const after = await parent.commit(async (tx) => {
    await configure(tx, parent.id, { cwd: '/workspace/later', instructions: 'Current instructions.' });
    Object.assign(await tx.doc(AgentDoc, parent.id), {
      extensions: { remove: ['local-bash'] }, tools: { remove: ['bash', 'edit'] },
    });
    return tx.appendEntry(parent.id, { kind: 'test.later-settings', data: {} });
  }, context);
  const currentAgent = await service.harness.snapshot(AgentDoc, parent.id, context);
  const firstFork = await parent.fork(before.id, { ownership: { kind: 'ownerless' } }, context);
  const currentFork = await parent.fork(after.id, { ownership: { kind: 'ownerless' } }, context);
  assert.deepEqual(await service.harness.snapshot(AgentDoc, firstFork.id, context), firstAgent);
  assert.deepEqual(await service.harness.snapshot(AgentDoc, currentFork.id, context), currentAgent);
  for (const fork of [firstFork, currentFork]) {
    // The fork was created through the harness, so it is driven through the harness too.
    const answered = await (await fork.submit({ type: 'input', content: 'Inspect the workspace.' }, context)).wait(context);
    assert.equal(answered.status, 'done');
  }
  assert.deepEqual(offeredTools(provider.requests[0]), ['add_numbers', ...sharedTools].sort());
  assert.deepEqual(offeredTools(provider.requests[1]), ['add_numbers']);
  const ownedTask = await parent.commit((tx) => tx.createTask(Owned, {}, { ownership: { kind: 'conversation' } }), context);
  const owned = (await service.harness.waitForTask(ownedTask, context)).state.outcome;
  assert.equal(owned.status, 'completed', JSON.stringify(owned));
  assert.deepEqual(await service.harness.snapshot(AgentDoc, owned.result.id, context), currentAgent);
  const identities = await Promise.all([parent.id, firstFork.id, currentFork.id, owned.result.id].map((conversationId) =>
    service.harness.snapshot(WorkspaceDoc, conversationId, context)));
  assert.equal(new Set(identities.map(({ id }) => id)).size, 4);
  assert.deepEqual(identities.map(({ origin }) => origin), ['new', 'fork', 'fork', 'new']);
  await file.close(service);
  const reopened = await file.open(scriptedModels([]).models);
  for (const [conversationId, agent] of [[firstFork.id, firstAgent], [currentFork.id, currentAgent], [owned.result.id, currentAgent]]) {
    assert.deepEqual(await reopened.harness.snapshot(AgentDoc, conversationId, context), agent);
  }
});

test('execution configuration atomically commits cwd with app state and preserves unrelated agent settings', async (t) => {
  const file = await integrationDatabase(t, DurableChatService);
  const service = await file.open(scriptedModels([]).models);
  const id = await service.createChat();
  const Selector = defineDoc({ kind: 'test.execution-selection', version: 1, scope: 'conversation',
    history: 'rewindable', fork: 'asOf', initial: () => ({ target: 'original' }) });
  const original = await service.harness.snapshot(AgentDoc, Number(id), context);
  await service.configureExecution(id, { cwd: '/workspace/new' }, async (tx, conversationId) => {
    (await tx.doc(Selector, conversationId)).target = 'selected';
  });
  assert.deepEqual(await service.harness.snapshot(AgentDoc, Number(id), context), { ...original, cwd: '/workspace/new' });
  assert.equal((await service.harness.snapshot(Selector, Number(id), context)).target, 'selected');
  await assert.rejects(service.configureExecution(id, { cwd: '/workspace/invalid' }, async (tx, conversationId) => {
    (await tx.doc(Selector, conversationId)).target = 'must roll back';
    throw new Error('Selection validation failed');
  }), /Selection validation failed/);
  assert.equal((await service.harness.snapshot(AgentDoc, Number(id), context)).cwd, '/workspace/new');
  assert.equal((await service.harness.snapshot(Selector, Number(id), context)).target, 'selected');
});
