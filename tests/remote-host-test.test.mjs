import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

import { installBashBrowserHooks } from './helpers/bash-browser-hooks.mjs';

const hooks = installBashBrowserHooks();
const { RemoteHostRepository } = await import('../src/pi/execution/remote/hosts.ts');
const { testRemoteHost, resolveRemoteWorkingDirectory, remoteHostConnectionMessage } = await import('../src/pi/execution/remote/test-host.ts');
const { encodeFrame, FrameType } = await import('../src/pi/execution/remote/protocol.ts');
const { PI_DAEMON_MANIFEST, PI_DAEMON_VERSION } = await import('../src/pi/execution/remote/daemon-manifest.ts');
hooks.deregister();
const settings = { name: 'Fixture', hostname: 'fixture.tailnet.ts.net', port: 22, username: 'test' };
const key = { algorithm: 'ssh-ed25519', fingerprint: 'SHA256:abc', publicKey: 'abc' };
function backend() {
  const values = new Map();
  return { getItemAsync: async (key) => values.get(key) ?? null, setItemAsync: async (key, value) => { values.set(key, value); }, deleteItemAsync: async (key) => { values.delete(key); } };
}
async function fixture() {
  let id = 0;
  const repo = new RemoteHostRepository(backend(), backend(), () => `test-${++id}`);
  const host = await repo.save(settings, { type: 'password', password: 'synthetic-secret' });
  return { repo, host };
}
function ssh(observed = key, behavior = {}) {
  const calls = { connections: 0, opened: 0, closed: 0, disconnected: 0, requests: [], messages: [], setup: [], assetsLoaded: 0, uploaded: [] };
  const connector = async (options) => {
    calls.connections++;
    assert.equal(options.host, settings.hostname);
    assert.equal(options.port, 22);
    if (!await options.verifyHostKey(observed)) throw Object.assign(new Error('native key rejected synthetic-secret'), { code: 'HOST_KEY_REJECTED' });
    return {
      disconnect: async () => { calls.disconnected++; },
      openShell: async (options, events) => {
        assert.equal(options.term, '');
        assert.equal(typeof events.onStderr, 'function');
        const emit = (bytes) => events.onData(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength));
        if (!options.command.includes('serve --token')) {
          const token = /PI-ENV-(?:PROBE|CACHE|UPLOAD) ([a-f0-9]{32})/.exec(options.command)[1];
          const stage = options.command.includes('PI-ENV-PROBE') ? 'detecting'
            : options.command.includes('PI-ENV-CACHE') ? 'checking' : 'uploading';
          calls.setup.push(stage);
          let finished = false;
          const complete = () => {
            if (finished) return;
            finished = true;
            if (stage === 'detecting') emit(Buffer.from(`PI-ENV-PROBE ${token}\nDarwin\narm64\n/home/test\n`));
            else if (stage === 'checking') emit(Buffer.from(`PI-ENV-CACHE ${token} ${behavior.cacheState ?? (behavior.fresh ? 'missing' : 'present')}\n`));
            else emit(Buffer.from(`PI-ENV-UPLOAD ${token} verified\n`));
            events.onClosed?.(stage === 'uploading' && behavior.uploadFailure ? 1 : 0);
          };
          if (stage !== 'uploading') setTimeout(complete, 0);
          return {
            write(bytes) { calls.uploaded.push(Buffer.from(bytes)); },
            sendEof() { setTimeout(complete, 0); },
            async close() { finished = true; },
          };
        }
        calls.opened++;
        const token = /--token ([a-f0-9]+)/.exec(options.command)[1];
        emit(Buffer.from(`PI-ENV ${token}\n`));
        return {
          close: async () => { calls.closed++; events.onClosed?.(0); },
          write: (bytes) => {
            const frame = Buffer.from(bytes);
            const type = frame.readUInt8(4), id = frame.readUInt32BE(5), length = frame.readUInt32BE(9);
            if (type !== FrameType.request) return;
            const request = JSON.parse(frame.subarray(13, 13 + length).toString());
            calls.requests.push(request.op);
            calls.messages.push(request);
            if (behavior.onRequest?.(request, { emit, events, id })) return;
            if (request.op === 'realpath' && behavior.cwdError) {
              emit(encodeFrame(FrameType.error, id, { code: behavior.cwdError, message: 'raw daemon diagnostic' }));
              return;
            }
            const response = request.op === 'hello'
              ? { protocol: 1, version: PI_DAEMON_VERSION, os: behavior.os ?? 'darwin', arch: 'arm64', home: behavior.home ?? '/home/test', tmpdir: '/tmp', separator: '/', cwd: '/', driveCwds: {}, pid: 123 }
              : request.op === 'realpath' ? { path: behavior.resolvedPath ?? '/real/project' }
                : { name: 'project', kind: behavior.kind ?? 'directory', size: 0, mtimeSec: 0, mtimeNsec: 0 };
            emit(encodeFrame(FrameType.result, id, response));
          },
        };
      },
    };
  };
  const dependencies = { connect: connector, loadDaemon: async (remote, signal) => {
    signal.throwIfAborted();
    assert.deepEqual(remote, { platform: 'darwin', arch: 'arm64' });
    calls.assetsLoaded++;
    return { bytes: new Uint8Array(readFileSync(new URL('../assets/pi-env/pi-env-darwin-arm64.bin', import.meta.url))), sha256: PI_DAEMON_MANIFEST['darwin-arm64'].sha256 };
  } };
  return { calls, dependencies };
}

