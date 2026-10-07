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
const { DurableChatService } = await import('../src/pi/chat-service.ts');
const { ChatMetadataDoc } = await import('../src/pi/chat-metadata.ts');
const { WorkspaceDoc, ensureWorkspaceDoc } = await import('../src/pi/workspace/document.ts');
const context = BACKGROUND_CONTEXT;
const answer = { chunks: ['Done.'] };

async function run(service, id, prompt = 'Perform the requested local operation.') {
  const submission = await service.send(id, prompt);
  assert.equal((await service.waitForSubmission(submission)).status, 'done');
  return (await toolRows(service, id)).at(-1);
}

test('bash is offered to every chat and its workspace identity survives reopening', async (t) => {
  const file = await integrationDatabase(t, DurableChatService);
  const provider = scriptedModels([answer]);
  const service = await file.open(provider.models);
  const id = await service.createChat();
  const workspace = await file.workspace(service, id, WorkspaceDoc);
  assert.ok(workspace.id);
  await service.waitForSubmission(await service.send(id, 'Hello.'));
  assert.ok(getCurrentTools(provider.requests[0].context.messages).some(({ name }) => name === 'bash'));
  await file.close(service);
  const reopened = await file.open(scriptedModels([]).models);
  assert.equal((await file.workspace(reopened, id, WorkspaceDoc)).id, workspace.id);
});

test('shell binary writes and Unicode names survive a service reopen', { timeout: 15_000 }, async (t) => {
  const file = await integrationDatabase(t, DurableChatService);
  const provider = scriptedModels([bashReply("printf AP9B | base64 -d > bytes.bin; printf 'hello 世界' > 'café-😀.txt'; base64 bytes.bin"), answer]);
  const first = await file.open(provider.models);
  const id = await first.createChat();
  assert.match((await run(first, id)).tool.output, /AP9B/);
  await file.close(first);
  const next = scriptedModels([bashReply("cat 'café-😀.txt'; printf Z >> bytes.bin; base64 bytes.bin"), answer]);
  const second = await file.open(next.models);
  const result = await run(second, id);
  assert.equal(result.tool.status, 'completed');
  assert.match(result.tool.output, /hello 世界/);
  assert.match(result.tool.output, /AP9BWg==/);
});

test('shell variables, cwd and /tmp reset for every command while /workspace persists', { timeout: 15_000 }, async (t) => {
  const file = await integrationDatabase(t, DurableChatService);
  const provider = scriptedModels([
    bashReply('printf saved > /workspace/keep; export TOKEN=sticky; cd /tmp; printf temporary > session'), answer,
    bashReply('test ! -e /tmp/session && printf TEMP_EMPTY; printf ":%s:%s:" "$PWD" "${TOKEN-unset}"; cat /workspace/keep'),
    answer,
  ]);
  const service = await file.open(provider.models);
  const id = await service.createChat();
  await run(service, id);
  assert.match((await run(service, id)).tool.output, /TEMP_EMPTY:\/workspace:unset:saved/);
});

test('line-heavy output keeps its end, including stderr, inside Pi truncation limits', { timeout: 15_000 }, async (t) => {
  const file = await integrationDatabase(t, DurableChatService);
  const provider = scriptedModels([bashReply('seq 1 4000; printf stderr-tail >&2'), answer]);
  const service = await file.open(provider.models);
  const id = await service.createChat();
  const row = await run(service, id);
  assert.match(row.tool.output, /4000\n/);
  assert.match(row.tool.output, /stderr-tail/);
  assert.doesNotMatch(row.tool.output, /^1\n2\n/);
  assert.ok(new TextEncoder().encode(row.tool.output).length < 60 * 1024);
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
    forkId = (await parent.fork(at, { ownership: { kind: 'ownerless' } }, context)).id;
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

test('closing mid-command stops it, and recovery never repeats the interrupted command', { timeout: 20_000 }, async (t) => {
  const file = await integrationDatabase(t, DurableChatService);
  // The shell buffers output, so the file write is the first observable progress.
  const provider = scriptedModels([bashReply('printf once >> /workspace/marker; sleep 5; printf UNEXPECTED >> /workspace/marker'), answer]);
  const first = await file.open(provider.models);
  const id = await first.createChat();
  const workspace = await file.workspace(first, id, WorkspaceDoc);
  const submission = await first.send(id, 'Run the local operation.');
  await until(async () => await file.file(workspace.id, 'marker') === 'once', 'the first append lands before close');
  const started = Date.now();
  await file.close(first);
  assert.ok(Date.now() - started < 3_000, 'close cancels sleep rather than waiting for the command deadline');
  await new Promise((resolve) => setTimeout(resolve, 100));
  assert.equal(await file.file(workspace.id, 'marker'), 'once', 'no later write lands after close');
  const recoveredProvider = scriptedModels([answer, bashReply('cat /workspace/marker'), answer]);
  const second = await file.open(recoveredProvider.models);
  await second.waitForSubmission(submission);
  const interrupted = (await toolRows(second, id)).find(({ tool }) => tool.status === 'error');
  assert.ok(interrupted, 'the interrupted call ends as an error result');
  assert.match((await run(second, id)).tool.output, /once/);
  assert.equal(await file.file(workspace.id, 'marker'), 'once', 'the original mutating command was not replayed');
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
  const submission = await service.send(id, 'Begin the operation.');
  await until(async () => await file.file(workspace.id, 'cancelled') !== undefined, 'first mutation landed');
  await service.cancel(id);
  assert.equal((await service.waitForSubmission(submission)).reason, 'aborted');
  assert.equal(await file.file(workspace.id, 'cancelled'), 'before');
  assert.match((await run(service, id)).tool.output, /before/);
  assert.equal(await file.file(workspace.id, 'cancelled'), 'before');
});

test('a deadline stops a command, reports the timeout and leaves earlier writes', { timeout: 15_000 }, async (t) => {
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
  assert.match(timedOut.tool.output, /timed out after 0\.1 seconds/);
  assert.ok(Date.now() - started < 2_000, 'the deadline interrupts sleep');
  const later = await run(service, id);
  assert.match(later.tool.output, /before/);
  assert.doesNotMatch(later.tool.output, /AFTER/);
});

test('bash gets the workspace HOME and TMPDIR without the phone process variables', async (t) => {
  const file = await integrationDatabase(t, DurableChatService);
  const service = await file.open(scriptedModels([
    bashReply('printf "%s:%s:%s" "$HOME" "$TMPDIR" "${CODEX_HOME-unset}"'), answer,
  ]).models);
  const id = await service.createChat();
  const result = await run(service, id);
  assert.match(result.tool.output, /\/workspace:\/tmp:unset/);
});
