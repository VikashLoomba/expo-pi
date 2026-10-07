import assert from 'node:assert/strict';
import test from 'node:test';
import { installBashBrowserHooks } from './helpers/bash-browser-hooks.mjs';

const hooks = installBashBrowserHooks();
test.after(() => hooks.deregister());
const { runSshCommand } = await import('../src/pi/execution/remote/command-channel.ts');
const { provisionDaemon } = await import('../src/pi/execution/remote/provisioning.ts');
const token = '0123456789abcdef0123456789abcdef';
const binary = { bytes: Uint8Array.from([0, 255, 2]), sha256: 'a'.repeat(64) };
const deferred = () => { let resolve; const promise = new Promise((r) => { resolve = r; }); return { promise, resolve }; };
const tick = () => new Promise((resolve) => setImmediate(resolve));
const queueFull = () => Object.assign(new Error('Queue limit'), { code: 'QUEUE_FULL' });
const nativeClosed = () => Object.assign(new Error('Native channel closed'), { code: 'CLOSED' });
const data = (text) => Uint8Array.from(Buffer.from(text)).buffer;

test('bootstrap output owns native buffers, excludes stderr, and waits for exit before close', async () => {
  let events;
  let closed = 0;
  let disconnected = 0;
  const eof = deferred();
  const connection = {
    async openShell(options, callbacks) {
      assert.equal(options.term, ''); events = callbacks;
      return { write() {}, sendEof() { eof.resolve(); }, async close() { closed++; } };
    },
    async disconnect() { disconnected++; },
  };
  let settled = false;
  const pending = runSshCommand(connection, 'probe', { signal: new AbortController().signal });
  void pending.then(() => { settled = true; });
  await eof.promise;
  const native = new Uint8Array([65, 66, 67]);
  events.onData(native.buffer); native.fill(88);
  events.onStderr(data('private remote diagnostic'));
  await tick();
  assert.equal(settled, false);
  assert.equal(closed, 0);
  events.onClosed(17);
  assert.deepEqual(await pending, { stdout: 'ABC', exitCode: 17 });
  assert.equal(closed, 1);
  assert.equal(disconnected, 0);
});

test('EOF racing native command completion drains queued output and exit status without replay or disconnect', async () => {
  for (const exitCode of [0, 23]) {
    let opens = 0;
    let closes = 0;
    let eofCalls = 0;
    let disconnects = 0;
    const result = await runSshCommand({
      async openShell(_options, events) {
        opens++;
        return {
          write() { assert.fail('Read-only command wrote input'); },
          sendEof() {
            eofCalls++;
            setImmediate(() => { events.onData(data('completed-output')); events.onClosed(exitCode); });
            throw nativeClosed();
          },
          async close() { closes++; },
        };
      }, async disconnect() { disconnects++; },
    }, 'short-command', { signal: new AbortController().signal });
    assert.deepEqual(result, { stdout: 'completed-output', exitCode });
    assert.equal(opens, 1);
    assert.equal(eofCalls, 1);
    assert.equal(closes, 1);
    assert.equal(disconnects, 0);
  }
});

test('EOF CLOSED still fails when the queued close has no exit status or never arrives before the deadline', async () => {
  for (const mode of ['missing-status', 'missing-close']) {
    let opens = 0;
    let closes = 0;
    let disconnects = 0;
    await assert.rejects(runSshCommand({
      async openShell(_options, events) {
        opens++;
        return {
          write() {},
          sendEof() {
            setImmediate(() => {
              events.onData(data('output alone is insufficient'));
              if (mode === 'missing-status') events.onClosed(undefined);
            });
            throw nativeClosed();
          },
          async close() { closes++; },
        };
      }, async disconnect() { disconnects++; },
    }, 'short-command', { signal: new AbortController().signal, timeoutMs: 20 }),
    { code: mode === 'missing-status' ? 'CLOSED' : 'TIMEOUT' });
    assert.equal(opens, 1);
    assert.equal(closes, 1);
    assert.ok(disconnects >= 1);
  }
});

test('cancellation interrupts terminal draining after EOF reports CLOSED', async () => {
  const controller = new AbortController();
  let closes = 0;
  let disconnects = 0;
  await assert.rejects(runSshCommand({
    async openShell() {
      return {
        write() {}, sendEof() { setImmediate(() => controller.abort()); throw nativeClosed(); },
        async close() { closes++; },
      };
    }, async disconnect() { disconnects++; },
  }, 'short-command', { signal: controller.signal }), { code: 'CANCELLED' });
  assert.equal(closes, 1);
  assert.ok(disconnects >= 1);
});

