import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import test from 'node:test';
import { installBashBrowserHooks } from './helpers/bash-browser-hooks.mjs';
import { remoteDaemonFixture, remoteDaemonPath } from './helpers/remote-daemon.mjs';

const hooks = installBashBrowserHooks();
test.after(() => hooks.deregister());
const { Connection, isConnectionLost } = await import('../src/pi/execution/remote/connection.ts');
const { FrameDecoder, encodeFrame, FrameType, MAX_FRAME } = await import('../src/pi/execution/remote/protocol.ts');
const { createSshChannelFactory } = await import('../src/pi/execution/remote/channel.ts');
const token = '0123456789abcdef0123456789abcdef';
const hello = { protocol: 1, version: '1.0.4', os: 'macos', arch: 'aarch64', home: '/Users/test',
  tmpdir: '/tmp', cwd: '/work', driveCwds: {}, separator: '/', pid: 99 };
const deferred = () => { let resolve; const promise = new Promise((r) => { resolve = r; }); return { promise, resolve }; };
const tick = () => new Promise((resolve) => setImmediate(resolve));

function scripted(handler) {
  const sessions = [];
  const factory = async (options) => {
    const state = { ...options, frames: [], closes: 0 };
    const decoder = new FrameDecoder(options.token);
    decoder.push(Buffer.from(`PI-ENV ${options.token}\n`), () => {});
    state.reply = (id, json = {}, payload, type = FrameType.result) => {
      options.onData(encodeFrame(type, id, json, payload));
    };
    sessions.push(state);
    options.onData(Buffer.from(`shell startup banner\nPI-ENV ${options.token}\n`));
    return {
      write(bytes) {
        decoder.push(bytes, (frame) => {
          state.frames.push(frame);
          queueMicrotask(() => {
            if (frame.json.op === 'hello') state.reply(frame.id, hello);
            else handler?.(state, frame);
          });
        });
      },
      async close() { state.closes += 1; },
    };
  };
  return { factory, sessions };
}

test('Pi framing preserves binary ownership across arbitrary fragments, coalescing and startup noise', () => {
  const decoder = new FrameDecoder(token);
  const frames = [];
  const payload = Uint8Array.from({ length: 65553 }, (_, i) => (i * 73) & 255);
  const encoded = encodeFrame(2, 9, { text: 'π\0\ud800X' }, payload);
  const stream = Buffer.concat([Buffer.alloc(1024 * 1024 + 19, 80), Buffer.from(`PI-ENV ${token}\n`),
    encoded, encodeFrame(6, 0, {}), encodeFrame(3, 10, { code: 'ENOENT' })]);
  for (let offset = 0; offset < stream.length; offset += 31) {
    const chunk = stream.subarray(offset, offset + 31).slice();
    decoder.push(chunk, (frame) => frames.push(frame));
    chunk.fill(0); // Simulate native buffer reuse immediately after callback delivery.
  }
  assert.equal(frames.length, 3);
  assert.equal(frames[0].json.text, 'π\0�X');
  assert.deepEqual(frames[0].payload, payload);
  payload.fill(0);
  assert.equal(frames[0].payload[1], 73);
  assert.equal(frames[2].json.code, 'ENOENT');
});

test('Pi framing rejects length/JSON corruption and oversized outbound frames', () => {
  for (const bytes of [Buffer.from([0, 0, 0, 1]), Buffer.from([1, 0, 0, 1]),
    Buffer.from([0, 0, 0, 9, 2, 0, 0, 0, 1, 0, 0, 0, 1])]) {
    const decoder = new FrameDecoder(token);
    decoder.push(Buffer.from(`PI-ENV ${token}\n`), () => {});
    assert.throws(() => decoder.push(bytes, () => {}), /Invalid/);
  }
  assert.throws(() => encodeFrame(1, 1, {}, new Uint8Array(MAX_FRAME)), /16 MiB/);
});

test('aborting an admitted request sends cancel and waits for daemon settlement without closing unrelated work', async () => {
  const cancel = deferred();
  const fake = scripted((state, frame) => {
    if (frame.type === FrameType.cancel) cancel.resolve({ state, frame });
    if (frame.json.op === 'lstat') state.reply(frame.id, { exists: true });
  });
  const connection = new Connection({ openChannel: fake.factory });
  try {
    const controller = new AbortController();
    const running = connection.request('exec', {}, { signal: controller.signal, onStart: () => controller.abort() });
    let settled = false;
    void running.then(() => { settled = true; }, () => { settled = true; });
    const { state, frame } = await cancel.promise;
    await tick();
    assert.equal(settled, false);
    assert.equal((await connection.request('lstat', {})).json.exists, true);
    state.reply(frame.id, { code: 'aborted', message: 'cancelled' }, undefined, FrameType.error);
    await assert.rejects(running, { code: 'aborted' });
    assert.equal(fake.sessions.length, 1);
    assert.equal(fake.sessions[0].closes, 0);
  } finally { await connection.close(); }
  assert.equal(fake.sessions[0].closes, 1);
});

