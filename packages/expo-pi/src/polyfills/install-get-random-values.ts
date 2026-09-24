import type { getRandomValues } from 'expo-crypto';

/**
 * Expose `getRandomValues` as `crypto.getRandomValues` when the runtime lacks it.
 * An existing implementation is always kept. This does not provide `crypto.subtle`.
 */
export function installGetRandomValues(
  target: typeof globalThis,
  implementation: typeof getRandomValues,
): void {
  if (typeof target.crypto?.getRandomValues === 'function') return;
  if (!target.crypto) {
    Object.defineProperty(target, 'crypto', { value: {}, configurable: true, writable: true });
  }
  Object.defineProperty(target.crypto, 'getRandomValues', {
    value: implementation,
    configurable: true,
    writable: true,
  });
}
