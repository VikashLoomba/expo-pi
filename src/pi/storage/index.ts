import { SqliteStorage } from '@earendil-works/pi-durable/storage/sqlite';
import { openDatabaseAsync } from 'expo-sqlite';

import { createExpoSqliteDatabase } from './expo-sqlite';

export { createExpoSqliteDatabase, type ExpoSqliteConnection } from './expo-sqlite';

/** Open the app's persistent Pi storage. Share the returned storage across conversations. */
export async function openExpoSqliteStorage(databaseName = 'pi-chats.db'): Promise<SqliteStorage> {
  // Own an isolated connection so Expo's connection cache cannot bypass our queue.
  const native = await openDatabaseAsync(databaseName, { useNewConnection: true });
  const database = createExpoSqliteDatabase(native);
  try {
    await database.exec('PRAGMA journal_mode = WAL');
    await database.exec('PRAGMA synchronous = NORMAL');
    await database.exec('PRAGMA busy_timeout = 5000');
    await database.exec('PRAGMA foreign_keys = ON');
  } catch (error) {
    try { await database.close(); } catch { /* Preserve the configuration error. */ }
    throw error;
  }
  // The portable core owns schema migrations, durable writes, reads and close.
  // It closes the database itself if migration or initialization fails.
  return SqliteStorage.open(database);
}
