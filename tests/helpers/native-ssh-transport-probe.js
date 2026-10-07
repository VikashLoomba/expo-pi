// Standalone Metro entry. Only the validation runner imports this file; it never
// enters the product bundle. Targets are disposable SSH fixtures on the test Mac.
import { Platform } from 'react-native';
import { connect, nativeVersion, SshError } from '@osuki-dev/react-native-ssh';
import sshPackage from '@osuki-dev/react-native-ssh/package.json';
import nativeSshDaemonProbe from './native-ssh-daemon-probe';

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const assert = (condition, message) => { if (!condition) throw new Error(message); };
const bytesEqual = (left, right) => left.length === right.length && left.every((value, index) => value === right[index]);

async function bounded(promise, label, ms = 10_000) {
  let timer;
  try {
    return await Promise.race([promise, new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error(`${label} did not settle within ${ms}ms`)), ms);
    })]);
  } finally { clearTimeout(timer); }
}

async function until(condition, label, signal, ms = 10_000) {
  const end = Date.now() + ms;
  while (!condition()) {
    if (signal.aborted) throw new Error('Transport probe aborted');
    if (Date.now() >= end) throw new Error(`${label} did not occur within ${ms}ms`);
    await delay(20);
  }
}

function capture(limit = 512 * 1024) {
  const state = { stdout: [], stderr: [], received: 0, closedCount: 0, fault: undefined, exitCode: undefined };
  let resolveClosed;
  state.closed = new Promise((resolve) => { resolveClosed = resolve; });
  const receive = (stream, buffer) => {
    // Native owns callback buffers. Retained data must be copied immediately.
    const bytes = new Uint8Array(buffer).slice();
    state.received += bytes.length;
    if (state.received > limit) { state.fault = `Output exceeded ${limit} byte test cap`; return; }
    state[stream].push(bytes);
  };
  state.events = {
    onData: (buffer) => receive('stdout', buffer),
    onStderr: (buffer) => receive('stderr', buffer),
    onClosed: (code) => { state.closedCount += 1; state.exitCode = code; resolveClosed(); },
  };
  state.join = (stream) => {
    const chunks = state[stream];
    const output = new Uint8Array(chunks.reduce((sum, chunk) => sum + chunk.length, 0));
    let offset = 0;
    for (const chunk of chunks) { output.set(chunk, offset); offset += chunk.length; }
    return output;
  };
  return state;
}