test('transport loss never replays mutations and invalidates session-owned handles', async () => {
  let mutations = 0;
  const fake = scripted((state, frame) => {
    if (frame.json.op === 'write') { mutations += 1; state.onClosed(new Error('lost after mutation')); }
    else state.reply(frame.id, { handle: 12 });
  });
  const connection = new Connection({ openChannel: fake.factory });
  try {
    const handle = await connection.request('open', {});
    await assert.rejects(connection.request('write', {}), (error) => isConnectionLost(error) && error.code === 'unknown');
    assert.equal(fake.sessions.length, 1);
    assert.equal(mutations, 1);
    await connection.info();
    assert.equal(fake.sessions.length, 2);
    await assert.rejects(connection.request('pread', { handle: 12 }, { session: handle.session }), isConnectionLost);
    assert.equal(mutations, 1);
    assert.ok(!fake.sessions[1].frames.some(({ json }) => json.op === 'pread'));
  } finally { await connection.close(); }
});

test('connect cancellation owns a late channel and close awaits its disposal', async () => {
  const late = deferred();
  let signal;
  let closes = 0;
  const connection = new Connection({ openChannel: (options) => { signal = options.signal; return late.promise; } });
  const controller = new AbortController();
  const pending = connection.info(controller.signal);
  await tick();
  controller.abort();
  await assert.rejects(pending, { code: 'aborted' });
  assert.equal(signal.aborted, true);
  let closed = false;
  const closing = connection.close().then(() => { closed = true; });
  await tick();
  assert.equal(closed, false);
  late.resolve({ write() {}, async close() { closes += 1; } });
  await closing;
  assert.equal(closes, 1);
  await assert.rejects(connection.info(), /closed/);
});

test('one cancelled startup waiter does not cancel another caller sharing the same startup', async () => {
  const ready = deferred();
  const fake = scripted();
  let startup;
  const connection = new Connection({ openChannel: async (options) => {
    startup = options;
    await ready.promise;
    return fake.factory(options);
  } });
  const controller = new AbortController();
  const first = connection.info(controller.signal);
  const second = connection.info();
  await tick();
  controller.abort();
  await assert.rejects(first, { code: 'aborted' });
  assert.equal(startup.signal.aborted, false);
  ready.resolve();
  assert.equal((await second).version, '1.0.4');
  await connection.close();
});

test('startup timeout and heartbeat silence seal uncertain sessions, and callback failures drain cancellation', async () => {
  let closed = 0;
  const noHello = new Connection({ startTimeoutMs: 15, openChannel: async () => ({ write() {}, async close() { closed += 1; } }) });
  await assert.rejects(noHello.info(), (error) => isConnectionLost(error) && /timed out/.test(error.message));
  await noHello.close();
  assert.equal(closed, 1);
  const fake = scripted((state, frame) => {
    if (frame.json.op === 'output') state.reply(frame.id, { kind: 'output' }, new Uint8Array([65]), FrameType.event);
    if (frame.type === FrameType.cancel) state.reply(frame.id, { code: 'aborted' }, undefined, FrameType.error);
  });
  const connection = new Connection({ openChannel: fake.factory, pingIntervalMs: 5, silenceLimitMs: 20 });
  try {
    await assert.rejects(connection.request('output', {}, { onEvent: () => { throw new Error('consumer failed'); } }), { code: 'callback_error' });
    await assert.rejects(connection.request('waiting', {}), (error) => isConnectionLost(error) && /timed out/.test(error.message));
    assert.ok(fake.sessions[0].frames.some(({ type }) => type === FrameType.ping));
  } finally { await connection.close(); }
});

const sshOptions = { host: 'example.tailnet.ts.net', port: 22, username: 'test',
  auth: { type: 'password', password: 'test-only' }, verifyHostKey: () => false };

const testDaemon = { bytes: new Uint8Array([0, 1, 2]), sha256: 'a'.repeat(64) };
function cachedBootstrap(command, events) {
  const output = command.includes('PI-ENV-PROBE') ? `PI-ENV-PROBE ${token}\nDarwin\narm64\n/work/it's pi-env\n`
    : command.includes('PI-ENV-CACHE') ? `PI-ENV-CACHE ${token} present\n` : undefined;
  if (!output) return undefined;
  return { write() { throw new Error('Cached bootstrap needs no upload.'); },
    sendEof() { events.onData(Uint8Array.from(Buffer.from(output)).buffer); events.onClosed(0); }, async close() {} };
}

