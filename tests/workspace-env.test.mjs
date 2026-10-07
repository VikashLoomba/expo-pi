import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { BACKGROUND_CONTEXT } from '@earendil-works/chord/context';
import { getOrThrow } from '@earendil-works/pi-durable/env';
import { installBashBrowserHooks } from './helpers/bash-browser-hooks.mjs';
import { nodeWorkspaces } from './helpers/node-workspaces.mjs';

const hooks = installBashBrowserHooks();
test.after(() => hooks.deregister());
const { WorkspaceExecutionEnv } = await import('../src/pi/workspace/execution-env.ts');
const context = BACKGROUND_CONTEXT;

/** Real workspace directories under a temporary root, one env per workspace id. */
async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), 'pi-workspace-env-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const workspaces = nodeWorkspaces(root);
  const env = (id = 'chat', cwd) => new WorkspaceExecutionEnv(workspaces.workspace(id), id, cwd);
  const disk = (id, path) => join(root, id, path);
  return { env, disk };
}

async function shell(env, command, options = {}) {
  const output = { stdout: '', stderr: '' };
  const result = getOrThrow(await env.exec(command, {
    ...options, onOutput: (text, _context, info) => { output[info.stream] += text; },
  }, context));
  return { exitCode: result.exitCode, ...output };
}

test('file methods reach only /workspace, with ~ and relative paths resolved there', async (t) => {
  const { env, disk } = await fixture(t);
  const workspace = env('chat', '/workspace/sub');
  getOrThrow(await workspace.writeFile('note', 'in sub', context));
  getOrThrow(await workspace.writeFile('~/top', 'at home', context));
  assert.equal(await readFile(disk('chat', 'sub/note'), 'utf8'), 'in sub');
  assert.equal(await readFile(disk('chat', 'top'), 'utf8'), 'at home');
  assert.equal(getOrThrow(await workspace.absolutePath('../top', context)), '/workspace/top');
  for (const path of ['/tmp/x', '/etc/passwd', '/workspace/../outside']) {
    const result = await workspace.writeFile(path, 'escaped', context);
    assert.equal(result.ok, false);
    assert.equal(result.error.code, 'permission_denied');
  }
});

test('text reads are strict UTF-8 and keep byte-order marks; invalid bytes are refused without changes', async (t) => {
  const { env, disk } = await fixture(t);
  const workspace = env();
  for (const text of ['', '﻿x', '﻿﻿x', '😀\r\n世界', '�']) {
    getOrThrow(await workspace.writeFile('sample', new TextEncoder().encode(text), context));
    assert.equal(getOrThrow(await workspace.readTextFile('sample', context)), text);
  }
  for (const bytes of [[0x80], [0xc0, 0xaf], [0xed, 0xa0, 0x80], [0xf4, 0x90, 0x80, 0x80], [0xe2, 0x82]]) {
    getOrThrow(await workspace.writeFile('sample', Uint8Array.from(bytes), context));
    const result = await workspace.readTextFile('sample', context);
    assert.equal(result.ok, false);
    assert.equal(result.error.code, 'invalid');
    assert.deepEqual([...await readFile(disk('chat', 'sample'))], bytes);
  }
});

test('line readers decode like the whole file and report a final unterminated line', async (t) => {
  const { env } = await fixture(t);
  const workspace = env();
  getOrThrow(await workspace.writeFile('lines', '﻿first\r\nsecond\n\nlast', context));
  assert.deepEqual(getOrThrow(await workspace.readTextLines('lines', undefined, context)), ['first\r', 'second', '', 'last']);
  const reader = getOrThrow(await workspace.openTextLineReader('lines', context));
  const lines = [];
  for (let line = getOrThrow(await reader.readLine(context)); line; line = getOrThrow(await reader.readLine(context))) {
    lines.push(line);
  }
  await reader.close(context);
  assert.deepEqual(lines.at(-1), { text: 'last', terminated: false });
  assert.equal((await reader.readLine(context)).ok, false, 'a closed reader refuses reads');
});

test('common shell commands work on the real directory', async (t) => {
  const { env, disk } = await fixture(t);
  const workspace = env();
  const result = await shell(workspace, [
    'mkdir -p project/src',
    "printf 'beta\\nalpha\\n' > project/src/names.txt",
    'printf \'{"count":2}\' > project/data.json',
    'cat project/src/names.txt | sort | grep -n a',
    "sed -i 's/beta/gamma/' project/src/names.txt",
    'jq .count project/data.json',
    'cp -r project copy && mv copy/data.json copy/moved.json',
    'ls copy | sort',
    'find project -type f | sort',
    'wc -l < project/src/names.txt',
    'rm -r copy',
  ].join('\n'));
  assert.equal(result.stderr, '');
  assert.equal(result.exitCode, 0);
  assert.equal(result.stdout, '1:alpha\n2:beta\n2\nmoved.json\nsrc\nproject/data.json\nproject/src/names.txt\n2\n');
  assert.equal(await readFile(disk('chat', 'project/src/names.txt'), 'utf8'), 'gamma\nalpha\n');
  await assert.rejects(stat(disk('chat', 'copy')), /ENOENT/);
});

test('the shell offers no link or permission commands for the workspace', async (t) => {
  const { env } = await fixture(t);
  const workspace = env();
  getOrThrow(await workspace.writeFile('file', 'x', context));
  for (const command of ['ln -s file link', 'ln file hard', 'readlink file', 'chmod 600 file']) {
    assert.equal((await shell(workspace, command)).exitCode, 127, command);
  }
});

test('rename replaces a file and refuses to replace a directory with contents', async (t) => {
  const { env, disk } = await fixture(t);
  const workspace = env();
  getOrThrow(await workspace.writeFile('a', 'new', context));
  getOrThrow(await workspace.writeFile('b', 'old', context));
  getOrThrow(await workspace.renameFile('a', 'b', context));
  assert.equal(await readFile(disk('chat', 'b'), 'utf8'), 'new');
  getOrThrow(await workspace.writeFile('dir/inner', 'x', context));
  getOrThrow(await workspace.writeFile('full/inner', 'y', context));
  assert.equal((await workspace.renameFile('dir', 'full', context)).ok, false);
  getOrThrow(await workspace.createDir('empty', undefined, context));
  getOrThrow(await workspace.renameFile('dir', 'empty', context));
  assert.equal(await readFile(disk('chat', 'empty/inner'), 'utf8'), 'x');
});

test('cleanup stops a running command and later commands run normally', async (t) => {
  const { env, disk } = await fixture(t);
  const workspace = env();
  const running = workspace.exec('printf first > marker; sleep 5; printf late >> marker', undefined, context);
  await new Promise((resolve) => setTimeout(resolve, 50));
  await workspace.cleanup(context);
  const result = await running;
  assert.equal(result.ok, false);
  assert.equal(result.error.code, 'aborted');
  assert.equal(await readFile(disk('chat', 'marker'), 'utf8'), 'first');
  assert.equal((await shell(workspace, 'cat marker')).stdout, 'first');
});

test('a command stops at its deadline, and a missing working directory fails to start', async (t) => {
  const { env } = await fixture(t);
  const started = Date.now();
  const result = await env().exec('sleep 60', { timeout: 0.05 }, context);
  assert.equal(result.ok, false);
  assert.equal(result.error.code, 'timeout');
  assert.ok(Date.now() - started < 2_000);
  const missing = await env('chat', '/workspace/missing').exec('true', undefined, context);
  assert.equal(missing.ok, false);
  assert.equal(missing.error.code, 'spawn_error');
});
