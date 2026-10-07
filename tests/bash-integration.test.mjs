import assert from 'node:assert/strict';
import test from 'node:test';
import { BACKGROUND_CONTEXT } from '@earendil-works/chord/context';
import { getCurrentTools } from '@earendil-works/pi-ai/utils/transcript';
import { Harness, createRegistry } from '@earendil-works/pi-durable';
import { scriptedModels } from './helpers/scripted-models.mjs';
import { bashReply, integrationDatabase, toolRows, until } from './helpers/bash-integration.mjs';
import { installBashBrowserHooks } from './helpers/bash-browser-hooks.mjs';

const hooks = installBashBrowserHooks();
test.after(() => hooks.deregister());
const { ChatMetadataDoc, DurableChatService } = await import('../src/pi/chat-service.ts');
const { WorkspaceDoc, ensureWorkspaceDoc } = await import('../src/pi/workspace/document.ts');
const { WorkspaceFileSystem } = await import('../src/pi/workspace/filesystem/index.ts');
const context = BACKGROUND_CONTEXT;
const answer = { chunks: ['Done.'] };

async function run(service, id, prompt = 'Perform the requested local operation.') {
  const submission = await service.send(id, prompt);
  assert.equal((await service.waitForSubmission(submission)).status, 'done');
  return toolRows(service, id).at(-1);
}

test('bash is centrally offered without opening workspace storage until execution', async (t) => {
  const file = await integrationDatabase(t, DurableChatService);
  const provider = scriptedModels([answer]);
  const service = await file.open(provider.models);
  const id = await service.createChat();
  const workspace = await file.workspace(service, id, WorkspaceDoc);
  assert.ok(workspace.id);
  await service.waitForSubmission(await service.send(id, 'Hello.'));
  assert.ok(getCurrentTools(provider.requests[0].context.messages).some(({ name }) => name === 'bash'));
  assert.equal(file.metrics.opened, 0, 'model-only use needs no workspace connection');
  await file.close(service);
  const reopened = await file.open(scriptedModels([]).models);
  assert.equal((await file.workspace(reopened, id, WorkspaceDoc)).id, workspace.id);
});

test('real shell binary writes, links and Unicode names survive service and SQLite reopen', { timeout: 15_000 }, async (t) => {
  const file = await integrationDatabase(t, DurableChatService);
  const provider = scriptedModels([bashReply("printf AP9B | base64 -d > bytes.bin; ln bytes.bin linked.bin; printf 'hello 世界' > 'café-😀.txt'; base64 linked.bin"), answer]);
  const first = await file.open(provider.models);
  const id = await first.createChat();
  const workspace = await file.workspace(first, id, WorkspaceDoc);
  assert.match((await run(first, id)).tool.output, /AP9B/);
  await file.close(first);
  assert.equal(file.metrics.closed, 1);
  const next = scriptedModels([bashReply("base64 linked.bin; cat 'café-😀.txt'; printf Z >> linked.bin; base64 bytes.bin"), answer]);
  const second = await file.open(next.models);
  assert.equal((await file.workspace(second, id, WorkspaceDoc)).id, workspace.id);
  const result = await run(second, id);
  assert.equal(result.tool.status, 'completed');
  assert.match(result.tool.output, /AP9B/);
  assert.match(result.tool.output, /hello 世界/);
  assert.match(result.tool.output, /AP9BWg==/, 'hard links preserve shared bytes across a restart');
});

test('shell state resets each call while temporary files survive until service restart', { timeout: 15_000 }, async (t) => {
  const file = await integrationDatabase(t, DurableChatService);
  const provider = scriptedModels([
    bashReply('printf saved > /workspace/keep; export TOKEN=sticky; cd /tmp; printf temporary > session'), answer,
    bashReply('cat /tmp/session; printf "%s:%s:" "$PWD" "${TOKEN-unset}"; cat /workspace/keep'), answer,
  ]);
  const service = await file.open(provider.models);
  const id = await service.createChat();
  await run(service, id);
  const row = await run(service, id);
  assert.match(row.tool.output, /temporary\/workspace:unset:saved/);
  await file.close(service);
  const reopened = await file.open(scriptedModels([
    bashReply('test ! -e /tmp/session && printf TEMP_EMPTY; cat /workspace/keep'), answer,
  ]).models);
  assert.match((await run(reopened, id)).tool.output, /TEMP_EMPTYsaved/);
});

