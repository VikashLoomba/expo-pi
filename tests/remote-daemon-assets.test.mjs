import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { installBashBrowserHooks } from './helpers/bash-browser-hooks.mjs';

const hooks = installBashBrowserHooks();
const originalRequire = globalThis.require;
test.after(() => {
  hooks.deregister();
  if (originalRequire === undefined) delete globalThis.require;
  else globalThis.require = originalRequire;
});
const { loadPackagedDaemon } = await import('../src/pi/execution/remote/daemon-assets.ts');
const { PI_DAEMON_MANIFEST } = await import('../src/pi/execution/remote/daemon-manifest.ts');
const deferred = () => { let resolve; const promise = new Promise((done) => { resolve = done; }); return { promise, resolve }; };
const freshSignal = () => new AbortController().signal;
const packaged = (target) => readFile(new URL(`../assets/pi-env/pi-env-${target}.bin`, import.meta.url)).then((bytes) => new Uint8Array(bytes));

// Substitute only the lazy native bridges; the production loader performs its
// real selection, sharing, abort handling, byte ownership and SHA-256 checks.
function nativeAssets({ download = async (target) => ({ localUri: target }), bytes = packaged } = {}) {
  const calls = { downloads: 0, reads: 0 };
  globalThis.require = (specifier) => {
    if (specifier === 'expo-asset') return { Asset: { fromModule: (target) => ({
      async downloadAsync() { calls.downloads++; return download(target); },
    }) } };
    if (specifier === 'expo-file-system') return { File: class {
      constructor(uri) { this.uri = uri; }
      async bytes() { calls.reads++; return bytes(this.uri); }
    } };
    const target = /\/pi-env-(darwin|linux)-(arm64|x64)\.bin$/.exec(specifier);
    assert.ok(target, `Unexpected lazy dependency: ${specifier}`);
    return `${target[1]}-${target[2]}`;
  };
  return calls;
}

test('pre-aborted asset loading touches no native bridge', async () => {
  const calls = nativeAssets();
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(loadPackagedDaemon({ platform: 'darwin', arch: 'arm64' }, controller.signal), { name: 'AbortError' });
  assert.deepEqual(calls, { downloads: 0, reads: 0 });
});

test('one cancelled caller releases immediately while another shares the native read and receives owned verified bytes', { timeout: 1_000 }, async () => {
  const reading = deferred();
  const waiting = deferred();
  const calls = nativeAssets({ bytes: () => { reading.resolve(); return waiting.promise; } });
  const remote = { platform: 'darwin', arch: 'arm64' };
  const controller = new AbortController();
  const cancelled = loadPackagedDaemon(remote, controller.signal);
  const other = loadPackagedDaemon(remote, freshSignal());
  await reading.promise;
  controller.abort();
  await assert.rejects(cancelled, { name: 'AbortError' });
  assert.deepEqual(calls, { downloads: 1, reads: 1 });
  const original = await packaged('darwin-arm64');
  waiting.resolve(original);
  const first = await other;
  assert.equal(first.sha256, PI_DAEMON_MANIFEST['darwin-arm64'].sha256);
  assert.deepEqual(first.bytes, original);
  first.bytes.fill(0);
  assert.deepEqual((await loadPackagedDaemon(remote, freshSignal())).bytes, original);
  assert.deepEqual(calls, { downloads: 1, reads: 1 });
});

test('same-size asset corruption fails pinned verification and a later attempt reloads rather than caching failure', async () => {
  const remote = { platform: 'linux', arch: 'arm64' };
  const original = await packaged('linux-arm64');
  const damaged = original.slice();
  damaged[damaged.length - 1] ^= 1;
  let valid = false;
  const calls = nativeAssets({ bytes: async () => valid ? original : damaged });
  await assert.rejects(loadPackagedDaemon(remote, freshSignal()), { code: 'DAEMON_ASSET' });
  valid = true;
  assert.deepEqual((await loadPackagedDaemon(remote, freshSignal())).bytes, original);
  assert.deepEqual(calls, { downloads: 2, reads: 2 });
});

test('asset bridge failures are sanitized and a missing local asset cannot reach the filesystem', async () => {
  const calls = nativeAssets({ download: async (target) => {
    if (target === 'linux-x64') throw new Error('native-sensitive-detail');
    return { localUri: null };
  } });
  for (const platform of ['linux', 'darwin']) {
    await assert.rejects(loadPackagedDaemon({ platform, arch: 'x64' }, freshSignal()), (error) => {
      assert.equal(error.code, 'DAEMON_ASSET');
      assert.match(error.message, /Reinstall the app/);
      assert.doesNotMatch(error.message, /native-sensitive-detail/);
      assert.equal(error.cause, undefined);
      return true;
    });
  }
  assert.deepEqual(calls, { downloads: 2, reads: 0 });
});
