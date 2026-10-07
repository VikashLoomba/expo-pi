import * as SecureStore from 'expo-secure-store';

/** Asynchronous string storage for secrets. Production uses the device Keychain/Keystore. */
export interface CredentialBackend {
  getItemAsync(key: string): Promise<string | null>;
  setItemAsync(key: string, value: string): Promise<void>;
  deleteItemAsync(key: string): Promise<void>;
}

export function createCredentialBackend(): CredentialBackend {
  // Keep this service name: saved API keys, OAuth grants and the OpenAI installation ID live under it.
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
