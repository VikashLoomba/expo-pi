import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile, writeFile, rename, access, rm } from 'node:fs/promises';
import { posix as nodePath } from 'node:path';
import { StringDecoder } from 'node:string_decoder';
import { BACKGROUND_CONTEXT, withAbortSignal } from '@earendil-works/chord/context';
import { getOrThrow } from '@earendil-works/pi-durable/env';
import { installBashBrowserHooks } from './helpers/bash-browser-hooks.mjs';
import { remoteDaemonFixture } from './helpers/remote-daemon.mjs';

const hooks = installBashBrowserHooks();
test.after(() => hooks.deregister());
const { Connection } = await import('../src/pi/execution/remote/connection.ts');
const { MobileRemoteExecutionEnv } = await import('../src/pi/execution/remote/environment.ts');
const { MobileUtf8Decoder } = await import('../src/pi/execution/remote/utf8.ts');
const { posix, resolveRemotePath } = await import('../src/pi/execution/remote/paths.ts');
const C = BACKGROUND_CONTEXT;
async function fixture(t, options = {}) {
  const remote = await remoteDaemonFixture(t, options);
  const connection = new Connection({ openChannel: remote.openChannel });
  const env = new MobileRemoteExecutionEnv({ connection, id: 'mac', cwd: remote.directory, ...options });
  t.after(() => env.cleanup(C));
  return { ...remote, connection, env };
}

test('mobile UTF8 decoding matches Node across every scalar boundary and invalid prefix', () => {
  const inputs = [Buffer.from('\ufeff\ufeffα🙂\r\n\ufefftail'), Buffer.from([0xe0, 0x80, 0x80, 0xed, 0xa0, 0x80, 0xf4, 0x90, 0x80, 0x80]),
    Buffer.from([0xf0, 0x90, 0x80]), Buffer.from([0xff, 0xfe, 0xc2, 0x80, 0xe2, 0x82])];
  for (const input of inputs) for (let chunkSize = 1; chunkSize <= input.length; chunkSize++) {
    const decoder = new MobileUtf8Decoder();
    const expected = new StringDecoder('utf8');
    let actual = ''; let reference = '';
    for (let offset = 0; offset < input.length; offset += chunkSize) {
      const bytes = input.subarray(offset, offset + chunkSize);
      actual += decoder.write(bytes); reference += expected.write(bytes);
    }
    assert.equal(actual + decoder.end(), reference + expected.end());
  }
});

test('POSIX paths use remote cwd and match Node lexical normalization without connection', async () => {
  for (const parts of [[], [''], ['a/', '..', 'b/'], ['/', '..'], ['/a', '/b'], ['../', 'x'], ['//a//', '..', '/']]) {
    assert.equal(posix.join(...parts), nodePath.join(...parts));
    assert.equal(posix.resolve('/remote/cwd', ...parts), nodePath.resolve('/remote/cwd', ...parts));
  }
  assert.equal(resolveRemotePath('/remote/cwd', 'file:///a%20b'), '/a b');
  assert.equal(resolveRemotePath('/remote/cwd', 'file://bad/a'), '/remote/cwd/file:/bad/a');
  assert.equal(resolveRemotePath('/remote/cwd', '~/x', '/remote/home'), '/remote/home/x');
  let connections = 0;
  const env = new MobileRemoteExecutionEnv({ id: 'same-host', cwd: '/remote/cwd',
    connection: new Connection({ openChannel: async () => { connections++; throw new Error('should remain lazy'); } }),
  });
  assert.equal(getOrThrow(await env.absolutePath('../file', C)), '/remote/file');
  assert.equal(getOrThrow(await env.joinPath(['a', 'b'], C)), 'a/b');
  assert.equal(connections, 0);
  await env.cleanup(C);
  assert.equal((await env.writeFile('stale', '', C)).error.code, 'aborted');
  assert.equal(connections, 0);
});

