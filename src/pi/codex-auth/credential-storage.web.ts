import { ObservableCredentialStore, type CredentialBackend } from './credential-store';
import { CODEX_CLIENT_ID } from './core';

// Browser sessions survive reloads in this tab. Native credentials use SecureStore;
// there is no browser equivalent of the device Keychain/Keystore.
export function createCredentialBackend(): CredentialBackend {
  return {
    async getItemAsync(name) { return typeof window === 'undefined' ? null : window.sessionStorage.getItem(name); },
    async setItemAsync(name, value) { window.sessionStorage.setItem(name, value); },
    async deleteItemAsync(name) { if (typeof window !== 'undefined') window.sessionStorage.removeItem(name); },
  };
}

export function createCodexCredentialStore(clientId = process.env.EXPO_PUBLIC_CODEX_OAUTH_CLIENT_ID?.trim() || CODEX_CLIENT_ID) {
  return new ObservableCredentialStore(createCredentialBackend(), `pi.codex.oauth.v1.${clientId}`);
}
