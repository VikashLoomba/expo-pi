import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { BACKGROUND_CONTEXT, withAbortSignal } from '@earendil-works/chord/context';
import { ExecutionError, ok, err } from '@earendil-works/pi-durable/env';
import { NodeExecutionEnv } from '@earendil-works/pi-durable/env/node';
import { installBashBrowserHooks } from './helpers/bash-browser-hooks.mjs';

const hooks = installBashBrowserHooks();
test.after(() => hooks.deregister());
const { createBashTool } = await import('../src/pi/bash/tool.ts');
const { BashOutput, presentOutput, TOOL_OUTPUT_BYTES, STREAM_ARTIFACT_BYTES } = await import('../src/pi/bash/output.ts');
const { scopeTool } = await import('../src/pi/execution/tool-scope.ts');
const { EditExecutionEnv, EDIT_BUDGET } = await import('../src/pi/workspace/edit-budget.ts');
const context = BACKGROUND_CONTEXT;

// Only the shell seam is exercised here; execution-composition.test proves a complete
// independent public environment through the actual DurableChatService and harness.
function shellFixture(exec) { return { id: 'independent-shell', cwd: '/fixture', exec }; }

test('a high-output environment never grows the shared collectors past their receiving budget', async () => {
  const output = new BashOutput(true);
  const chunk = '🌍'.repeat(16_384); // 64 KiB, over 32 MiB total through each collector.
  for (let index = 0; index < 513; index++) {
    output.stdout.append(chunk);
    output.stderr.append(chunk);
    for (const stream of [output.stdout, output.stderr]) {
      assert.ok(stream.retainedBytes <= STREAM_ARTIFACT_BYTES + TOOL_OUTPUT_BYTES / 2);
    }
  }
  assert.equal(output.stdout.bytes, 513 * 65_536);
  assert.equal(output.stderr.bytes, 513 * 65_536);
  assert.equal(output.stdout.artifact, undefined);
  const writes = [];
  const rendered = await presentOutput(output, 0, context, { write(...args) { writes.push(args); } });
  assert.equal(writes.length, 0, 'discarded full output is never advertised as a complete artifact');
  assert.equal(rendered.details.outputFiles, undefined);
  assert.match(rendered.text, /artifact capture limit/);
  assert.ok(Buffer.byteLength(rendered.text) <= TOOL_OUTPUT_BYTES + 4096);
  assert.doesNotMatch(rendered.text, /�/);
});

test('plain environments preserve split streams, exact byte counts, default timeout and honest artifact absence', async () => {
  let options;
  const env = shellFixture(async (command, received, current) => {
    assert.equal(command, 'emit'); options = received;
    received.onOutput('first\n' + 'line\n'.repeat(2_000), current, { stream: 'stdout' });
    received.onOutput('error-tail 😀', current, { stream: 'stderr' });
    return ok({ exitCode: 7 });
  });
  const result = await createBashTool().execute({ command: 'emit' }, { env, outputWindow: undefined }, context);
  assert.equal(options.cwd, '/fixture');
  assert.equal(options.timeout, 10, 'the public shell timeout is seconds');
  assert.equal(options.inheritEnv, true, 'the selected backend supplies its own environment defaults');
  assert.equal(options.window, undefined, 'stream identity cannot survive coalesced window samples');
  assert.equal(result.isError, true);
  assert.equal(result.details.stdoutBytes, 10_006);
  assert.equal(result.details.stderrBytes, Buffer.byteLength('error-tail 😀'));
  assert.equal(result.details.outputFiles, undefined);
  assert.match(result.content[0].text, /stderr:\nerror-tail 😀/);
  assert.match(result.content[0].text, /no persistent artifact writer/);
});

test('timeout normalization, failure visibility and cancellation use only the public shell contract', async () => {
  const timeouts = [];
  const env = shellFixture(async (_command, options) => {
    timeouts.push(options.timeout);
    return err(new ExecutionError('timeout', 'deadline reached'));
  });
  const tool = createBashTool();
  for (const timeout of [0.01, 99, 0.10001]) {
    const result = await tool.execute({ command: 'wait', timeout }, { env, outputWindow: undefined }, context);
    assert.equal(result.details.exitCode, 124);
    assert.equal(result.isError, true);
    assert.match(result.content[0].text, /deadline reached/);
    assert.match(result.content[0].text, /Files may have been partially changed/);
  }
  assert.deepEqual(timeouts, [0.1, 30, 0.101]);
  const controller = new AbortController();
  const reason = new Error('caller cancelled');
  const cancelled = shellFixture(async () => { controller.abort(reason); return err(new ExecutionError('aborted', 'backend cancellation')); });
  await assert.rejects(tool.execute({ command: 'wait' }, { env: cancelled, outputWindow: undefined }, withAbortSignal(controller.signal, context)), (cause) => cause === reason);
  await assert.rejects(tool.execute({ command: 'wait' }, {}, context), /No execution environment/);
});

