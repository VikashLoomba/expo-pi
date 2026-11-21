import { openStore, sqliteBackend, type Store } from '@earendil-works/chord';
import { BACKGROUND_CONTEXT, withAbortSignal, type Context } from '@earendil-works/chord/context';
import type { SqliteDatabase } from '@earendil-works/chord/sqlite';
import {
  FileSystemSyncRemote, HistoryUnavailableError, LOG_START, pullSession, UnsyncedCommitsError, uploadSession,
  type LocalCopy, type SyncBody, type SyncFileSystem, type SyncStateStore,
} from '@earendil-works/chord/sync';
import { FileError } from '@earendil-works/pi-durable/env';
import { compile, num, obj, opt } from '@earendil-works/pi-schema';

import { INFINICHAT_DATABASE } from '../infinichat-store';
import type { InfiniChatHomeStorage } from './home';
import { fileFailure } from './machine';

/**
 * The transport of a move: Chord's session sync (`@earendil-works/chord/sync`, experimental at 1.6.0), as its test
 * "hands a session back and forth: each device continues it as its own" does it (`test/sync/sync.test.ts`). The side
 * that gives the conversation uploads what its store committed since the two sides last shared it, and the side that
 * takes it applies that to its copy. The remote is a folder on a machine, Chord's own `FileSystemSyncRemote`, as p2's
 * backup to a folder is (`apps/p2/src/runtime/backup.ts`): a phone reaches it through the environment of its
 * connection there, the machine's server on its own disk, and another machine's server over its own SSH. A machine
 * gives into its own folder; a phone, which no machine reaches, gives into the folder of the machine that takes.
 *
 * Upstream has one remote and devices that upload as they commit. Here a folder hears from a device only when the
 * conversation moves through it, so what it holds can be behind the conversation, which went another way meanwhile.
 * Who holds the conversation is not the folder's to say: the home record and each server's state are (`home.ts`).
 * So where a folder's history is not one the giver continues, the giver starts it over with its whole store, and
 * where a taker's copy is not one the folder continues, the taker restores the whole store beside it. Each is what
 * upstream's client does with a copy that diverged, without the fork: the holder's store is the conversation.
 */

/** The machine's InfiniChat folder, in its account's home. */
export const FOLDER = '.infinichat';
/** A machine's folder of handovers, in its InfiniChat folder: its server makes it for its account alone. */
export const SYNC = 'sync';
/** The conversation in a folder: there is one, so one session. */
const SESSION = 'infinichat';
/** Where a take restores the whole store, until it is this device's copy. */
export const INCOMING = `${INFINICHAT_DATABASE}.incoming`;
/**
 * The bytes gathered for one write to a folder. A compression stream hands out a few KiB at a time (Node's 8 on
 * average, the phone's library 1), and the folder remote appends each chunk with a call of its own, which over SSH is
 * a round trip each: tens of thousands for the owner's conversation. One write of this size keeps upstream's pipeline
 * busy instead (512 KiB a request, eight in flight; pi-env `remote-env.js`, which the phone's port matches).
 */
const CHUNK = 4 * 1024 * 1024;

/** This device's InfiniChat databases, by name, as a move opens and places them. */
export interface StoreFiles {
  exists(name: string): boolean;
  /** A connection of its own to the database, which is created when it isn't there; its opener closes it. */
  open(name: string): Promise<SqliteDatabase>;
  /**
   * Folds the WAL a close left into the closed database (`PRAGMA wal_checkpoint(TRUNCATE)`), so the database file alone
   * is the conversation; fails while it is still in use, and does nothing when it isn't there.
   */
  fold(name: string): Promise<void>;
  /** Renames a closed database to `to`, removing both names' `-wal` and `-shm`; what was at `to` is the device's. */
  rename(from: string, to: string): Promise<void>;
  /** Removes a database and its `-wal` and `-shm`. */
  remove(name: string): Promise<void>;
}

/** A machine's folder as one side of a move reaches it. */
export interface HandoverFolder {
  /** The files there: the machine's own, or an environment borrowed from the owner of a connection to it. */
  files: SyncFileSystem;
  root: string;
  /** What this device's copy last shared with this folder; one per folder, as p2 keeps one per backup target. */
  bookmarks: SyncStateStore;
  signal: AbortSignal;
  /** The machine's name when the folder is reached over SSH: a file's failure there becomes a message naming it. */
  machine?: string;
  /** Called with the bytes of each write to the folder and each read from it. */
  copied?: (bytes: number) => void;
}