test('line-heavy output keeps stderr and a readable persistent spill path inside Pi truncation limits', { timeout: 15_000 }, async (t) => {
  const file = await integrationDatabase(t, DurableChatService);
  const script = [bashReply('seq 1 1500; printf stderr-tail >&2'), answer];
  const provider = scriptedModels(script);
  const service = await file.open(provider.models);
  const id = await service.createChat();
  const row = await run(service, id);
  assert.match(row.tool.output, /stderr-tail/);
  assert.match(row.tool.output, /truncated/i);
  assert.ok(new TextEncoder().encode(row.tool.output).length < 60 * 1024);
  const path = row.tool.output.match(/Full stdout: (\/workspace\/\.bash-output\/[^\s]+)/)?.[1];
  assert.ok(path, 'the model and UI receive the spill path, not just invisible result details');
  await file.close(service);
  const next = await file.open(scriptedModels([bashReply(`wc -l '${path}'`), answer]).models);
  assert.match((await run(next, id)).tool.output, /1500/, 'all output survives reopening as a workspace artifact');
});

test('a transient workspace-open failure does not poison later calls or replace the workspace identity', { timeout: 15_000 }, async (t) => {
  const file = await integrationDatabase(t, DurableChatService);
  const provider = scriptedModels([bashReply('printf first'), answer, bashReply('printf RETRIED'), answer]);
  let attempts = 0;
  const service = await file.open(provider.models, { openWorkspaceDatabase: async () => {
    if (++attempts === 1) throw new Error('Synthetic workspace storage unavailable');
    return file.openWorkspaceDatabase();
  } });
  const id = await service.createChat();
  const before = await file.workspace(service, id, WorkspaceDoc);
  assert.equal((await run(service, id)).tool.status, 'error');
  assert.match((await run(service, id)).tool.output, /RETRIED/);
  assert.equal(attempts, 2);
  assert.equal((await file.workspace(service, id, WorkspaceDoc)).id, before.id);
});

test('nonzero exit preserves stdout and stderr in an error result and allows another call', { timeout: 15_000 }, async (t) => {
  const file = await integrationDatabase(t, DurableChatService);
  const provider = scriptedModels([
    bashReply("printf 'stdout-marker'; printf 'stderr-marker' >&2; exit 7"), answer,
    bashReply("printf 'recovered-marker'"), answer,
  ]);
  const service = await file.open(provider.models);
  const id = await service.createChat();
  const failed = await run(service, id);
  assert.equal(failed.tool.status, 'error');
  assert.match(failed.tool.output, /stdout-marker/);
  assert.match(failed.tool.output, /stderr-marker/);
  assert.match(failed.tool.output, /7/);
  assert.match((await run(service, id)).tool.output, /recovered-marker/);
});

test('forks get a fresh workspace and explicit context; resetting the parent retains its workspace', { timeout: 15_000 }, async (t) => {
  const file = await integrationDatabase(t, DurableChatService);
  const provider = scriptedModels([bashReply('printf parent-only > /workspace/parent.txt'), answer]);
  const first = await file.open(provider.models);
  const id = await first.createChat();
  await run(first, id);
  const parentWorkspace = await file.workspace(first, id, WorkspaceDoc);
  await file.close(first);
  const raw = await Harness.open(await file.openStorage(), {
    models: provider.models, registry: createRegistry(),
    async conversationCreated(tx, conversation) {
      (await tx.doc(ChatMetadataDoc, conversation.id)).createdAt = Date.now();
      await ensureWorkspaceDoc(tx, conversation.id, conversation.parent ? 'fork' : 'new');
    },
  }, context);
  let forkId;
  try {
    const parent = await raw.conversation(Number(id), context);
    const at = (await parent.entries({}, 1, undefined, context)).items[0].id;
    forkId = String((await parent.fork(at, { ownership: { kind: 'ownerless' } }, context)).id);
    await parent.reset(undefined, context);
    assert.equal((await raw.snapshot(WorkspaceDoc, Number(id), context)).id, parentWorkspace.id);
  } finally { await raw.close(context); }
  const next = scriptedModels([
    bashReply('test ! -e /workspace/parent.txt && printf EMPTY_FORK; printf fork-only > /workspace/fork.txt'), answer,
    bashReply('cat /workspace/parent.txt; test ! -e /workspace/fork.txt && printf PARENT_ISOLATED'), answer,
  ]);
  const second = await file.open(next.models);
  const forkWorkspace = await file.workspace(second, forkId, WorkspaceDoc);
  assert.notEqual(forkWorkspace.id, parentWorkspace.id);
  assert.equal(forkWorkspace.origin, 'fork');
  assert.match((await run(second, forkId)).tool.output, /EMPTY_FORK/);
  assert.match(JSON.stringify(next.requests[0].context.messages.filter(({ role }) => role === 'system')), /fork|inherited/i);
  const parentResult = await run(second, id);
  assert.match(parentResult.tool.output, /parent-only/);
  assert.match(parentResult.tool.output, /PARENT_ISOLATED/);
});

