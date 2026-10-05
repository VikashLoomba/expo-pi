import type { SqliteDatabase, SqliteValue } from '@earendil-works/pi-durable/storage/sqlite';

type Entry = { database: Promise<SqliteDatabase>; references: number; closing?: Promise<void> };

/**
 * Lease one owned connection/transaction queue per name. Expo's web VFS has no
 * SQLite connection locks, so separate connection queues can silently lose writes.
 * A lease closes independently; the physical connection closes after the last one.
 */
export function createSharedDatabasePool(open: (name: string) => Promise<SqliteDatabase>) {
  const entries = new Map<string, Entry>();
  return async function acquire(name: string): Promise<SqliteDatabase> {
    let entry = entries.get(name);
    if (entry?.closing) {
      await entry.closing;
      entry = entries.get(name);
    }
    if (!entry) {
      entry = { database: Promise.resolve().then(() => open(name)), references: 0 };
      entries.set(name, entry);
    }
    const owner = entry;
    owner.references++;
    let database: SqliteDatabase;
    try { database = await owner.database; }
    catch (error) {
      if (--owner.references === 0 && entries.get(name) === owner) entries.delete(name);
      throw error;
    }
    let closed = false;
    let closing: Promise<void> | undefined;
    function admitted<T>(operation: () => Promise<T>): Promise<T> {
      return closed ? Promise.reject(new Error('Workspace database lease is closed')) : operation();
    }
    return {
      exec: (sql) => admitted(() => database.exec(sql)),
      run: (sql, ...values) => admitted(() => database.run(sql, ...values)),
      get: <T extends object>(sql: string, ...values: SqliteValue[]) =>
        admitted(() => database.get<T>(sql, ...values)),
      all: <T extends object>(sql: string, ...values: SqliteValue[]) =>
        admitted(() => database.all<T>(sql, ...values)),
      transaction: (callback) => admitted(() => database.transaction(callback)),
      close: () => {
        if (!closing) {
          closed = true;
          if (--owner.references === 0) {
            owner.closing = database.close().finally(() => {
              if (entries.get(name) === owner) entries.delete(name);
            });
            closing = owner.closing;
          } else closing = Promise.resolve();
        }
        return closing;
      },
    };
  };
}
