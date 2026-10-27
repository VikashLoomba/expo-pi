import { createModels, type CredentialStore } from '@earendil-works/pi-ai';

import { registerChatProviders } from '../pi/chat-providers';
import { STORED_CREDENTIALS_ONLY } from '../pi/model-auth';

/**
 * The chat providers with pi-ai's own auth over this machine's credential store: on a machine its Node sign-in flows
 * apply, where the phone needs native replacements. As on the phone, the store is the only source: no environment key
 * or auth file counts, so the sign-ins the phone shows are the ones a send uses. The phone's native web search
 * decorator is left out: it acts only on requests the chat service's extension binds, and InfiniChat's Harness
 * installs none.
 */
export function createServerModels(credentials: CredentialStore) {
  const models = createModels({ credentials, authContext: STORED_CREDENTIALS_ONLY });
  registerChatProviders(models);
  return models;
}