test('settings connection test rejects unknown keys without an approval callback and closes before daemon access', async () => {
  const { repo, host } = await fixture();
  const remote = ssh();
  await assert.rejects(testRemoteHost(repo, host.id, { signal: new AbortController().signal }, remote.dependencies), /SSH server key was not accepted/);
  assert.equal(remote.calls.opened, 0);
  assert.deepEqual(remote.calls.setup, [], 'trust rejection or cancellation occurs before remote setup');
  assert.equal((await repo.admit(host.id)).trustedHostKey, undefined);
});

test('explicit verified-key acceptance persists trust, validates only the daemon handshake, and awaits SSH cleanup', async () => {
  const { repo, host } = await fixture();
  const remote = ssh();
  let challenges = 0;
  const result = await testRemoteHost(repo, host.id, { signal: new AbortController().signal, onHostKey: async (challenge) => {
    challenges++;
    assert.deepEqual(challenge.observed, key);
    assert.equal(challenge.trusted, undefined);
    return true;
  } }, remote.dependencies);
  assert.deepEqual(result, { version: PI_DAEMON_VERSION, os: 'darwin', arch: 'arm64', home: '/home/test' });
  assert.equal(challenges, 1);
  assert.deepEqual(remote.calls.setup, ['detecting', 'checking'], 'an existing installation is verified automatically');
  assert.equal(remote.calls.uploaded.length, 0, 'a verified installation is reused');
  assert.deepEqual(remote.calls.requests, ['hello']);
  assert.equal(remote.calls.closed, 1);
  assert.equal(remote.calls.disconnected, 1);
  assert.deepEqual((await repo.admit(host.id)).trustedHostKey, key);
  await testRemoteHost(repo, host.id, { signal: new AbortController().signal, onHostKey: async () => { throw new Error('known key must not ask'); } }, ssh().dependencies);
});

test('a changed key is rejected without replacing the trusted key', async () => {
  const { repo, host } = await fixture();
  await repo.acceptHostKey(host, key);
  const remote = ssh({ ...key, fingerprint: 'SHA256:def', publicKey: 'def' });
  await assert.rejects(testRemoteHost(repo, host.id, { signal: new AbortController().signal, onHostKey: async (challenge) => {
    assert.deepEqual(challenge.trusted, key);
    return false;
  } }, remote.dependencies), /SSH server key was not accepted/);
  assert.equal(remote.calls.opened, 0);
  assert.deepEqual(remote.calls.setup, [], 'trust rejection or cancellation occurs before remote setup');
  assert.deepEqual((await repo.admit(host.id)).trustedHostKey, key);
});