test('CLOSED during a binary write remains a failure even when successful exit callbacks are queued', async () => {
  let writes = 0;
  let closes = 0;
  let disconnects = 0;
  await assert.rejects(runSshCommand({
    async openShell(_options, events) {
      return {
        write() {
          writes++;
          setImmediate(() => { events.onData(data('untrusted-success')); events.onClosed(0); });
          throw nativeClosed();
        },
        sendEof() { assert.fail('EOF after a rejected binary write'); }, async close() { closes++; },
      };
    }, async disconnect() { disconnects++; },
  }, 'upload', { signal: new AbortController().signal, input: binary.bytes }), { code: 'CLOSED' });
  assert.equal(writes, 1);
  assert.equal(closes, 1);
  assert.ok(disconnects >= 1);
});

test('binary upload uses bounded writes, retries only rejected queue writes, and delivers EOF after every byte', async () => {
  const input = Uint8Array.from({ length: 200_123 }, (_, i) => (i * 113) & 255);
  const accepted = [];
  let attempts = 0;
  let eofAttempts = 0;
  let closed = 0;
  const connection = {
    async openShell(options, events) {
      return {
        write(bytes) {
          assert.ok(bytes.byteLength <= 64 * 1024);
          if (++attempts <= 2) throw queueFull();
          accepted.push(bytes.slice());
        },
        sendEof() {
          if (++eofAttempts <= 2) throw queueFull();
          assert.deepEqual(Buffer.concat(accepted), Buffer.from(input));
          queueMicrotask(() => events.onClosed(0));
        },
        async close() { closed++; },
      };
    }, async disconnect() { assert.fail('Successful upload must keep SSH alive.'); },
  };
  assert.equal((await runSshCommand(connection, 'upload', { signal: new AbortController().signal, input })).exitCode, 0);
  assert.equal(attempts, 6);
  assert.equal(eofAttempts, 3);
  assert.equal(closed, 1);
});

test('a native write failure is not retried and tears down both command and connection', async () => {
  const writeError = Object.assign(new Error('Native write failed'), { code: 'IO' });
  let writes = 0;
  let closes = 0;
  let disconnects = 0;
  const connection = {
    async openShell() { return {
      write() { writes++; throw writeError; }, sendEof() { assert.fail('EOF after write failure'); }, async close() { closes++; },
    }; },
    async disconnect() { disconnects++; },
  };
  await assert.rejects(runSshCommand(connection, 'upload', {
    signal: new AbortController().signal, input: binary.bytes,
  }), (error) => error === writeError);
  assert.equal(writes, 1);
  assert.equal(closes, 1);
  assert.ok(disconnects >= 1);
});

test('cancellation interrupts queue backpressure and drains the owned command', async () => {
  const controller = new AbortController();
  const writing = deferred();
  let closes = 0;
  let disconnects = 0;
  const connection = {
    async openShell() { return {
      write() { writing.resolve(); throw queueFull(); }, sendEof() { assert.fail('Cancelled upload EOF'); }, async close() { closes++; },
    }; },
    async disconnect() { disconnects++; },
  };
  const pending = runSshCommand(connection, 'upload', { signal: controller.signal, input: binary.bytes });
  await writing.promise;
  controller.abort();
  await assert.rejects(pending, { code: 'CANCELLED' });
  assert.equal(closes, 1);
  assert.ok(disconnects >= 1);
});

test('synchronous cancellation before deferred command admission opens no shell', async () => {
  const controller = new AbortController();
  let opened = 0;
  const pending = runSshCommand({
    async openShell() { opened++; assert.fail('Cancelled command was admitted.'); }, async disconnect() {},
  }, 'remote-side-effect', { signal: controller.signal });
  controller.abort();
  await assert.rejects(pending, { code: 'CANCELLED' });
  assert.equal(opened, 0);
});

test('timeout owns a channel delivered after timeout and waits for its cleanup', async () => {
  const late = deferred();
  const disconnected = deferred();
  let closed = 0;
  const pending = runSshCommand({
    openShell() { return late.promise; },
    async disconnect() { disconnected.resolve(); },
  }, 'probe', { signal: new AbortController().signal, timeoutMs: 5 });
  let settled = false;
  void pending.catch(() => { settled = true; });
  await disconnected.promise;
  assert.equal(settled, false);
  late.resolve({ write() { assert.fail('Write after timeout'); }, sendEof() { assert.fail('EOF after timeout'); }, async close() { closed++; } });
  await assert.rejects(pending, { code: 'TIMEOUT' });
  assert.equal(closed, 1);
});

