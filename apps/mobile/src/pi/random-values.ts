import { getRandomValues } from 'expo-crypto';

/**
 * Hermes has no `crypto` global, and Pi generates ids with `crypto.getRandomValues` (pi-ai `utils/uuid`,
 * `auth/oauth/pkce`; pi-durable's codemode seed). Install it from expo-crypto once, before any Pi module
 * runs. An implementation the runtime already has is kept; `crypto.subtle` is not provided.
 */
if (typeof globalThis.crypto?.getRandomValues !== 'function') {
  if (!globalThis.crypto) {
    Object.defineProperty(globalThis, 'crypto', { value: {}, configurable: true, writable: true });
  }
  Object.defineProperty(globalThis.crypto, 'getRandomValues', {
    value: getRandomValues,
    configurable: true,
    writable: true,
  });
}
