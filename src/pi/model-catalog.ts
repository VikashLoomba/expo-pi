import {
  getSupportedThinkingLevels, type Api, type Model, type Models, type ModelThinkingLevel,
} from '@earendil-works/pi-ai';
import type { ModelRef } from '@earendil-works/pi-durable';
import { DEFAULT_IMAGE_LIMITS } from '@earendil-works/pi-durable/tools';

import { DEFAULT_JPEG_QUALITY } from './images';

export type { ModelThinkingLevel } from '@earendil-works/pi-ai';

/** The same serializable references persisted by pi-durable's AgentDoc. */
export type ChatModelSettings = {
  model: ModelRef;
  thinkingLevel: ModelThinkingLevel;
};

/** What an attached photo is fitted to before it is sent, from the model's `inputLimits.images`. */
export interface ImageInput {
  readonly maxWidth: number;
  readonly maxHeight: number;
  /** Most bytes of base64 per image. */
  readonly maxBytes: number;
  readonly jpegQuality: number;
  readonly maxPerMessage?: number;
}

export interface ModelOption {
  readonly id: string;
  readonly provider: string;
  readonly name: string;
  readonly reasoning: boolean;
  readonly thinkingLevels: readonly ModelThinkingLevel[];
  readonly contextWindow: number;
  /** Undefined when the model takes no images. */
  readonly images?: ImageInput;
}

/** The limits pi-durable's `read` tool fits an image to for this model: its own, else pi-durable's defaults. */
function imageInput(model: Model<Api>): ImageInput | undefined {
  if (!model.input.includes('image')) return undefined;
  const limits = model.inputLimits?.images;
  return {
    maxWidth: limits?.resize?.maxWidth ?? DEFAULT_IMAGE_LIMITS.maxWidth,
    maxHeight: limits?.resize?.maxHeight ?? DEFAULT_IMAGE_LIMITS.maxHeight,
    maxBytes: limits?.resize?.maxBytes ?? DEFAULT_IMAGE_LIMITS.maxBytes,
    jpegQuality: limits?.resize?.jpegQuality ?? DEFAULT_JPEG_QUALITY,
    ...(limits?.maxPerMessage === undefined ? {} : { maxPerMessage: limits.maxPerMessage }),
  };
}

export interface ProviderOption {
  readonly id: string;
  readonly name: string;
  readonly models: readonly ModelOption[];
}

export type ModelCatalog = readonly ProviderOption[];

/** Registration-time choices for a new chat when no recently used chat applies. */
export interface NewChatDefaults {
  /** Tried before the other connected providers, which follow in catalog order. */
  readonly preferredProvider?: string;
  /** Default model ID for each provider. */
  readonly models: Readonly<Record<string, string>>;
}

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
      ...(model.input.includes('image') ? { images: imageInput(model) } : {}),
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
  const model = findCatalogModel(catalog, settings.model);
  if (error || !model) throw new Error(error ?? `The model ${settings.model.modelId} is unavailable.`);
  return model;
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

/**
 * Default selection for new chats only: the preferred model when it has a supported reasoning
 * setting, otherwise the catalog's first model that has one. Persisted chats must use validation.
 */
export function getDefaultModelSettings(catalog: ModelCatalog, preferred?: ModelRef): ChatModelSettings | undefined {
  const preferredModel = preferred ? findCatalogModel(catalog, preferred) : undefined;
  const model = preferredModel?.thinkingLevels.length ? preferredModel
    : catalog.flatMap((provider) => provider.models).find((candidate) => candidate.thinkingLevels.length > 0);
  return model ? createModelSettings(model) : undefined;
}