test('real daemon preserves opened identity, UTF8/BOM, paged directories and temporary ownership', async (t) => {
  const { env, directory, metrics } = await fixture(t, { fragment: true });
  const text = '\ufeff\ufeffHello 🙂\r\n\ufeffsecond\n';
  getOrThrow(await env.writeFile('text', text, C));
  assert.equal(await readFile(`${directory}/text`, 'utf8'), text);
  assert.equal(getOrThrow(await env.readTextFile('text', C)), text);
  assert.deepEqual(getOrThrow(await env.readTextLines('text', undefined, C)), ['\ufeffHello 🙂\r', '\ufeffsecond']);
  const reader = getOrThrow(await env.openBinaryReader('text', undefined, C));
  await writeFile(`${directory}/replacement`, 'replacement');
  await rename(`${directory}/replacement`, `${directory}/text`);
  assert.equal(Buffer.from(getOrThrow(await reader.read(0, 1000, C))).toString(), text);
  assert.equal(getOrThrow(await reader.info(C)).size, Buffer.byteLength(text));
  const temp = getOrThrow(await env.createTempFile({ prefix: 'pi-mobile-', suffix: '.txt' }, C));
  await access(temp);
  await env.cleanup(C);
  await assert.rejects(access(temp));
  assert.equal((await reader.read(0, 1, C)).error.code, 'invalid');
  assert.equal(metrics.sessions, 1); assert.equal(metrics.closes, 1);
});

test('lost session invalidates handles; later requests reconnect without replaying mutations', async (t) => {
  const { env, directory, children, metrics } = await fixture(t);
  getOrThrow(await env.writeFile('counter', 'x', C));
  const reader = getOrThrow(await env.openBinaryReader('counter', undefined, C));
  const child = [...children][0];
  await new Promise((resolve) => { child.once('close', resolve); child.kill('SIGKILL'); });
  const stale = await reader.read(0, 1, C);
  assert.equal(stale.ok, false); assert.equal(metrics.sessions, 1);
  assert.equal(getOrThrow(await env.readTextFile('counter', C)), 'x');
  assert.equal(metrics.sessions, 2);
  await reader.close(C);
  assert.equal(await readFile(`${directory}/counter`, 'utf8'), 'x');
});

test('normal cleanup kills only owned command groups and awaits readers and session closure', async (t) => {
  const { env, metrics } = await fixture(t);
  const other = await fixture(t);
  let started;
  const ready = new Promise((resolve) => { started = resolve; });
  const command = env.exec('printf ready; sleep 30', { onOutput: () => started() }, C);
  await ready;
  await env.cleanup(C);
  const result = getOrThrow(await command);
  assert.equal(result.exitCode, 137);
  assert.equal(metrics.sessions, 1); assert.equal(metrics.closes, 1);
  assert.equal(getOrThrow(await other.env.exec('printf alive', undefined, C)).exitCode, 0);
});

test('cancel pending connection and stop pending admission settle and dispose late channel', async () => {
  let open; let started;
  const ready = new Promise((resolve) => { started = resolve; });
  let closed = 0;
  const connection = new Connection({ openChannel: () => { started(); return new Promise((resolve) => { open = resolve; }); } });
  const env = new MobileRemoteExecutionEnv({ connection, id: 'test', cwd: '/tmp' });
  const controller = new AbortController();
  const operation = env.fileInfo('file', withAbortSignal(controller.signal, C));
  await ready; controller.abort();
  assert.equal((await operation).error.code, 'aborted');
  const closing = env.cleanup(C);
  open({ write() {}, close: async () => { closed++; } });
  await closing;
  assert.equal(closed, 1);
});

test('exec timeout, argv literals, stream metadata and callback errors retain public results', async (t) => {
  const { env } = await fixture(t);
  const output = [];
  assert.equal(getOrThrow(await env.exec(['printf', '%s', 'literal; $(pwd)'], { onOutput: (text, _, info) => output.push([text, info.stream]) }, C)).exitCode, 0);
  assert.deepEqual(output, [['literal; $(pwd)', 'stdout']]);
  assert.equal((await env.exec('sleep 10', { timeout: 0.05 }, C)).error.code, 'timeout');
  assert.equal((await env.exec('printf output; sleep 10', { onOutput: () => { throw new Error('consumer stopped'); } }, C)).error.code, 'callback_error');
  assert.equal(getOrThrow(await env.exec('exit 7', undefined, C)).exitCode, 7);
});

