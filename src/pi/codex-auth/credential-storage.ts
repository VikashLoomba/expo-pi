import * as SecureStore from 'expo-secure-store';

import { ObservableCredentialStore, type CredentialBackend } from './credential-store';
import { CODEX_CLIENT_ID } from './core';

// Namespace by OAuth client so a registered mobile client never receives tokens
// issued for the default public client. SecureStore keys allow only .-_ and alphanumerics.
export function credentialStorageKey(clientId = CODEX_CLIENT_ID): string {
  return `pi.codex.oauth.v1.${Array.from(clientId, (character) => character.codePointAt(0)!.toString(16)).join('-')}`;
}

export function createCredentialBackend(): CredentialBackend {
  const options: SecureStore.SecureStoreOptions = {
    keychainService: 'com.vikashloomba.piagent.oauth',
    keychainAccessible: SecureStore.WHEN_UNLOCKED_THIS_DEVICE_ONLY,
    requireAuthentication: false,
  };
  return {
    getItemAsync: (key) => SecureStore.getItemAsync(key, options),
    setItemAsync: (key, value) => SecureStore.setItemAsync(key, value, options),
    deleteItemAsync: (key) => SecureStore.deleteItemAsync(key, options),
  };
}

export function createCodexCredentialStore(clientId = process.env.EXPO_PUBLIC_CODEX_OAUTH_CLIENT_ID?.trim() || CODEX_CLIENT_ID) {
  return new ObservableCredentialStore(createCredentialBackend(), credentialStorageKey(clientId));
}
