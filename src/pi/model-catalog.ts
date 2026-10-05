import { getSupportedThinkingLevels, type Models, type ModelThinkingLevel } from '@earendil-works/pi-ai';
import type { ModelRef } from '@earendil-works/pi-durable';

export type { ModelThinkingLevel } from '@earendil-works/pi-ai';

/** The same serializable references persisted by pi-durable's AgentDoc. */
export type ChatModelSettings = {
  model: ModelRef;
  thinkingLevel: ModelThinkingLevel;
};

export interface ModelOption {
  readonly id: string;
  readonly provider: string;
  readonly name: string;
  readonly reasoning: boolean;
  readonly thinkingLevels: readonly ModelThinkingLevel[];
  readonly contextWindow: number;
}

export interface ProviderOption {
  readonly id: string;
  readonly name: string;
  readonly models: readonly ModelOption[];
}

export type ModelCatalog = readonly ProviderOption[];

/**
 * Read the registered SDK providers, including dynamic providers with an empty
 * last-known catalog. Credentials affect availability, not catalog identity.
 */
export function buildModelCatalog(models: Pick<Models, 'getProviders' | 'getModels'>): ModelCatalog {
  return models.getProviders().map((provider): ProviderOption => ({
    id: provider.id,
    name: provider.name || provider.id,
    models: models.getModels(provider.id).map((model): ModelOption => ({
      id: model.id,
      provider: provider.id,
      name: model.name || model.id,
      reasoning: model.reasoning,
      thinkingLevels: getSupportedThinkingLevels(model),
      contextWindow: model.contextWindow,
    })).sort((left, right) => left.name.localeCompare(right.name) || left.id.localeCompare(right.id)),
  })).sort((left, right) => left.name.localeCompare(right.name) || left.id.localeCompare(right.id));
}

export function findCatalogModel(catalog: ModelCatalog, reference: ModelRef): ModelOption | undefined {
  return catalog.find((provider) => provider.id === reference.provider)?.models
    .find((model) => model.id === reference.modelId);
}

/** Validate saved choices without rewriting or silently substituting a model. */
export function getModelSettingsError(catalog: ModelCatalog, settings: ChatModelSettings): string | undefined {
  const provider = catalog.find((candidate) => candidate.id === settings.model.provider);
  if (!provider) return `The provider ${settings.model.provider} is unavailable. Choose a provider in chat settings.`;
  const model = provider.models.find((candidate) => candidate.id === settings.model.modelId);
  if (!model) return `The model ${settings.model.modelId} is unavailable from ${provider.name}. Choose a model in chat settings.`;
  if (!model.thinkingLevels.includes(settings.thinkingLevel)) {
    return `${model.name} does not support the saved reasoning effort (${settings.thinkingLevel}). Choose an available effort in chat settings.`;
  }
  return undefined;
}

export function assertModelSettings(catalog: ModelCatalog, settings: ChatModelSettings): ModelOption {
  const error = getModelSettingsError(catalog, settings);
  if (error) throw new Error(error);
  return findCatalogModel(catalog, settings.model)!;
}

/**
 * Used only for a new chat or an explicit model change. Preserve the current
 * effort when supported; otherwise choose the model's lowest supported level.
 * In particular, models that cannot turn reasoning off never receive `off`.
 */
export function createModelSettings(model: ModelOption, preferredThinkingLevel: ModelThinkingLevel = 'off'): ChatModelSettings {
  const thinkingLevel = model.thinkingLevels.includes(preferredThinkingLevel)
    ? preferredThinkingLevel : model.thinkingLevels[0];
  if (!thinkingLevel) throw new Error(`${model.name} has no supported reasoning settings.`);
  return { model: { provider: model.provider, modelId: model.id }, thinkingLevel };
}

/** Default selection for new chats only; persisted chats must use validation. */
export function getDefaultModelSettings(catalog: ModelCatalog, preferred?: ModelRef): ChatModelSettings | undefined {
  const preferredModel = preferred ? findCatalogModel(catalog, preferred) : undefined;
  const model = preferredModel?.thinkingLevels.length ? preferredModel
    : catalog.flatMap((provider) => provider.models).find((candidate) => candidate.thinkingLevels.length > 0);
  return model ? createModelSettings(model) : undefined;
}