test('watch recovers coverage with overflow after session loss and stops before owner disposal', async (t) => {
  const { env, children, metrics } = await fixture(t);
  const changes = [];
  let recovered;
  const overflow = new Promise((resolve) => { recovered = resolve; });
  const watcher = getOrThrow(await env.watch([{ path: '.' }], (change) => {
    changes.push(change); if ('overflow' in change) recovered();
  }, C));
  const child = [...children][0];
  await new Promise((resolve) => { child.once('close', resolve); child.kill('SIGKILL'); });
  await overflow;
  assert.equal(metrics.sessions, 2);
  await env.cleanup(C);
  const count = changes.length;
  await watcher.close(C);
  assert.equal(changes.length, count);
  assert.equal(metrics.closes, 2);
});

test('a reused owner forgets explicitly closed and terminal watchers, including terminal admission races', async () => {
  for (const ending of ['close', 'terminal', 'during-admission']) {
    let event; let settle; let closes = 0;
    const connection = {
      async info() { return { os: 'linux' }; },
      request(op, _json, options) {
        assert.equal(op, 'watch');
        event = options.onEvent;
        const pending = new Promise((resolve) => { settle = () => resolve({ json: {}, session: 1 }); });
        options.signal.addEventListener('abort', settle, { once: true });
        event({ kind: 'ready', mode: 'native' });
        if (ending === 'during-admission') {
          event({ kind: 'error', code: 'invalid', message: 'Coverage limit reached.' });
          settle();
        }
        return pending;
      },
      async close() { settle(); },
    };
    const env = new MobileRemoteExecutionEnv({ connection, id: 'watch-owner', cwd: '/project' });
    const watcher = getOrThrow(await env.watch([{ path: '.' }], () => {}, C));
    const close = watcher.close.bind(watcher);
    watcher.close = async (...args) => { closes++; return close(...args); };
    if (ending === 'close') await watcher.close(C);
    if (ending === 'terminal') {
      event({ kind: 'error', code: 'invalid', message: 'Coverage limit reached.' });
      settle();
    }
    await env.cleanup(C);
    assert.equal(closes, ending === 'close' ? 1 : 0, `owner retained a finished ${ending} watcher`);
  }
});

test('owner shutdown still closes the daemon when a watcher disposer rejects', async (t) => {
  const { env, metrics } = await fixture(t);
  const watcher = getOrThrow(await env.watch([{ path: '.' }], () => {}, C));
  watcher.close = async () => { throw new Error('watch disposer failed'); };
  await env.cleanup(C);
  assert.equal(metrics.closes, 1);
  assert.equal((await env.fileInfo('.', C)).error.code, 'aborted');
});

test('removing an owned temporary root relinquishes its path before shutdown', async (t) => {
  const { env } = await fixture(t);
  const temporary = getOrThrow(await env.createTempDir('pi-mobile-removed-', C));
  t.after(() => rm(temporary, { recursive: true, force: true }));
  getOrThrow(await env.remove(temporary, { recursive: true }, C));
  getOrThrow(await env.createDir(temporary, undefined, C));
  getOrThrow(await env.writeFile(`${temporary}/replacement`, 'belongs to the replacement directory', C));
  await env.cleanup(C);
  assert.equal(await readFile(`${temporary}/replacement`, 'utf8'), 'belongs to the replacement directory');
});

test('stop seals active work, closes watch admission and does not reconnect during cleanup', async (t) => {
  const { env, metrics } = await fixture(t);
  let started;
  const ready = new Promise((resolve) => { started = resolve; });
  const command = env.exec('printf ready; sleep 30', { onOutput: () => started() }, C);
  await ready;
  env.stop();
  assert.equal((await command).error.code, 'aborted');
  assert.equal((await env.fileInfo('.', C)).error.code, 'aborted');
  await env.cleanup(C);
  assert.equal(metrics.sessions, 1); assert.equal(metrics.closes, 1);
});

