import assert from 'node:assert/strict';
import test from 'node:test';
import { BACKGROUND_CONTEXT, withAbortSignal } from '@earendil-works/chord/context';
import { getCurrentTools } from '@earendil-works/pi-ai/utils/transcript';
import { scriptedModels } from './helpers/scripted-models.mjs';
import { integrationDatabase, toolReply, toolRound, until } from './helpers/bash-integration.mjs';
import { installBashBrowserHooks } from './helpers/bash-browser-hooks.mjs';

const hooks = installBashBrowserHooks();
test.after(() => hooks.deregister());
const { DurableChatService } = await import('../src/pi/chat-service.ts');
const { WorkspaceDoc } = await import('../src/pi/workspace/document.ts');
const { WorkspaceFileSystem } = await import('../src/pi/workspace/filesystem/index.ts');
const { WorkspaceRuntime } = await import('../src/pi/workspace/runtime.ts');
const { WorkspaceExecutionEnv, createWorkspaceExecutionEnv, acquireWorkspaceExecutionScope } = await import('../src/pi/workspace/execution-env.ts');
const { createWorkspaceExtension } = await import('../src/pi/workspace/extension.ts');
const { createBashEngine } = await import('../src/pi/bash/engine/index.ts');
const context = BACKGROUND_CONTEXT;
const answer = { chunks: ['Done.'] };
const rows = (service, id) => service.getConversation(id).messages.filter((message) => message.tool);
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const policy = { scope: acquireWorkspaceExecutionScope, promptFacts: () => [] };
const wrappedTool = (extension, name) => {
  let tool = extension.tools.find((candidate) => candidate.name === name);
  for (const wrapper of extension.wraps ?? []) if (wrapper.tool === name) tool = wrapper.wrap(tool);
  return tool;
};
const deferred = () => {
  let resolve;
  const promise = new Promise((done) => { resolve = done; });
  return { promise, resolve };
};

async function run(service, id) {
  const submission = await service.send(id, 'Perform the requested workspace operation.');
  assert.equal((await service.waitForSubmission(submission)).status, 'done');
  return rows(service, id);
}

test('workspace registrations make reads safe and all mutations unsafe and sequential', async () => {
  const runtime = new WorkspaceRuntime(async () => { throw new Error('Registration must remain lazy'); });
  try {
    const tools = createWorkspaceExtension(policy).tools;
    assert.deepEqual(tools.map(({ name, replay, executionMode }) => ({ name, replay, executionMode })), [
      { name: 'bash', replay: 'unsafe', executionMode: 'sequential' },
      { name: 'read', replay: 'safe', executionMode: 'sequential' },
      { name: 'write', replay: 'unsafe', executionMode: 'sequential' },
      { name: 'edit', replay: 'unsafe', executionMode: 'sequential' },
    ]);
    assert.equal(typeof tools.find(({ name }) => name === 'edit').prepareArguments, 'function');
  } finally { await runtime.close(); }
});

test('one real Pi tool round shares bytes in write, bash, edit and read order and survives reopen', { timeout: 15_000 }, async (t) => {
  const file = await integrationDatabase(t, DurableChatService);
  const provider = scriptedModels([toolRound([
    { name: 'write', arguments: { path: 'nested/notes', content: 'original\nsecond\n' } },
    { name: 'bash', arguments: { command: "printf 'shell\n' >> nested/notes; cat nested/notes" } },
    { name: 'edit', arguments: { path: 'nested/notes', edits: [{ oldText: 'original', newText: 'edited' }] } },
    { name: 'read', arguments: { path: '/workspace/nested/notes' } },
  ]), answer]);
  const first = await file.open(provider.models);
  const id = await first.createChat();
  const workspace = await file.workspace(first, id, WorkspaceDoc);
  const tools = await run(first, id);
  assert.deepEqual(tools.map(({ tool }) => [tool.name, tool.status]), [
    ['write', 'completed'], ['bash', 'completed'], ['edit', 'completed'], ['read', 'completed'],
  ]);
  assert.match(tools[1].tool.output, /original\nsecond\nshell/);
  assert.equal(tools[3].tool.output, 'edited\nsecond\nshell\n');
  const offered = getCurrentTools(provider.requests[0].context.messages).map(({ name }) => name);
  for (const name of ['bash', 'read', 'write', 'edit']) assert.ok(offered.includes(name));
  await file.close(first);
  const second = await file.open(scriptedModels([toolReply('read', { path: 'nested/notes' }), answer]).models);
  assert.equal((await file.workspace(second, id, WorkspaceDoc)).id, workspace.id);
  assert.equal((await run(second, id)).at(-1).tool.output, 'edited\nsecond\nshell\n');
});

