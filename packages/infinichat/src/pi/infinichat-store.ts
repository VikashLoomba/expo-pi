import { openStore, sqliteBackend, type Store } from '@earendil-works/chord';
import { BACKGROUND_CONTEXT, type Context } from '@earendil-works/chord/context';
import type { SqliteDatabase } from '@earendil-works/chord/sqlite';
import type { Storage } from '@earendil-works/pi-durable';
import { StoreStorage } from '@earendil-works/pi-durable/storage/store';

/** The conversation's database, as both sides' folders name it: a Chord store. */
export const INFINICHAT_DATABASE = 'infinichat-store.db';

/**
 * The name pi-durable's records are kept under in InfiniChat's store, as an object's type name is in a host's
 * (pi-durable `test/examples/35-durable-on-the-store.ts`).
 */
const OWNER = 'infinichat';

/**
 * The commits a holder keeps in its store's outbox for the next move, at most. A move sends them where the other
 * side's copy is that close behind, and the whole store otherwise (`infinichat-remote/sync.ts`). A commit rewrites
 * the documents it changes whole, so the commits of a long stay are several times the store itself: three ordinary
 * turns on the owner's conversation (216 MB as a store, 74 MiB to send whole) were 78 commits and 1.3 MB of outbox,
 * 98 KiB a turn to send. At this many commits they are about half of what sending the whole store is.
 */
const OUTBOX_COMMITS = 10_000;

/**
 * InfiniChat's conversation is kept in a Chord store, over the SQLite connection its host opens: Node's on a machine,
 * expo-sqlite's on the phone. The store is the conversation's and not a Chord host's, where pi-durable's example gives
 * a host its store: the conversation comes to a device and leaves it while that device's host lives. Whoever opens
 * the store closes it, after the Harness, which closes only its own storage in it.
 *
 * This opens it for the side that holds the conversation. A store that has moved keeps an outbox, which Chord's
 * session sync uploads from and a move turns on; upstream uploads as commits happen, so its outbox stays short (p2
 * `src/runtime/backup.ts`), where a move uploads once. So a holder drops an outbox that has outgrown its use, and the
 * next move sends the store whole.
 */
export async function openInfiniChatStore(database: SqliteDatabase, context: Context): Promise<Store> {
  const store = await openStore(sqliteBackend(database), context);
  const { outbox } = store;
  if (outbox !== undefined) {
    store.onCommitted((head) => {
      // A trim the store's close cuts off is the next commit's to make.
      if (head - outbox.floor > OUTBOX_COMMITS) void outbox.trim(head, BACKGROUND_CONTEXT).catch(() => {});
    }, () => {});
  }
  return store;
}

/** pi-durable's storage in the store, which a Harness opens over and closes. */
export const infiniChatStorage = (store: Store, context: Context): Promise<Storage> =>
  StoreStorage.open(store, OWNER, context);
