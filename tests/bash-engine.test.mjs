import assert from 'node:assert/strict';
import { createHash, randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import test from 'node:test';
import { gzipSync as nodeGzip, gunzipSync as nodeGunzip } from 'node:zlib';
import { installBashBrowserHooks } from './helpers/bash-browser-hooks.mjs';

const hooks = installBashBrowserHooks();
test.after(() => hooks.deregister());
const { InMemoryFs } = await import('just-bash/browser');
const { createBashEngine, BASH_CAPABILITIES, BASH_EXECUTION_LIMITS } = await import('../src/pi/bash/engine/index.ts');
const { gzipSync, gunzipSync } = await import('../src/pi/bash/engine/bounded-zlib.ts');
const { crc32 } = await import('../src/pi/bash/engine/crc32.ts');
const require = createRequire(import.meta.url);
const { adaptBashBrowser } = require('../src/pi/bash/engine/browser-compat.cjs');

function engine(files = {}) {
  const fs = new InMemoryFs({ '/workspace/.keep': '', '/tmp/.keep': '', ...files });
  return { fs, bash: createBashEngine(fs) };
}

test('adaptation fails closed when the pinned published artifact changes', () => {
  const source = readFileSync(new URL(import.meta.resolve('just-bash/browser')), 'utf8');
  assert.match(adaptBashBrowser(source, './crypto'), /import \{ Buffer \} from "buffer"/);
  assert.throws(() => adaptBashBrowser(`${source}\n`, './crypto'), /artifact changed/);
});

test('Metro only resolves zlib for the exact browser entry and preserves the Pi chain', () => {
  const config = require('../metro.config.js');
  const context = { originModulePath: '/app/node_modules/just-bash/dist/bundle/browser.js',
    resolveRequest: (_context, moduleName, platform) => ({ type: 'sentinel', moduleName, platform }) };
  const result = config.resolver.resolveRequest(context, 'node:zlib', 'ios');
  assert.match(result.filePath, /bounded-zlib\.ts$/);
  assert.equal(result.type, 'sourceFile');
  assert.deepEqual(config.resolver.resolveRequest({ ...context, originModulePath: '/app/other.js' }, 'node:zlib', 'ios'),
    { type: 'sentinel', moduleName: 'node:zlib', platform: 'ios' });
  assert.match(config.transformer.piBashUpstreamTransformerPath, /expo-pi.*transform-worker/);
});

test('bounded codecs interoperate with Node gzip for binary, Unicode and incompressible bytes', () => {
  for (const bytes of [new Uint8Array(), new TextEncoder().encode('héllo 🌍\0\n'), new Uint8Array([0, 128, 255, 13]), randomBytes(200_000)]) {
    const compressed = gzipSync(bytes);
    assert.deepEqual(new Uint8Array(nodeGunzip(compressed)), new Uint8Array(bytes));
    assert.deepEqual(gunzipSync(nodeGzip(bytes)), new Uint8Array(bytes));
  }
});

test('gunzip validates all member CRCs, lengths, metadata, truncation and output limits', () => {
  const one = nodeGzip(new TextEncoder().encode('first'));
  const two = nodeGzip(new TextEncoder().encode('second'));
  assert.equal(new TextDecoder().decode(gunzipSync(new Uint8Array([...one, ...two]))), 'firstsecond');
  const bad = new Uint8Array(one); bad[bad.length - 8] ^= 1;
  assert.throws(() => gunzipSync(bad), /integrity/);
  assert.throws(() => gunzipSync(new Uint8Array([...bad, ...two])), /integrity/);
  assert.throws(() => gunzipSync(one.subarray(0, one.length - 1)), /integrity|truncated|unexpected/);
  const wrongSize = new Uint8Array(one); wrongSize[wrongSize.length - 4] ^= 1;
  assert.throws(() => gunzipSync(wrongSize), /integrity/);
  const bomb = nodeGzip(new Uint8Array(2_000_000));
  // Spoofed ISIZE cannot authorize a larger allocation or evade the real limit.
  bomb.writeUInt32LE(1, bomb.length - 4);
  assert.throws(() => gunzipSync(bomb, { maxOutputLength: 1024 }), /output exceeds limit/);
  assert.throws(() => gzipSync(randomBytes(500), { maxOutputLength: 10 }), /output exceeds limit/);
  assert.throws(() => gunzipSync(new Uint8Array(4 * 1024 * 1024 + 1)), /size exceeds/);
  assert.throws(() => gunzipSync(new Uint8Array(Array.from({ length: 129 }, () => [...nodeGzip('')]).flat())), /too many/);
});

test('gzip metadata, header CRC and integrity tests remain truthful', async () => {
  const original = nodeGzip('payload');
  const metadata = new TextEncoder().encode('named.txt\0comment\0');
  const header = new Uint8Array([...original.subarray(0, 10), ...metadata]);
  header[3] = 8 | 16 | 2;
  const checksum = crc32(header) & 0xffff;
  const archive = new Uint8Array([...header, checksum & 255, checksum >>> 8, ...original.subarray(10)]);
  assert.equal(new TextDecoder().decode(gunzipSync(archive)), 'payload');
  const invalid = new Uint8Array(archive); invalid[header.length] ^= 1;
  assert.throws(() => gunzipSync(invalid), /header CRC/);
  const { bash } = engine({ '/workspace/good.gz': archive, '/workspace/bad.gz': invalid });
  assert.equal((await bash.exec('gzip -t good.gz')).exitCode, 0);
  const failure = await bash.exec('gzip -t bad.gz');
  assert.notEqual(failure.exitCode, 0);
  assert.match(failure.stderr, /CRC/);
  const excessive = new Uint8Array([...original.subarray(0, 10), ...new Uint8Array(16 * 1024).fill(65), 0, ...original.subarray(10)]);
  excessive[3] = 8;
  assert.throws(() => gunzipSync(excessive), /header exceeds/);
});

test('shell runs pipelines, redirections, jq, sed, awk, regex and Unicode', async () => {
  const { bash, fs } = engine();
  const result = await bash.exec(`printf 'héllo 🌍\\nsecond\\n' > text
    cat text | grep héllo | sed 's/héllo/bonjour/' > result
    printf '{"value":42}' | jq '.value'
    awk 'END {print NR}' text
    cat result`);
  assert.equal(result.stderr, '');
  assert.equal(result.exitCode, 0);
  assert.equal(result.stdout, '42\n2\nbonjour 🌍\n');
  assert.equal(await fs.readFile('/workspace/result'), 'bonjour 🌍\n');
});

test('cp and mv preserve dangling link inodes, no-clobber and same-file protection', async () => {
  const { fs, bash } = engine({ '/workspace/regular': 'retained' });
  const result = await bash.exec('ln -s missing dangling; cp dangling copy; mv copy moved; readlink moved');
  assert.equal(result.exitCode, 0, result.stderr);
  assert.equal(result.stdout, 'missing\n');
  assert.equal((await fs.lstat('/workspace/dangling')).isSymbolicLink, true);
  assert.equal((await fs.lstat('/workspace/moved')).isSymbolicLink, true);
  assert.equal(await fs.exists('/workspace/copy'), false);

  const protectedTarget = await bash.exec('cp -n regular dangling; mv -n regular dangling; readlink dangling; cat regular');
  assert.equal(protectedTarget.exitCode, 0, protectedTarget.stderr);
  assert.equal(protectedTarget.stdout, 'missing\nretained');
  const sameCopy = await bash.exec('cp dangling dangling');
  assert.equal(sameCopy.exitCode, 1);
  assert.match(sameCopy.stderr, /same file/);
  assert.equal((await bash.exec('mv dangling dangling')).exitCode, 0);
  assert.equal(await fs.readlink('/workspace/dangling'), 'missing');

  // Actual regular-file aliases still use the upstream identity safeguard.
  const aliasCopy = await bash.exec('ln -s regular alias; cp regular alias');
  assert.equal(aliasCopy.exitCode, 1);
  assert.match(aliasCopy.stderr, /same file/);
  assert.equal(await fs.readFile('/workspace/regular'), 'retained');
  assert.notEqual((await bash.exec('cp -P dangling unsupported')).exitCode, 0);
});

test('rm unlinks dangling and directory links without traversing the target', async () => {
  const { fs, bash } = engine({ '/workspace/directory/retained': 'safe' });
  const created = await bash.exec('ln -s missing dangling; ln -s directory plain; ln -s directory recursive');
  assert.equal(created.exitCode, 0, created.stderr);
  const removed = await bash.exec('rm dangling plain; rm -r recursive');
  assert.equal(removed.exitCode, 0, removed.stderr);
  assert.equal(removed.stderr, '');
  for (const name of ['dangling', 'plain', 'recursive']) {
    await assert.rejects(fs.lstat(`/workspace/${name}`), /ENOENT/);
  }
  assert.equal(await fs.readFile('/workspace/directory/retained'), 'safe');
  assert.equal((await bash.exec('rm directory')).exitCode, 1);
  assert.equal((await bash.exec('rm absent')).exitCode, 1);
  assert.equal((await bash.exec('rm -f absent')).exitCode, 0);
});

test('native-adapted gzip, zcat, rg -z and base64 preserve bytes without a global Buffer', async () => {
  const originalBuffer = globalThis.Buffer;
  const originalCrypto = Object.getOwnPropertyDescriptor(globalThis, 'crypto');
  try {
    globalThis.Buffer = undefined;
    Object.defineProperty(globalThis, 'crypto', { configurable: true, value: undefined });
    const bytes = new Uint8Array([0, 255, 128, 10, 65]);
    const { fs, bash } = engine({ '/workspace/data': bytes });
    const result = await bash.exec('gzip -k data; zcat data.gz > restored; base64 -w 0 restored');
    assert.equal(result.exitCode, 0, result.stderr);
    assert.deepEqual(await fs.readFileBuffer('/workspace/restored'), bytes);
    assert.equal(result.stdout, 'AP+ACkE=');
    const search = await bash.exec("printf 'héllo world\\n' | gzip > text.gz; rg -z héllo text.gz");
    assert.equal(search.exitCode, 0, search.stderr);
    assert.match(search.stdout, /héllo world/);
    const temp = await bash.exec('mktemp /workspace/safe.XXXXXX');
    assert.equal(temp.exitCode, 0, temp.stderr);
    assert.equal(globalThis.Buffer, undefined);
    assert.equal(globalThis.crypto, undefined);
  } finally {
    globalThis.Buffer = originalBuffer;
    if (originalCrypto) Object.defineProperty(globalThis, 'crypto', originalCrypto);
  }
});

test('SHA commands use the module-local bridge and preserve binary check-file behavior', async () => {
  const bytes = new Uint8Array([0, 255, 128, 42]);
  const { fs, bash } = engine({ '/workspace/bytes': bytes });
  for (const [command, algorithm] of [['sha1sum', 'sha1'], ['sha256sum', 'sha256']]) {
    const result = await bash.exec(`${command} bytes > checks; ${command} -c checks`);
    assert.equal(result.exitCode, 0, result.stderr);
    assert.equal(result.stdout, 'bytes: OK\n');
    assert.equal(await fs.readFile('/workspace/checks'), `${createHash(algorithm).update(bytes).digest('hex')}  bytes\n`);
  }
});

test('capabilities exclude native runtimes and calls start with fresh shell state', async () => {
  const { bash } = engine();
  assert.ok(BASH_CAPABILITIES.length > 70);
  const first = await bash.exec('export SECRET=private; cd /tmp; function fn() { echo wrong; }; pwd');
  assert.equal(first.stdout, '/tmp\n');
  const next = await bash.exec('pwd; echo "${SECRET-unset}"; type fn');
  assert.equal(next.stdout, '/workspace\nunset\n');
  for (const command of ['node', 'js-exec', 'python', 'python3', 'curl', 'wget', 'sqlite3', 'tar', 'yq', 'xan', 'file', 'html-to-markdown']) {
    assert.equal((await bash.exec(command)).exitCode, 127, `${command} must not be registered`);
  }
});

test('source/work/output limits fail and an aborted command cannot reach later mutations', async () => {
  const { bash, fs } = engine();
  assert.notEqual((await bash.exec('x'.repeat(BASH_EXECUTION_LIMITS.maxSourceBytes + 1))).exitCode, 0);
  const loop = await bash.exec('while true; do :; done');
  assert.notEqual(loop.exitCode, 0);
  assert.match(loop.stderr, /limit|iterations|commands/i);
  const large = await bash.exec('yes x');
  assert.ok(large.stdout.length <= BASH_EXECUTION_LIMITS.maxOutputSize);
  const controller = new AbortController();
  const running = bash.exec('echo admitted > first; sleep 5; echo late > second', { signal: controller.signal });
  setTimeout(() => controller.abort(new Error('user cancelled')), 20);
  const aborted = await running;
  assert.notEqual(aborted.exitCode, 0);
  assert.equal(await fs.exists('/workspace/first'), true);
  assert.equal(await fs.exists('/workspace/second'), false);
});

test('requested deadline is also applied inside the interpreter and validates configuration', async () => {
  const { fs } = engine();
  assert.throws(() => createBashEngine(fs, 30_001), /timeout/);
  assert.throws(() => createBashEngine(fs, 0), /timeout/);
  const result = await createBashEngine(fs, 10).exec('sleep 5; echo late > late');
  assert.notEqual(result.exitCode, 0);
  assert.equal(await fs.exists('/workspace/late'), false);
});
