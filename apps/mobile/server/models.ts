import { createModels, type CredentialStore } from '@earendil-works/pi-ai';
import { anthropicProvider } from '@earendil-works/pi-ai/providers/anthropic';
import { deepseekProvider } from '@earendil-works/pi-ai/providers/deepseek';
import { googleProvider } from '@earendil-works/pi-ai/providers/google';
import { openaiProvider } from '@earendil-works/pi-ai/providers/openai';
import { openrouterProvider } from '@earendil-works/pi-ai/providers/openrouter';
import { xaiProvider } from '@earendil-works/pi-ai/providers/xai';

import { STORED_CREDENTIALS_ONLY } from '../src/pi/model-auth';

/**
 * The providers the phone's `createChatModels` registers, with pi-ai's own auth over this machine's credential store:
 * on a machine its Node sign-in flows apply, where the phone needs native replacements. As on the phone, the store is
 * the only source: no environment key or auth file counts, so the sign-ins the phone shows are the ones a send uses.
 * The phone's native web search decorator is left out: it acts only on requests its chat-service extension binds, and
 * InfiniChat's Harness installs none.
 */
export function createServerModels(credentials: CredentialStore) {
  const models = createModels({ credentials, authContext: STORED_CREDENTIALS_ONLY });
  for (const provider of [openaiProvider(), anthropicProvider(), deepseekProvider(), googleProvider(),
    openrouterProvider(), xaiProvider()]) {
    models.setProvider(provider);
  }
  return models;
}
