import type { Provider } from '@earendil-works/pi-ai';

/** pi-ai's Anthropic provider, which takes an API key (`chat-providers.ts`). */
export const ANTHROPIC_PROVIDER_ID = 'anthropic';

/**
 * Where a saved Anthropic key keeps the ID of the workspace it acts in: its credential's `env`, pi-ai's place for the
 * settings that go with a key (its README, "Credential Store"), under the name pi-ai's Anthropic provider and
 * Anthropic's SDK read a workspace from (`ANTHROPIC_WORKSPACE_ID_ENV` in pi-ai's `src/env-api-keys.ts`, which only its
 * `compat` entry exports).
 */
export const ANTHROPIC_WORKSPACE_ID_ENV = 'ANTHROPIC_WORKSPACE_ID';

/** The request header that names the workspace a request is for (Anthropic's API reference). */
const WORKSPACE_HEADER = 'anthropic-workspace-id';

/**
 * pi-ai's Anthropic provider, sending the workspace saved with its key. Anthropic refuses a request from a key that
 * isn't scoped to one workspace unless it names one (its Authentication guide, "Select a workspace"); a key that is
 * scoped needs none, so the ID is the user's to give. pi-ai 1.5.2 reads `ANTHROPIC_WORKSPACE_ID` only for workload
 * identity federation (`src/providers/anthropic.ts`, `src/api/anthropic-messages.ts`), so the header is added where
 * a provider says how its key authenticates a request: what `resolve` returns as auth headers `Models` puts on every
 * request (pi-ai's README, "Transforming Request Headers"), as Cloudflare AI Gateway's auth returns its own
 * (`src/providers/cloudflare-auth.ts`). This goes once pi-ai sends the header itself.
 */
export function withAnthropicWorkspace(provider: Provider<'anthropic-messages'>): Provider<'anthropic-messages'> {
  const apiKey = provider.auth.apiKey;
  if (provider.id !== ANTHROPIC_PROVIDER_ID || !apiKey) {
    throw new Error('A workspace ID goes with the API key of pi-ai’s Anthropic provider.');
  }
  return {
    ...provider,
    auth: {
      ...provider.auth,
      apiKey: {
        ...apiKey,
        async resolve(input) {
          const resolved = await apiKey.resolve(input);
          const workspace = input.credential?.env?.[ANTHROPIC_WORKSPACE_ID_ENV];
          if (!resolved || !workspace) return resolved;
          return { ...resolved,
            auth: { ...resolved.auth, headers: { ...resolved.auth.headers, [WORKSPACE_HEADER]: workspace } } };
        },
      },
    },
  };
}