test('host edits during a trust decision cannot pin the observed key onto the new endpoint', async () => {
  const { repo, host } = await fixture();
  const remote = ssh();
  await assert.rejects(testRemoteHost(repo, host.id, { signal: new AbortController().signal, onHostKey: async () => {
    await repo.save({ ...host, hostname: 'edited.tailnet.ts.net' });
    return true;
  } }, remote.dependencies), /machine changed/);
  assert.equal(remote.calls.opened, 0);
  assert.deepEqual(remote.calls.setup, [], 'trust rejection or cancellation occurs before remote setup');
  assert.equal((await repo.admit(host.id)).trustedHostKey, undefined);
});

test('renaming a machine during a trust decision does not reject the unchanged connection', async () => {
  const { repo, host } = await fixture();
  const remote = ssh();
  await testRemoteHost(repo, host.id, { signal: new AbortController().signal, onHostKey: async () => {
    await repo.save({ ...host, name: 'New display name' });
    return true;
  } }, remote.dependencies);
  assert.equal(repo.get(host.id).name, 'New display name');
  assert.deepEqual((await repo.admit(host.id)).trustedHostKey, key);
  assert.equal(remote.calls.opened, 1);
});

test('cancellation during explicit trust approval does not persist trust or start the daemon', async () => {
  const { repo, host } = await fixture();
  const controller = new AbortController();
  const remote = ssh();
  await assert.rejects(testRemoteHost(repo, host.id, { signal: controller.signal, onHostKey: async () => {
    controller.abort(); return true;
  } }, remote.dependencies), /cancelled/);
  assert.equal(remote.calls.opened, 0);
  assert.deepEqual(remote.calls.setup, [], 'trust rejection or cancellation occurs before remote setup');
  assert.equal((await repo.admit(host.id)).trustedHostKey, undefined);
});

test('error feedback distinguishes DNS, reachability, credentials, and trust without native diagnostics', () => {
  const message = (code, detail = 'synthetic-secret') => remoteHostConnectionMessage(Object.assign(new Error(detail), { code }));
  assert.match(message('CONNECT', 'DNS lookup synthetic-secret failed'), /could not be resolved/);
  assert.match(message('CONNECT'), /could not be reached through Tailscale/);
  assert.match(message('AUTH_FAILED'), /authentication failed/);
  assert.match(message('HOST_KEY_REJECTED'), /key was not accepted/);
  for (const code of ['CONNECT', 'AUTH_FAILED', 'HOST_KEY_REJECTED', 'KEY', 'INTERNAL', 'TIMEOUT']) assert.doesNotMatch(message(code), /synthetic-secret/);
});

for (const code of ['ENOENT', 'ENOTDIR', 'EACCES', 'EPERM']) test(`chat directory validation explains actual daemon failure ${code}`, async () => {
  const { repo, host } = await fixture();
  await repo.acceptHostKey(host, key);
  const remote = ssh(key, { cwdError: code });
  await assert.rejects(resolveRemoteWorkingDirectory(repo, host.id, '/project', { signal: new AbortController().signal }, remote.dependencies),
    code === 'EACCES' || code === 'EPERM' ? /cannot access this working directory/ : /does not exist or is not a directory/);
  assert.equal(remote.calls.closed, 1);
  assert.equal(remote.calls.disconnected, 1);
});

test('connection tests identify unsupported remote OS without claiming the daemon is missing', async () => {
  const { repo, host } = await fixture();
  await repo.acceptHostKey(host, key);
  const remote = ssh(key, { os: 'windows' });
  await assert.rejects(testRemoteHost(repo, host.id, { signal: new AbortController().signal }, remote.dependencies), /operating system is not supported/);
  assert.deepEqual(remote.calls.requests, ['hello']);
  assert.equal(remote.calls.disconnected, 1);
});


