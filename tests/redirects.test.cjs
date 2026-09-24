const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const withPiNative = require('../metro/with-pi-native.cjs');

const fixture = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-native-test-'));
test.after(() => fs.rmSync(fixture, { recursive: true, force: true }));

function packageAt(relative, name = '@earendil-works/pi-ai', version = '0.87.1') {
  const root = path.join(fixture, relative);
  fs.mkdirSync(root, { recursive: true });
  fs.writeFileSync(path.join(root, 'package.json'), JSON.stringify({ name, version }));
  return root;
}
function resolve(filePath, platform = 'ios', environment) {
  const original = { type: 'sourceFile', filePath };
  const config = withPiNative({ resolver: {} });
  const context = {
    originModulePath: path.join(fixture, 'App.tsx'),
    customResolverOptions: { environment },
    resolveRequest: () => original,
  };
  return { original, result: config.resolver.resolveRequest(context, './context.js', platform) };
}
const modules = {
  'auth/context': 'auth-context.native.ts',
  'env-api-keys': 'env-api-keys.native.ts',
  'auth/oauth/load': 'oauth-load.native.ts',
  'utils/provider-env': 'provider-env.native.ts',
};
const npmRoot = packageAt('node_modules/@earendil-works/pi-ai');
for (const [key, filename] of Object.entries(modules)) {
  for (const platform of ['ios', 'android']) {
    test(`${platform}: redirects ${key}`, () => {
      const { result } = resolve(path.join(npmRoot, 'dist', key + '.js'), platform);
      assert.equal(result.type, 'sourceFile');
      assert.equal(path.basename(result.filePath), filename);
      assert.ok(fs.existsSync(result.filePath));
    });
  }
}
test('handles a pnpm package location', () => {
  const root = packageAt('node_modules/.pnpm/pi-ai@0.87.1/node_modules/@earendil-works/pi-ai');
  assert.equal(path.basename(resolve(path.join(root, 'dist/auth/context.js')).result.filePath), 'auth-context.native.ts');
});
test('handles a source workspace', () => {
  const root = packageAt('workspace/packages/ai');
  assert.equal(path.basename(resolve(path.join(root, 'src/auth/context.ts')).result.filePath), 'auth-context.native.ts');
});
test('leaves web alone', () => {
  const { result, original } = resolve(path.join(npmRoot, 'dist/auth/context.js'), 'web');
  assert.strictEqual(result, original);
});
for (const env of ['node', 'react-server']) {
  test(`leaves ${env} server environment alone`, () => {
    const { result, original } = resolve(path.join(npmRoot, 'dist/auth/context.js'), 'ios', env);
    assert.strictEqual(result, original);
  });
}
test('does not replace another package with an identical internal filename', () => {
  const other = packageAt('other', 'not-pi');
  const { result, original } = resolve(path.join(other, 'dist/auth/context.js'));
  assert.strictEqual(result, original);
});
test('does not replace unlisted Pi files', () => {
  const { result, original } = resolve(path.join(npmRoot, 'dist/models.js'));
  assert.strictEqual(result, original);
});
test('blocks unreviewed Pi versions', () => {
  const root = packageAt('future', '@earendil-works/pi-ai', '9.0.0');
  assert.throws(() => resolve(path.join(root, 'dist/auth/context.js')), /Review the four upstream modules/);
});
test('chains an already-installed resolver', () => {
  const original = { type: 'sourceFile', filePath: path.join(npmRoot, 'dist/auth/context.js') };
  let calls = 0;
  const config = withPiNative({ resolver: { resolveRequest: () => { calls++; return original; } } });
  const result = config.resolver.resolveRequest({ customResolverOptions: {} }, 'alias-to-context', 'ios');
  assert.equal(calls, 1);
  assert.equal(path.basename(result.filePath), 'auth-context.native.ts');
});
test('leaves assets and empty modules alone', () => {
  for (const original of [{ type: 'empty' }, { type: 'assetFiles', filePaths: ['image.png'] }]) {
    const config = withPiNative({ resolver: {} });
    assert.strictEqual(config.resolver.resolveRequest({ resolveRequest: () => original }, 'anything', 'ios'), original);
  }
});
test('propagates resolution errors rather than hiding them', () => {
  const config = withPiNative({ resolver: {} });
  assert.throws(() => config.resolver.resolveRequest({ resolveRequest: () => { throw new Error('missing module'); } }, 'missing', 'ios'), /missing module/);
});
