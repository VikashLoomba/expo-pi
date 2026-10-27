import { createModels, type CredentialStore } from '@earendil-works/pi-ai';
import { openaiProvider } from '@earendil-works/pi-ai/providers/openai';
import { registerChatProviders } from '@pi-agent/infinichat/pi/chat-providers';
import { STORED_CREDENTIALS_ONLY } from '@pi-agent/infinichat/pi/model-auth';
import type { NewChatDefaults } from '@pi-agent/infinichat/pi/model-catalog';
import { withNativeWebSearch } from '@pi-agent/infinichat/pi/native-web-search/provider';
import {
  isPermanentOpenAIAuthError, OPENAI_PROVIDER_ID, validateOpenAICredential,
} from '@pi-agent/infinichat/pi/openai-auth/core';
import { ProviderCredentialStore } from '@pi-agent/infinichat/pi/provider-credentials';

import { createNativeOpenAIOAuth } from './openai-auth';
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

/** `registerChatProviders` is the only integration point needed to expose another provider. */
export function createChatModels(credentials: CredentialStore) {
  // Mobile apps have no process environment or desktop auth files; only stored credentials apply.
  const models = createModels({ credentials, authContext: STORED_CREDENTIALS_ONLY });
  registerChatProviders(models);
  // pi-ai's sign-in flows need Node, so only API keys apply, besides OpenAI's native sign-in and web search.
  for (const provider of models.getProviders()) {
    models.setProvider({ ...provider, auth: { apiKey: provider.auth.apiKey } });
  }
  const openai = withNativeWebSearch(openaiProvider());
  models.setProvider({ ...openai, auth: { ...openai.auth, oauth: createNativeOpenAIOAuth() } });
  return models;
}

export function createChatCredentialStore() {
  return new ProviderCredentialStore(createCredentialBackend(), {
    openai: { isPermanentAuthError: isPermanentOpenAIAuthError, validate: validateOpenAICredential },
  });
}
