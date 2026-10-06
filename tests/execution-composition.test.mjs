import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import test from 'node:test';
import { BACKGROUND_CONTEXT } from '@earendil-works/chord/context';
import { AgentDoc } from '@earendil-works/pi-durable';
import { integrationDatabase, toolReply, toolRound, until } from './helpers/bash-integration.mjs';
import { installBashBrowserHooks } from './helpers/bash-browser-hooks.mjs';
import { scriptedModels } from './helpers/scripted-models.mjs';
import { DirectEnvTask, independentExecution, OwnedConversationTask, TestExecutionDoc } from './helpers/independent-env.mjs';

const hooks = installBashBrowserHooks();
test.after(() => hooks.deregister());
const { DurableChatService } = await import('../src/pi/chat-service.ts');
const context = BACKGROUND_CONTEXT;
const answer = { chunks: ['Done.'] };
const rows = (service, id) => service.getConversation(id).messages.filter((message) => message.tool);

async function fixture(t, script) {
  const file = await integrationDatabase(t, DurableChatService);
  const independent = await independentExecution(file.directory);
  const provider = scriptedModels(script);
  const service = await file.open(provider.models, { execution: independent.decorate });
  return { file, independent, provider, service };
}

async function select(service, id, independent, kind = 'independent', cwd = independent.root) {
  await service.configureExecution(id, { cwd }, async (tx, conversationId) => {
    (await tx.doc(TestExecutionDoc, conversationId)).kind = kind;
  });
}

async function run(service, id, input = 'Run the selected execution tools.') {
  const result = await service.waitForSubmission(await service.send(id, input));
  assert.equal(result.status, 'done', JSON.stringify(result));
  return rows(service, id);
}

async function task(service, id, definition) {
  const taskId = await service.harness.commit((tx) => tx.createTask(definition, {}, {
    conversationId: Number(id), ownership: { kind: 'conversation' },
  }), context);
  await service.resume();
  return (await service.harness.waitForTask(taskId, context)).state;
}

test('the actual service runs all four shared tools in an independent public env without opening local storage', { timeout: 15_000 }, async (t) => {
  const { file, independent, provider, service } = await fixture(t, [toolRound([
    { name: 'write', arguments: { path: 'nested/note', content: 'alpha\nsecond\n' } },
    { name: 'bash', arguments: { command: "printf 'shell\n' >> nested/note; cat nested/note" } },
    { name: 'edit', arguments: { path: 'nested/note', edits: [{ oldText: 'alpha', newText: 'edited' }] } },
    { name: 'read', arguments: { path: 'nested/note' } },
  ]), answer]);
  const id = await service.createChat();
  await select(service, id, independent);
  assert.equal(file.metrics.opened, 0, 'selection only commits metadata');
  assert.equal(independent.operations.length, 0, 'selection resolves no execution resources');
  const tools = await run(service, id);
  assert.deepEqual(tools.map(({ tool }) => [tool.name, tool.status]), [
    ['write', 'completed'], ['bash', 'completed'], ['edit', 'completed'], ['read', 'completed'],
  ]);
  assert.equal(tools.at(-1).tool.output, 'edited\nsecond\nshell\n');
  assert.equal(await readFile(join(independent.root, 'nested/note'), 'utf8'), 'edited\nsecond\nshell\n');
  assert.equal(file.metrics.opened, 0, 'selected independent tools never construct the local workspace database');
  for (const name of ['writeFile', 'exec', 'openBinaryReader']) {
    assert.ok(independent.operations.some((operation) => operation.name === name), `public ${name} reached the selected backend`);
  }
  assert.ok(!independent.operations.some(({ name }) => ['readTextFile', 'readBinaryFile'].includes(name)),
    'shared read and edit consume bounded public readers, never whole-file backend reads');
  assert.equal(independent.metrics.scopes, 4);
  assert.equal(independent.metrics.released, 4);
  assert.equal(independent.metrics.cleaned, 0, 'finishing a tool does not shut down its environment owner');
  const prompt = JSON.stringify(provider.requests[0].context.messages.filter(({ role }) => role === 'system'));
  assert.match(prompt, /independent test host/);
  assert.ok(prompt.includes(independent.root), 'cwd comes from the selected environment');
  assert.doesNotMatch(prompt, /share this chat’s local filesystem|just-bash|recreated for every tool invocation/);
  const results = provider.requests[1].context.messages.filter(({ role }) => role === 'toolResult');
  assert.equal(results.length, 4, 'all four committed results reach the next model request');
  assert.match(JSON.stringify(results.at(-1)), /edited\\nsecond\\nshell/);
});