test('artifact capture preserves complete bounded streams, including Unicode and line-heavy text', async () => {
  const written = new Map();
  const artifacts = { async write(kind, content) { written.set(kind, content); return `/artifacts/${kind}`; } };
  const stdout = '🌍\n'.repeat(2_000);
  const stderr = 'stderr';
  const env = shellFixture(async (_command, options, current) => {
    options.onOutput(stdout, current, { stream: 'stdout' });
    options.onOutput(stderr, current, { stream: 'stderr' });
    return ok({ exitCode: 0 });
  });
  const result = await createBashTool({ artifacts: () => artifacts }).execute({ command: 'emit' }, { env, outputWindow: undefined }, context);
  assert.equal(written.get('bash-stdout'), stdout);
  assert.equal(written.get('bash-stderr'), stderr);
  assert.match(result.content[0].text, /Full stdout: \/artifacts\/bash-stdout/);
  assert.deepEqual(result.details.outputFiles, { stdout: '/artifacts/bash-stdout', stderr: '/artifacts/bash-stderr' });
});

test('scope construction is pure, release runs on failures, and it never calls backend owner cleanup', async () => {
  let admitted = 0, released = 0, ownerCleanup = 0;
  const env = { id: 'scope-fixture', cwd: '/fixture', async cleanup() { ownerCleanup++; } };
  const failure = new Error('tool failed');
  const tool = { name: 'fixture', async execute(_args, api) { assert.equal(api.env, env); throw failure; } };
  const policy = { async scope(selected, current) {
    assert.equal(selected, env); admitted++;
    return { env, context: current, async release() { released++; } };
  } };
  const wrapped = scopeTool(tool, policy).wrap(tool);
  assert.equal(admitted, 0);
  await assert.rejects(wrapped.execute({}, { env, outputWindow: undefined }, context), (cause) => cause === failure);
  assert.equal(admitted, 1); assert.equal(released, 1); assert.equal(ownerCleanup, 0);
});

test('edit policy preserves environment identity, rejects oversize before materialization and closes only itself', async () => {
  let reads = 0, cleaned = 0, readersClosed = 0;
  const independent = {
    id: 'independent-files', cwd: '/first',
    async openBinaryReader() { return ok({
      async info() { return ok({ size: EDIT_BUDGET.maxFileBytes + 1 }); },
      async close() { readersClosed++; },
    }); },
    async readTextFile() { reads++; throw new Error('must not materialize an oversized file'); },
    async cleanup() { cleaned++; },
  };
  const env = new EditExecutionEnv(independent, [{ oldText: 'old', newText: 'new' }]);
  assert.equal(env.id, independent.id);
  env.cwd = '/second'; assert.equal(independent.cwd, '/second');
  await assert.rejects(env.readTextFile('file', context), /file-size limit/);
  assert.equal(reads, 0);
  assert.equal(readersClosed, 1, 'preflight releases its reader even when admission rejects');
  await env.cleanup(context); assert.equal(cleaned, 0);
});

test('edit admission follows a real independent environment symlink before materializing its oversized target', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'pi-edit-symlink-'));
  const target = join(directory, 'large.txt');
  const link = join(directory, 'link.txt');
  await writeFile(target, 'x'.repeat(EDIT_BUDGET.maxFileBytes + 1));
  await symlink(target, link);
  const backend = new NodeExecutionEnv({ cwd: directory });
  t.after(async () => { await backend.cleanup(context); await rm(directory, { recursive: true, force: true }); });
  const info = await backend.fileInfo(link, context);
  assert.equal(info.ok, true);
  assert.equal(info.value.kind, 'symlink');
  assert.ok(info.value.size < EDIT_BUDGET.maxFileBytes, 'lstat metadata cannot enforce the target size limit');
  let materialized = false;
  backend.readTextFile = async () => { materialized = true; throw new Error('oversized file reached readTextFile'); };
  const policy = new EditExecutionEnv(backend, [{ oldText: 'x', newText: 'y' }]);
  await assert.rejects(policy.readTextFile(link, context), /edit file-size limit/);
  assert.equal(materialized, false);
});

test('a preview never resumes after a character crosses its byte boundary', () => {
  const output = new BashOutput(false);
  output.stdout.append('x'.repeat(TOOL_OUTPUT_BYTES / 2 - 1));
  output.stdout.append('😀');
  output.stdout.append('z');
  assert.equal(output.stdout.text, 'x'.repeat(TOOL_OUTPUT_BYTES / 2 - 1));
  assert.equal(output.stdout.bytes, TOOL_OUTPUT_BYTES / 2 + 4);
});

test('backend failure stays visible after stderr fills its preview, without inventing stream bytes', async () => {
  const env = shellFixture(async (_command, options, current) => {
    options.onOutput('x'.repeat(100_000), current, { stream: 'stderr' });
    return err(new ExecutionError('spawn_error', 'VISIBLE_BACKEND_FAILURE'));
  });
  const result = await createBashTool().execute({ command: 'fail' }, { env, outputWindow: undefined }, context);
  assert.match(result.content[0].text, /VISIBLE_BACKEND_FAILURE/);
  assert.match(result.content[0].text, /Files may have been partially changed/);
  assert.equal(result.details.stderrBytes, 100_000);
});

test('scope cancellation preserves its identity when a stock tool replaces the error', async () => {
  const controller = new AbortController();
  const reason = { stop: 'request resource owner cancelled' };
  const env = { id: 'cancel-fixture', cwd: '/fixture' };
  let released = false;
  const tool = { name: 'fixture', async execute() { controller.abort(reason); throw new Error('SDK replacement'); } };
  const policy = { async scope() {
    return { env, context: withAbortSignal(controller.signal, context), async release() { released = true; } };
  } };
  const wrapped = scopeTool(tool, policy).wrap(tool);
  await assert.rejects(wrapped.execute({}, { env, outputWindow: undefined }, context), (cause) => cause === reason);
  assert.equal(released, true);
});
