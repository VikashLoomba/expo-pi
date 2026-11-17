/** pi-ai's Anthropic provider, which takes an API key (`chat-providers.ts`). */
export const ANTHROPIC_PROVIDER_ID = 'anthropic';

/**
 * Where a saved Anthropic key keeps the ID of the workspace it acts in: its credential's `env`, pi-ai's place for the
 * settings that go with a key (its README, "Credential Store"), under the name pi-ai's Anthropic provider and
 * Anthropic's SDK read a workspace from (`ANTHROPIC_WORKSPACE_ID_ENV` in pi-ai's `src/env-api-keys.ts`, which only its
 * `compat` entry exports).
 */
export const ANTHROPIC_WORKSPACE_ID_ENV = 'ANTHROPIC_WORKSPACE_ID';
