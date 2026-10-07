import assert from 'node:assert/strict';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import test from 'node:test';
import { BACKGROUND_CONTEXT } from '@earendil-works/chord/context';
import { getCurrentTools } from '@earendil-works/pi-ai/utils/transcript';
import { scriptedModels } from './helpers/scripted-models.mjs';
import { integrationDatabase, toolReply, toolRound } from './helpers/bash-integration.mjs';
import { readChat } from './helpers/chat-view.mjs';
import { installBashBrowserHooks } from './helpers/bash-browser-hooks.mjs';

const hooks = installBashBrowserHooks();
test.after(() => hooks.deregister());
const { DurableChatService } = await import('../src/pi/chat-service.ts');
const { WorkspaceDoc } = await import('../src/pi/workspace/document.ts');
const { createWorkspaceExtension } = await import('../src/pi/workspace/extension.ts');
const { EDIT_DIFF_UNITS } = await import('../src/pi/workspace/tools.ts');
const context = BACKGROUND_CONTEXT;
const answer = { chunks: ['Done.'] };
const rows = async (service, id) => (await readChat(service, id)).messages.filter((message) => message.tool);

async function run(service, id) {
  const submission = await service.send(id, 'Perform the requested workspace operation.');
  assert.equal((await service.waitForSubmission(submission)).status, 'done');
  return rows(service, id);
}

/** A chat and its workspace directory on disk. */
async function chat(t, script) {
  const file = await integrationDatabase(t, DurableChatService);
  const provider = scriptedModels(script);
  const service = await file.open(provider.models);
  const id = await service.createChat();
  const workspace = await file.workspace(service, id, WorkspaceDoc);
  // The app creates the directory on first use; fixtures written before that need it now.
  const directory = join(file.workspaceRoot, workspace.id);
  await mkdir(directory, { recursive: true });
  return { file, provider, service, id, directory };
}

test('reads are replay-safe, mutations are not, and every tool runs its round one call at a time', () => {
  const tools = createWorkspaceExtension({ promptFacts: () => [] }).tools;
  assert.deepEqual(tools.map(({ name, replay, executionMode }) => ({ name, replay, executionMode })), [
    { name: 'read', replay: 'safe', executionMode: 'sequential' },
    { name: 'write', replay: 'unsafe', executionMode: 'sequential' },
    { name: 'edit', replay: 'unsafe', executionMode: 'sequential' },
    { name: 'bash', replay: 'unsafe', executionMode: 'sequential' },
  ]);
});

test('one real Pi tool round shares bytes in write, bash, edit and read order and survives reopen',
  { timeout: 15_000 }, async (t) => {
  const { file, provider, service, id, directory } = await chat(t, [toolRound([
    { name: 'write', arguments: { path: 'nested/notes', content: 'original\nsecond\n' } },
    { name: 'bash', arguments: { command: "printf 'shell\n' >> nested/notes; cat nested/notes" } },
    { name: 'edit', arguments: { path: 'nested/notes', edits: [{ oldText: 'original', newText: 'edited' }] } },
    { name: 'read', arguments: { path: '/workspace/nested/notes' } },
  ]), answer]);
  const tools = await run(service, id);
  assert.deepEqual(tools.map(({ tool }) => [tool.name, tool.status]), [
    ['write', 'completed'], ['bash', 'completed'], ['edit', 'completed'], ['read', 'completed'],
  ]);
  assert.match(tools[1].tool.output, /original\nsecond\nshell/);
  assert.equal(tools[3].tool.output, 'edited\nsecond\nshell\n');
  assert.equal(await readFile(join(directory, 'nested/notes'), 'utf8'), 'edited\nsecond\nshell\n');
  const offered = getCurrentTools(provider.requests[0].context.messages).map(({ name }) => name);
  for (const name of ['bash', 'read', 'write', 'edit']) assert.ok(offered.includes(name));
  await file.close(service);
  const second = await file.open(scriptedModels([toolReply('read', { path: 'nested/notes' }), answer]).models);
  assert.equal((await run(second, id)).at(-1).tool.output, 'edited\nsecond\nshell\n');
});

test('chats cannot see each other’s files', { timeout: 15_000 }, async (t) => {
  const file = await integrationDatabase(t, DurableChatService);
  const provider = scriptedModels([
    toolReply('write', { path: 'secret', content: 'first chat only' }), answer,
    toolRound([
      { name: 'read', arguments: { path: 'secret' } },
      { name: 'bash', arguments: { command: 'ls -a /workspace' } },
    ]),
    answer,
  ]);
  const service = await file.open(provider.models);
  const first = await service.createChat();
  const second = await service.createChat();
  await run(service, first);
  const tools = await run(service, second);
  assert.equal(tools[0].tool.status, 'error');
  assert.match(tools[0].tool.output, /ENOENT/);
  assert.doesNotMatch(tools[1].tool.output, /secret/);
});