export default async function nativeSshTransportProbe({ platform, signal, config }) {
  assert(typeof globalThis.HermesInternal === 'object' && Platform.OS === platform,
    'A Hermes runtime on the requested native platform is required before SSH testing');
  const checks = [];
  const observations = {};
  const connections = new Set();
  const controllers = new Set();
  const run = async (name, operation, allowAborted = false) => {
    const start = Date.now();
    try {
      if (signal.aborted && !allowAborted) throw new Error('Transport probe aborted');
      await operation();
      checks.push({ name, passed: true, milliseconds: Date.now() - start });
    } catch (error) {
      checks.push({ name, passed: false, milliseconds: Date.now() - start,
        error: SshError.is(error) ? { code: error.code, message: error.message } : { message: String(error) } });
    }
  };
  const cleanup = async (connection) => {
    if (!connection) return;
    await bounded(connection.disconnect(), 'connection cleanup', 5000);
    connections.delete(connection);
  };
  const abortAll = () => {
    for (const controller of controllers) controller.abort();
    for (const connection of connections) connection.disconnect().catch(() => {});
  };
  signal.addEventListener('abort', abortAll, { once: true });
  const connectTo = async (target, override = {}) => {
    const controller = new AbortController();
    controllers.add(controller);
    const timer = setTimeout(() => controller.abort(), 10_000);
    try {
      const connection = await connect({
        host: target.host, port: target.port, username: target.username,
        auth: target.privateKey ? { type: 'privateKey', privateKey: target.privateKey }
          : { type: 'password', password: target.password },
        verifyHostKey: (key) => key.fingerprint === target.fingerprint,
        signal: controller.signal, connectTimeoutMs: 8000, keepaliveIntervalMs: 1000, keepaliveMax: 2,
        ...override,
      });
      connections.add(connection);
      return connection;
    } finally { clearTimeout(timer); controllers.delete(controller); }
  };
  const rejected = async (target, override, code) => {
    let connection;
    try {
      connection = await connectTo(target, override);
      throw new Error(`Connection unexpectedly succeeded instead of ${code}`);
    } catch (error) { assert(SshError.is(error, code), `Expected ${code}, got ${SshError.is(error) ? error.code : String(error)}`); }
    finally { await cleanup(connection); }
  };

  let connection;
  try {
    await run('Hermes native runtime', async () => {
      assert(typeof globalThis.HermesInternal === 'object' && Platform.OS === platform, 'Wrong runtime or platform');
      assert(Boolean(nativeVersion()), 'SSH native core missing');
    });
    await run('Pinned host key rejects an untrusted server', async () => {
      let presentedFingerprint;
      await rejected(config.upstream, { verifyHostKey: (key) => {
        presentedFingerprint = key.fingerprint;
        return false;
      } }, 'HOST_KEY_REJECTED');
      assert(presentedFingerprint === config.upstream.fingerprint, 'Verifier was not called with the expected fixture host key');
    });
    await run('Incorrect password rejects with AUTH_FAILED', () => rejected(config.upstream,
      { auth: { type: 'password', password: `${config.upstream.password}-incorrect` } }, 'AUTH_FAILED'));
    await run('Password authentication and pinned host acceptance', async () => {
      const passwordConnection = await connectTo(config.upstream);
      try {
        assert(passwordConnection.isConnected && passwordConnection.hostKey.fingerprint === config.upstream.fingerprint,
          'Authenticated connection does not expose the accepted key');
        const result = await bounded(passwordConnection.exec(config.upstream.commands.echo), 'password fixture exec');
        assert(result.stdout === config.upstream.expected.echo && result.stderr === '' && result.exitCode === 0,
          'Password-authenticated command returned unexpected output');
      } finally { await cleanup(passwordConnection); }
    });
    await run('Connect cancellation while host verification is pending', async () => {
      const controller = new AbortController();
      controllers.add(controller);
      let entered = false;
      let release;
      const pending = connectTo(config.upstream, { signal: controller.signal,
        verifyHostKey: () => { entered = true; return new Promise((resolve) => { release = resolve; }); } });
      const outcome = pending.then((value) => ({ value }), (error) => ({ error }));
      try {
        await until(() => entered, 'host verification callback', signal);
        controller.abort();
        const result = await bounded(outcome, 'cancelled connection', 3000);
        if (result.value) await cleanup(result.value);
        assert(SshError.is(result.error, 'CANCELLED'), 'Pending connect did not reject with CANCELLED');
      } finally { controller.abort(); release?.(false); controllers.delete(controller); }
    });
    await run('Private key authentication to the Mac OpenSSH server', async () => {
      connection = await connectTo(config.openssh);
      assert(connection.isConnected && connection.hostKey.fingerprint === config.openssh.fingerprint,
        'Private-key connection failed or accepted a different host key');
    });
    await run('Non-PTY exec returns exact stdout, separate stderr, and exit status', async () => {
      assert(connection?.isConnected, 'No OpenSSH connection');
      const result = await bounded(connection.exec(config.openssh.commands.streams), 'exec streams');
      assert(result.stdout === config.openssh.expected.stdout && result.stderr === config.openssh.expected.stderr
        && result.exitCode === config.openssh.expected.exitCode, 'stdout/stderr/status mismatch');
    });
    await run('execRaw preserves invalid UTF-8 bytes', async () => {
      assert(connection?.isConnected, 'No OpenSSH connection');
      const result = await bounded(connection.execRaw(config.openssh.commands.bytes), 'raw exec');
      assert(bytesEqual(new Uint8Array(result.stdout), config.openssh.expected.bytes)
        && result.stderr.byteLength === 0 && result.exitCode === 0, 'Raw output bytes changed');
    });
    await run('Streaming channel without PTY separates stdout/stderr and closes exactly once', async () => {
      assert(connection?.isConnected, 'No OpenSSH connection');
      const output = capture();
      const shell = await bounded(connection.openShell({ term: '', command: config.openssh.commands.streams }, output.events), 'open non-PTY stream');
      try {
        await bounded(output.closed, 'stream exit');
        assert(!output.fault && output.closedCount === 1 && output.exitCode === config.openssh.expected.exitCode,
          'Streaming close/status mismatch');
        assert(bytesEqual(output.join('stdout'), [...config.openssh.expected.stdout].map((char) => char.charCodeAt(0)))
          && bytesEqual(output.join('stderr'), [...config.openssh.expected.stderr].map((char) => char.charCodeAt(0))),
        'Streaming stdout/stderr were merged or changed');
      } finally { await bounded(shell.close(), 'stream close', 3000); }
    });
    await run('Binary multi-chunk round trip preserves NUL, invalid UTF-8, and input buffer copies', async () => {
      assert(connection?.isConnected, 'No OpenSSH connection');
      const expected = Uint8Array.from({ length: 256 * 1024 + 37 }, (_, index) => (index * 73 + 19) & 255);
      const output = capture(expected.length + 64);
      const shell = await bounded(connection.openShell({ term: '', command: config.openssh.commands.stream }, output.events), 'open binary echo');
      try {
        let sent = 0;
        const sizes = [1, 2, 255, 4097, 16384];
        let writes = 0;
        while (sent < expected.length) {
          const size = Math.min(sizes[writes % sizes.length], expected.length - sent);
          const backing = new Uint8Array(size + 6);
          backing.set(expected.subarray(sent, sent + size), 3);
          const input = backing.subarray(3, 3 + size);
          shell.write(writes % 2 === 0 ? input : input.slice().buffer);
          backing.fill(0); // Native write must have copied before returning.
          sent += size;
          writes += 1;
          await until(() => output.received >= sent || output.fault || output.closedCount > 0, 'binary echo progress', signal);
          assert(!output.fault && output.closedCount === 0, output.fault || 'Echo closed before EOF');
        }
        shell.sendEof();
        await bounded(output.closed, 'binary EOF');
        assert(bytesEqual(output.join('stdout'), expected) && output.stderr.length === 0
          && output.exitCode === 0 && output.closedCount === 1, 'Binary echo, EOF, or exit status mismatch');
        observations.binaryRoundTrip = { bytes: expected.length, writes, receivedChunks: output.stdout.length,
          copiedNativeOutput: true, mutatedInputAfterWrite: true };
      } finally { await bounded(shell.close(), 'binary channel close', 3000); }
    });
    try {
      assert(connection?.isConnected && config.daemon, 'No connected OpenSSH session or Pi daemon fixture');
      const daemon = await nativeSshDaemonProbe({ connection, daemonPath: config.daemon.path,
        scratchDirectory: config.daemon.scratchDirectory, signal });
      checks.push(...daemon.checks);
      observations.piDaemon = daemon.observations;
    } catch (error) {
      checks.push({ name: 'Real Pi daemon probe setup', passed: false, error: { message: String(error) } });
    }
    await run('Closing an idle command channel cancels it without disconnecting SSH', async () => {
      assert(connection?.isConnected, 'No OpenSSH connection');
      const output = capture();
      const shell = await bounded(connection.openShell({ term: '', command: config.openssh.commands.sleep }, output.events), 'open sleeping channel');
      await bounded(shell.close(), 'idle channel cancellation', 3000);
      await bounded(output.closed, 'idle onClosed', 1000);
      assert(!shell.isOpen && output.closedCount === 1 && connection.isConnected, 'Channel cancellation damaged connection or closure callbacks');
      const after = await bounded(connection.exec(config.openssh.commands.echo), 'exec after cancellation');
      assert(after.stdout === config.openssh.expected.echo && after.exitCode === 0, 'Connection unusable after channel cancellation');
    });
    await run('Disconnect closes an active channel and is idempotent', async () => {
      assert(connection?.isConnected, 'No OpenSSH connection');
      const output = capture();
      const shell = await bounded(connection.openShell({ term: '', command: config.openssh.commands.stream }, output.events), 'open disconnect channel');
      await cleanup(connection);
      await bounded(output.closed, 'disconnect onClosed', 3000);
      assert(!connection.isConnected && !shell.isOpen && output.closedCount === 1, 'Disconnect left an open native handle');
      await bounded(connection.disconnect(), 'second disconnect', 1000);
      let closedError;
      try { shell.write('must fail'); } catch (error) { closedError = error; }
      assert(SshError.is(closedError, 'CLOSED'), 'Write after disconnect did not throw CLOSED');
    });
    await run('Remote session loss emits onDisconnected and permits a fresh connection', async () => {
      assert(typeof config.openssh.commands.drop === 'string', 'No controlled session-drop command configured');
      let notifications = 0;
      const dropped = await connectTo(config.openssh, { onDisconnected: () => { notifications += 1; } });
      const output = capture();
      try {
        const shell = await bounded(dropped.openShell({ term: '', command: config.openssh.commands.drop }, output.events), 'open controlled drop');
        await until(() => notifications > 0, 'remote disconnect notification', signal, 5000);
        await bounded(output.closed, 'dropped channel onClosed', 3000);
        assert(notifications === 1 && output.closedCount === 1 && !dropped.isConnected && !shell.isOpen,
          'Remote drop left native handles open or emitted duplicate callbacks');
        observations.remoteDrop = { onDisconnectedCount: notifications, channelClosedCount: output.closedCount };
      } finally { await cleanup(dropped); }
      const reconnected = await connectTo(config.openssh);
      try {
        const after = await bounded(reconnected.exec(config.openssh.commands.echo), 'exec after remote drop');
        assert(after.stdout === config.openssh.expected.echo && after.exitCode === 0, 'Reconnect failed after remote loss');
      } finally { await cleanup(reconnected); }
    });

  } finally {
    for (const controller of controllers) controller.abort();
    for (const active of connections) {
      await run('Final SSH connection cleanup', () => cleanup(active), true);
    }
    signal.removeEventListener('abort', abortAll);
  }
  return { ok: checks.every((check) => check.passed), hermes: typeof globalThis.HermesInternal === 'object',
    platform: Platform.OS, packageVersion: sshPackage.version, nativeVersion: nativeVersion(),
    coverage: 'Actual native SSH transport to disposable Mac servers; no product ExecutionEnv or host settings',
    endpoints: Object.fromEntries(['upstream', 'openssh'].map((name) => [name, { host: config[name].host, port: config[name].port }])),
    checks, observations };
}
