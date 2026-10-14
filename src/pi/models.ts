import { createModels, type CredentialStore } from '@earendil-works/pi-ai';
import { anthropicProvider } from '@earendil-works/pi-ai/providers/anthropic';
import { deepseekProvider } from '@earendil-works/pi-ai/providers/deepseek';
import { googleProvider } from '@earendil-works/pi-ai/providers/google';
import { openaiProvider } from '@earendil-works/pi-ai/providers/openai';
import { openrouterProvider } from '@earendil-works/pi-ai/providers/openrouter';
import { xaiProvider } from '@earendil-works/pi-ai/providers/xai';

import type { NewChatDefaults } from './model-catalog';
import { createNativeOpenAIOAuth } from './openai-auth';
import { isPermanentOpenAIAuthError, OPENAI_PROVIDER_ID, validateOpenAICredential } from './openai-auth/core';
import { withNativeWebSearch } from './native-web-search/provider';
import { ProviderCredentialStore } from './provider-credentials';
import { createCredentialBackend } from './secure-storage';

/**
 * Used when no recently used chat applies. OpenAI goes first so native web search applies;
 * a provider whose entry is missing from its catalog falls back to its first reasoning model.
 */
export const NEW_CHAT_DEFAULTS: NewChatDefaults = {
  preferredProvider: OPENAI_PROVIDER_ID,
  models: {
    openai: 'gpt-6-sol',
    anthropic: 'claude-sonnet-5-5',
    deepseek: 'deepseek-flash',
    google: 'gemini-3.8-flash',
    xai: 'grok-4.7',
    openrouter: 'anthropic/claude-sonnet-5.5',
  },
};

/** Registration is the only integration point needed to expose another mobile provider. */
export function createChatModels(credentials: CredentialStore) {
  // Mobile apps have no process environment or desktop auth files; only stored credentials apply.
  const models = createModels({
    credentials, authContext: { env: async () => undefined, fileExists: async () => false },
  });
  const openai = withNativeWebSearch(openaiProvider());
  models.setProvider({ ...openai, auth: { ...openai.auth, oauth: createNativeOpenAIOAuth() } });
  // Individual imports preserve Metro's lazy, mobile-safe SDK boundaries.
  for (const provider of [anthropicProvider(), deepseekProvider(), googleProvider(), openrouterProvider(), xaiProvider()]) {
    models.setProvider({ ...provider, auth: { apiKey: provider.auth.apiKey } });
  }
  return models;
}

export function createChatCredentialStore() {
  return new ProviderCredentialStore(createCredentialBackend(), {
    openai: { isPermanentAuthError: isPermanentOpenAIAuthError, validate: validateOpenAICredential },
  });
}