/** A body in pieces of `CHUNK`, each reported once the folder has it. */
async function* gathered(body: SyncBody, copied: (bytes: number) => void): SyncBody {
  let parts: Uint8Array[] = [];
  let size = 0;
  const piece = () => {
    const bytes = new Uint8Array(size);
    let offset = 0;
    for (const part of parts) {
      bytes.set(part, offset);
      offset += part.byteLength;
    }
    parts = [];
    size = 0;
    return bytes;
  };
  for await (const chunk of body) {
    parts.push(chunk);
    size += chunk.byteLength;
    if (size < CHUNK) continue;
    const bytes = piece();
    yield bytes;
    copied(bytes.byteLength);
  }
  if (size === 0) return;
  const bytes = piece();
  yield bytes;
  copied(bytes.byteLength);
}

/**
 * A body with each chunk reported as it is read. Not a generator: a pull releases a body it never started reading
 * through `return()`, which a generator that has not started does not pass on (chord `src/sync/filesystem.ts`,
 * `readerBody`).
 */
function counted(body: SyncBody, copied: (bytes: number) => void): SyncBody {
  const inner = body[Symbol.asyncIterator]();
  const outer: AsyncIterableIterator<Uint8Array, undefined> = {
    async next() {
      const result = await inner.next();
      if (result.done) return { done: true, value: undefined };
      copied(result.value.byteLength);
      return result;
    },
    async return() {
      await inner.return?.();
      return { done: true, value: undefined };
    },
    [Symbol.asyncIterator]: () => outer,
  };
  return outer;
}

/** Chord's folder remote, writing in pieces a connection carries well and saying how much it has moved. */
class FolderRemote extends FileSystemSyncRemote {
  private readonly copied: (bytes: number) => void;

  constructor(folder: HandoverFolder) {
    super(folder.files, folder.root);
    this.copied = folder.copied ?? (() => {});
  }

  override putBatch(...[session, after, to, device, body, context, options]:
    Parameters<FileSystemSyncRemote['putBatch']>) {
    return super.putBatch(session, after, to, device, gathered(body, this.copied), context, options);
  }

  override async getBatch(...args: Parameters<FileSystemSyncRemote['getBatch']>) {
    const body = await super.getBatch(...args);
    return body && counted(body, this.copied);
  }
}

/** Runs one side's part with the folder's cancellation, and words what a machine's files refused. */
async function reached<T>(folder: HandoverFolder, run: (context: Context) => Promise<T>): Promise<T> {
  try {
    return await run(withAbortSignal(folder.signal, BACKGROUND_CONTEXT));
  } catch (error) {
    if (folder.machine === undefined || !(error instanceof FileError)) throw error;
    throw fileFailure(folder.signal, error, folder.machine,
      `Check the account’s home folder permissions and disk space on ${folder.machine}.`);
  }
}

/** The store of a conversation nobody holds open, for a move, with the outbox sync uploads from. */
const openCopy = async (files: StoreFiles, name: string, context: Context): Promise<Store> =>
  openStore(sqliteBackend(await files.open(name)), context, { outbox: true });

/** Where this device's closed conversation ends, its store's last commit; undefined when it keeps none. */
export async function conversationHead(files: StoreFiles): Promise<number | undefined> {
  if (!files.exists(INFINICHAT_DATABASE)) return undefined;
  const store = await openStore(sqliteBackend(await files.open(INFINICHAT_DATABASE)), BACKGROUND_CONTEXT);
  try {
    return store.lastSeq;
  } finally {
    await store.close(BACKGROUND_CONTEXT);
  }
}

/**
 * Uploads this device's closed conversation to the folder as `device`, and resolves with where it ends: the commits
 * since this copy and the folder last shared it, or the whole store where the outbox does not reach back that far
 * (Chord's archive slot), which a first move, a long stay (`infinichat-store.ts`) and a copy restored from another
 * folder all are. Nothing reads a folder's history from before a whole store, so the folder starts over with one;
 * and one whose history this copy does not continue (`diverged`, `behind`) starts over too. Sending it again
 * uploads nothing.
 */