test('local and independent conversations use different namespaces through the same registrations', { timeout: 15_000 }, async (t) => {
  const { file, independent, service } = await fixture(t, [
    toolRound([{ name: 'write', arguments: { path: 'same-name', content: 'independent' } },
      { name: 'read', arguments: { path: 'same-name' } }]), answer,
    toolRound([{ name: 'write', arguments: { path: 'same-name', content: 'local' } },
      { name: 'read', arguments: { path: 'same-name' } }]), answer,
    toolReply('read', { path: 'same-name' }), answer,
  ]);
  const external = await service.createChat();
  const local = await service.createChat();
  await select(service, external, independent);
  assert.equal((await run(service, external)).at(-1).tool.output, 'independent');
  assert.equal(file.metrics.opened, 0);
  assert.equal((await run(service, local)).at(-1).tool.output, 'local');
  assert.ok(file.metrics.opened > 0);
  assert.equal((await run(service, external)).at(-1).tool.output, 'independent');
  assert.equal(await readFile(join(independent.root, 'same-name'), 'utf8'), 'independent');
});

test('metadata-only prompting does not acquire scopes or perform backend operations', { timeout: 10_000 }, async (t) => {
  const { file, independent, service } = await fixture(t, [answer]);
  const id = await service.createChat();
  await select(service, id, independent);
  await run(service, id);
  assert.ok(independent.metrics.resolutions > 0);
  assert.equal(independent.metrics.scopes, 0);
  assert.deepEqual(independent.operations, []);
  assert.equal(file.metrics.opened, 0);
});

test('a custom task uses the actual local runtime.env for successive temporary methods and owner cleanup', { timeout: 10_000 }, async (t) => {
  const { file, independent, provider, service } = await fixture(t, []);
  const id = await service.createChat();
  const direct = await task(service, id, DirectEnvTask);
  assert.deepEqual(direct.outcome, { status: 'completed', result: { text: 'written through runtime.env()', cwd: '/workspace' } });
  assert.ok(file.metrics.opened > 0, 'local direct task materialized its actual workspace');
  assert.equal(independent.operations.length, 0);
  assert.equal(provider.requests.length, 0, 'custom tasks do not require a model turn');
});

test('test selector and cwd commit atomically, survive reopen, rewind at forks, and inherit into owned conversations', { timeout: 20_000 }, async (t) => {
  const { file, independent, service } = await fixture(t, [toolReply('write', { path: 'persisted', content: 'kept by independent host' }), answer]);
  const id = await service.createChat();
  await select(service, id, independent);
  const original = await service.harness.snapshot(AgentDoc, Number(id), context);
  await assert.rejects(service.configureExecution(id, { cwd: join(independent.root, 'rolled-back') }, async (tx, conversationId) => {
    (await tx.doc(TestExecutionDoc, conversationId)).kind = 'failing';
    throw new Error('Rollback target and cwd together.');
  }), /Rollback/);
  assert.equal((await service.harness.snapshot(AgentDoc, Number(id), context)).cwd, original.cwd);
  assert.equal((await service.harness.snapshot(TestExecutionDoc, Number(id), context)).kind, 'independent');
  await run(service, id);
  const parent = await service.harness.conversation(Number(id), context);
  const entries = await parent.entries({}, 100, undefined, context);
  const at = entries.items[0].id;
  await select(service, id, independent, 'failing', join(independent.root, 'later'));
  const fork = await parent.fork(at, { ownership: { kind: 'ownerless' } }, context);
  assert.equal((await service.harness.snapshot(TestExecutionDoc, fork.id, context)).kind, 'independent');
  assert.equal((await service.harness.snapshot(AgentDoc, fork.id, context)).cwd, independent.root);
  await file.close(service);
  const provider = scriptedModels([toolReply('read', { path: 'persisted' }), answer]);
  const reopened = await file.open(provider.models, { execution: independent.decorate });
  assert.equal(provider.requests.length, 0, 'inspection and reopen do not resume the scheduler');
  assert.equal((await run(reopened, String(fork.id))).at(-1).tool.output, 'kept by independent host');
  const owned = await task(reopened, String(fork.id), OwnedConversationTask);
  assert.equal(owned.outcome.status, 'completed', JSON.stringify(owned));
  const child = owned.outcome.result.conversationId;
  assert.equal((await reopened.harness.snapshot(TestExecutionDoc, child, context)).kind, 'independent');
  assert.equal((await reopened.harness.snapshot(AgentDoc, child, context)).cwd, independent.root);
  assert.deepEqual(owned.outcome.result.direct, { status: 'completed', result: { text: 'written through runtime.env()', cwd: independent.root } });
  const direct = await task(reopened, String(fork.id), DirectEnvTask);
  assert.deepEqual(direct.outcome, owned.outcome.result.direct);
  assert.equal(file.metrics.opened, 0, 'reopen, fork, owned creation and runtime.env remain independent');
});

for (const kind of ['missing', 'failing']) test(`a ${kind} selected env fails without falling back to the local backend`, { timeout: 10_000 }, async (t) => {
  const { file, independent, provider, service } = await fixture(t, [toolReply('write', { path: 'must-not-exist', content: 'bad fallback' }), answer]);
  const id = await service.createChat();
  await select(service, id, independent, kind);
  const result = await service.waitForSubmission(await service.send(id, 'Try the selected host.'));
  const tools = rows(service, id);
  assert.equal(result.status, 'done');
  assert.equal(tools.length, 1);
  assert.equal(tools[0].tool.status, 'error');
  assert.match(tools[0].tool.output, /environment|unavailable/i);
  assert.match(JSON.stringify(provider.requests[1].context.messages.filter(({ role }) => role === 'toolResult')), /environment|unavailable/i,
    'the backend failure is committed and reaches the model');
  assert.equal(file.metrics.opened, 0);
  assert.equal(independent.operations.length, 0);
});