test('connection testing prepares a fresh remote automatically and reports bounded setup stages', async () => {
  const { repo, host } = await fixture();
  await repo.acceptHostKey(host, key);
  const remote = ssh(key, { fresh: true });
  const progress = [];
  const result = await testRemoteHost(repo, host.id, { signal: new AbortController().signal, onProgress: (stage) => progress.push(stage) }, remote.dependencies);
  assert.deepEqual(progress, ['detecting', 'checking', 'uploading']);
  assert.deepEqual(remote.calls.setup, progress);
  assert.equal(remote.calls.assetsLoaded, 1);
  assert.ok(remote.calls.uploaded.length > 0, 'fresh setup transfers the binary over the SSH channel');
  assert.equal(result.home, '/home/test');
  assert.equal(remote.calls.disconnected, 1);
  assert.equal('daemonPath' in repo.get(host.id), false);
});

test('automatic setup errors provide actionable fixed feedback without installation instructions or diagnostic input', () => {
  for (const code of ['UNSUPPORTED_REMOTE', 'DAEMON_SETUP', 'DAEMON_UPLOAD', 'DAEMON_VERIFY', 'INTERNAL']) {
    const message = remoteHostConnectionMessage(Object.assign(new Error('synthetic-secret /custom/pi-env'), { code }));
    assert.doesNotMatch(message, /synthetic-secret|custom|absolute path|install Pi/i);
    assert.match(message, /remote execution|remote operating|machine|software/i);
  }
});

test('unavailable or damaged bundled assets direct recovery to the app without exposing native diagnostics', async () => {
  const { repo, host } = await fixture();
  await repo.acceptHostKey(host, key);
  const remote = ssh(key);
  await assert.rejects(testRemoteHost(repo, host.id, { signal: new AbortController().signal }, {
    ...remote.dependencies,
    loadDaemon: async () => {
      const { BootstrapError } = await import('../src/pi/execution/remote/bootstrap-errors.ts');
      throw new BootstrapError('DAEMON_ASSET');
    },
  }), /bundled remote execution software is unavailable or damaged\. Reinstall the app/);
  assert.equal(remote.calls.opened, 0);
  assert.ok(remote.calls.disconnected > 0);
  assert.doesNotMatch(remoteHostConnectionMessage(Object.assign(new Error('synthetic-secret'), { code: 'DAEMON_ASSET' })), /synthetic-secret/);
});

test('cancelling automatic setup does not start the daemon or lose accepted SSH trust', async () => {
  const { repo, host } = await fixture();
  await repo.acceptHostKey(host, key);
  const remote = ssh(key, { fresh: true });
  const controller = new AbortController();
  await assert.rejects(testRemoteHost(repo, host.id, { signal: controller.signal,
    onProgress: (stage) => { if (stage === 'uploading') controller.abort(); },
  }, remote.dependencies), /cancelled/);
  assert.equal(remote.calls.opened, 0);
  assert.ok(remote.calls.disconnected > 0, 'setup cancellation disconnects the owned SSH transport');
  assert.deepEqual((await repo.admit(host.id)).trustedHostKey, key);
});


for (const [behavior, expected] of [[{ cacheState: 'nohash' }, /software could not be verified.*needs sha256sum, shasum, or openssl/],
  [{ fresh: true, uploadFailure: true }, /software could not be transferred/]]) {
  test(`connection test explains automatic setup failure ${JSON.stringify(behavior)}`, async () => {
    const { repo, host } = await fixture();
    await repo.acceptHostKey(host, key);
    const remote = ssh(key, behavior);
    await assert.rejects(testRemoteHost(repo, host.id, { signal: new AbortController().signal }, remote.dependencies), expected);
    assert.equal(remote.calls.opened, 0, 'failed setup never starts the daemon');
    assert.ok(remote.calls.disconnected > 0);
  });
}

