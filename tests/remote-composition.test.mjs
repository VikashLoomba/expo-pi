import assert from 'node:assert/strict';
import { access, mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import test from 'node:test';
import { BACKGROUND_CONTEXT } from '@earendil-works/chord/context';
import { AgentDoc, defineExtension, defineTask, section } from '@earendil-works/pi-durable';
import { getOrThrow } from '@earendil-works/pi-durable/env';
import { integrationDatabase, toolReply, toolRound, until } from './helpers/bash-integration.mjs';
import { installBashBrowserHooks } from './helpers/bash-browser-hooks.mjs';
import { readChat } from './helpers/chat-view.mjs';
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
const rows = async (service, id) => (await readChat(service, id)).messages.filter((message) => message.tool);
function backend() {
  const data = new Map();
  return { getItemAsync: async (key) => data.get(key) ?? null, setItemAsync: async (key, value) => { data.set(key, value); }, deleteItemAsync: async (key) => { data.delete(key); } };
}
async function fixture(t, script, extensions = []) {
  const remote = await remoteDaemonFixture(t);
  const file = await integrationDatabase(t, DurableChatService);
  const provider = scriptedModels(script);
  let sequence = 0;
  const hosts = new RemoteHostRepository(backend(), backend(), () => `fixture-${++sequence}`);
  let host = await hosts.save({ name: 'Daemon fixture', hostname: 'fixture.tailnet.ts.net', port: 22, username: 'fixture' }, { type: 'password', password: 'synthetic-secret' });
  host = await hosts.acceptHostKey(host, { algorithm: 'ssh-ed25519', fingerprint: 'SHA256:abc', publicKey: 'abc' });
  const admissions = [];
  let composition;
  const decorate = (local) => {
    const combined = createRemoteExecution(local, hosts, (admission) => { admissions.push(admission); return remote.openChannel; });
    composition = { ...combined, extensions: [...combined.extensions ?? [], defineExtension({ name: 'test.remote-direct', tasks: [DirectEnvTask, OwnedConversationTask] }), ...extensions] };
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
  assert.deepEqual((await readChat(f.service, id)).execution, { target: { kind: 'local' }, cwd: '/workspace' });
  await select(f, id);
  assert.equal(f.remote.metrics.sessions, 0);
  const tools = await run(f.service, id);
  assert.deepEqual(tools.map(({ tool }) => [tool.name, tool.status]), [['write', 'completed'], ['bash', 'completed'], ['edit', 'completed'], ['read', 'completed']]);
  assert.equal(tools.at(-1).tool.output, 'edited\nsecond\nshell\n');
  assert.equal(await readFile(join(f.remote.directory, 'nested/note'), 'utf8'), 'edited\nsecond\nshell\n');
  assert.equal(f.remote.metrics.sessions, 1, 'successive shared tools reuse the service-owned session');
  assert.equal(f.remote.children.size, 1, 'the service retains its session between tools');
  assert.equal(f.remote.metrics.closes, 0);
  const prompt = JSON.stringify(f.provider.requests[0].context.messages.filter(({ role }) => role === 'system'));
  assert.match(prompt, /SSH over Tailscale/);
  assert.ok(prompt.includes(f.remote.directory));
  assert.doesNotMatch(prompt, /just-bash|synthetic-secret|SHA256/);
  const results = f.provider.requests[1].context.messages.filter(({ role }) => role === 'toolResult');
  assert.equal(results.length, 4);
  assert.match(JSON.stringify(results.at(-1)), /edited\\nsecond\\nshell/);
  await f.file.close(f.service);
  assert.equal(f.remote.children.size, 0);
  assert.equal(f.remote.metrics.closes, 1, 'service shutdown disposes the shared session once');
});

test('a remote edit refuses a file that is not UTF-8 and leaves its bytes unchanged', real, async (t) => {
  const f = await fixture(t, [toolReply('edit', { path: 'latin1.txt', edits: [{ oldText: 'alpha', newText: 'beta' }] }), answer]);
  const id = await f.service.createChat();
  await select(f, id);
  const original = Buffer.from('caf\xe9 alpha\n', 'latin1');
  await writeFile(join(f.remote.directory, 'latin1.txt'), original);
  const tools = await run(f.service, id);
  assert.equal(tools[0].tool.status, 'error');
  assert.match(tools[0].tool.output, /Error code: invalid/);
  assert.deepEqual(await readFile(join(f.remote.directory, 'latin1.txt')), original);
});

test('production remote metadata prompting opens neither SSH nor local filesystem storage', real, async (t) => {
  const f = await fixture(t, [answer]);
  const id = await f.service.createChat();
  await select(f, id);
  await run(f.service, id);
  assert.equal(f.remote.metrics.sessions, 0);
  assert.equal(f.admissions.length, 0, 'prompt resolver never loads SSH secrets');
});

test('prompt sections, tools and tasks borrow one environment without closing sibling resources', real, async (t) => {
  const promptEnvironments = [];
  const contextExtension = defineExtension({ name: 'test.remote-context', sections: [
    section('remote_context', async (input, context) => {
      promptEnvironments.push(input.env);
      return getOrThrow(await input.env.readTextFile('AGENTS.md', context));
    }),
  ] });
  const f = await fixture(t, [toolReply('write', { path: 'watched', content: 'changed by tool' }), answer], [contextExtension]);
  const id = await f.service.createChat();
  await select(f, id);
  const env = await f.composition.resolve(target(f.service, id, f.remote.directory), C);
  getOrThrow(await env.writeFile('AGENTS.md', 'Use the retained project environment.', C));
  getOrThrow(await env.writeFile('watched', '', C));
  const reader = getOrThrow(await env.openBinaryReader('AGENTS.md', undefined, C));
  const temporary = getOrThrow(await env.createTempFile({ prefix: 'shared-owner-' }, C));
  const changes = [];
  const watcher = getOrThrow(await env.watch([{ path: 'watched' }], (change) => changes.push(change), C));
  await run(f.service, id);
  const direct = await task(f.service, id, DirectEnvTask);
  assert.equal(direct.outcome.status, 'completed');
  assert.ok(promptEnvironments.length >= 2);
  assert.ok(promptEnvironments.every((value) => value === env), 'each prompt borrows the resolver-owned instance');
  assert.match(JSON.stringify(f.provider.requests[0]), /Use the retained project environment/);
  assert.equal(Buffer.from(getOrThrow(await reader.read(0, 100, C))).toString(), 'Use the retained project environment.');
  await access(temporary);
  await until(() => changes.length > 0, 'the tool write reaches the retained watcher');
  assert.equal(getOrThrow(await env.readTextFile('watched', C)), 'changed by tool');
  assert.equal(f.remote.metrics.sessions, 1);
  assert.equal(f.remote.metrics.closes, 0);
  await f.file.close(f.service);
  assert.equal(f.remote.metrics.closes, 1);
  assert.equal(f.remote.children.size, 0);
  await assert.rejects(access(temporary), { code: 'ENOENT' });
  assert.equal((await reader.read(0, 1, C)).ok, false);
  await watcher.close(C);
});

test('cancelling one chat task leaves another chat using the same remote environment alive', real, async (t) => {
  const started = [Promise.withResolvers(), Promise.withResolvers()];
  const borrowed = [];
  const tasks = started.map((ready, index) => defineTask({
    name: `test.remote-shared-cancel-${index}`, version: 1, initial: () => ({ phase: 'run' }),
    phases: { async run(_task, runtime, context) {
      const env = await runtime.env(context);
      borrowed[index] = env;
      assert.equal(await runtime.env(context), env, 'successive task resolution borrows the same environment');
      const result = getOrThrow(await env.exec(`printf ready; while [ ! -f done-${index} ]; do sleep 0.02; done`,
        { onOutput: (text) => { if (text.includes('ready')) ready.resolve(); } }, context));
      await runtime.commit(() => ({ status: 'terminal', outcome: { status: 'completed', result } }), context);
    } },
    async abort(_task, runtime, context) {
      await runtime.commit(() => ({ status: 'terminal', outcome: { status: 'aborted' } }), context);
    },
  }));
  const f = await fixture(t, [], [defineExtension({ name: 'test.remote-shared-cancel', tasks })]);
  const chats = [await f.service.createChat(), await f.service.createChat()];
  for (const id of chats) await select(f, id);
  const taskIds = await f.service.harness.commit(async (tx) => {
    const ids = [];
    for (const [index, definition] of tasks.entries()) ids.push(await tx.createTask(definition, {}, {
      conversationId: Number(chats[index]), ownership: { kind: 'conversation' },
    }));
    return ids;
  }, C);
  await Promise.all(started.map((ready) => ready.promise));
  assert.equal(borrowed[0], borrowed[1], 'same connection settings and cwd share the owner across chats');
  await f.service.harness.abortTask(taskIds[0], C);
  assert.equal((await f.service.harness.waitForTask(taskIds[0], C)).state.outcome.status, 'aborted');
  assert.equal((await f.service.harness.getTask(taskIds[1], C)).state.status, 'running');
  getOrThrow(await borrowed[1].writeFile('done-1', '', C));
  assert.equal((await f.service.harness.waitForTask(taskIds[1], C)).state.outcome.status, 'completed');
  assert.equal(f.remote.metrics.sessions, 1);
  assert.equal(f.remote.metrics.closes, 0, 'request cancellation does not terminate the shared connection');
  await f.file.close(f.service);
  assert.equal(f.remote.metrics.closes, 1);
});

test('a retained remote environment retries a failed first credential admission', real, async (t) => {
  const f = await fixture(t, []);
  const id = await f.service.createChat();
  await select(f, id);
  const env = await f.composition.resolve(target(f.service, id, f.remote.directory), C);
  const admit = f.hosts.admit.bind(f.hosts);
  let attempts = 0;
  f.hosts.admit = async (...args) => {
    if (++attempts === 1) throw new Error('Credential store temporarily unavailable.');
    return admit(...args);
  };
  const first = await env.fileInfo('.', C);
  assert.equal(first.ok, false);
  assert.match(first.error.message, /temporarily unavailable/);
  const retried = await f.composition.resolve(target(f.service, id, f.remote.directory), C);
  assert.equal(retried, env);
  assert.equal(getOrThrow(await retried.fileInfo('.', C)).kind, 'directory');
  assert.equal(attempts, 2);
  assert.equal(f.remote.metrics.sessions, 1);
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
  assert.deepEqual((await readChat(reopened, first)).execution, { target: remoteTarget, cwd: firstDirectory });
  assert.deepEqual((await readChat(reopened, second)).execution, { target: remoteTarget, cwd: secondDirectory });
  assert.equal((await run(reopened, first)).at(-1).tool.output, 'first chat');
  assert.equal((await run(reopened, second)).at(-1).tool.output, 'second chat');
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
});

test('production local and remote selections keep same-named files isolated', real, async (t) => {
  const f = await fixture(t, [toolReply('write', { path: 'same-name', content: 'remote' }), answer,
    toolReply('write', { path: 'same-name', content: 'local' }), answer,
    toolReply('read', { path: 'same-name' }), answer, toolReply('read', { path: 'same-name' }), answer]);
  const remote = await f.service.createChat(), local = await f.service.createChat();
  await select(f, remote);
  await run(f.service, remote);
  await run(f.service, local);
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
  assert.deepEqual(await f.service.harness.snapshot(ExecutionTargetDoc, fork.id, C), { target: { kind: 'ssh', machineId: f.host.id } });
  assert.equal((await f.service.harness.snapshot(AgentDoc, fork.id, C)).cwd, f.remote.directory);
  await f.file.close(f.service);
  const provider = scriptedModels([toolReply('read', { path: 'persisted' }), answer]);
  const reopened = await f.file.open(provider.models, { execution: f.decorate });
  const before = f.remote.metrics.sessions;
  assert.deepEqual((await readChat(reopened, fork.id)).execution, { target: { kind: 'ssh', machineId: f.host.id }, cwd: f.remote.directory });
  assert.equal(f.remote.metrics.sessions, before, 'reopen is metadata-only');
  assert.equal((await run(reopened, fork.id)).at(-1).tool.output, 'remote-current-files');
  const owned = await task(reopened, fork.id, OwnedConversationTask);
  assert.equal(owned.outcome.status, 'completed', JSON.stringify(owned));
  const child = owned.outcome.result.conversationId;
  assert.deepEqual(await reopened.harness.snapshot(ExecutionTargetDoc, child, C), { target: { kind: 'ssh', machineId: f.host.id } });
  assert.equal((await reopened.harness.snapshot(AgentDoc, child, C)).cwd, f.remote.directory);
  assert.deepEqual(owned.outcome.result.direct, { status: 'completed', result: { text: 'written through runtime.env()', cwd: f.remote.directory } });
  assert.equal(f.remote.children.size, 1, 'the direct task and inherited child borrow the retained environment');
  assert.equal(f.remote.metrics.sessions, before + 1);
});

test('production resolver preserves already admitted snapshots and rejects stale unadmitted facades after host edits', real, async (t) => {
  const f = await fixture(t, []);
  const id = await f.service.createChat();
  await select(f, id);
  const admitted = await f.composition.resolve(target(f.service, id, f.remote.directory), C);
  const stale = await f.composition.resolve(target(f.service, id, join(f.remote.directory, 'unadmitted')), C);
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
  assert.equal(f.admissions.at(-1).host, next);
  assert.equal(f.admissions.at(-1).auth.password, 'replacement-secret');
  assert.notEqual(subsequent, admitted);
  await f.file.close(f.service);
  assert.equal(f.remote.children.size, 0);
});

test('removed production hosts retain chat selection and fail without local fallback', real, async (t) => {
  const f = await fixture(t, [toolReply('write', { path: 'must-not-exist', content: 'forbidden fallback' }), answer]);
  const id = await f.service.createChat();
  await select(f, id);
  await f.hosts.remove(f.host.id);
  const result = await f.service.waitForSubmission(await f.service.send(id, 'Try the selected host.'));
  assert.ok(['done', 'error'].includes(result.status), JSON.stringify(result));
  const conversation = await readChat(f.service, id);
  assert.deepEqual(conversation.execution.target, { kind: 'ssh', machineId: f.host.id });
  const observable = JSON.stringify({ result, conversation });
  assert.match(observable, /removed|execution environment/i);
  assert.equal(f.remote.metrics.sessions, 0);
});

test('name-only edits preserve lazy admission and reuse an already connected environment', real, async (t) => {
  const f = await fixture(t, []);
  const id = await f.service.createChat();
  await select(f, id);
  const original = await f.composition.resolve(target(f.service, id, f.remote.directory), C);
  const renamed = await f.hosts.save({ ...f.host, name: 'Renamed before admission' });
  assert.equal(await f.composition.resolve(target(f.service, id, f.remote.directory), C), original);
  getOrThrow(await original.writeFile('after-rename', 'unchanged connection', C));
  await f.hosts.save({ ...renamed, name: 'Renamed after admission' });
  const borrowed = await f.composition.resolve(target(f.service, id, f.remote.directory), C);
  assert.equal(borrowed, original);
  assert.equal(getOrThrow(await borrowed.readTextFile('after-rename', C)), 'unchanged connection');
  assert.equal(f.remote.metrics.sessions, 1);
  assert.equal(f.admissions.length, 1);
});

test('changing accounts and returning to the original account keeps current cwd views in one filesystem namespace', real, async (t) => {
  const f = await fixture(t, []);
  const id = await f.service.createChat();
  await select(f, id);
  const original = await f.composition.resolve(target(f.service, id, f.remote.directory), C);
  const otherAccount = await f.hosts.save({ ...f.host, username: 'another-account' });
  const restoredAccount = await f.hosts.save({ ...otherAccount, username: f.host.username });
  assert.equal(restoredAccount.credentialRef, f.host.credentialRef, 'account edits preserve unchanged authentication and server trust');
  const current = await f.composition.resolve(target(f.service, id, f.remote.directory), C);
  const otherCwd = await f.composition.resolve(target(f.service, id, '/different/project'), C);
  assert.notEqual(current, original);
  assert.equal(current.id, `ssh:${restoredAccount.namespaceId}`);
  assert.equal(otherCwd.id, current.id, 'cwd views cannot mix a cached old namespace with the currently selected one');
  assert.equal(f.remote.metrics.sessions, 0);
});

test('credential and trust changes replace cached resolution even when the filesystem namespace is unchanged', real, async (t) => {
  const f = await fixture(t, []);
  const id = await f.service.createChat();
  await select(f, id);
  const original = await f.composition.resolve(target(f.service, id, f.remote.directory), C);
  getOrThrow(await original.writeFile('connection-settings', 'original', C));
  const changed = await f.hosts.save(f.host, { type: 'password', password: 'new-credential' });
  const replacement = await f.composition.resolve(target(f.service, id, f.remote.directory), C);
  assert.notEqual(replacement, original);
  assert.equal(replacement.id, original.id, 'credential changes preserve file namespace');
  getOrThrow(await replacement.writeFile('connection-settings', 'replacement', C));
  assert.equal(f.admissions.at(-1).auth.password, 'new-credential');
  assert.equal(f.admissions.at(-1).host, changed);
  assert.equal(getOrThrow(await original.readTextFile('connection-settings', C)), 'replacement', 'admitted old work retains its original connection');
  await f.hosts.forgetHostKey(changed);
  const untrusted = await f.composition.resolve(target(f.service, id, f.remote.directory), C);
  assert.notEqual(untrusted, replacement);
  assert.equal(untrusted.id, replacement.id);
  await f.hosts.remove(f.host.id);
  await assert.rejects(f.composition.resolve(target(f.service, id, f.remote.directory), C), /removed/);
  assert.equal(getOrThrow(await original.readTextFile('connection-settings', C)), 'replacement',
    'removal blocks new borrowing without revoking work admitted before the change');
  assert.equal(f.remote.metrics.sessions, 2, 'unadmitted replacement resolution is still lazy');
  await f.file.close(f.service);
  assert.equal(f.remote.children.size, 0);
  assert.equal(f.remote.metrics.closes, 2, 'shutdown closes both admitted connections');
});

test('production composition shutdown seals direct owners and drains real daemon sessions', real, async (t) => {
  const f = await fixture(t, []);
  const id = await f.service.createChat();
  await select(f, id);
  const env = await f.composition.resolve(target(f.service, id, f.remote.directory), C);
  const dormant = await f.composition.resolve(target(f.service, id, '/unused/project'), C);
  getOrThrow(await env.writeFile('owner', 'active', C));
  assert.equal(f.remote.children.size, 1);
  f.composition.stop();
  assert.equal((await env.writeFile('stale', '', C)).ok, false);
  assert.equal((await dormant.fileInfo('.', C)).ok, false, 'shutdown seals unresolved connection owners too');
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
  assert.deepEqual((await readChat(f.service, id)).execution, { target: { kind: 'ssh', machineId: f.host.id }, cwd: f.remote.directory });
  assert.equal((await f.service.harness.snapshot(AgentDoc, Number(id), C)).cwd, f.remote.directory);
  assert.deepEqual(await f.service.harness.snapshot(ExecutionTargetDoc, Number(id), C), { target: { kind: 'ssh', machineId: f.host.id } });
});

test('native admitted channel refuses missing SSH trust before constructing a transport', () => {
  assert.throws(() => admittedSshChannel({ host: {}, auth: { type: 'password', password: 'never-connect' } }), /verify.*SSH host key/);
});

test('combined execution and model settings capture caller drafts before asynchronous admission', real, async (t) => {
  const f = await fixture(t, []);
  const id = await f.service.createChat();
  const expected = structuredClone((await readChat(f.service, id)).settings);
  const draft = structuredClone(expected);
  const pending = f.service.updateExecution(id, { target: { kind: 'ssh', machineId: f.host.id }, cwd: f.remote.directory }, draft);
  draft.model.modelId = 'mutated-after-validation';
  await pending;
  assert.deepEqual((await readChat(f.service, id)).settings, expected);
});

test('production remote filesystem identity follows accepted server identity and remains stable across cwd changes', real, async (t) => {
  const f = await fixture(t, []);
  const id = await f.service.createChat();
  await select(f, id);
  const before = await f.composition.resolve(target(f.service, id, f.remote.directory), C);
  const otherCwd = await f.composition.resolve(target(f.service, id, '/different/project'), C);
  assert.equal(before.id, otherCwd.id);
  await f.hosts.acceptHostKey(f.host, { algorithm: 'ssh-ed25519', fingerprint: 'SHA256:replacement', publicKey: 'replacement' });
  const replaced = await f.composition.resolve(target(f.service, id, f.remote.directory), C);
  assert.notEqual(before.id, replaced.id);
  assert.equal(f.remote.metrics.sessions, 0, 'checking namespace and cwd performs no SSH admission');
  assert.notEqual(before, otherCwd, 'cwd is part of environment identity, without changing filesystem identity');
  await f.file.close(f.service);
});
