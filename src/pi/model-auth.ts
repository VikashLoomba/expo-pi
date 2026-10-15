import { ModelsError, type Models } from '@earendil-works/pi-ai';

import { assertModelSettings, buildModelCatalog, type ChatModelSettings } from './model-catalog';
import { SESSION_EXPIRED } from './provider-credentials';

/**
 * The one pre-send check: the provider is registered and authenticated and offers the model. `authError` says why a
 * provider has no usable credential, for example a locked keychain or `SESSION_EXPIRED`.
 */
export async function requireModelAuth(models: Models, settings: ChatModelSettings,
  authError?: (providerId: string) => string | undefined): Promise<void> {
  assertModelSettings(buildModelCatalog(models), settings);
  const provider = models.getProvider(settings.model.provider);
  if (!provider) throw new Error(`The provider ${settings.model.provider} is unavailable.`);
  const signIn = () => new Error(authError?.(provider.id)
    || `Sign in or connect ${provider.name} in Account to send a message.`);
  // Resolving refreshes an expiring token now, so a failed refresh never becomes failed durable work. pi-ai keeps
  // the credential when the refresh fails; signing in again replaces it.
  const auth = await models.getAuth(provider.id).catch((error: unknown) => {
    // Only a refresh the provider refused carries the expired mark; any other OAuth failure keeps pi-ai's message.
    const expired = authError?.(provider.id) === SESSION_EXPIRED;
    if (error instanceof ModelsError && error.code === 'oauth' && expired) {
      throw new Error(SESSION_EXPIRED, { cause: error });
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
