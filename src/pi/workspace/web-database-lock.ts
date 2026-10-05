import type { SqliteDatabase } from '@earendil-works/pi-durable/storage/sqlite';

/** Hold cross-tab ownership for the physical connection's entire lifetime. */
export function openWebDatabaseWithLock(name: string, open: () => Promise<SqliteDatabase>): Promise<SqliteDatabase> {
  if (typeof navigator === 'undefined' || !navigator.locks) {
    return Promise.reject(new Error('Persistent browser workspaces require the Web Locks API in a secure context.'));
  }
  return new Promise((resolve, reject) => {
    let request: Promise<void>;
    // ifAvailable avoids an invisible forever-pending tool behind another tab.
    request = navigator.locks.request(`pi-workspace-database:${name}`, { ifAvailable: true }, async (lock) => {
      if (!lock) throw new Error('This workspace database is open in another browser tab. Close that tab and retry.');
      let release!: () => void;
      const lifetime = new Promise<void>((done) => { release = done; });
      const database = await open();
      const close = database.close.bind(database);
      database.close = async () => {
        try { await close(); }
        finally {
          release();
          // A following acquire must not race the browser's lock release.
          await request;
        }
      };
      resolve(database);
      await lifetime;
    });
    void request.catch(reject);
  });
}
