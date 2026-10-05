import { openDatabaseAsync } from 'expo-sqlite';
import { createExpoSqliteDatabase } from '../storage/expo-sqlite';
import { createSharedDatabasePool } from './shared-database';
import { openWebDatabaseWithLock } from './web-database-lock';

// All chats still have separate namespaces. Web connections share ownership of
// one transaction queue because the installed OPFS VFS does not implement locks.
const acquire = createSharedDatabasePool((name) => openWebDatabaseWithLock(name, async () =>
  createExpoSqliteDatabase(await openDatabaseAsync(name, { useNewConnection: true }))));

export function openWorkspaceDatabase(name = 'pi-workspaces.db') {
  return acquire(name);
}
