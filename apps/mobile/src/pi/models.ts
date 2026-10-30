import { createModels, type CredentialStore } from '@earendil-works/pi-ai';
import { registerChatProviders } from '@pi-agent/infinichat/pi/chat-providers';
import { STORED_CREDENTIALS_ONLY } from '@pi-agent/infinichat/pi/model-auth';
import {
  isPermanentOpenAIAuthError, validateOpenAICredential,
} from '@pi-agent/infinichat/pi/openai-auth/core';
import { ProviderCredentialStore } from '@pi-agent/infinichat/pi/provider-credentials';

import { createNativeOpenAIOAuth } from './openai-auth';
import { createCredentialBackend } from './secure-storage';

/** `registerChatProviders` is the only integration point needed to expose another provider. */
export function createChatModels(credentials: CredentialStore) {
  // Mobile apps have no process environment or desktop auth files; only stored credentials apply.
  const models = createModels({ credentials, authContext: STORED_CREDENTIALS_ONLY });
  registerChatProviders(models);
  // pi-ai's sign-in flows need Node, so only API keys apply, besides OpenAI's native sign-in.
  for (const provider of models.getProviders()) {
    const oauth = provider.id === 'openai' ? { oauth: createNativeOpenAIOAuth() } : {};
    models.setProvider({ ...provider, auth: { apiKey: provider.auth.apiKey, ...oauth } });
  }
  return models;
}

export function createChatCredentialStore() {
  return new ProviderCredentialStore(createCredentialBackend(), {
    openai: { isPermanentAuthError: isPermanentOpenAIAuthError, validate: validateOpenAICredential },
  });
}