test('machine connection testing succeeds without making any working-directory request', async () => {
  const { repo, host } = await fixture();
  await repo.acceptHostKey(host, key);
  const remote = ssh(key, { cwdError: 'ENOENT' });
  assert.equal((await testRemoteHost(repo, host.id, { signal: new AbortController().signal }, remote.dependencies)).home, '/home/test');
  assert.deepEqual(remote.calls.requests, ['hello']);
  assert.equal(remote.calls.closed, 1);
  assert.equal(remote.calls.disconnected, 1);
});

test('chat directory validation resolves the entered absolute path and returns its admitted host settings', async () => {
  const { repo, host } = await fixture();
  const trusted = await repo.acceptHostKey(host, key);
  const remote = ssh(key, { resolvedPath: '/real/project' });
  const result = await resolveRemoteWorkingDirectory(repo, host.id, '/home/test/project-link', { signal: new AbortController().signal }, remote.dependencies);
  assert.deepEqual(result, { cwd: '/real/project', host: trusted });
  assert.deepEqual(remote.calls.requests, ['hello', 'realpath', 'lstat']);
  assert.equal(remote.calls.messages[1].path, '/home/test/project-link');
  assert.equal(remote.calls.messages[2].path, '/real/project');
  assert.equal(remote.calls.closed, 1);
  assert.equal(remote.calls.disconnected, 1);
});

test('empty chat directory uses the authenticated remote home and validates it as a directory', async () => {
  const { repo, host } = await fixture();
  const trusted = await repo.acceptHostKey(host, key);
  const remote = ssh(key, { home: '/Users/Remote Person', resolvedPath: '/Users/Remote Person' });
  assert.deepEqual(await resolveRemoteWorkingDirectory(repo, host.id, '', { signal: new AbortController().signal }, remote.dependencies),
    { cwd: '/Users/Remote Person', host: trusted });
  assert.equal(remote.calls.messages[1].path, '/Users/Remote Person');
  assert.deepEqual(remote.calls.requests, ['hello', 'realpath', 'lstat']);
});

test('invalid chat directory input is rejected before SSH admission', async () => {
  const { repo, host } = await fixture();
  const remote = ssh();
  for (const path of ['relative/path', '~/project', '/invalid\0path', '/invalid\npath']) {
    await assert.rejects(resolveRemoteWorkingDirectory(repo, host.id, path, { signal: new AbortController().signal }, remote.dependencies), /absolute working directory/);
  }
  assert.equal(remote.calls.connections, 0);
});

test('explicit absolute directory input preserves trailing spaces as part of the remote filename', async () => {
  const { repo, host } = await fixture();
  await repo.acceptHostKey(host, key);
  const remote = ssh(key, { resolvedPath: '/project ' });
  const result = await resolveRemoteWorkingDirectory(repo, host.id, '/project ', { signal: new AbortController().signal }, remote.dependencies);
  assert.equal(remote.calls.messages[1].path, '/project ');
  assert.equal(result.cwd, '/project ');
});

test('chat directory selection cannot accept an unknown or changed SSH key', async () => {
  const { repo, host } = await fixture();
  const unknown = ssh();
  let challenges = 0;
  const options = { signal: new AbortController().signal, onHostKey: async () => { challenges++; return true; } };
  await assert.rejects(resolveRemoteWorkingDirectory(repo, host.id, '/project', options, unknown.dependencies), /SSH server key was not accepted/);
  assert.equal(unknown.calls.opened, 0);
  assert.equal(challenges, 0, 'Directory selection must ignore interactive trust handlers even if passed from JavaScript.');
  assert.equal((await repo.admit(host.id)).trustedHostKey, undefined);
  await repo.acceptHostKey(host, key);
  const changed = ssh({ ...key, fingerprint: 'SHA256:def', publicKey: 'def' });
  await assert.rejects(resolveRemoteWorkingDirectory(repo, host.id, '/project', options, changed.dependencies), /SSH server key was not accepted/);
  assert.deepEqual((await repo.admit(host.id)).trustedHostKey, key);
  assert.equal(changed.calls.opened, 0);
});

