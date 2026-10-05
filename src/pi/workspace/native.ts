import { openDatabaseAsync } from 'expo-sqlite';
import { createExpoSqliteDatabase } from '../storage/expo-sqlite';

/** A separately owned connection keeps file traffic outside Pi's commit queue. */
export async function openWorkspaceDatabase(name = 'pi-workspaces.db') {
  const connection = await openDatabaseAsync(name, { useNewConnection: true });
  // Filesystem schema initialization owns WAL, synchronization and migrations
  // for native, web and test connections alike. Keep that policy in one place.
  return createExpoSqliteDatabase(connection);
}
