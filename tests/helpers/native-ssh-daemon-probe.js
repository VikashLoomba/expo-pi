// Validation only: a small client for Pi's documented v1 wire format. This is
// never imported by product code and does not implement an ExecutionEnv.
// Use the installed browser implementation in Hermes and Node smoke runs.
// Retained subarrays below are copied because Hermes can return a Uint8Array.
import { Buffer } from 'buffer/index.js';
import { PI_DAEMON_VERSION } from '../../src/pi/execution/remote/daemon-manifest';

const assert = (condition, message) => { if (!condition) throw new Error(message); };
const quote = (value) => `'${value.replace(/'/g, `'"'"'`)}'`;

function frame(type, id, json, payload = new Uint8Array(0)) {
  const body = Buffer.from(JSON.stringify(json), 'utf8');
  const header = Buffer.alloc(13);
  header.writeUInt32BE(9 + body.length + payload.length, 0);
  header.writeUInt8(type, 4);
  header.writeUInt32BE(id, 5);
  header.writeUInt32BE(body.length, 9);
  return Buffer.concat([header, body, payload]);
}

async function bounded(promise, label, milliseconds = 10_000) {
  let timer;
  try {
    return await Promise.race([promise, new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error(`${label} exceeded ${milliseconds}ms`)), milliseconds);
    })]);
  } finally { clearTimeout(timer); }
}