test('shared edit preflight rejects excessive independent files before materialization or mutation', { timeout: 15_000 }, async (t) => {
  const { file, independent, service } = await fixture(t, [toolReply('edit', {
    path: 'large', edits: [{ oldText: 'x', newText: 'changed' }],
  }), answer]);
  const original = Buffer.alloc(8 * 1024 * 1024 + 1, 'x');
  await writeFile(join(independent.root, 'large'), original);
  const id = await service.createChat();
  await select(service, id, independent);
  const tool = (await run(service, id))[0].tool;
  assert.equal(tool.status, 'error');
  assert.match(tool.output, /budget|limit/i);
  assert.ok(independent.operations.some(({ name }) => name === 'fileInfo'));
  assert.ok(!independent.operations.some(({ name }) => ['readTextFile', 'readBinaryFile', 'writeFile'].includes(name)));
  assert.deepEqual(await readFile(join(independent.root, 'large')), original);
  assert.equal(file.metrics.opened, 0);
});

test('a committed independent edit failure preserves unrelated malformed UTF-8 bytes', async (t) => {
  const { file, independent, provider, service } = await fixture(t, [toolReply('edit', {
    path: 'invalid.txt', edits: [{ oldText: 'alpha', newText: 'beta' }],
  }), answer]);
  const original = Buffer.concat([Buffer.from([255]), Buffer.from('alpha\n')]);
  await writeFile(join(independent.root, 'invalid.txt'), original);
  const id = await service.createChat();
  await select(service, id, independent);
  const tool = (await run(service, id))[0].tool;
  assert.equal(tool.status, 'error');
  assert.match(tool.output, /invalid|UTF-8/i);
  assert.deepEqual(await readFile(join(independent.root, 'invalid.txt')), original);
  assert.ok(!independent.operations.some(({ name }) => ['readTextFile', 'readBinaryFile', 'writeFile'].includes(name)));
  assert.match(JSON.stringify(provider.requests[1].context.messages.filter(({ role }) => role === 'toolResult')), /invalid|UTF-8/i,
    'the committed rejection reaches the subsequent model request');
  assert.equal(file.metrics.opened, 0);
});

test('shared bash consumes stream metadata and commits bounded independent output with honest artifact limits', { timeout: 20_000 }, async (t) => {
  const { file, independent, service } = await fixture(t, [toolReply('bash', { command: 'fixture:large-output' }), answer]);
  const id = await service.createChat();
  await select(service, id, independent);
  const tool = (await run(service, id))[0].tool;
  assert.equal(independent.metrics.emittedBytes, 64 * 1024 * 1024);
  assert.ok(tool.output.length < 100_000, `presentation retained ${tool.output.length} code units`);
  assert.match(tool.output, /DISTINCT_STDERR/);
  assert.match(tool.output, /7/);
  assert.match(tool.output, /unavailable|not (?:retained|saved)|could not|exceed/i);
  const exec = independent.operations.find(({ name }) => name === 'exec');
  assert.equal(exec.window, undefined, 'separate stream presentation does not ask for a coalesced window');
  assert.equal(typeof exec.timeout, 'number', 'default timeout is normalized before delegation');
  assert.equal(file.metrics.opened, 0);
});

test('a cancelled independent command awaiting drain does not block a local chat', { timeout: 15_000 }, async (t) => {
  const { file, independent, service } = await fixture(t, [
    toolReply('bash', { command: 'fixture:wait' }),
    toolReply('bash', { command: 'printf LOCAL_PROGRESS' }), answer,
    answer,
  ]);
  independent.behavior.holdCancelledDrain = true;
  const external = await service.createChat();
  const local = await service.createChat();
  await select(service, external, independent);
  const pending = await service.send(external, 'Start waiting.');
  await until(() => independent.metrics.active === 1, 'independent command reached its wait');
  const cancelling = service.cancel(external);
  let retry;
  try {
    await until(() => independent.metrics.aborted === 1, 'cancellation reaches the selected env');
    retry = service.send(external, 'Continue after the cancelled command drains.');
    const progressing = run(service, local, 'Run locally while the other host drains.');
    const localRows = await Promise.race([progressing, new Promise((_, reject) => setTimeout(() => reject(new Error('Local chat was blocked by cancelled independent environment drainage.')), 1500))]);
    assert.match(localRows.at(-1).tool.output, /LOCAL_PROGRESS/);
    assert.equal(independent.metrics.active, 1, 'independent drainage is still held while local work succeeds');
    assert.ok(file.metrics.opened > 0);
  } finally {
    independent.releaseDrain();
    await cancelling;
    await service.waitForSubmission(pending);
    if (retry) await service.waitForSubmission(await retry);
  }
  assert.equal(independent.metrics.active, 0);
});
