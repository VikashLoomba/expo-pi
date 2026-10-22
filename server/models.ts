import { createModels, type CredentialStore } from '@earendil-works/pi-ai';
import { registerBunOAuthFlows } from '@earendil-works/pi-ai/bun-oauth';
import { anthropicProvider } from '@earendil-works/pi-ai/providers/anthropic';
import { deepseekProvider } from '@earendil-works/pi-ai/providers/deepseek';
import { googleProvider } from '@earendil-works/pi-ai/providers/google';
import { openaiProvider } from '@earendil-works/pi-ai/providers/openai';
import { openrouterProvider } from '@earendil-works/pi-ai/providers/openrouter';
import { xaiProvider } from '@earendil-works/pi-ai/providers/xai';

/**
 * The providers the phone's `createChatModels` registers, with pi-ai's own auth over this machine's credential store:
 * on a machine its Node sign-in flows apply, where the phone needs native replacements, and so does its environment
 * lookup, so a provider key in the service's environment counts when nothing is stored. The phone's native web search
 * decorator is left out: it acts only on requests its chat-service extension binds, and InfiniChat's Harness installs
 * none.
 */
export function createServerModels(credentials: CredentialStore) {
  // pi-ai loads its sign-in flows through an import bundlers cannot follow, which a single-file bundle cannot resolve
  // at run time, so the bundle registers them statically, as pi's own standalone binary does (coding-agent
  // `src/bun/runtime-setup.ts:10` at v1.4.0). The flows use only `node:http` and `node:crypto`.
  registerBunOAuthFlows();
  const models = createModels({ credentials });
  for (const provider of [openaiProvider(), anthropicProvider(), deepseekProvider(), googleProvider(),
    openrouterProvider(), xaiProvider()]) {
    models.setProvider(provider);
  }
  return models;
}