export default async function nativeSshDaemonProbe({ connection, daemonPath, signal, scratchDirectory }) {
  const checks = [];
  const observations = { daemonPath, framesReceived: 0, stdoutCallbacks: 0, stderrBytes: 0,
    syncNoiseBytes: 0, partialFrames: 0, multipleFramesInCallback: 0 };
  const run = async (name, operation) => {
    const started = Date.now();
    try {
      if (signal?.aborted) throw new Error('Pi daemon probe aborted');
      const value = await operation();
      checks.push({ name, passed: true, milliseconds: Date.now() - started });
      return value;
    } catch (error) {
      checks.push({ name, passed: false, milliseconds: Date.now() - started,
        error: { message: String(error), ...(error.code ? { code: error.code } : {}) } });
      return undefined;
    }
  };
  const token = `${Date.now().toString(16)}${Math.random().toString(16).slice(2)}00000000000000000000000000000000`.slice(0, 32);
  const marker = Buffer.from(`PI-ENV ${token}\n`, 'utf8');
  const pending = new Map();
  let buffer = Buffer.alloc(0);
  let synced = false;
  let shell;
  let fault;
  let disposing = false;
  let nextId = 0;
  let ping;
  let closedCount = 0;
  let closedCode;
  let resolveClosed;
  const closed = new Promise((resolve) => { resolveClosed = resolve; });
  const fail = (error) => {
    fault ??= error;
    for (const entry of pending.values()) { clearTimeout(entry.timer); entry.reject(error); }
    pending.clear();
  };
  const abort = () => {
    fail(new Error('Pi daemon probe aborted'));
    if (shell) shell.close().catch(() => {});
  };
  const receive = (data) => {
    if (fault || disposing) return;
    observations.stdoutCallbacks += 1;
    try {
      // Own every retained byte; callback storage is supplied by native code.
      buffer = Buffer.concat([buffer, Buffer.from(new Uint8Array(data))]);
      assert(buffer.length <= 17 * 1024 * 1024, 'Pi receive buffer exceeded validation cap');
      if (!synced) {
        const offset = buffer.indexOf(marker);
        if (offset < 0) {
          assert(buffer.length <= 1024 * 1024, 'Pi did not emit its synchronization marker');
          return;
        }
        observations.syncNoiseBytes = offset;
        buffer = Buffer.from(buffer.subarray(offset + marker.length));
        synced = true;
      }
      let received = 0;
      while (buffer.length >= 4) {
        const length = buffer.readUInt32BE(0);
        assert(length >= 9 && length <= 16 * 1024 * 1024, 'Pi returned an invalid frame length');
        if (buffer.length < length + 4) { observations.partialFrames += 1; break; }
        const type = buffer.readUInt8(4);
        const id = buffer.readUInt32BE(5);
        const jsonLength = buffer.readUInt32BE(9);
        assert(jsonLength <= length - 9, 'Pi returned an invalid JSON length');
        const json = JSON.parse(buffer.toString('utf8', 13, 13 + jsonLength));
        assert(json !== null && typeof json === 'object' && !Array.isArray(json), 'Pi JSON must be an object');
        const payload = Buffer.from(buffer.subarray(13 + jsonLength, length + 4));
        buffer = Buffer.from(buffer.subarray(length + 4));
        observations.framesReceived += 1;
        received += 1;
        if (type === 6) { assert(id === 0, 'Pi ping has a request ID'); continue; }
        const entry = pending.get(id);
        assert(entry, `Pi returned an unexpected request ID ${id}`);
        if (type === 4) { entry.events.push({ json, payload }); continue; }
        assert(type === 2 || type === 3, `Pi returned unexpected frame type ${type}`);
        clearTimeout(entry.timer);
        pending.delete(id);
        if (type === 3) {
          const error = new Error(json.message || 'Pi daemon request failed');
          error.code = json.code;
          entry.reject(error);
        } else entry.resolve({ json, payload, events: entry.events });
      }
      if (received > 1) observations.multipleFramesInCallback += 1;
    } catch (error) { fail(error); }
  };
  const start = (op, json = {}, payload, split = false) => {
    const id = ++nextId;
    const promise = new Promise((resolve, reject) => {
      if (fault || signal?.aborted) { reject(fault || new Error('Pi daemon probe aborted')); return; }
      const timer = setTimeout(() => fail(new Error(`Pi ${op} request timed out`)), 10_000);
      pending.set(id, { resolve, reject, timer, events: [] });
      try {
        const bytes = frame(1, id, { op, ...json }, payload);
        if (split) {
          // Force separate write calls across the length/header/body boundaries;
          // the transport may legally coalesce them before delivery.
          shell.write(bytes.subarray(0, 2));
          shell.write(bytes.subarray(2, 11));
          shell.write(bytes.subarray(11));
        } else shell.write(bytes);
      } catch (error) { fail(error); }
    });
    return { id, promise };
  };
  const request = (op, json, payload) => start(op, json, payload).promise;
  signal?.addEventListener('abort', abort, { once: true });
  try {
    const ready = await run('Real Pi daemon synchronization and hello over SSH', async () => {
      assert(typeof daemonPath === 'string' && daemonPath.startsWith('/'), 'An absolute daemon path is required');
      assert(typeof scratchDirectory === 'string' && scratchDirectory.startsWith('/'), 'A fixture scratch directory is required');
      const opening = connection.openShell({ term: '', command: `${quote(daemonPath)} serve --token ${token}` }, {
        onData: receive,
        onStderr: (data) => { observations.stderrBytes += data.byteLength; },
        onClosed: (code) => {
          closedCount += 1;
          closedCode = code;
          resolveClosed();
          if (!disposing) fail(new Error(`Pi daemon channel closed unexpectedly (${code})`));
        },
      });
      // If setup times out, dispose a channel that arrives later as well.
      opening.then((opened) => { if (disposing) opened.close().catch(() => {}); }, () => {});
      shell = await bounded(opening, 'Pi SSH channel open');
      const reply = await start('hello', { protocol: 1 }, undefined, true).promise;
      const hello = reply.json;
      assert(synced && reply.payload.length === 0, 'Pi synchronization or hello payload was invalid');
      assert(hello.protocol === 1 && hello.version === PI_DAEMON_VERSION, 'Unexpected Pi protocol or daemon version');
      assert(hello.os === 'macos' && hello.arch === 'aarch64' && hello.separator === '/', 'Hello did not describe the test Mac');
      assert(['home', 'tmpdir', 'cwd'].every((key) => typeof hello[key] === 'string' && hello[key].startsWith('/')),
        'Pi hello omitted absolute remote paths');
      assert(Number.isInteger(hello.pid) && hello.pid > 0 && hello.driveCwds !== null
        && typeof hello.driveCwds === 'object' && !Array.isArray(hello.driveCwds), 'Pi hello omitted process/path metadata');
      observations.hello = hello;
      ping = setInterval(() => {
        try { if (!fault && !disposing) shell.write(frame(6, 0, {})); }
        catch (error) { fail(error); }
      }, 5000);
      return hello;
    });
    if (!ready) return { checks, observations };

    await run('Real Pi binary file write/read roundtrip', async () => {
      const path = `${scratchDirectory.replace(/\/$/, '')}/native-ssh-${token}.bin`;
      const bytes = Buffer.alloc(64 * 1024 + 17);
      for (let i = 0; i < bytes.length; i += 1) bytes[i] = (i * 73 + 19) & 255;
      let handle;
      let written = false;
      try {
        await request('write', { path, append: false, parents: false }, bytes);
        written = true;
        const opened = await request('open', { path, noFollow: true });
        handle = opened.json.handle;
        assert(Number.isInteger(handle), 'Pi file open did not return a handle');
        const read = await request('pread', { handle, offset: 0, length: bytes.length });
        assert(read.payload.equals(bytes), 'Binary file payload changed across SSH and Pi framing');
        observations.binaryRoundtripBytes = bytes.length;
      } finally {
        if (handle !== undefined && !fault) await request('close', { handle });
        if (written && !fault) await request('rm', { path, recursive: false, force: false });
      }
    });

    await run('Real Pi exec stdout/stderr events and exit status', async () => {
      const reply = await request('exec', { argv: ['/bin/sh', '-c', "printf 'pi-stdio-π\\n'; printf 'pi-diagnostic\\n' >&2; exit 7"],
        cwd: scratchDirectory, env: {}, inheritEnv: true, timeoutMs: 5000 });
      const streams = { stdout: [], stderr: [] };
      for (const event of reply.events) {
        assert(event.json.kind === 'output' && Object.hasOwn(streams, event.json.stream), 'Unexpected Pi exec event');
        streams[event.json.stream].push(event.payload);
      }
      assert(Buffer.concat(streams.stdout).toString('utf8') === 'pi-stdio-π\n', 'Pi stdout event bytes changed');
      assert(Buffer.concat(streams.stderr).toString('utf8') === 'pi-diagnostic\n', 'Pi stderr event bytes changed');
      assert(reply.json.exitCode === 7 && reply.payload.length === 0, 'Pi exec terminal result changed');
      observations.execOutputEvents = reply.events.length;
    });

    await run('Real Pi immediate exec cancellation returns aborted', async () => {
      const command = start('exec', { argv: ['/bin/sleep', '30'], cwd: scratchDirectory,
        env: {}, inheritEnv: true, timeoutMs: 20_000 });
      // Observe rejection before sending cancellation, avoiding an unhandled
      // rejection even if native callbacks dispatch immediately.
      const outcome = command.promise.then(() => ({ succeeded: true }), (error) => ({ error }));
      shell.write(frame(5, command.id, {}));
      const result = await outcome;
      assert(result.error?.code === 'aborted', 'Pi cancellation did not settle with the documented aborted code');
      const reply = await request('lstat', { path: scratchDirectory });
      assert(reply.json.kind === 'directory', 'The daemon was not usable after cancelling one request');
    });
    return { checks, observations };
  } finally {
    disposing = true;
    clearInterval(ping);
    signal?.removeEventListener('abort', abort);
    fail(new Error('Pi daemon probe finished'));
    if (shell) {
      const started = Date.now();
      try {
        shell.sendEof();
        await bounded(closed, 'Pi daemon EOF shutdown', 5000);
        await bounded(shell.close(), 'Pi daemon channel close', 3000);
        assert(closedCount === 1 && closedCode === 0, 'Pi daemon did not exit cleanly exactly once after EOF');
        checks.push({ name: 'Real Pi daemon exits cleanly on channel EOF', passed: true, milliseconds: Date.now() - started });
      } catch (error) {
        checks.push({ name: 'Real Pi daemon exits cleanly on channel EOF', passed: false,
          milliseconds: Date.now() - started, error: { message: String(error) } });
        await bounded(shell.close(), 'Pi daemon fallback channel close', 3000).catch(() => {});
      }
    }
    observations.closedCount = closedCount;
    observations.exitCode = closedCode;
  }
}
