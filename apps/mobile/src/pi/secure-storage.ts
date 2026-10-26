import * as SecureStore from 'expo-secure-store';

import type { CredentialBackend } from './provider-credentials';

export function createCredentialBackend(): CredentialBackend {
  // This one service holds saved API keys, OAuth grants and the OpenAI installation ID. Readable while
  // locked (after the first unlock since boot), so background work can refresh OAuth tokens; the items
  // never leave this device (no backup, no sync).
  const options: SecureStore.SecureStoreOptions = {
    keychainService: 'com.vikashloomba.piagent.oauth',
    keychainAccessible: SecureStore.AFTER_FIRST_UNLOCK_THIS_DEVICE_ONLY,
    requireAuthentication: false,
  };
  return {
    getItemAsync: (key) => SecureStore.getItemAsync(key, options),
    setItemAsync: (key, value) => SecureStore.setItemAsync(key, value, options),
    deleteItemAsync: (key) => SecureStore.deleteItemAsync(key, options),
  };
}
