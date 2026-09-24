const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const worker = require('../build/transform-worker.cjs');

const fixture = fs.mkdtempSync(path.join(os.tmpdir(), 'expo-pi-worker-'));
test.after(() => fs.rmSync(fixture, { recursive: true, force: true }));

fs.writeFileSync(path.join(fixture, 'upstream.cjs'), `
module.exports = {
  calls: [],
  async transform(config, projectRoot, filename, data, options) {
    module.exports.calls.push({ config, projectRoot, filename, source: data.toString('utf8'), options });
    return { output: 'upstream' };
  },
  getCacheKey(config, options) { return 'upstream-key:' + options.projectRoot; },
};`);
const upstream = require(path.join(fixture, 'upstream.cjs'));
const config = { [worker.UPSTREAM_TRANSFORMER_KEY]: 'upstream.cjs' };

function packageFile(relative, name, source) {
  const file = path.join(fixture, relative);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const root = relative.split('/dist/')[0];
  fs.writeFileSync(path.join(fixture, root, 'package.json'), JSON.stringify({ name }));
  fs.writeFileSync(file, source);
  return path.relative(fixture, file);
}
const PI_SOURCE = 'export const load = (s) => import(s);\n';
const piFile = packageFile('node_modules/@earendil-works/pi-ai/dist/auth/context.js', '@earendil-works/pi-ai', PI_SOURCE);
const otherFile = packageFile('node_modules/other/dist/auth/context.js', 'other', PI_SOURCE);
const workspaceFile = packageFile('packages/ai/dist/auth/context.js', '@earendil-works/pi-ai', PI_SOURCE);
// A nested package.json without a name (e.g. {"type": "module"}) doesn't hide the owner.
fs.writeFileSync(path.join(fixture, 'node_modules/@earendil-works/pi-ai/dist/package.json'), '{"type":"module"}');

async function run(filename, options) {
  upstream.calls.length = 0;
  const result = await worker.transform(config, fixture, filename, Buffer.from(fs.readFileSync(path.join(fixture, filename))), options);
  assert.deepEqual(result, { output: 'upstream' });
  assert.equal(upstream.calls.length, 1);
  return upstream.calls[0];
}

for (const platform of ['ios', 'android']) {
  test(`${platform}: rewrites Pi modules before delegating`, async () => {
    const call = await run(piFile, { platform, customTransformOptions: {} });
    assert.match(call.source, /__expoPiUnsupportedImport\(s\)/);
    assert.equal(call.filename, piFile);
    assert.equal(call.projectRoot, fixture);
  });
}
test('rewrites a Pi source workspace outside node_modules', async () => {
  assert.match((await run(workspaceFile, { platform: 'ios' })).source, /__expoPiUnsupportedImport/);
});
test('passes web bundles through unchanged', async () => {
  assert.equal((await run(piFile, { platform: 'web' })).source, PI_SOURCE);
});
for (const environment of ['node', 'react-server']) {
  test(`passes ${environment} bundles through unchanged`, async () => {
    assert.equal((await run(piFile, { platform: 'ios', customTransformOptions: { environment } })).source, PI_SOURCE);
  });
}
test('passes other packages through unchanged', async () => {
  assert.equal((await run(otherFile, { platform: 'ios' })).source, PI_SOURCE);
});
test('delegates the cache key to the upstream worker', () => {
  assert.equal(worker.getCacheKey(config, { projectRoot: fixture }), `upstream-key:${fixture}`);
});
test('explains a missing withPi configuration', async () => {
  await assert.rejects(worker.transform({}, fixture, piFile, Buffer.from(PI_SOURCE), { platform: 'ios' }), /configured with withPi\(\)/);
});
