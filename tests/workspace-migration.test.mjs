import assert from 'node:assert/strict';
import test from 'node:test';
import { BACKGROUND_CONTEXT } from '@earendil-works/chord/context';
import { getCurrentTools } from '@earendil-works/pi-ai/utils/transcript';
import { AgentDoc, Harness, createRegistry, defineDoc } from '@earendil-works/pi-durable';
import { scriptedModels } from './helpers/scripted-models.mjs';
import { integrationDatabase, toolReply } from './helpers/bash-integration.mjs';
import { installBashBrowserHooks } from './helpers/bash-browser-hooks.mjs';

const hooks = installBashBrowserHooks();
test.after(() => hooks.deregister());
const { ChatMetadataDoc, DurableChatService } = await import('../src/pi/chat-service.ts');
const { WorkspaceDoc, WORKSPACE_TOOLS, WORKSPACE_CAPABILITY_REVISION, migrateWorkspaceCapabilities } =
  await import('../src/pi/workspace/document.ts');
const { WorkspaceFileSystem } = await import('../src/pi/workspace/filesystem/index.ts');
const context = BACKGROUND_CONTEXT;
const answer = { chunks: ['Done.'] };
const LegacyWorkspaceDoc = defineDoc({
  kind: 'app.bash.workspace', version: 1, scope: 'conversation', history: 'latest', fork: 'initial',
  initial: () => ({ id: '', origin: 'new' }),
});

async function rawHarness(file, models, options = {}) {
  return Harness.open(await file.openStorage(), { models, registry: createRegistry(), ...options }, context);
}

async function run(service, id) {
  const submission = await service.send(id, 'Inspect the workspace.');
  assert.equal((await service.waitForSubmission(submission)).status, 'done');
  return service.getConversation(id).messages.filter((message) => message.tool).at(-1);
}

for (const selection of [
  {
    name: 'exact lists', initial: { extensions: ['mobile-chat'], tools: ['add_numbers', 'bash'] },
    expected: { extensions: ['mobile-chat', 'local-bash'], tools: ['add_numbers', 'bash', 'read', 'write', 'edit'] },
  },
  {
    name: 'remove lists', initial: {
      extensions: { remove: ['local-bash', 'unrelated-extension'] }, tools: { remove: ['bash', 'read', 'write', 'edit', 'add_numbers'] },
    },
    expected: { extensions: { remove: ['unrelated-extension'] }, tools: { remove: ['add_numbers'] } },
  },
]) test(`version 1 migration preserves workspace bytes and unrelated settings while adopting tools: ${selection.name}`, { timeout: 15_000 }, async (t) => {
  const file = await integrationDatabase(t, DurableChatService);
  const workspaceId = `legacy-${selection.name.replace(' ', '-')}`;
  const provider = scriptedModels([toolReply('read', { path: 'preserved' }), answer]);
  const seed = await rawHarness(file, provider.models, {
    async conversationCreated(tx, conversation) {
      (await tx.doc(ChatMetadataDoc, conversation.id)).createdAt = 123456;
      Object.assign(await tx.doc(LegacyWorkspaceDoc, conversation.id), { id: workspaceId, origin: 'existing' });
      Object.assign(await tx.doc(AgentDoc, conversation.id), selection.initial, { instructions: 'Preserve this instruction.' });
    },
  });
  const conversation = await seed.createConversation({ ownership: { kind: 'ownerless' },
    agent: { model: { provider: 'openai-codex', modelId: 'gpt-6-sol' }, thinkingLevel: 'off' } }, context);
  await seed.close(context);
  const database = await file.openWorkspaceDatabase();
  try {
    const files = await WorkspaceFileSystem.open(database, workspaceId);
    await files.writeFile('/preserved', 'bytes from the bash-only workspace');
  } finally { await database.close(); }
  const id = String(conversation.id);
  const service = await file.open(provider.models);
  assert.deepEqual(await file.workspace(service, id, WorkspaceDoc), {
    id: workspaceId, origin: 'existing', capabilityRevision: WORKSPACE_CAPABILITY_REVISION,
  });
  assert.equal((await run(service, id)).tool.output, 'bytes from the bash-only workspace');
  const offered = getCurrentTools(provider.requests[0].context.messages).map(({ name }) => name);
  for (const tool of WORKSPACE_TOOLS) assert.ok(offered.includes(tool), tool);
  if (selection.name === 'remove lists') assert.equal(offered.includes('add_numbers'), false);
  await file.close(service);
  const verify = await rawHarness(file, provider.models);
  try {
    const agent = await verify.snapshot(AgentDoc, conversation.id, context);
    assert.deepEqual(agent.extensions, selection.expected.extensions);
    assert.deepEqual(agent.tools, selection.expected.tools);
    assert.equal(agent.instructions, 'Preserve this instruction.');
    assert.deepEqual(agent.model, { provider: 'openai-codex', modelId: 'gpt-6-sol' });
    assert.equal(agent.thinkingLevel, 'off');
    assert.equal((await verify.snapshot(ChatMetadataDoc, conversation.id, context)).createdAt, 123456);
    assert.equal((await verify.snapshot(WorkspaceDoc, conversation.id, context)).id, workspaceId);
  } finally { await verify.close(context); }
});

