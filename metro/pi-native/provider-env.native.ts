import type { ProviderEnv } from '@earendil-works/pi-ai';

type ProcessGlobal = {
  process?: { env?: Record<string, string | undefined> };
};

/** Scoped configuration first, then an already-present runtime process.env. */
export function getProviderEnvValue(
  name: string,
  env?: ProviderEnv,
): string | undefined {
  const ambient = (globalThis as typeof globalThis & ProcessGlobal).process?.env;
  // No Bun /proc/self/environ or Node filesystem fallback on native.
  return env?.[name] || ambient?.[name] || undefined;
}