test('combined bootstrap stdout and stderr are bounded and diagnostics never become failure text', async () => {
  let disconnected = 0;
  const pending = runSshCommand({
    async openShell(options, events) {
      queueMicrotask(() => {
        events.onData(new Uint8Array(32 * 1024).buffer);
        events.onStderr(new Uint8Array(32 * 1024 + 1).fill(83).buffer);
      });
      return { write() {}, sendEof() {}, async close() {} };
    }, async disconnect() { disconnected++; },
  }, 'probe', { signal: new AbortController().signal });
  await assert.rejects(pending, (error) => error.code === 'DAEMON_SETUP' && !error.message.includes('SSSS'));
  assert.ok(disconnected >= 1);
});

test('a setup channel lost without exit status is a transport failure, not an unsupported platform', async () => {
  let disconnected = 0;
  await assert.rejects(runSshCommand({
    async openShell(options, events) {
      return { write() {}, sendEof() { events.onClosed(undefined); }, async close() {} };
    }, async disconnect() { disconnected++; },
  }, 'probe', { signal: new AbortController().signal }), { code: 'CLOSED' });
  assert.ok(disconnected >= 1);
});

function scriptedBootstrap({ state = 'missing', uploadStatus = 0, uploadMarker = true, eofClosed = false } = {}) {
  const commands = [];
  const writes = [];
  return {
    commands, writes,
    async openShell(options, events) {
      commands.push(options.command);
      let output;
      let status = 0;
      if (options.command.includes('PI-ENV-PROBE')) output = `login banner\nPI-ENV-PROBE ${token}\nLinux\naarch64\n/home/owner\n`;
      else if (options.command.includes('PI-ENV-CACHE')) output = `PI-ENV-CACHE ${token} ${state}\n`;
      else if (options.command.includes('PI-ENV-UPLOAD')) {
        output = uploadMarker ? `PI-ENV-UPLOAD ${token} verified\n` : '';
        status = uploadStatus;
      } else assert.fail('Unexpected command');
      return {
        write(bytes) { writes.push(bytes.slice()); },
        sendEof() {
          if (eofClosed) {
            setImmediate(() => { events.onData(data(output)); events.onClosed(status); });
            throw nativeClosed();
          }
          events.onData(data(output)); events.onClosed(status);
        }, async close() {},
      };
    }, async disconnect() {},
  };
}

test('provisioning selects detected target and reports ordered fresh-install stages', async () => {
  const connection = scriptedBootstrap();
  const stages = [];
  const path = await provisionDaemon(connection, { token, signal: new AbortController().signal,
    loadDaemon: async (remote) => { assert.deepEqual(remote, { platform: 'linux', arch: 'arm64' }); return binary; },
    onProgress: (stage) => stages.push(stage),
  });
  assert.equal(path, `/home/owner/.pi/mobile/tools/pi-env-${binary.sha256.slice(0, 32)}`);
  assert.deepEqual(stages, ['detecting', 'checking', 'uploading']);
  assert.deepEqual(Buffer.concat(connection.writes), Buffer.from(binary.bytes));
});

test('cache verification rejects absent hash tools and malformed replies before any upload', async () => {
  for (const [state, code] of [['nohash', 'DAEMON_VERIFY'], ['unexpected', 'DAEMON_SETUP']]) {
    const connection = scriptedBootstrap({ state });
    await assert.rejects(provisionDaemon(connection, { token, signal: new AbortController().signal, loadDaemon: async () => binary }), { code });
    assert.equal(connection.commands.length, 2);
    assert.equal(connection.writes.length, 0);
  }
});

test('provisioning accepts queued verified cache output after EOF CLOSED and still rejects invalid markers', async () => {
  const connection = scriptedBootstrap({ state: 'present', eofClosed: true });
  const result = await provisionDaemon(connection, { token, signal: new AbortController().signal, loadDaemon: async () => binary });
  assert.equal(result, `/home/owner/.pi/mobile/tools/pi-env-${binary.sha256.slice(0, 32)}`);
  assert.equal(connection.commands.length, 2);
  assert.equal(connection.writes.length, 0);
  const malformed = scriptedBootstrap({ state: 'unexpected', eofClosed: true });
  await assert.rejects(provisionDaemon(malformed, { token, signal: new AbortController().signal, loadDaemon: async () => binary }), { code: 'DAEMON_SETUP' });
  assert.equal(malformed.commands.length, 2);
});

test('upload requires both success status and verification marker', async () => {
  for (const options of [{ uploadStatus: 1 }, { uploadMarker: false }]) {
    const connection = scriptedBootstrap(options);
    await assert.rejects(provisionDaemon(connection, { token, signal: new AbortController().signal, loadDaemon: async () => binary }), { code: 'DAEMON_UPLOAD' });
  }
});
