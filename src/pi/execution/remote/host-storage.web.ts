import { RemoteHostRepository } from './hosts';

/** SSH execution requires the native app; never persist SSH secrets in the browser. */
export function createRemoteHostRepository(): RemoteHostRepository {
  const unavailable = async (): Promise<never> => { throw new Error('Remote SSH execution is available in the native mobile app.'); };
  return new RemoteHostRepository({
    getItemAsync: async () => null,
    setItemAsync: unavailable,
    deleteItemAsync: unavailable,
  }, { getItemAsync: unavailable, setItemAsync: unavailable, deleteItemAsync: unavailable }, () => globalThis.crypto.randomUUID());
}
