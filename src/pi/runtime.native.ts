import { getRandomValues } from 'expo-crypto';

// SDK 58 provides the other web APIs Pi needs, but the tested iOS Hermes
// runtime has no global crypto. Bridge only secure random generation.
if (typeof globalThis.crypto?.getRandomValues !== 'function') {
  if (!globalThis.crypto) {
    Object.defineProperty(globalThis, 'crypto', { value: {}, configurable: true });
  }
  Object.defineProperty(globalThis.crypto, 'getRandomValues', {
    value: getRandomValues,
    configurable: true,
  });
}
