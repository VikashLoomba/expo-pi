import type { NativeWebSearchIntegration } from './types';

export type NativeWebSearchScope = NativeWebSearchIntegration | { error: unknown };

// Correlation only: canonical data lives in Pi documents. The durable generation
// invocation supplies this same signal to beforeRequest and provider options.
const scopes = new WeakMap<AbortSignal, NativeWebSearchScope>();

export function bindNativeWebSearch(signal: AbortSignal, scope: NativeWebSearchScope | undefined) {
  if (scope) scopes.set(signal, scope);
  else scopes.delete(signal);
}

export function nativeWebSearchScope(signal: AbortSignal | undefined) {
  return signal ? scopes.get(signal) : undefined;
}
