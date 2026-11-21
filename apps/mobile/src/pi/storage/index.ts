import type { Store } from '@earendil-works/chord';
import { BACKGROUND_CONTEXT } from '@earendil-works/chord/context';
import type { SqliteDatabase } from '@earendil-works/chord/sqlite';
import { SqliteStorage } from '@earendil-works/pi-durable/storage/sqlite';
import { openInfiniChatStore } from '@pi-agent/infinichat/pi/infinichat-store';
import { openDatabaseAsync } from 'expo-sqlite';

import { createExpoSqliteDatabase } from './expo-sqlite';

export { createExpoSqliteDatabase, type ExpoSqliteConnection } from './expo-sqlite';

/** One of the app's databases over a connection of its own, configured as every one of them is. */
async function openExpoDatabase(databaseName: string): Promise<SqliteDatabase> {
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
  return database;
}

/** Open the app's persistent Pi storage. Share the returned storage across conversations. */
export async function openExpoSqliteStorage(databaseName = 'pi-chats.db'): Promise<SqliteStorage> {
  // The portable core owns schema migrations, durable writes, reads and close.
  // It closes the database itself if migration or initialization fails.
  return SqliteStorage.open(await openExpoDatabase(databaseName));
}

/** InfiniChat's store on this phone, which its opener closes; Chord closes the database if the store fails to open. */
export async function openExpoStore(databaseName: string): Promise<Store> {
  return openInfiniChatStore(await openExpoDatabase(databaseName), BACKGROUND_CONTEXT);
}
