import { createServerModels } from '@pi-agent/infinichat/node/models';
import { buildModelCatalog, type ModelCatalog } from '@pi-agent/infinichat/pi/model-catalog';
import { validateOpenAICredential } from '@pi-agent/infinichat/pi/openai-auth/core';
import { ProviderCredentialStore, type CredentialBackend } from '@pi-agent/infinichat/pi/provider-credentials';

const ADVICE = 'Check that credentials.json in the app’s data folder can be read and written, then try again.';

/**
 * This Mac's own providers for its chats: pi-ai's models over the app's credential store, composed as the server
 * composes them for a machine (`infinichat-server/src/main.ts`). The catalog is read once and again after a
 * refresh; the store's access states say which providers can send. Sign-in comes with piece 8.
 */
export class MacAccount {
  readonly credentials: ProviderCredentialStore;
  readonly models: ReturnType<typeof createServerModels>;
  private catalog: ModelCatalog;
  private readonly listeners = new Set<() => void>();

  constructor(secrets: CredentialBackend) {
    this.credentials = new ProviderCredentialStore(secrets, { openai: { validate: validateOpenAICredential } }, ADVICE);
    this.models = createServerModels(this.credentials);
    this.credentials.registerProviders(this.models.getProviders().map((provider) => provider.id));
    this.catalog = buildModelCatalog(this.models);
    // A provider whose credential cannot be read reports it in its own access state.
    void this.credentials.restore().catch(() => {});
  }

  readonly subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  };
  readonly getCatalog = (): ModelCatalog => this.catalog;
  /** Why a provider has no usable credential, for the chats' pre-send check. */
  readonly authError = (providerId: string): string | undefined =>
    this.credentials.getProviderSnapshot(providerId).error;

  /** Asks each provider for its models again, as the phone's Refresh models does. */
  async refreshCatalog(): Promise<void> {
    const result = await this.models.refresh();
    this.catalog = buildModelCatalog(this.models);
    for (const listener of [...this.listeners]) listener();
    if (result.errors.size) {
      throw new Error('Some provider models could not be refreshed. Existing models are still available.');
    }
  }
}
