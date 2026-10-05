import type { CredentialStore } from '@earendil-works/pi-ai';
import { anthropicProvider } from '@earendil-works/pi-ai/providers/anthropic';
import { googleProvider } from '@earendil-works/pi-ai/providers/google';
import { openaiProvider } from '@earendil-works/pi-ai/providers/openai';
import { openrouterProvider } from '@earendil-works/pi-ai/providers/openrouter';
import { xaiProvider } from '@earendil-works/pi-ai/providers/xai';

import { createCodexSession } from './codex-auth';
import { createCodexCredentialStore, createCredentialBackend } from './codex-auth/credential-storage';
import { ProviderCredentialStore } from './provider-credentials';
import { createNativeOpenAIOAuth } from './openai-auth';
import { isCompletedOpenAIRefresh, isPermanentOpenAIAuthError, validateOpenAICredential } from './openai-auth/core';
import { withNativeWebSearch } from './native-web-search/provider';

/** Registration is the only integration point needed to expose another mobile provider. */
export function createChatModels(credentials: CredentialStore) {
  const models = createCodexSession(credentials);
  const openai = withNativeWebSearch(openaiProvider());
  models.setProvider({ ...openai, auth: { ...openai.auth, oauth: createNativeOpenAIOAuth() } });
  // Individual imports preserve Metro's lazy, mobile-safe SDK boundaries.
  for (const provider of [anthropicProvider(), googleProvider(), openrouterProvider(), xaiProvider()]) {
    models.setProvider({ ...provider, auth: { apiKey: provider.auth.apiKey } });
  }
  return models;
}

export function createChatCredentialStore() {
  return new ProviderCredentialStore(createCodexCredentialStore(), createCredentialBackend(), {
    openai: { isCompletedRefresh: isCompletedOpenAIRefresh, isPermanentAuthError: isPermanentOpenAIAuthError,
      validate: validateOpenAICredential },
  });
}
