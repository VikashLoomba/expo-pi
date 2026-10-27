import { ModelsError, type AuthContext, type Models } from '@earendil-works/pi-ai';

import { assertModelSettings, buildModelCatalog, type ChatModelSettings } from './model-catalog';
import { SESSION_EXPIRED } from './provider-credentials';

/**
 * pi-ai's auth context with no environment and no auth files, so only the credential store counts: what the account
 * screens show as connected is what a send uses. The phone has neither; a machine has both, and leaves them out.
 */
export const STORED_CREDENTIALS_ONLY: AuthContext = { env: async () => undefined, fileExists: async () => false };

/**
 * The one pre-send check: the provider is registered and authenticated and offers the model. `authError` says why a
 * provider has no usable credential, for example a locked keychain or `SESSION_EXPIRED`. `machine` names the machine
 * whose credentials these are, when they are not this phone's, for the messages that send the user to sign in.
 */
export async function requireModelAuth(models: Models, settings: ChatModelSettings,
  authError?: (providerId: string) => string | undefined, machine?: string): Promise<void> {
  assertModelSettings(buildModelCatalog(models), settings);
  const provider = models.getProvider(settings.model.provider);
  if (!provider) throw new Error(`The provider ${settings.model.provider} is unavailable.`);
  const where = machine === undefined ? 'in Account' : `on ${machine}`;
  const signIn = () => new Error(authError?.(provider.id)
    || `Sign in or connect ${provider.name} ${where} to send a message.`);
  // Resolving refreshes an expiring token now, so a failed refresh never becomes failed durable work. pi-ai keeps
  // the credential when the refresh fails; signing in again replaces it.
  const auth = await models.getAuth(provider.id).catch((error: unknown) => {
    if (error instanceof ModelsError && error.code === 'oauth') {
      // Only a refresh the provider refused carries the expired mark; any other OAuth failure keeps pi-ai's message
      // on the phone. A machine has no such mark, and says what pi-ai documents for `oauth`: sign in again.
      if (authError?.(provider.id) === SESSION_EXPIRED) throw new Error(SESSION_EXPIRED, { cause: error });
      if (machine !== undefined) {
        throw new Error(`Could not renew the ${provider.name} sign-in on ${machine}. Sign in again.`, { cause: error });
      }
    }
    throw error;
  });
  if (!auth) throw signIn();
  const available = await models.getAvailable(provider.id);
  if (!available.some((model) => model.id === settings.model.modelId)) {
    throw new Error(`${settings.model.modelId} is not available for this account. `
      + 'Choose another model in chat settings.');
  }
}
