import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import test from 'node:test';
import { installBashBrowserHooks } from './helpers/bash-browser-hooks.mjs';

const hooks = installBashBrowserHooks();
test.after(() => hooks.deregister());
const { InMemoryFs } = await import('just-bash/browser');
const { createBashEngine, BASH_CAPABILITIES } = await import('../src/pi/bash/engine/index.ts');
const require = createRequire(import.meta.url);

function engine(files = {}) {
  const fs = new InMemoryFs({ '/workspace/.keep': '', '/tmp/.keep': '', ...files });
  return { fs, bash: createBashEngine(fs) };
}

test('Metro resolves zlib to the unsupported stub only for the exact browser entry and preserves the Pi chain', () => {
  const config = require('../metro.config.js');
  const context = { originModulePath: '/app/node_modules/just-bash/dist/bundle/browser.js',
    resolveRequest: (_context, moduleName, platform) => ({ type: 'sentinel', moduleName, platform }) };
  const result = config.resolver.resolveRequest(context, 'node:zlib', 'ios');
  assert.match(result.filePath, /zlib-stub\.ts$/);
  assert.equal(result.type, 'sourceFile');
  assert.deepEqual(config.resolver.resolveRequest({ ...context, originModulePath: '/app/other.js' }, 'node:zlib', 'ios'),
    { type: 'sentinel', moduleName: 'node:zlib', platform: 'ios' });
  assert.match(config.transformerPath, /expo-pi.*transform-worker/);
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

test('the shell keeps bytes without a global Buffer, and gzip fails clearly', async () => {
  const originalBuffer = globalThis.Buffer;
  try {
    globalThis.Buffer = undefined;
    const bytes = new Uint8Array([0, 255, 128, 10, 65]);
    const { fs, bash } = engine({ '/workspace/data': bytes });
    const result = await bash.exec('cp data restored; base64 -w 0 restored');
    assert.equal(result.exitCode, 0, result.stderr);
    assert.deepEqual(await fs.readFileBuffer('/workspace/restored'), bytes);
    assert.equal(result.stdout, 'AP+ACkE=');
    const temp = await bash.exec('mktemp /workspace/safe.XXXXXX');
    assert.equal(temp.exitCode, 0, temp.stderr);
  } finally {
    globalThis.Buffer = originalBuffer;
  }
  const { gzipSync } = await import('../src/pi/bash/engine/zlib-stub.ts');
  assert.throws(() => gzipSync(), /gzip is not supported/);
});

test('capabilities exclude native runtimes and calls start with fresh shell state', async () => {
  const { bash } = engine();
  assert.ok(BASH_CAPABILITIES.length > 70);
  const first = await bash.exec('export SECRET=private; cd /tmp; function fn() { echo wrong; }; pwd');
  assert.equal(first.stdout, '/tmp\n');
  const next = await bash.exec('pwd; echo "${SECRET-unset}"; type fn');
  assert.equal(next.stdout, '/workspace\nunset\n');
  for (const command of ['node', 'js-exec', 'python', 'python3', 'curl', 'wget', 'sqlite3', 'tar', 'gzip', 'gunzip', 'zcat',
    'sha1sum', 'sha256sum', 'yq', 'xan', 'file', 'html-to-markdown']) {
    assert.equal((await bash.exec(command)).exitCode, 127, `${command} must not be registered`);
  }
});

test('an aborted command cannot reach later mutations', async () => {
  const { bash, fs } = engine();
  const controller = new AbortController();
  const running = bash.exec('echo admitted > first; sleep 5; echo late > second', { signal: controller.signal });
  setTimeout(() => controller.abort(new Error('user cancelled')), 20);
  const aborted = await running;
  assert.notEqual(aborted.exitCode, 0);
  assert.equal(await fs.exists('/workspace/first'), true);
  assert.equal(await fs.exists('/workspace/second'), false);
});
