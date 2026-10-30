import { isModelType, PI_AI_VERSION, type Api, type Model, type Provider } from '@earendil-works/pi-ai';

/** Where pi publishes its catalog, per provider and pi version (pi `scripts/model-catalog-protocol.ts`). */
const CATALOG_URL = 'https://pi.dev/api/models/providers/';
/** pi's own wait for one catalog request (coding-agent `REMOTE_CATALOG_ATTEMPT_TIMEOUT_MS`); a server's start waits. */
const ATTEMPT_MS = 4_000;

/**
 * A chat model as pi.dev lists it, checked the way pi-ai checks the catalog its Radius gateway returns
 * (`isRadiusGatewayModel`, `src/providers/radius-config.ts:26-39` at v1.4.0).
 */
function isChatModel(value: unknown): value is Model<Api> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    && 'type' in value && value.type === 'chat'
    && 'id' in value && typeof value.id === 'string'
    && 'name' in value && typeof value.name === 'string'
    && 'api' in value && typeof value.api === 'string'
    && 'baseUrl' in value && typeof value.baseUrl === 'string'
    && 'reasoning' in value && typeof value.reasoning === 'boolean'
    && 'input' in value && Array.isArray(value.input)
    && 'cost' in value && typeof value.cost === 'object' && value.cost !== null
    && 'contextWindow' in value && typeof value.contextWindow === 'number'
    && 'maxTokens' in value && typeof value.maxTokens === 'number';
}

/**
 * A built-in provider with pi.dev's newer models over the ones pi-ai ships, as pi's own agent overlays them
 * (coding-agent `withRemoteCatalog`, `src/core/remote-catalog-provider.ts` at v1.4.0): pi-ai's lists are fixed when it
 * is released, and pi.dev publishes the catalog again as models come out. The provider becomes dynamic, so
 * `Models.refresh()` fetches it, for a provider with a credential, as pi-ai refreshes any. The list stays in memory
 * (owner, 2026-10-30): each start fetches it again, and a failed fetch keeps the last one. Unlike the agent's, it
 * doesn't compare pi.dev's date with the shipped catalog's, whose only source, `providers/all`, carries every provider.
 */
export function withPiCatalog(provider: Provider): Provider {
  let fetched: readonly Model<Api>[] = [];
  const getModels = () => {
    const byId = new Map(provider.getModels().map((model) => [model.id, model]));
    for (const model of fetched) byId.set(model.id, model);
    return [...byId.values()];
  };
  return {
    ...provider,
    getModels,
    getAllModels: () => [
      ...(provider.getAllModels?.() ?? []).filter((model) => !isModelType(model, 'chat')), ...getModels(),
    ],
    async refreshModels(context) {
      if (!context.allowNetwork) return;
      const url = `${CATALOG_URL}${encodeURIComponent(provider.id)}?types=chat&pi-version=${PI_AI_VERSION}`;
      const response = await fetch(url, {
        headers: { accept: 'application/json' },
        signal: AbortSignal.any([context.signal, AbortSignal.timeout(ATTEMPT_MS)]),
      });
      if (!response.ok) throw new Error(`pi.dev’s ${provider.name} models could not be read (${response.status}).`);
      const listed: unknown = await response.json();
      const models = (Array.isArray(listed) ? listed : []).filter(isChatModel)
        .map((model) => ({ ...model, provider: provider.id }));
      await context.publish({ update: () => { fetched = models; } });
    },
  };
}