for (const selection of [
  { name: 'exact tool selection', settings: { extensions: ['mobile-chat', 'local-bash'], tools: ['add_numbers', 'read'] }, expected: ['add_numbers', 'read'] },
  { name: 'tool exclusions', settings: { extensions: { remove: ['unrelated-extension'] }, tools: { remove: ['write', 'edit', 'add_numbers'] } }, expected: ['bash', 'read'] },
  { name: 'extension exclusion', settings: { extensions: { remove: ['local-bash'] }, tools: { remove: [] } }, expected: ['add_numbers'] },
]) test(`capability revision prevents reopening from undoing later explicit ${selection.name}`, { timeout: 15_000 }, async (t) => {
  const file = await integrationDatabase(t, DurableChatService);
  const initial = await file.open(scriptedModels([]).models);
  const id = await initial.createChat();
  const workspace = await file.workspace(initial, id, WorkspaceDoc);
  assert.equal(workspace.capabilityRevision, WORKSPACE_CAPABILITY_REVISION);
  await file.close(initial);
  const editor = await rawHarness(file, scriptedModels([]).models);
  try {
    await editor.commit(async (tx) => {
      Object.assign(await tx.doc(AgentDoc, Number(id)), selection.settings, { instructions: 'A deliberate later selection.' });
    }, context);
  } finally { await editor.close(context); }
  // Reopen twice: this must be a completed migration, not a launch-time force-enable.
  for (let attempt = 0; attempt < 2; attempt++) {
    const provider = scriptedModels([answer]);
    const service = await file.open(provider.models);
    assert.deepEqual(await file.workspace(service, id, WorkspaceDoc), workspace);
    await run(service, id);
    assert.deepEqual(getCurrentTools(provider.requests[0].context.messages).map(({ name }) => name).sort(), [...selection.expected].sort());
    await file.close(service);
  }
  const verify = await rawHarness(file, scriptedModels([]).models);
  try {
    const agent = await verify.snapshot(AgentDoc, Number(id), context);
    assert.deepEqual(agent.extensions, selection.settings.extensions);
    assert.deepEqual(agent.tools, selection.settings.tools);
    assert.equal(agent.instructions, 'A deliberate later selection.');
  } finally { await verify.close(context); }
});

test('a historical conversation fork gets a fresh capable workspace while parent bytes and identity survive', { timeout: 15_000 }, async (t) => {
  const file = await integrationDatabase(t, DurableChatService);
  const first = await file.open(scriptedModels([toolReply('write', { path: 'parent-file', content: 'parent bytes' }), answer]).models);
  const parentId = await first.createChat();
  await run(first, parentId);
  const parentWorkspace = await file.workspace(first, parentId, WorkspaceDoc);
  await file.close(first);
  const raw = await rawHarness(file, scriptedModels([]).models, {
    async conversationCreated(tx, conversation) {
      (await tx.doc(ChatMetadataDoc, conversation.id)).createdAt = Date.now();
      await migrateWorkspaceCapabilities(tx, conversation.id, conversation.parent ? 'fork' : 'new');
    },
  });
  let forkId;
  try {
    const parent = await raw.conversation(Number(parentId), context);
    const entries = await parent.entries({}, 100, undefined, context);
    forkId = String((await parent.fork(entries.items.at(-1).id, { ownership: { kind: 'ownerless' } }, context)).id);
    const childWorkspace = await raw.snapshot(WorkspaceDoc, Number(forkId), context);
    assert.notEqual(childWorkspace.id, parentWorkspace.id);
    assert.equal(childWorkspace.origin, 'fork');
    assert.equal(childWorkspace.capabilityRevision, WORKSPACE_CAPABILITY_REVISION);
  } finally { await raw.close(context); }
  const provider = scriptedModels([
    toolReply('read', { path: 'parent-file' }), answer,
    toolReply('read', { path: 'parent-file' }), answer,
  ]);
  const service = await file.open(provider.models);
  const fork = await run(service, forkId);
  assert.equal(fork.tool.status, 'error');
  assert.match(fork.tool.output, /ENOENT/);
  assert.match(JSON.stringify(provider.requests[0].context.messages.filter(({ role }) => role === 'system')), /fork.*empty|inherited.*NOT copied/i);
  assert.equal((await run(service, parentId)).tool.output, 'parent bytes');
  assert.deepEqual(await file.workspace(service, parentId, WorkspaceDoc), parentWorkspace);
});
