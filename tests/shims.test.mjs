import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { defaultProviderAuthContext } from '../metro/pi-native/auth-context.native.ts';
import { getProviderEnvValue } from '../metro/pi-native/provider-env.native.ts';
import * as env from '../metro/pi-native/env-api-keys.native.ts';
import * as oauth from '../metro/pi-native/oauth-load.native.ts';

test('credential-file discovery is disabled without throwing', async () => {
  assert.equal(await defaultProviderAuthContext().fileExists('~/.aws/credentials'), false);
});
test('scoped env overrides beat ambient values', () => {
  process.env.PI_NATIVE_TEST_ENV = 'ambient';
  try {
    assert.equal(getProviderEnvValue('PI_NATIVE_TEST_ENV', { PI_NATIVE_TEST_ENV: 'scoped' }), 'scoped');
    assert.equal(getProviderEnvValue('PI_NATIVE_TEST_ENV'), 'ambient');
  } finally { delete process.env.PI_NATIVE_TEST_ENV; }
});
test('default auth preserves whitespace validation', async () => {
  process.env.PI_NATIVE_TEST_ENV = '   ';
  try { assert.equal(await defaultProviderAuthContext().env('PI_NATIVE_TEST_ENV'), undefined); }
  finally { delete process.env.PI_NATIVE_TEST_ENV; }
});
test('env helper preserves all runtime export names', () => {
  assert.deepEqual(Object.keys(env).sort(), [
    'ANTHROPIC_API_KEY_ENV', 'ANTHROPIC_AUTH_TOKEN_ENV', 'ANTHROPIC_OAUTH_TOKEN_ENV', 'findEnvKeys', 'getEnvApiKey',
  ].sort());
});
test('preserves explicit OpenAI/Google/provider-scoped key lookup', () => {
  assert.equal(env.getEnvApiKey('openai', { OPENAI_API_KEY: 'test-openai' }), 'test-openai');
  assert.equal(env.getEnvApiKey('google', { GEMINI_API_KEY: 'test-google' }), 'test-google');
  assert.equal(env.getEnvApiKey('google-vertex', { GOOGLE_CLOUD_API_KEY: 'test-vertex' }), 'test-vertex');
});
test('DeepSeek uses the scoped API key and matches the published provider mapping', () => {
  assert.deepEqual(env.findEnvKeys('deepseek', { DEEPSEEK_API_KEY: 'scoped' }), ['DEEPSEEK_API_KEY']);
  assert.equal(env.getEnvApiKey('deepseek', { DEEPSEEK_API_KEY: 'scoped' }), 'scoped');
  assert.equal(env.findEnvKeys('typesafe', { TYPESAFE_API_KEY: 'upstream-only' }), undefined);
});
test('Anthropic bearer token is not misclassified as an API key', () => {
  const scoped = { ANTHROPIC_AUTH_TOKEN: 'bearer', ANTHROPIC_API_KEY: 'api-key' };
  assert.deepEqual(env.findEnvKeys('anthropic', scoped), ['ANTHROPIC_AUTH_TOKEN', 'ANTHROPIC_API_KEY']);
  assert.equal(env.getEnvApiKey('anthropic', scoped), 'api-key');
  assert.equal(env.getEnvApiKey('anthropic', { ANTHROPIC_AUTH_TOKEN: 'bearer' }), undefined);
});
test('Anthropic OAuth-token env priority is preserved', () => {
  assert.equal(env.getEnvApiKey('anthropic', { ANTHROPIC_OAUTH_TOKEN: 'oauth-token', ANTHROPIC_API_KEY: 'api-key' }), 'oauth-token');
});
test('unknown providers do not claim credentials', () => {
  assert.equal(env.getEnvApiKey('does-not-exist', {}), undefined);
  assert.equal(env.findEnvKeys('toString', {}), undefined);
});
test('OAuth module imports safely but disabled loaders reject on invocation', async () => {
  for (const [name, loader] of Object.entries(oauth)) {
    if (name.startsWith('load')) {
      await assert.rejects(loader({ name: 'test', gateway: 'test' }), /desktop OAuth loaders are disabled/);
    }
  }
});
test('OAuth registration export still supports explicitly supplied implementations', async () => {
  const fake = { name: 'test-flow' };
  oauth.registerBundledOAuthFlowLoaders({
    anthropic: () => fake, openaiCodex: () => fake, githubCopilot: () => fake,
    openrouter: () => fake, kimiCoding: () => fake, meta: () => fake,
    xai: () => fake, radius: () => fake,
  });
  assert.equal(await oauth.loadAnthropicOAuth(), fake);
  assert.equal(await oauth.loadRadiusOAuth({ name: 'test', gateway: 'test' }), fake);
});
test('mobile shim files contain no dynamic imports or Node runtime requires', () => {
  const dir = new URL('../metro/pi-native/', import.meta.url);
  for (const file of fs.readdirSync(dir).filter((name) => name.endsWith('.ts'))) {
    const source = fs.readFileSync(new URL(file, dir), 'utf8');
    assert.doesNotMatch(source, /\bimport\s*\(/, file);
    assert.doesNotMatch(source, /\brequire\s*\(/, file);
    assert.doesNotMatch(source, /\bimport\.meta\b/, file);
    assert.doesNotMatch(source, /from\s*['"]node:/, file);
  }
});
