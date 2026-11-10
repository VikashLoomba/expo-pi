import { cleanupSessionResources, type Models, type MutableModels } from '@earendil-works/pi-ai';
import { createClaudeCodeProvider, PROVIDER_ID } from '@earendil-works/pi-claude-code/src/provider';
import { CLAUDE_CODE_PROVIDER_ID } from '@pi-agent/infinichat/pi/claude-code';
import type { ProviderAccess } from '@pi-agent/infinichat/pi/provider-credentials';

/** pi-ai's Anthropic provider, which takes an API key (`chat-providers.ts`). */
const ANTHROPIC_PROVIDER_ID = 'anthropic';
// The apps name the provider without loading it; this fails the typecheck when upstream renames it.
PROVIDER_ID satisfies typeof CLAUDE_CODE_PROVIDER_ID;

/**
 * Claude on a machine goes through its Claude Code login instead of an Anthropic API key (owner, 2026-11-10):
 * pi-claude-code's provider, registered as its own extension entry registers it (`src/index.ts`,
 * `pi.registerProvider(createClaudeCodeProvider())`), in place of pi-ai's Anthropic one. It drives the `claude`
 * program on the server's PATH, which keeps the login; the provider stores no credential, starts a `claude` process
 * per conversation's requests and keeps at most two warm for five minutes (its `ARCHITECTURE.md`, "Process reuse").
 * pi.dev lists no models for it, so it comes without `withPiCatalog`: it asks Claude Code for the account's.
 */
export function registerClaudeCode(models: MutableModels): void {
  models.deleteProvider(ANTHROPIC_PROVIDER_ID);
  models.setProvider(createClaudeCodeProvider());
}

/**
 * The machine's Claude Code login as the Providers screens show a provider's access. The credential store has none
 * for it, so this asks pi-ai's availability check, which runs `claude auth status` (pi-ai `ApiKeyAuth.check`): signed
 * in with a Claude plan it reports `oauth`, with a Console key `api_key`.
 */
export async function claudeCodeAccess(models: Models): Promise<ProviderAccess> {
  const auth = await models.checkAuth(CLAUDE_CODE_PROVIDER_ID).catch(() => undefined);
  return { ready: true, connected: auth !== undefined, ...(auth === undefined ? {} : { type: auth.type }) };
}

/**
 * Ends the warm `claude` processes as the server closes: the provider registers their close with pi-ai's session
 * resources (`src/claude-cli.ts`), which no Harness calls, so they would otherwise outlive it until their own timer.
 */
export const closeClaudeCode = (): void => cleanupSessionResources();
