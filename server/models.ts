import { createModels } from '@earendil-works/pi-ai';
import { anthropicProvider } from '@earendil-works/pi-ai/providers/anthropic';
import { deepseekProvider } from '@earendil-works/pi-ai/providers/deepseek';
import { googleProvider } from '@earendil-works/pi-ai/providers/google';
import { openaiProvider } from '@earendil-works/pi-ai/providers/openai';
import { openrouterProvider } from '@earendil-works/pi-ai/providers/openrouter';
import { xaiProvider } from '@earendil-works/pi-ai/providers/xai';

/**
 * The providers the phone's `createChatModels` registers, with pi-ai's own auth: on a machine its Node sign-in flows
 * and environment keys apply, where the phone needs native replacements. Credentials live in pi-ai's in-memory store
 * until the server keeps its own. The phone's native web search decorator is left out: it acts only on requests its
 * chat-service extension binds, and InfiniChat's Harness installs none.
 */
export function createServerModels() {
  const models = createModels();
  for (const provider of [openaiProvider(), anthropicProvider(), deepseekProvider(), googleProvider(),
    openrouterProvider(), xaiProvider()]) {
    models.setProvider(provider);
  }
  return models;
}