test('closing mid-command drains work and unsafe recovery never duplicates an admitted append', { timeout: 20_000 }, async (t) => {
  const file = await integrationDatabase(t, DurableChatService);
  const provider = scriptedModels([bashReply("printf once >> /workspace/marker; sleep 5; printf UNEXPECTED >> /workspace/marker"), answer]);
  const first = await file.open(provider.models);
  const id = await first.createChat();
  const workspace = await file.workspace(first, id, WorkspaceDoc);
  const observerDb = await file.openWorkspaceDatabase();
  const observer = await WorkspaceFileSystem.open(observerDb, workspace.id);
  try {
    const submission = await first.send(id, 'Run the local operation.');
    await until(async () => await observer.exists('/marker') && (await observer.readFile('/marker')) === 'once',
      'the first append commits before service close');
    const started = Date.now();
    await file.close(first);
    assert.ok(Date.now() - started < 3_000, 'close cancels sleep rather than waiting for the command deadline');
    assert.equal(await observer.readFile('/marker'), 'once', 'no later write remains active after close resolves');
    const recoveredProvider = scriptedModels([answer, bashReply('cat /workspace/marker'), answer]);
    const second = await file.open(recoveredProvider.models);
    await second.resume();
    await second.waitForSubmission(submission);
    const interrupted = toolRows(second, id).find(({ tool }) => tool.status === 'error');
    assert.ok(interrupted);
    assert.match(interrupted.tool.output, /interrupted|partially/i);
    assert.equal(await observer.readFile('/marker'), 'once');
    assert.match((await run(second, id)).tool.output, /once/);
    assert.equal(await observer.readFile('/marker'), 'once', 'the original mutating command was not replayed');
  } finally { await observer.drain(); await observerDb.close(); }
});

test('explicit cancellation stops mutation and leaves the same workspace usable', { timeout: 15_000 }, async (t) => {
  const file = await integrationDatabase(t, DurableChatService);
  const provider = scriptedModels([
    bashReply('printf before > /workspace/cancelled; sleep 5; printf AFTER >> /workspace/cancelled'),
    bashReply('cat /workspace/cancelled'), answer,
  ]);
  const service = await file.open(provider.models);
  const id = await service.createChat();
  const workspace = await file.workspace(service, id, WorkspaceDoc);
  const observerDb = await file.openWorkspaceDatabase();
  const observer = await WorkspaceFileSystem.open(observerDb, workspace.id);
  try {
    const submission = await service.send(id, 'Begin the operation.');
    await until(() => observer.exists('/cancelled'), 'first mutation committed');
    await service.cancel(id);
    assert.equal((await service.waitForSubmission(submission)).reason, 'aborted');
    assert.equal(await observer.readFile('/cancelled'), 'before');
    assert.match((await run(service, id)).tool.output, /before/);
    assert.equal(await observer.readFile('/cancelled'), 'before');
  } finally { await observer.drain(); await observerDb.close(); }
});

test('a bounded deadline stops later writes and releases the workspace queue', { timeout: 15_000 }, async (t) => {
  const file = await integrationDatabase(t, DurableChatService);
  const provider = scriptedModels([
    bashReply('printf before > /workspace/deadline; sleep 5; printf AFTER >> /workspace/deadline', { timeout: 0.1 }), answer,
    bashReply('cat /workspace/deadline'), answer,
  ]);
  const service = await file.open(provider.models);
  const id = await service.createChat();
  const started = Date.now();
  const timedOut = await run(service, id);
  assert.equal(timedOut.tool.status, 'error');
  assert.match(timedOut.tool.output, /Exit code: 124/);
  assert.match(timedOut.tool.output, /Files may have been partially changed/);
  assert.match(timedOut.tool.output, /Output produced before interruption may be unavailable/);
  assert.ok(Date.now() - started < 2_000, 'the deadline cooperatively interrupts sleep');
  const later = await run(service, id);
  assert.match(later.tool.output, /before/);
  assert.doesNotMatch(later.tool.output, /AFTER/);
});


test('shared bash inherits the local virtual HOME and TMPDIR without phone process variables', async (t) => {
  const file = await integrationDatabase(t, DurableChatService);
  const service = await file.open(scriptedModels([
    bashReply('printf "%s:%s:%s" "$HOME" "$TMPDIR" "${CODEX_HOME-unset}"'), answer,
  ]).models);
  const id = await service.createChat();
  const result = await run(service, id);
  assert.match(result.tool.output, /\/workspace:\/tmp:unset/);
});
