import assert from 'node:assert/strict';
import test from 'node:test';
import { createModels, getSupportedThinkingLevels } from '@earendil-works/pi-ai';
import { anthropicProvider } from '@earendil-works/pi-ai/providers/anthropic';
import { openaiProvider } from '@earendil-works/pi-ai/providers/openai';
import {
  assertModelSettings, buildModelCatalog, createModelSettings, findCatalogModel,
  getDefaultModelSettings, getModelSettingsError,
} from '../src/pi/model-catalog.ts';

function model(id, overrides = {}) {
  return {
    id, name: id, provider: 'future-provider', api: 'openai-completions',
    baseUrl: 'https://example.invalid', input: ['text'], reasoning: true,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 100_000, maxTokens: 10_000, ...overrides,
  };
}

function register(models, id, entries, name = id) {
  models.setProvider({
    id, name,
    auth: { apiKey: { name: 'API key', async check() { return undefined; }, async resolve() { return undefined; } } },
    getModels: () => entries,
    stream() { throw new Error('Catalog reads must not generate.'); },
    streamSimple() { throw new Error('Catalog reads must not generate.'); },
  });
}

test('registered SDK providers supply their own labels, models, and exact reasoning capabilities', () => {
  const models = createModels();
  models.setProvider(openaiProvider());
  models.setProvider(anthropicProvider());
  const catalog = buildModelCatalog(models);
  assert.equal(catalog.length, 2);
  for (const provider of models.getProviders()) {
    const option = catalog.find((candidate) => candidate.id === provider.id);
    assert.equal(option.name, provider.name);
    assert.equal(option.models.length, models.getModels(provider.id).length);
    for (const sdkModel of models.getModels(provider.id)) {
      const entry = findCatalogModel(catalog, { provider: provider.id, modelId: sdkModel.id });
      assert.equal(entry.name, sdkModel.name);
      assert.deepEqual(entry.thinkingLevels, getSupportedThinkingLevels(sdkModel));
    }
  }
});

test('custom providers and changing catalogs need no provider or model allowlists', () => {
  const models = createModels();
  const entries = [model('same-id', { name: 'Custom model' })];
  register(models, 'future-provider', entries, 'Future provider');
  register(models, 'another-provider', [model('same-id', { provider: 'another-provider', reasoning: false })]);
  register(models, 'empty-provider', []);
  const catalog = buildModelCatalog(models);
  assert.equal(catalog.find((provider) => provider.id === 'empty-provider').models.length, 0);
  assert.equal(findCatalogModel(catalog, { provider: 'future-provider', modelId: 'same-id' }).name, 'Custom model');
  assert.deepEqual(findCatalogModel(catalog, { provider: 'another-provider', modelId: 'same-id' }).thinkingLevels, ['off']);
  entries.push(model('newly-discovered'));
  assert.ok(findCatalogModel(buildModelCatalog(models), { provider: 'future-provider', modelId: 'newly-discovered' }));
  assert.equal(catalog.find((provider) => provider.id === 'future-provider').models.length, 1, 'prior UI snapshots stay unchanged');
});

test('effort choices honor disabled levels and explicit xhigh/max capability', () => {
  const models = createModels();
  register(models, 'future-provider', [
    model('ordinary'),
    model('reasoning-required', { thinkingLevelMap: { off: null, minimal: null, low: null, medium: 'balanced', high: 'deep', xhigh: null, max: 'maximum' } }),
    model('extended', { thinkingLevelMap: { xhigh: 'extra', max: 'maximum' } }),
    model('no-reasoning', { reasoning: false, thinkingLevelMap: { xhigh: 'extra' } }),
  ]);
  const catalog = buildModelCatalog(models);
  const find = (modelId) => findCatalogModel(catalog, { provider: 'future-provider', modelId });
  assert.deepEqual(find('ordinary').thinkingLevels, ['off', 'minimal', 'low', 'medium', 'high']);
  assert.deepEqual(find('reasoning-required').thinkingLevels, ['medium', 'high', 'max']);
  assert.deepEqual(find('extended').thinkingLevels, ['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max']);
  assert.deepEqual(find('no-reasoning').thinkingLevels, ['off']);
  assert.equal(createModelSettings(find('reasoning-required')).thinkingLevel, 'medium');
  assert.equal(createModelSettings(find('reasoning-required'), 'high').thinkingLevel, 'high');
  assert.equal(createModelSettings(find('no-reasoning'), 'max').thinkingLevel, 'off');
});

test('saved missing providers, removed models, and unsupported effort are explicit errors with no substitution', () => {
  const models = createModels();
  register(models, 'future-provider', [model('available')]);
  const catalog = buildModelCatalog(models);
  for (const settings of [
    { model: { provider: 'removed-provider', modelId: 'available' }, thinkingLevel: 'off' },
    { model: { provider: 'future-provider', modelId: 'removed-model' }, thinkingLevel: 'off' },
    { model: { provider: 'future-provider', modelId: 'available' }, thinkingLevel: 'max' },
  ]) {
    const stored = structuredClone(settings);
    assert.ok(getModelSettingsError(catalog, settings));
    assert.throws(() => assertModelSettings(catalog, settings));
    assert.deepEqual(settings, stored);
  }
  const valid = { model: { provider: 'future-provider', modelId: 'available' }, thinkingLevel: 'high' };
  assert.equal(getModelSettingsError(catalog, valid), undefined);
  assert.equal(assertModelSettings(catalog, valid).id, 'available');
});

test('new-chat defaults prefer a valid requested model and handle empty catalogs', () => {
  const models = createModels();
  assert.equal(getDefaultModelSettings(buildModelCatalog(models)), undefined);
  register(models, 'future-provider', [
    model('a-unusable', { thinkingLevelMap: { off: null, minimal: null, low: null, medium: null, high: null } }),
    model('b-fallback'),
    model('c-preferred', { thinkingLevelMap: { off: null, minimal: null } }),
  ]);
  const catalog = buildModelCatalog(models);
  assert.deepEqual(getDefaultModelSettings(catalog, { provider: 'future-provider', modelId: 'c-preferred' }), {
    model: { provider: 'future-provider', modelId: 'c-preferred' }, thinkingLevel: 'low',
  });
  assert.deepEqual(getDefaultModelSettings(catalog, { provider: 'removed-provider', modelId: 'old' }), {
    model: { provider: 'future-provider', modelId: 'b-fallback' }, thinkingLevel: 'off',
  }, 'a missing preference falls back to the first model with a supported effort');
});
