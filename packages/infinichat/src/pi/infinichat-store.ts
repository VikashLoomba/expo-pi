import { openStore, sqliteBackend, type Store } from '@earendil-works/chord';
import type { Context } from '@earendil-works/chord/context';
import type { SqliteDatabase } from '@earendil-works/chord/sqlite';
import type { Storage } from '@earendil-works/pi-durable';
import { StoreStorage } from '@earendil-works/pi-durable/storage/store';

/**
 * The name pi-durable's records are kept under in InfiniChat's store, as an object's type name is in a host's
 * (pi-durable `test/examples/35-durable-on-the-store.ts`).
 */
const OWNER = 'infinichat';

/**
 * InfiniChat's conversation is kept in a Chord store, over the SQLite connection its host opens: Node's on a machine,
 * expo-sqlite's on the phone. The store is the conversation's and not a Chord host's, where pi-durable's example gives
 * a host its store: the conversation comes to a device and leaves it while that device's host lives. Whoever opens
 * the store closes it, after the Harness, which closes only its own storage in it.
 */
export const openInfiniChatStore = (database: SqliteDatabase, context: Context): Promise<Store> =>
  openStore(sqliteBackend(database), context);

/** pi-durable's storage in the store, which a Harness opens over and closes. */
export const infiniChatStorage = (store: Store, context: Context): Promise<Storage> =>
  StoreStorage.open(store, OWNER, context);