test('SSH channel factory owns native buffers, separates stderr, quotes command and disposes both resources', async () => {
  let callbacks;
  let receivedOptions;
  const sent = [];
  const output = [];
  let shellsClosed = 0;
  let disconnected = 0;
  const input = { ...sshOptions, auth: { ...sshOptions.auth } };
  const factory = createSshChannelFactory(input, { loadDaemon: async () => testDaemon, connect: async (options) => {
    receivedOptions = options;
    return {
      async openShell(options, events) {
        assert.equal(options.term, '');
        const bootstrap = cachedBootstrap(options.command, events);
        if (bootstrap) return bootstrap;
        assert.match(options.command, /^'\/work\/it'"'"'s pi-env\/\.pi\/mobile\/tools\/pi-env-a{32}' serve --token /);
        callbacks = events;
        return { write(bytes) { sent.push(bytes); }, async close() { shellsClosed += 1; } };
      },
      async disconnect() { disconnected += 1; },
    };
  } });
  input.auth.password = 'changed after admission';
  const channel = await factory({ token, signal: new AbortController().signal, onData: (bytes) => output.push(bytes), onClosed() {} });
  assert.equal(receivedOptions.auth.password, 'test-only');
  const bytes = new Uint8Array([0, 1, 255]);
  callbacks.onData(bytes.buffer);
  callbacks.onStderr(bytes.buffer);
  bytes.fill(3);
  assert.deepEqual([...output[0]], [0, 1, 255]);
  assert.equal(output.length, 1);
  channel.write(bytes.subarray(1));
  bytes.fill(9);
  assert.deepEqual([...sent[0]], [3, 3]);
  await channel.close();
  await channel.close();
  assert.equal(shellsClosed, 1);
  assert.equal(disconnected, 1);
  assert.throws(() => channel.write(bytes), /closed/);
});

test('SSH cancellation closes a late shell; trust/auth errors preserve codes without native diagnostics', async () => {
  const late = deferred();
  const opened = deferred();
  let shellCloses = 0;
  let disconnects = 0;
  const controller = new AbortController();
  const factory = createSshChannelFactory(sshOptions, { connect: async () => ({
    async openShell() { opened.resolve(); return late.promise; },
    async disconnect() { disconnects += 1; },
  }) });
  const pending = factory({ token, signal: controller.signal, onData() {}, onClosed() {} });
  await opened.promise;
  controller.abort();
  late.resolve({ write() {}, async close() { shellCloses += 1; } });
  await assert.rejects(pending, { code: 'CANCELLED' });
  assert.ok(disconnects >= 1);
  assert.ok(shellCloses >= 1);
  for (const code of ['HOST_KEY_REJECTED', 'AUTH_FAILED', 'CONNECT', 'KEY', 'INVALID_ARGUMENT', 'INTERNAL']) {
    const error = Object.assign(new Error('synthetic-private-key synthetic-password'), { code });
    const failed = createSshChannelFactory(sshOptions, { connect: async () => { throw error; } });
    await assert.rejects(failed({ token, signal: new AbortController().signal, onData() {}, onClosed() {} }), (actual) => {
      assert.equal(actual.code, code);
      assert.doesNotMatch(actual.message + actual.stack + JSON.stringify(actual), /synthetic-private-key|synthetic-password/);
      assert.equal(actual.cause, undefined);
      return true;
    });
  }
});

test('production Pi connection interoperates with real daemon binary, exec, cancellation and recovery',
  { timeout: 15_000, skip: !(await remoteDaemonPath()) && 'Install the matching external Pi daemon or set PI_ENV_DAEMON' }, async (t) => {
    const fixture = await remoteDaemonFixture(t, { fragment: true });
    const connection = new Connection({ openChannel: fixture.openChannel });
    t.after(() => connection.close());
    assert.equal((await connection.info()).version, '1.0.4');
    const path = join(fixture.directory, 'bytes-π');
    const bytes = Uint8Array.from({ length: 65553 }, (_, i) => i & 255);
    await connection.request('write', { path }, { payload: bytes });
    assert.deepEqual(new Uint8Array(await readFile(path)), bytes);
    const opened = await connection.request('open', { path, noFollow: true });
    assert.deepEqual((await connection.request('pread', { handle: opened.json.handle, offset: 0, length: bytes.length }, { session: opened.session })).payload, bytes);
    const output = [];
    const result = await connection.request('exec', { argv: ['/bin/sh', '-c', "printf 'stdout-π'; printf 'stderr' >&2; exit 7"], cwd: fixture.directory,
      env: {}, inheritEnv: true }, { onEvent: (json, payload) => output.push([json.stream, Buffer.from(payload).toString('utf8')]) });
    assert.equal(result.json.exitCode, 7);
    assert.equal(output.filter(([stream]) => stream === 'stdout').map(([, text]) => text).join(''), 'stdout-π');
    assert.equal(output.filter(([stream]) => stream === 'stderr').map(([, text]) => text).join(''), 'stderr');
    const controller = new AbortController();
    await assert.rejects(connection.request('exec', { argv: ['/bin/sh', '-c', 'sleep 10'], cwd: fixture.directory, env: {}, inheritEnv: true },
      { signal: controller.signal, onStart: () => controller.abort() }), { code: 'aborted' });
    assert.equal((await connection.request('lstat', { path })).json.size, bytes.length);
    assert.equal(fixture.metrics.sessions, 1);
    const child = [...fixture.children][0];
    await new Promise((resolve) => { child.once('close', resolve); child.kill(); });
    await assert.rejects(connection.request('fstat', { handle: opened.json.handle }, { session: opened.session }), isConnectionLost);
    await connection.info();
    assert.equal(fixture.metrics.sessions, 2);
    await connection.request('rm', { path, recursive: false, force: false });
  });