test('legacy edit argument shapes still work through the bounded edit', { timeout: 15_000 }, async (t) => {
  const { service, id } = await chat(t, [toolRound([
    { name: 'write', arguments: { path: 'legacy', content: 'alpha beta' } },
    { name: 'edit', arguments: { path: 'legacy', oldText: 'alpha', newText: 'first' } },
    { name: 'edit', arguments: { path: 'legacy', edits: JSON.stringify({ oldText: 'beta', newText: 'last' }) } },
    { name: 'read', arguments: { path: 'legacy' } },
  ]), answer]);
  const tools = await run(service, id);
  assert.deepEqual(tools.map(({ tool }) => tool.status), ['completed', 'completed', 'completed', 'completed']);
  assert.equal(tools.at(-1).tool.output, 'first last');
});

for (const scenario of [
  { name: 'missing match', content: 'alpha beta',
    edits: [{ oldText: 'alpha', newText: 'changed' }, { oldText: 'absent', newText: 'other' }] },
  { name: 'ambiguous match', content: 'alpha alpha', edits: [{ oldText: 'alpha', newText: 'changed' }] },
  { name: 'overlapping replacements', content: 'alpha beta',
    edits: [{ oldText: 'alpha beta', newText: 'changed' }, { oldText: 'beta', newText: 'other' }] },
]) test(`failed edit batch leaves original contents unchanged: ${scenario.name}`, { timeout: 15_000 }, async (t) => {
  const { service, id } = await chat(t, [toolRound([
    { name: 'write', arguments: { path: 'original', content: scenario.content } },
    { name: 'edit', arguments: { path: 'original', edits: scenario.edits } },
    { name: 'read', arguments: { path: 'original' } },
  ]), answer]);
  const tools = await run(service, id);
  assert.equal(tools[1].tool.status, 'error');
  assert.equal(tools[2].tool.output, scenario.content);
});

test('read refuses images, edit refuses invalid UTF-8, and neither changes bytes', { timeout: 15_000 }, async (t) => {
  const png = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=';
  const { provider, service, id, directory } = await chat(t, [toolRound([
    { name: 'bash', arguments: {
      command: `printf '${png}' | base64 -d > image.png; printf AP9B | base64 -d > bytes.bin`,
    } },
    { name: 'read', arguments: { path: 'image.png' } },
    { name: 'read', arguments: { path: 'bytes.bin' } },
    { name: 'edit', arguments: { path: 'bytes.bin', edits: [{ oldText: 'A', newText: 'X' }] } },
  ]), answer]);
  const tools = await run(service, id);
  assert.equal(tools[1].tool.status, 'error');
  assert.match(tools[1].tool.output, /image\/png.*not supported/);
  assert.equal(tools[2].tool.output, '\0�A');
  assert.equal(tools[3].tool.status, 'error');
  assert.match(tools[3].tool.output, /Error code: invalid/);
  assert.deepEqual([...await readFile(join(directory, 'bytes.bin'))], [0x00, 0xff, 0x41]);
  const imageResult = provider.requests[1].context.messages
    .find((message) => message.role === 'toolResult' && message.toolName === 'read');
  assert.ok(imageResult.content.every((part) => part.type === 'text'),
    'unsupported images do not turn into attachments');
});

test('an edit card keeps a bounded diff and the transcript stores no full patch', { timeout: 15_000 }, async (t) => {
  const lines = Array.from({ length: 2000 }, (_, index) => `line ${index} ${'z'.repeat(40)}`);
  const { service, id } = await chat(t, [toolRound([
    { name: 'write', arguments: { path: 'wide.txt', content: `${lines.join('\n')}\n` } },
    { name: 'edit', arguments: { path: 'wide.txt',
      edits: [{ oldText: lines.join('\n'), newText: lines.join('\n').toUpperCase() }] } },
  ]), answer]);
  const tools = await run(service, id);
  const card = tools[1].tool.file;
  assert.equal(tools[1].tool.status, 'completed');
  assert.equal(card.diffTruncated, true);
  assert.ok(card.diff.length <= EDIT_DIFF_UNITS);
  assert.equal(card.firstChangedLine, 1);
  const conversation = await service.harness.conversation(Number(id), context);
  const entries = (await conversation.entries({}, 50, undefined, context)).items;
  const stored = entries.flatMap((entry) => entry.model ?? [])
    .find((message) => message.role === 'toolResult' && message.toolName === 'edit');
  assert.deepEqual(Object.keys(stored.details).sort(), ['diff', 'diffTruncated', 'firstChangedLine']);
  assert.ok(JSON.stringify(stored.details).length < 2 * EDIT_DIFF_UNITS);
});
