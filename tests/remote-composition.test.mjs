import assert from 'node:assert/strict';
import { mkdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import test from 'node:test';
import { BACKGROUND_CONTEXT } from '@earendil-works/chord/context';
import { AgentDoc, defineExtension } from '@earendil-works/pi-durable';
import { getOrThrow } from '@earendil-works/pi-durable/env';
import { integrationDatabase, toolReply, toolRound } from './helpers/bash-integration.mjs';
import { installBashBrowserHooks } from './helpers/bash-browser-hooks.mjs';
import { scriptedModels } from './helpers/scripted-models.mjs';
import { DirectEnvTask, OwnedConversationTask } from './helpers/independent-env.mjs';
import { remoteDaemonFixture, remoteDaemonPath } from './helpers/remote-daemon.mjs';

const hooks = installBashBrowserHooks();
test.after(() => hooks.deregister());
const { DurableChatService } = await import('../src/pi/chat-service.ts');
const { createRemoteExecution, admittedSshChannel } = await import('../src/pi/execution/remote/composition.ts');
const { RemoteHostRepository } = await import('../src/pi/execution/remote/hosts.ts');
const { ExecutionTargetDoc } = await import('../src/pi/execution/document.ts');
const C = BACKGROUND_CONTEXT;
const real = { skip: await remoteDaemonPath() ? false : 'Install Pi Env 1.0.4 or set PI_ENV_DAEMON.', timeout: 20_000 };
const answer = { chunks: ['Done.'] };
const rows = (service, id) => service.getConversation(id).messages.filter((message) => message.tool);
function backend() {
  const data = new Map();
  return { getItemAsync: async (key) => data.get(key) ?? null, setItemAsync: async (key, value) => { data.set(key, value); }, deleteItemAsync: async (key) => { data.delete(key); } };
}
async function fixture(t, script) {
  const remote = await remoteDaemonFixture(t);
  const file = await integrationDatabase(t, DurableChatService);
  const provider = scriptedModels(script);
  let sequence = 0;
  const hosts = new RemoteHostRepository(backend(), backend(), () => `fixture-${++sequence}`);
  let host = await hosts.save({ name: 'Daemon fixture', hostname: 'fixture.tailnet.ts.net', port: 22, username: 'fixture' }, { type: 'password', password: 'synthetic-secret' });
  host = await hosts.acceptHostKey(host.id, host.revision, { algorithm: 'ssh-ed25519', fingerprint: 'SHA256:abc', publicKey: 'abc' });
  const admissions = [];
  let composition;
  const decorate = (local) => {
    const combined = createRemoteExecution(local, hosts, (admission) => { admissions.push(admission); return remote.openChannel; });
    composition = { ...combined, extensions: [...combined.extensions ?? [], defineExtension({ name: 'test.remote-direct', tasks: [DirectEnvTask, OwnedConversationTask] })] };
    return composition;
  };
  const service = await file.open(provider.models, { execution: decorate });
  return { remote, file, provider, hosts, host, admissions, service, decorate, get composition() { return composition; } };
}
async function select(f, id) { await f.service.updateExecution(id, { target: { kind: 'ssh', machineId: f.host.id }, cwd: f.remote.directory }); }
async function run(service, id) {
  const result = await service.waitForSubmission(await service.send(id, 'Use the selected execution environment.'));
  assert.equal(result.status, 'done', JSON.stringify(result));
  return rows(service, id);
}
async function task(service, id, definition) {
  const taskId = await service.harness.commit((tx) => tx.createTask(definition, {}, { conversationId: Number(id), ownership: { kind: 'conversation' } }), C);
  await service.resume();
  return (await service.harness.waitForTask(taskId, C)).state;
}
function target(service, id, cwd) { return { conversationId: Number(id), cwd, read: service.harness }; }

test('production remote composition runs all shared tools through the real daemon and commits readable results', real, async (t) => {
  const f = await fixture(t, [toolRound([
    { name: 'write', arguments: { path: 'nested/note', content: 'alpha\nsecond\n' } },
    { name: 'bash', arguments: { command: "printf 'shell\n' >> nested/note; cat nested/note" } },
    { name: 'edit', arguments: { path: 'nested/note', edits: [{ oldText: 'alpha', newText: 'edited' }] } },
    { name: 'read', arguments: { path: 'nested/note' } },
  ]), answer]);
  const id = await f.service.createChat();
  assert.deepEqual(f.service.getConversation(id).execution, { target: { kind: 'local' }, cwd: '/workspace' });
  await select(f, id);
  assert.equal(f.remote.metrics.sessions, 0);
  assert.equal(f.file.metrics.opened, 0);
  const tools = await run(f.service, id);
  assert.deepEqual(tools.map(({ tool }) => [tool.name, tool.status]), [['write', 'completed'], ['bash', 'completed'], ['edit', 'completed'], ['read', 'completed']]);
  assert.equal(tools.at(-1).tool.output, 'edited\nsecond\nshell\n');
  assert.equal(await readFile(join(f.remote.directory, 'nested/note'), 'utf8'), 'edited\nsecond\nshell\n');
  assert.equal(f.file.metrics.opened, 0);
  assert.equal(f.remote.metrics.sessions, 4, 'each shared tool owns one remote session');
  assert.equal(f.remote.children.size, 0, 'all tool sessions are drained before completion');
  assert.equal(f.remote.metrics.closes, 4);
  const prompt = JSON.stringify(f.provider.requests[0].context.messages.filter(({ role }) => role === 'system'));
  assert.match(prompt, /SSH over Tailscale/);
  assert.ok(prompt.includes(f.remote.directory));
  assert.doesNotMatch(prompt, /just-bash|synthetic-secret|SHA256/);
  const results = f.provider.requests[1].context.messages.filter(({ role }) => role === 'toolResult');
  assert.equal(results.length, 4);
  assert.match(JSON.stringify(results.at(-1)), /edited\\nsecond\\nshell/);
});

test('production remote metadata prompting opens neither SSH nor local filesystem storage', real, async (t) => {
  const f = await fixture(t, [answer]);
  const id = await f.service.createChat();
  await select(f, id);
  await run(f.service, id);
  assert.equal(f.remote.metrics.sessions, 0);
  assert.equal(f.admissions.length, 0, 'prompt resolver never loads SSH secrets');
  assert.equal(f.file.metrics.opened, 0);
});

test('two chats on one remote machine keep independent committed directories through tools and reopen', real, async (t) => {
  const f = await fixture(t, [
    toolReply('write', { path: 'same-name', content: 'first chat' }), answer,
    toolReply('write', { path: 'same-name', content: 'second chat' }), answer,
  ]);
  assert.equal('defaultCwd' in f.host, false, 'Machine settings have no working-directory ownership.');
  const firstDirectory = join(f.remote.directory, 'first project');
  const secondDirectory = join(f.remote.directory, 'second project');
  await Promise.all([mkdir(firstDirectory), mkdir(secondDirectory)]);
  const first = await f.service.createChat();
  const second = await f.service.createChat();
  const remoteTarget = { kind: 'ssh', machineId: f.host.id };
  await f.service.updateExecution(first, { target: remoteTarget, cwd: firstDirectory });
  await f.service.updateExecution(second, { target: remoteTarget, cwd: secondDirectory });
  await run(f.service, first);
  await run(f.service, second);
  assert.equal(await readFile(join(firstDirectory, 'same-name'), 'utf8'), 'first chat');
  assert.equal(await readFile(join(secondDirectory, 'same-name'), 'utf8'), 'second chat');
  assert.equal((await f.service.harness.snapshot(AgentDoc, Number(first), C)).cwd, firstDirectory);
  assert.equal((await f.service.harness.snapshot(AgentDoc, Number(second), C)).cwd, secondDirectory);
  await f.file.close(f.service);
  const provider = scriptedModels([
    toolReply('read', { path: 'same-name' }), answer,
    toolReply('read', { path: 'same-name' }), answer,
  ]);
  const reopened = await f.file.open(provider.models, { execution: f.decorate });
  assert.deepEqual(reopened.getConversation(first).execution, { target: remoteTarget, cwd: firstDirectory });
  assert.deepEqual(reopened.getConversation(second).execution, { target: remoteTarget, cwd: secondDirectory });
  assert.equal((await run(reopened, first)).at(-1).tool.output, 'first chat');
  assert.equal((await run(reopened, second)).at(-1).tool.output, 'second chat');
  assert.equal(f.file.metrics.opened, 0);
});

test('remote resolution without a committed chat directory fails before SSH or secret admission', real, async (t) => {
  const f = await fixture(t, []);
  const id = await f.service.createChat();
  await select(f, id);
  for (const cwd of [undefined, '', 'relative/project', '/bad\0directory']) {
    await assert.rejects(f.composition.resolve(target(f.service, id, cwd), C), /working directory.*chat/);
  }
  assert.equal(f.remote.metrics.sessions, 0);
  assert.equal(f.admissions.length, 0);
  assert.equal(f.file.metrics.opened, 0);
});

test('production local and remote selections keep same-named files isolated', real, async (t) => {
  const f = await fixture(t, [toolReply('write', { path: 'same-name', content: 'remote' }), answer,
    toolReply('write', { path: 'same-name', content: 'local' }), answer,
    toolReply('read', { path: 'same-name' }), answer, toolReply('read', { path: 'same-name' }), answer]);
  const remote = await f.service.createChat(), local = await f.service.createChat();
  await select(f, remote);
  await run(f.service, remote);
  assert.equal(f.file.metrics.opened, 0);
  await run(f.service, local);
  assert.ok(f.file.metrics.opened > 0);
  assert.equal((await run(f.service, remote)).at(-1).tool.output, 'remote');
  assert.equal((await run(f.service, local)).at(-1).tool.output, 'local');
  assert.equal(await readFile(join(f.remote.directory, 'same-name'), 'utf8'), 'remote');
});

test('production selection/cwd survive reopen, historical fork, and direct task-owned conversation inheritance', real, async (t) => {
  const f = await fixture(t, [toolReply('write', { path: 'persisted', content: 'remote-current-files' }), answer]);
  const id = await f.service.createChat();
  await select(f, id);
  await run(f.service, id);
  const parent = await f.service.harness.conversation(Number(id), C);
  const firstEntry = (await parent.entries({}, 100, undefined, C)).items[0].id;
  await f.service.updateExecution(id, { target: { kind: 'local' }, cwd: '/workspace' });
  const fork = await parent.fork(firstEntry, { ownership: { kind: 'ownerless' } }, C);
  assert.deepEqual(await f.service.harness.snapshot(ExecutionTargetDoc, fork.id, C), { kind: 'ssh', machineId: f.host.id });
  assert.equal((await f.service.harness.snapshot(AgentDoc, fork.id, C)).cwd, f.remote.directory);
  await f.file.close(f.service);
  const provider = scriptedModels([toolReply('read', { path: 'persisted' }), answer]);
  const reopened = await f.file.open(provider.models, { execution: f.decorate });
  const before = f.remote.metrics.sessions;
  assert.deepEqual(reopened.getConversation(String(fork.id)).execution, { target: { kind: 'ssh', machineId: f.host.id }, cwd: f.remote.directory });
  assert.equal(f.remote.metrics.sessions, before, 'reopen is metadata-only');
  assert.equal((await run(reopened, String(fork.id))).at(-1).tool.output, 'remote-current-files');
  const owned = await task(reopened, String(fork.id), OwnedConversationTask);
  assert.equal(owned.outcome.status, 'completed', JSON.stringify(owned));
  const child = owned.outcome.result.conversationId;
  assert.deepEqual(await reopened.harness.snapshot(ExecutionTargetDoc, child, C), { kind: 'ssh', machineId: f.host.id });
  assert.equal((await reopened.harness.snapshot(AgentDoc, child, C)).cwd, f.remote.directory);
  assert.deepEqual(owned.outcome.result.direct, { status: 'completed', result: { text: 'written through runtime.env()', cwd: f.remote.directory } });
  assert.equal(f.remote.children.size, 0);
  assert.equal(f.file.metrics.opened, 0);
});

test('production resolver preserves already admitted snapshots and rejects stale unadmitted facades after host edits', real, async (t) => {
  const f = await fixture(t, []);
  const id = await f.service.createChat();
  await select(f, id);
  const admitted = await f.composition.resolve(target(f.service, id, f.remote.directory), C);
  const stale = await f.composition.resolve(target(f.service, id, f.remote.directory), C);
  getOrThrow(await admitted.writeFile('snapshot', 'before', C));
  assert.equal(f.admissions.length, 1);
  const next = await f.hosts.save({ ...f.host, hostname: 'edited.tailnet.ts.net' }, { type: 'password', password: 'replacement-secret' });
  getOrThrow(await admitted.writeFile('snapshot', 'after', C));
  const failure = await stale.writeFile('stale', 'must fail', C);
  assert.equal(failure.ok, false);
  assert.match(failure.error.message, /changed/);
  assert.equal(f.admissions.length, 1);
  assert.equal(f.admissions[0].host.hostname, 'fixture.tailnet.ts.net');
  assert.equal(f.admissions[0].auth.password, 'synthetic-secret');
  const subsequent = await f.composition.resolve(target(f.service, id, f.remote.directory), C);
  getOrThrow(await subsequent.writeFile('new-admission', 'new', C));
  assert.equal(f.admissions.at(-1).host.revision, next.revision);
  assert.equal(f.admissions.at(-1).auth.password, 'replacement-secret');
  await Promise.all([admitted, stale, subsequent].map((env) => env.cleanup(C)));
  assert.equal(f.remote.children.size, 0);
  assert.equal(f.file.metrics.opened, 0);
});

test('removed production hosts retain chat selection and fail without local fallback', real, async (t) => {
  const f = await fixture(t, [toolReply('write', { path: 'must-not-exist', content: 'forbidden fallback' }), answer]);
  const id = await f.service.createChat();
  await select(f, id);
  await f.hosts.remove(f.host.id);
  const result = await f.service.waitForSubmission(await f.service.send(id, 'Try the selected host.'));
  assert.ok(['done', 'error'].includes(result.status), JSON.stringify(result));
  assert.deepEqual(f.service.getConversation(id).execution.target, { kind: 'ssh', machineId: f.host.id });
  const observable = JSON.stringify({ result, conversation: f.service.getConversation(id) });
  assert.match(observable, /removed|execution environment/i);
  assert.equal(f.remote.metrics.sessions, 0);
  assert.equal(f.file.metrics.opened, 0);
});

test('production composition shutdown seals direct owners and drains real daemon sessions', real, async (t) => {
  const f = await fixture(t, []);
  const id = await f.service.createChat();
  await select(f, id);
  const env = await f.composition.resolve(target(f.service, id, f.remote.directory), C);
  getOrThrow(await env.writeFile('owner', 'active', C));
  assert.equal(f.remote.children.size, 1);
  f.composition.stop();
  assert.equal((await env.writeFile('stale', '', C)).ok, false);
  await f.composition.close();
  assert.equal(f.remote.children.size, 0);
  await assert.rejects(f.composition.resolve(target(f.service, id, f.remote.directory), C), /stopped/);
});

test('production execution settings do not publish target or cwd when a durable task remains unsettled', real, async (t) => {
  const f = await fixture(t, []);
  const id = await f.service.createChat();
  await select(f, id);
  // Create a task without resuming the scheduler; pending work must block selection.
  await f.service.harness.commit((tx) => tx.createTask(DirectEnvTask, {}, { conversationId: Number(id), ownership: { kind: 'conversation' } }), C);
  await assert.rejects(f.service.updateExecution(id, { target: { kind: 'local' }, cwd: '/workspace' }), /Wait for execution to stop/);
  assert.deepEqual(f.service.getConversation(id).execution, { target: { kind: 'ssh', machineId: f.host.id }, cwd: f.remote.directory });
  assert.equal((await f.service.harness.snapshot(AgentDoc, Number(id), C)).cwd, f.remote.directory);
  assert.deepEqual(await f.service.harness.snapshot(ExecutionTargetDoc, Number(id), C), { kind: 'ssh', machineId: f.host.id });
});

test('native admitted channel refuses missing SSH trust before constructing a transport', () => {
  assert.throws(() => admittedSshChannel({ host: {}, auth: { type: 'password', password: 'never-connect' } }), /verify.*SSH host key/);
});

test('combined execution and model settings capture caller drafts before asynchronous admission', real, async (t) => {
  const f = await fixture(t, []);
  const id = await f.service.createChat();
  const expected = structuredClone(f.service.getConversation(id).settings);
  const draft = structuredClone(expected);
  const pending = f.service.updateExecution(id, { target: { kind: 'ssh', machineId: f.host.id }, cwd: f.remote.directory }, draft);
  draft.model.modelId = 'mutated-after-validation';
  await pending;
  assert.deepEqual(f.service.getConversation(id).settings, expected);
});

test('production remote filesystem identity follows accepted server identity and remains stable across cwd changes', real, async (t) => {
  const f = await fixture(t, []);
  const id = await f.service.createChat();
  await select(f, id);
  const before = await f.composition.resolve(target(f.service, id, f.remote.directory), C);
  const otherCwd = await f.composition.resolve(target(f.service, id, '/different/project'), C);
  assert.equal(before.id, otherCwd.id);
  await f.hosts.acceptHostKey(f.host.id, f.host.revision, { algorithm: 'ssh-ed25519', fingerprint: 'SHA256:replacement', publicKey: 'replacement' });
  const replaced = await f.composition.resolve(target(f.service, id, f.remote.directory), C);
  assert.notEqual(before.id, replaced.id);
  assert.equal(f.remote.metrics.sessions, 0, 'checking namespace and cwd performs no SSH admission');
  await Promise.all([before, otherCwd, replaced].map((env) => env.cleanup(C)));
});