test('invalid file paths and paging are rejected by Pi before opening workspace storage', { timeout: 15_000 }, async (t) => {
  const file = await integrationDatabase(t, DurableChatService);
  const invalid = [
    { path: 'missing', offset: 0 }, { path: 'missing', offset: 1.5 },
    { path: 'missing', limit: 0 }, { path: 'missing', limit: -1 }, { path: 'missing', limit: 0.5 }, { path: 'missing', limit: 1.5 },
    { path: 'missing', offset: true }, { path: 'missing', offset: null },
    { path: 'missing', offset: '1.5' }, { path: 'missing', offset: '2' },
    { path: 'missing', limit: true }, { path: 'missing', limit: null },
    { path: 'missing', limit: '1.5' }, { path: 'missing', limit: '2' },
    { path: '' }, { path: 'x'.repeat(4097) },
  ];
  const provider = scriptedModels([toolRound(invalid.map((args) => ({ name: 'read', arguments: args }))), answer]);
  const service = await file.open(provider.models);
  const id = await service.createChat();
  const tools = await run(service, id);
  assert.equal(tools.length, invalid.length);
  for (const { tool } of tools) assert.equal(tool.status, 'error', tool.output);
  assert.equal(file.metrics.opened, 0, `argument validation precedes workspace invocation: ${tools.map(({ tool }, index) => `${index}: ${tool.output.slice(0, 160)}`).join('; ')}`);
});

test('legacy edit argument preparation survives the wrapper and committed Pi execution', { timeout: 15_000 }, async (t) => {
  const file = await integrationDatabase(t, DurableChatService);
  const provider = scriptedModels([toolRound([
    { name: 'write', arguments: { path: 'legacy', content: 'alpha beta' } },
    { name: 'edit', arguments: { path: 'legacy', oldText: 'alpha', newText: 'first' } },
    { name: 'edit', arguments: { path: 'legacy', edits: JSON.stringify({ oldText: 'beta', newText: 'last' }) } },
    { name: 'read', arguments: { path: 'legacy' } },
  ]), answer]);
  const service = await file.open(provider.models);
  const tools = await run(service, await service.createChat());
  assert.deepEqual(tools.map(({ tool }) => tool.status), ['completed', 'completed', 'completed', 'completed']);
  assert.equal(tools.at(-1).tool.output, 'first last');
});

for (const scenario of [
  { name: 'missing match', content: 'alpha beta', edits: [{ oldText: 'alpha', newText: 'changed' }, { oldText: 'absent', newText: 'other' }] },
  { name: 'ambiguous match', content: 'alpha alpha', edits: [{ oldText: 'alpha', newText: 'changed' }] },
  { name: 'overlapping replacements', content: 'alpha beta', edits: [{ oldText: 'alpha beta', newText: 'changed' }, { oldText: 'beta', newText: 'other' }] },
]) test(`failed edit batch leaves original contents unchanged: ${scenario.name}`, { timeout: 15_000 }, async (t) => {
  const file = await integrationDatabase(t, DurableChatService);
  const provider = scriptedModels([toolRound([
    { name: 'write', arguments: { path: 'original', content: scenario.content } },
    { name: 'edit', arguments: { path: 'original', edits: scenario.edits } },
    { name: 'read', arguments: { path: 'original' } },
  ]), answer]);
  const service = await file.open(provider.models);
  const tools = await run(service, await service.createChat());
  assert.equal(tools[1].tool.status, 'error');
  assert.equal(tools[2].tool.output, scenario.content);
});