export function give(files: StoreFiles, device: string, folder: HandoverFolder): Promise<number> {
  return reached(folder, async (context) => {
    if (!files.exists(INFINICHAT_DATABASE)) throw new Error('There is no InfiniChat conversation here to move.');
    const store = await openCopy(files, INFINICHAT_DATABASE, context);
    try {
      const startOver = async () => {
        await folder.bookmarks.set(SESSION, { syncedHead: undefined }, context);
        const session = await folder.files.joinPath([folder.root, SESSION], context);
        if (!session.ok) throw session.error;
        const removed = await folder.files.remove(session.value, { recursive: true, force: true }, context);
        if (!removed.ok) throw removed.error;
      };
      const upload = () => uploadSession({ sessionId: SESSION, device, source: store, store: new FolderRemote(folder),
        state: folder.bookmarks, context });
      const shared = (await folder.bookmarks.get(SESSION, context))?.syncedHead ?? LOG_START;
      if ((store.outbox?.floor ?? LOG_START) > shared) await startOver();
      let result = await upload();
      if (result.type !== 'uploaded' && result.type !== 'idle') {
        await startOver();
        result = await upload();
      }
      if (result.type !== 'uploaded' && result.type !== 'idle') {
        throw new Error(`The conversation could not be uploaded (${result.type}).`);
      }
      return store.lastSeq;
    } finally {
      await store.close(BACKGROUND_CONTEXT);
    }
  });
}

/**
 * Brings this device's copy to `head`, where the giver said the conversation ends, from what the folder holds: applied
 * to the copy where the folder's history continues from it, and else restored whole beside it and put in its place.
 * A copy is replaced only by a store that ends at `head`, and applying what is already applied changes nothing, so
 * a take a failure cut off is run again.
 */
export function take(files: StoreFiles, head: number, folder: HandoverFolder): Promise<void> {
  return reached(folder, async (context) => {
    const pull = (local: LocalCopy) => pullSession({ sessionId: SESSION, store: new FolderRemote(folder), local,
      state: folder.bookmarks, context });
    if (files.exists(INFINICHAT_DATABASE)) {
      const copy = await openCopy(files, INFINICHAT_DATABASE, context);
      try {
        await pull({ kind: 'store', store: copy });
        if (copy.lastSeq === head) return;
      } catch (error) {
        if (!(error instanceof UnsyncedCommitsError) && !(error instanceof HistoryUnavailableError)) throw error;
      } finally {
        await copy.close(BACKGROUND_CONTEXT);
      }
    }
    await files.remove(INCOMING);
    const { store } = await pull({ kind: 'empty', backend: sqliteBackend(await files.open(INCOMING)) });
    const restored = store.lastSeq;
    await store.close(BACKGROUND_CONTEXT);
    if (restored !== head) {
      await files.remove(INCOMING);
      throw new Error(`The copy${folder.machine === undefined ? '' : ` from ${folder.machine}`} doesn’t match the `
        + 'conversation that was sent. Try again.');
    }
    // The rename takes the file alone, so its WAL is folded into it first.
    await files.fold(INCOMING);
    await files.rename(INCOMING, INFINICHAT_DATABASE);
  });
}

const bookmark = compile(obj({ syncedHead: opt(num()), pulling: opt(num()) }));

/**
 * What this device's copy last shared with a machine's folder, kept where the home record is, by the machine's ID
 * there. Losing one loses nothing: the next move through that folder sends or restores the store whole.
 */
export function storedBookmarks(storage: InfiniChatHomeStorage, machineId: string): SyncStateStore {
  const key = `pi.infinichat.synced.v1.${machineId}`;
  return {
    async get() {
      const text = storage.getItem(key);
      const value: unknown = text === null ? undefined : JSON.parse(text);
      if (!bookmark.check(value)) return undefined;
      return { syncedHead: value.syncedHead, ...(value.pulling === undefined ? {} : { pulling: value.pulling }) };
    },
    async set(_session, state) {
      storage.setItem(key, JSON.stringify(state));
    },
  };
}
