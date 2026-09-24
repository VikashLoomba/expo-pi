import type { AuthContext } from '@earendil-works/pi-ai';
import { getProviderEnvValue } from './provider-env.native.ts';

export function defaultProviderAuthContext(): AuthContext {
  return {
    async env(name) {
      const value = getProviderEnvValue(name);
      return typeof value === 'string' && value.trim().length > 0
        ? value
        : undefined;
    },
    async fileExists(_path) {
      // This means no *desktop credential-file discovery*, not no mobile FS.
      return false;
    },
  };
}