test('chat directory validation rejects a regular file and a malformed resolved path, closing each session', async () => {
  const { repo, host } = await fixture();
  await repo.acceptHostKey(host, key);
  for (const [behavior, message] of [[{ kind: 'file' }, /not a directory/], [{ resolvedPath: 'relative' }, /could not be prepared or verified/]]) {
    const remote = ssh(key, behavior);
    await assert.rejects(resolveRemoteWorkingDirectory(repo, host.id, '/project', { signal: new AbortController().signal }, remote.dependencies), message);
    assert.equal(remote.calls.closed, 1);
    assert.equal(remote.calls.disconnected, 1);
  }
});

test('cancelling a pending directory request closes its owned connection even without daemon cancellation acknowledgement', async () => {
  const { repo, host } = await fixture();
  await repo.acceptHostKey(host, key);
  const controller = new AbortController();
  const remote = ssh(key, { onRequest(request) {
    if (request.op === 'realpath') { controller.abort(); return true; }
  } });
  await assert.rejects(resolveRemoteWorkingDirectory(repo, host.id, '/project', { signal: controller.signal }, remote.dependencies), /cancelled/);
  assert.deepEqual(remote.calls.requests, ['hello', 'realpath']);
  assert.equal(remote.calls.closed, 1);
  assert.equal(remote.calls.disconnected, 1);
});

test('changing connection settings while a chat directory is being resolved rejects the stale selection', async () => {
  const { repo, host } = await fixture();
  const trusted = await repo.acceptHostKey(host, key);
  const remote = ssh(key, { onRequest(request, { emit, id }) {
    if (request.op !== 'realpath') return false;
    void repo.save({ ...trusted, username: 'new-account' }).then(() => emit(encodeFrame(FrameType.result, id, { path: '/real/project' })));
    return true;
  } });
  await assert.rejects(resolveRemoteWorkingDirectory(repo, host.id, '/project', { signal: new AbortController().signal }, remote.dependencies), /machine changed/);
  assert.equal(remote.calls.closed, 1);
  assert.equal(remote.calls.disconnected, 1);
});

test('renaming a machine during directory validation preserves the checked connection', async () => {
  const { repo, host } = await fixture();
  const trusted = await repo.acceptHostKey(host, key);
  const remote = ssh(key, { onRequest(request, { emit, id }) {
    if (request.op !== 'realpath') return false;
    void repo.save({ ...trusted, name: 'Renamed machine' }).then(() => emit(encodeFrame(FrameType.result, id, { path: '/real/project' })));
    return true;
  } });
  const result = await resolveRemoteWorkingDirectory(repo, host.id, '/project', { signal: new AbortController().signal }, remote.dependencies);
  assert.deepEqual(result, { cwd: '/real/project', host: trusted });
  assert.equal(repo.get(host.id).name, 'Renamed machine');
  assert.equal(remote.calls.closed, 1);
});

test('directory validation never reconnects between path resolution and directory inspection', async () => {
  const { repo, host } = await fixture();
  await repo.acceptHostKey(host, key);
  const remote = ssh(key, { onRequest(request, { emit, events, id }) {
    if (request.op !== 'realpath') return false;
    emit(encodeFrame(FrameType.result, id, { path: '/real/project' }));
    events.onClosed();
    return true;
  } });
  await assert.rejects(resolveRemoteWorkingDirectory(repo, host.id, '/project', { signal: new AbortController().signal }, remote.dependencies), /could not be prepared or verified/);
  assert.equal(remote.calls.connections, 1);
  assert.deepEqual(remote.calls.requests, ['hello', 'realpath']);
  assert.equal(remote.calls.disconnected, 1);
});
