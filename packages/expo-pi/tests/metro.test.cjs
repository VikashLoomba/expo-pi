const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { withPi } = require('../build/metro.cjs');
const { UPSTREAM_TRANSFORMER_KEY, WEB_CLIENT_TRANSFORM_KEY } = require('../build/transform-worker.cjs');

const build = path.join(__dirname, '../build');
const base = () => ({
  projectRoot: '/app',
  transformerPath: '/app/node_modules/@expo/metro-config/build/transform-worker/transform-worker.js',
  transformer: { babelTransformerPath: '/app/babel.js' },
  resolver: { sourceExts: ['ts'] },
  serializer: {},
});

test('installs the transform worker and records the previous one relative to the project', () => {
  const input = base();
  const config = withPi(input);
  assert.equal(config.transformerPath, path.join(build, 'transform-worker.cjs'));
  assert.equal(config.transformer[UPSTREAM_TRANSFORMER_KEY], 'node_modules/@expo/metro-config/build/transform-worker/transform-worker.js');
  assert.match(config.transformer.expoPiCacheKey, /^[0-9a-f]{40}$/);
  assert.equal(config.transformer[WEB_CLIENT_TRANSFORM_KEY], false);
  assert.equal(config.transformer.babelTransformerPath, '/app/babel.js');
  assert.deepEqual(config.resolver.sourceExts, ['ts']);
  assert.strictEqual(config.serializer, input.serializer);
});
test('does not modify the input config', () => {
  const input = base();
  withPi(input);
  assert.deepEqual(input, base());
});
test('chains another custom transform worker', () => {
  const config = withPi({ ...base(), transformerPath: '/app/node_modules/nativewind/transformer.js' });
  assert.equal(config.transformer[UPSTREAM_TRANSFORMER_KEY], 'node_modules/nativewind/transformer.js');
});
test('is idempotent', () => {
  const once = withPi(base());
  assert.strictEqual(withPi(once), once);
});
test('web client rewriting is opt-in and keeps the upstream chain', () => {
  const input = base();
  const wrapped = withPi(input, { web: true });
  assert.equal(wrapped.transformer[WEB_CLIENT_TRANSFORM_KEY], true);
  assert.equal(input.transformer[WEB_CLIENT_TRANSFORM_KEY], undefined);
  assert.strictEqual(withPi(wrapped), wrapped);
  assert.strictEqual(withPi(wrapped, { web: true }), wrapped);
  const disabled = withPi(wrapped, { web: false });
  assert.equal(disabled.transformer[WEB_CLIENT_TRANSFORM_KEY], false);
  assert.equal(disabled.transformer[UPSTREAM_TRANSFORMER_KEY], wrapped.transformer[UPSTREAM_TRANSFORMER_KEY]);
  assert.strictEqual(disabled.resolver, wrapped.resolver);
  assert.equal(wrapped.transformer[WEB_CLIENT_TRANSFORM_KEY], true);
  assert.equal(withPi(disabled, { web: true }).transformer[WEB_CLIENT_TRANSFORM_KEY], true);
});
test('resolves the crypto bridge to this package from any Pi location', () => {
  const config = withPi(base());
  const context = { resolveRequest: () => assert.fail('should not delegate') };
  assert.deepEqual(config.resolver.resolveRequest(context, '@automatalabs/expo-pi/crypto', 'ios'), {
    type: 'sourceFile', filePath: path.join(build, 'polyfills/crypto.js'),
  });
});
test('delegates every other request to the previous resolver, or Metro default', () => {
  const resolved = { type: 'sourceFile', filePath: '/app/x.js' };
  const withPrevious = withPi({ ...base(), resolver: { resolveRequest: (_c, name) => ({ ...resolved, name }) } });
  assert.deepEqual(withPrevious.resolver.resolveRequest({}, 'react', 'ios'), { ...resolved, name: 'react' });
  const withDefault = withPi(base());
  assert.strictEqual(withDefault.resolver.resolveRequest({ resolveRequest: () => resolved }, 'react', 'ios'), resolved);
});