test('native conformance assertion adapter runs the same reader case', async (t) => {
  const { createEnvConformance } = await import('@earendil-works/pi-durable/testing');
  const { remoteConformanceAssertions } = await import('./helpers/remote-conformance-assertions.js');
  const { env } = await fixture(t);
  const cases = createEnvConformance({ assertions: remoteConformanceAssertions, withEnv: (use) => use(env), shell: ['sh', '-c'], symlinks: true });
  await cases[0].run();
});

test('whole text read stays within the size-at-open boundary when a remote file grows', async (t) => {
  const { env, directory, connection } = await fixture(t);
  const initial = `${'a'.repeat(512 * 1024 - 1)}🙂`;
  await writeFile(`${directory}/growing`, initial);
  const request = connection.request.bind(connection);
  let appended = false;
  const reads = [];
  connection.request = async (op, json, options) => {
    const reply = await request(op, json, options);
    if (op === 'open' && json.mode === 'read' && !appended) {
      appended = true;
      await writeFile(`${directory}/growing`, initial + 'b'.repeat(1024 * 1024));
    }
    if (op === 'pread') reads.push([json.offset, json.length]);
    return reply;
  };
  assert.equal(getOrThrow(await env.readTextFile('growing', C)), initial);
  assert.ok(reads.every(([offset, length]) => offset + length <= Buffer.byteLength(initial)));
});

test('exec well-forms environment keys before JSON object serialization', async (t) => {
  const { env } = await fixture(t);
  let output = '';
  assert.equal(getOrThrow(await env.exec(['printf', 'ok'], { env: { '\ud800': 'value' }, onOutput: (text) => { output += text; } }, C)).exitCode, 0);
  assert.equal(output, 'ok');
});

test('owner cleanup bounds non-cancellable FIFO opens and reports the lost operation honestly', async (t) => {
  const { env } = await fixture(t);
  getOrThrow(await env.exec(['mkfifo', 'blocked'], undefined, C));
  const reading = env.readTextFile('blocked', C);
  await new Promise((resolve) => setTimeout(resolve, 40));
  const start = Date.now();
  await env.cleanup(C);
  const result = await reading;
  assert.equal(result.ok, false);
  assert.equal(result.error.code, 'unknown');
  assert.ok(Date.now() - start < 3000, 'cleanup must close an unresponsive owned channel');
});

test('temporary paths retire through an existing replacement session; cleanup alone never reconnects', async (t) => {
  for (const reconnect of [false, true]) {
    const { env, children, metrics } = await fixture(t);
    const temporary = getOrThrow(await env.createTempDir('pi-mobile-recovery-', C));
    t.after(() => rm(temporary, { recursive: true, force: true }));
    const child = [...children][0];
    await new Promise((resolve) => { child.once('close', resolve); child.kill(); });
    if (reconnect) getOrThrow(await env.fileInfo(temporary, C));
    await env.cleanup(C);
    assert.equal(metrics.sessions, reconnect ? 2 : 1, 'cleanup must not create a daemon session');
    if (reconnect) await assert.rejects(access(temporary), { code: 'ENOENT' });
    else await access(temporary); // Best effort: no connection exists to remove this remote path.
  }
});

test('callback failure still leaves daemon spill cleanup owned by its environment', async (t) => {
  const { env, connection } = await fixture(t);
  const request = connection.request.bind(connection);
  let spill;
  connection.request = async (...args) => {
    try { return await request(...args); }
    catch (error) { if (error.fields?.spillPath) spill = error.fields.spillPath; throw error; }
  };
  const result = await env.exec('printf abc; sleep 30', {
    spill: { afterBytes: 1, afterLines: 1 }, onOutput: () => { throw new Error('consumer failed'); },
  }, C);
  assert.equal(result.error.code, 'callback_error');
  assert.ok(spill, 'daemon reported spill path even when callback error has result precedence');
  await access(spill);
  await env.cleanup(C);
  await assert.rejects(access(spill));
});