test('a competing bash runtime cannot interleave while the real SDK edit is between reading and writing', { timeout: 15_000 }, async (t) => {
  const file = await integrationDatabase(t, DurableChatService);
  const provider = scriptedModels([toolReply('edit', { path: 'race', edits: [{ oldText: 'original', newText: 'edited' }] }), answer]);
  const service = await file.open(provider.models);
  const id = await service.createChat();
  const workspace = await file.workspace(service, id, WorkspaceDoc);
  const competing = new WorkspaceRuntime(file.openWorkspaceDatabase);
  await competing.run(workspace.id, undefined, ({ files }) => files.writeFile('/race', 'original'));
  const release = deferred();
  const originalOpen = WorkspaceExecutionEnv.prototype.openBinaryReader;
  let paused = false;
  WorkspaceExecutionEnv.prototype.openBinaryReader = async function (...args) {
    const result = await originalOpen.apply(this, args);
    if (result.ok && args[0] === '/workspace/race') {
      const read = result.value.read.bind(result.value);
      result.value.read = async (...readArgs) => {
        const source = await read(...readArgs);
        if (!paused && source.ok) {
          paused = true;
          await release.promise;
        }
        return source;
      };
    }
    return result;
  };
  let shell;
  try {
    const submission = await service.send(id, 'Edit the file.');
    await until(() => paused, 'tool reached the instrumented filesystem boundary');
    let shellStarted = false;
    shell = competing.run(workspace.id, undefined, async ({ mounted, signal }) => {
      shellStarted = true;
      return createBashEngine(mounted, 1000).exec("printf '|bash' >> /workspace/race", { signal });
    });
    await delay(25);
    assert.equal(shellStarted, false, 'the whole SDK edit owns the shared workspace queue');
    release.resolve();
    assert.equal((await service.waitForSubmission(submission)).status, 'done');
    assert.equal((await shell).exitCode, 0);
    await competing.run(workspace.id, undefined, async ({ files }) => {
      assert.equal(await files.readFile('/race'), 'edited|bash');
    });
  } finally {
    release.resolve();
    WorkspaceExecutionEnv.prototype.openBinaryReader = originalOpen;
    await shell?.catch(() => {});
    await competing.close();
  }
});

for (const name of ['write', 'edit']) test(`unsafe ${name} is not replayed after file commit and shutdown before tool result`, { timeout: 20_000 }, async (t) => {
  const file = await integrationDatabase(t, DurableChatService);
  const args = name === 'write' ? { path: 'recovery', content: 'committed' }
    : { path: 'recovery', edits: [{ oldText: 'original', newText: 'committed' }] };
  const first = await file.open(scriptedModels([toolReply(name, args), answer]).models);
  const id = await first.createChat();
  const workspace = await file.workspace(first, id, WorkspaceDoc);
  const database = await file.openWorkspaceDatabase();
  const observer = await WorkspaceFileSystem.open(database, workspace.id);
  await observer.writeFile('/recovery', 'original');
  const release = deferred();
  const originalWrite = WorkspaceExecutionEnv.prototype.writeFile;
  let paused = false;
  WorkspaceExecutionEnv.prototype.writeFile = async function (...values) {
    const result = await originalWrite.apply(this, values);
    if (!paused && result.ok && values[0] === '/workspace/recovery') {
      paused = true;
      await release.promise;
    }
    return result;
  };
  try {
    const submission = await first.send(id, 'Change the file.');
    await until(() => paused, 'tool reached the instrumented filesystem boundary');
    assert.equal(await observer.readFile('/recovery'), 'committed');
    const closing = file.close(first);
    release.resolve();
    await closing;
    WorkspaceExecutionEnv.prototype.writeFile = originalWrite;
    await observer.writeFile('/recovery', 'original external change');
    const second = await file.open(scriptedModels([answer]).models);
    await second.resume();
    await second.waitForSubmission(submission);
    const interrupted = rows(second, id).find(({ tool }) => tool.name === name && tool.status === 'error');
    assert.ok(interrupted);
    assert.match(interrupted.tool.output, /interrupted|partially/i);
    assert.equal(await observer.readFile('/recovery'), 'original external change', 'recovery did not repeat the committed mutation');
  } finally {
    release.resolve();
    WorkspaceExecutionEnv.prototype.writeFile = originalWrite;
    await observer.drain();
    await database.close();
  }
});

test('the wrapper preserves caller cancellation after the SDK post-write check', async (t) => {
  const file = await integrationDatabase(t, DurableChatService);
  const runtime = new WorkspaceRuntime(file.openWorkspaceDatabase);
  const tool = wrappedTool(createWorkspaceExtension(policy), 'write');
  const controller = new AbortController();
  const reason = new Error('cancel after committed write');
  const originalWrite = WorkspaceExecutionEnv.prototype.writeFile;
  WorkspaceExecutionEnv.prototype.writeFile = async function (...args) {
    const result = await originalWrite.apply(this, args);
    controller.abort(reason);
    return result;
  };
  try {
    // Only the already-committed identity is supplied here; filesystem and SDK execution are real.
    const api = { conversationId: 1, outputWindow: undefined, env: createWorkspaceExecutionEnv(runtime, 'post-write-cancel', '/workspace') };
    await assert.rejects(tool.execute({ path: 'saved', content: 'committed' }, api,
      withAbortSignal(controller.signal, context)), (error) => error === reason);
    await runtime.run('post-write-cancel', undefined, async ({ files }) => {
      assert.equal(await files.readFile('/saved'), 'committed');
    });
  } finally {
    WorkspaceExecutionEnv.prototype.writeFile = originalWrite;
    await runtime.close();
  }
});
