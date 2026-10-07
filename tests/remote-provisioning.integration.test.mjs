import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { chmod, mkdir, readFile, readdir, readlink, stat, symlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import test from 'node:test';
import { BACKGROUND_CONTEXT } from '@earendil-works/chord/context';
import { installBashBrowserHooks } from './helpers/bash-browser-hooks.mjs';
import { remoteShellConnector } from './helpers/remote-shell-connector.mjs';

const hooks = installBashBrowserHooks();
test.after(() => hooks.deregister());
const { Connection } = await import('../src/pi/execution/remote/connection.ts');
const { MobileRemoteExecutionEnv } = await import('../src/pi/execution/remote/environment.ts');
const { createSshChannelFactory } = await import('../src/pi/execution/remote/channel.ts');
const { PI_DAEMON_MANIFEST, PI_DAEMON_VERSION } = await import('../src/pi/execution/remote/daemon-manifest.ts');
const target = `${process.platform}-${process.arch}`;
const metadata = PI_DAEMON_MANIFEST[target];
if (!metadata) throw new Error(`The real daemon provisioning tests need a supported host, got ${target}.`);
const packaged = new Uint8Array(await readFile(new URL(`../assets/pi-env/pi-env-${target}.bin`, import.meta.url)));
const hash = (bytes) => createHash('sha256').update(bytes).digest('hex');
assert.equal(hash(packaged), metadata.sha256, 'The real bootstrap fixture must use the unchanged pinned daemon.');
const sshOptions = {
  host: 'isolated-shell.tailnet.test', port: 22, username: 'test',
  auth: { type: 'password', password: 'unused-shell-fixture' }, verifyHostKey: () => true,
};

function connect(t, fixture, overrides = {}) {
  const loadDaemon = overrides.loadDaemon ?? (async (remote, signal) => {
    signal.throwIfAborted();
    assert.equal(`${remote.platform}-${remote.arch}`, target);
    return { bytes: packaged.slice(), sha256: metadata.sha256 };
  });
  const connection = new Connection({
    openChannel: createSshChannelFactory({ ...sshOptions, ...overrides.options }, { connect: fixture.connector, loadDaemon }),
  });
  t.after(() => connection.close());
  return connection;
}

async function installedFiles(fixture) {
  const directory = join(fixture.home, '.pi/mobile/tools');
  try { return (await readdir(directory)).map((name) => join(directory, name)); }
  catch (error) { if (error.code === 'ENOENT') return []; throw error; }
}

async function assertInstalled(fixture) {
  const files = await installedFiles(fixture);
  assert.equal(files.length, 1, 'Only the complete daemon is retained after a successful isolated install.');
  assert.equal(hash(await readFile(files[0])), metadata.sha256);
  assert.ok((await stat(files[0])).mode & 0o100, 'Installed daemon must be executable by its owner.');
  return files[0];
}

async function assertExec(connection, home) {
  const chunks = [];
  const result = await connection.request('exec', {
    argv: ['/bin/sh', '-c', "printf 'provisioned-π'; printf 'stderr-ok' >&2"],
    cwd: home, env: {}, inheritEnv: true,
  }, { onEvent: (_json, payload) => chunks.push(Buffer.from(payload).toString()) });
  assert.equal(result.json.exitCode, 0);
  assert.ok(chunks.join('').includes('provisioned-π'));
  assert.ok(chunks.join('').includes('stderr-ok'));
}

const uploadedBytes = (fixture) => fixture.metrics.writes
  .filter((entry) => entry.command.includes('PI-ENV-UPLOAD ')).reduce((sum, entry) => sum + entry.bytes, 0);

test('real bootstrap installs the pinned daemon into a pristine quoted HOME, launches it and reuses verified bytes', async (t) => {
  const fixture = await remoteShellConnector(t);
  const first = connect(t, fixture);
  assert.equal((await first.info()).version, PI_DAEMON_VERSION);
  await assertExec(first, fixture.home);
  const installed = await assertInstalled(fixture);
  const before = await stat(installed);
  await first.close();
  const writes = uploadedBytes(fixture);
  assert.equal(writes, packaged.byteLength, 'Pristine bootstrap uploads the binary exactly once.');

  const second = connect(t, fixture);
  assert.equal((await second.info()).version, PI_DAEMON_VERSION);
  assert.equal(uploadedBytes(fixture), writes,
    'A new SSH session verifies and reuses the cached daemon without uploading it again.');
  assert.equal((await stat(installed)).ino, before.ino);
  await assertExec(second, fixture.home);
});

test('real bootstrap repairs a corrupt cached daemon before execution', async (t) => {
  const fixture = await remoteShellConnector(t);
  const first = connect(t, fixture);
  await first.info();
  await first.close();
  const installed = await assertInstalled(fixture);
  await writeFile(installed, '#!/bin/sh\nprintf corrupted-was-executed > "$HOME/corrupt-marker"\n');
  await chmod(installed, 0o700);
  const second = connect(t, fixture);
  assert.equal((await second.info()).version, PI_DAEMON_VERSION);
  await assertInstalled(fixture);
  await assert.rejects(stat(join(fixture.home, 'corrupt-marker')), { code: 'ENOENT' });
  assert.equal(uploadedBytes(fixture), 2 * packaged.byteLength);
});

test('independent clients can provision the same pristine cache concurrently without replacing live sessions', async (t) => {
  const fixture = await remoteShellConnector(t);
  const one = connect(t, fixture);
  const two = connect(t, fixture);
  const infos = await Promise.all([one.info(), two.info()]);
  assert.ok(infos.every((info) => info.version === PI_DAEMON_VERSION));
  assert.notEqual(infos[0].pid, infos[1].pid);
  await assertInstalled(fixture);
  await one.close();
  await assertExec(two, fixture.home);
});

test('rejected SSH trust performs no detection, asset loading or remote cache mutation', async (t) => {
  const fixture = await remoteShellConnector(t);
  let loads = 0;
  const connection = connect(t, fixture, {
    options: { verifyHostKey: () => false },
    loadDaemon: async () => { loads += 1; throw new Error('Assets must not load before trust.'); },
  });
  await assert.rejects(connection.info(), /server key|not accepted|trust/i);
  assert.equal(loads, 0);
  assert.deepEqual(fixture.metrics.commands, []);
  assert.deepEqual(await readdir(fixture.home), []);
});

test('cancelling an actual binary upload never starts that daemon and the next attempt recovers', async (t) => {
  const controller = new AbortController();
  let interrupted = false;
  const fixture = await remoteShellConnector(t, { onWrite(_data, { command }) {
    if (!interrupted && command.includes('PI-ENV-UPLOAD ')) { interrupted = true; controller.abort(); }
  } });
  const connection = connect(t, fixture);
  await assert.rejects(connection.info(controller.signal), { code: 'aborted' });
  await connection.close();
  assert.equal(interrupted, true);
  assert.ok(!fixture.metrics.commands.some((command) => / serve --token /.test(command)));
  assert.equal(fixture.children.size, 0);
  const recovered = connect(t, fixture);
  assert.equal((await recovered.info()).version, PI_DAEMON_VERSION);
  await assertInstalled(fixture);
});

test('uploaded bytes with an incorrect hash are refused before becoming an executable cache entry', async (t) => {
  const fixture = await remoteShellConnector(t);
  const damaged = packaged.slice();
  damaged[damaged.length - 1] ^= 1;
  const connection = connect(t, fixture, { loadDaemon: async () => ({ bytes: damaged, sha256: metadata.sha256 }) });
  await assert.rejects(connection.info(), /verification|checksum|hash/i);
  await connection.close();
  assert.deepEqual(await installedFiles(fixture), []);
  assert.ok(!fixture.metrics.commands.some((command) => / serve --token /.test(command)));
});

test('unsupported OS is rejected before loading a daemon or modifying the remote cache', async (t) => {
  const fixture = await remoteShellConnector(t);
  const bin = join(fixture.directory, 'bin');
  await mkdir(bin);
  await writeFile(join(bin, 'uname'), '#!/bin/sh\ncase "$1" in -s) printf "FreeBSD\\n";; -m) printf "x86_64\\n";; esac\n', { mode: 0o700 });
  // The fixture reads this environment object on each channel admission.
  const unsupported = await remoteShellConnector(t, { environment: { PATH: `${bin}:${process.env.PATH}` } });
  let loads = 0;
  const connection = connect(t, unsupported, { loadDaemon: async () => { loads += 1; throw new Error('Unsupported platform asset load.'); } });
  await assert.rejects(connection.info(), /not supported|unsupported|macOS|Linux/i);
  const env = new MobileRemoteExecutionEnv({ connection, id: 'unsupported', cwd: unsupported.home });
  assert.equal((await env.fileInfo('.', BACKGROUND_CONTEXT)).error.code, 'not_supported');
  await env.cleanup(BACKGROUND_CONTEXT);
  assert.equal(loads, 0);
  assert.deepEqual(await installedFiles(unsupported), []);
});

test('unsupported architecture is rejected before any cache mutation', async (t) => {
  const fixture = await remoteShellConnector(t);
  const bin = join(fixture.directory, 'bin');
  await mkdir(bin);
  await writeFile(join(bin, 'uname'), '#!/bin/sh\ncase "$1" in -s) printf "Linux\\n";; -m) printf "riscv64\\n";; esac\n', { mode: 0o700 });
  const unsupported = await remoteShellConnector(t, { environment: { PATH: `${bin}:${process.env.PATH}` } });
  const connection = connect(t, unsupported, { loadDaemon: async () => { throw new Error('Unsupported architecture asset load.'); } });
  await assert.rejects(connection.info(), /not supported|unsupported|macOS|Linux/i);
  assert.deepEqual(await readdir(unsupported.home), []);
});

test('Android is rejected before selecting a Linux binary or modifying the remote cache', async (t) => {
  const fixture = await remoteShellConnector(t);
  const bin = join(fixture.directory, 'bin');
  await mkdir(bin);
  await writeFile(join(bin, 'uname'), '#!/bin/sh\ncase "$1" in -s) printf "Linux\\n";; -m) printf "aarch64\\n";; -o) printf "Android\\n";; esac\n', { mode: 0o700 });
  const android = await remoteShellConnector(t, { environment: { PATH: `${bin}:${process.env.PATH}` } });
  let loads = 0;
  const connection = connect(t, android, { loadDaemon: async () => { loads += 1; throw new Error('Android asset load.'); } });
  await assert.rejects(connection.info(), /not supported|unsupported|macOS|Linux/i);
  assert.equal(loads, 0);
  assert.deepEqual(await readdir(android.home), []);
});

test('a remote account without a hash utility cannot install or launch unverified bytes', async (t) => {
  const fixture = await remoteShellConnector(t);
  const bin = join(fixture.directory, 'bin');
  await mkdir(bin);
  await symlink('/bin/sh', join(bin, 'sh'));
  const system = process.platform === 'darwin' ? 'Darwin' : 'Linux';
  const machine = process.arch === 'arm64' ? 'aarch64' : 'x86_64';
  await writeFile(join(bin, 'uname'), `#!/bin/sh\ncase "$1" in -s) printf '${system}\\n';; -m) printf '${machine}\\n';; esac\n`, { mode: 0o700 });
  const noHash = await remoteShellConnector(t, { environment: { PATH: bin } });
  const connection = connect(t, noHash);
  await assert.rejects(connection.info(), /verified|verification|SHA-256/i);
  assert.deepEqual(await readdir(noHash.home), []);
  assert.equal(uploadedBytes(noHash), 0);
});

for (const kind of ['directory', 'symlink to directory', 'symlink to file']) {
  test(`a ${kind} at the daemon cache destination cannot redirect the upload`, async (t) => {
    const fixture = await remoteShellConnector(t);
    const directory = join(fixture.home, '.pi/mobile/tools');
    await mkdir(directory, { recursive: true });
    const destination = join(directory, `pi-env-${metadata.sha256.slice(0, 32)}`);
    const unrelated = join(fixture.home, 'unrelated-owner-data');
    if (kind === 'symlink to file') {
      await writeFile(unrelated, 'preserve this file');
      await symlink(unrelated, destination);
    } else {
      await mkdir(kind === 'directory' ? destination : unrelated);
      await writeFile(join(kind === 'directory' ? destination : unrelated, 'owner-file'), 'preserve this file');
      if (kind === 'symlink to directory') await symlink(unrelated, destination);
    }
    const connection = connect(t, fixture);
    await assert.rejects(connection.info(), /upload|setup|closed/i);
    await connection.close();
    if (kind === 'symlink to file') assert.equal(await readFile(unrelated, 'utf8'), 'preserve this file');
    else assert.deepEqual(await readdir(kind === 'directory' ? destination : unrelated), ['owner-file']);
    if (kind !== 'directory') assert.equal(await readlink(destination), unrelated);
    assert.deepEqual(await readdir(directory), [destination.slice(directory.length + 1)]);
    assert.ok(!fixture.metrics.commands.some((command) => / serve --token /.test(command)));
  });
}

test('a verified cached file without execute permission is repaired before launch', async (t) => {
  const fixture = await remoteShellConnector(t);
  const first = connect(t, fixture);
  await first.info();
  await first.close();
  await chmod(await assertInstalled(fixture), 0o600);
  const second = connect(t, fixture);
  assert.equal((await second.info()).version, PI_DAEMON_VERSION);
  await assertInstalled(fixture);
  assert.equal(uploadedBytes(fixture), 2 * packaged.byteLength);
});
