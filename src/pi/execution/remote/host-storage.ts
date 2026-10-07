import { randomUUID } from 'expo-crypto';
import * as SecureStore from 'expo-secure-store';
import Storage from 'expo-sqlite/kv-store';

import { RemoteHostRepository } from './hosts';

/** Application-owned settings storage; never part of a conversation checkpoint. */
export function createRemoteHostRepository(): RemoteHostRepository {
  const options: SecureStore.SecureStoreOptions = {
    keychainService: 'com.vikashloomba.piagent.ssh',
    keychainAccessible: SecureStore.WHEN_UNLOCKED_THIS_DEVICE_ONLY,
    requireAuthentication: false,
  };
  return new RemoteHostRepository({
    getItemAsync: (key) => Storage.getItem(key),
    setItemAsync: (key, value) => Storage.setItem(key, value),
    deleteItemAsync: (key) => Storage.removeItem(key),
  }, {
    getItemAsync: (key) => SecureStore.getItemAsync(key, options),
    setItemAsync: (key, value) => SecureStore.setItemAsync(key, value, options),
    deleteItemAsync: (key) => SecureStore.deleteItemAsync(key, options),
  }, randomUUID);
}
