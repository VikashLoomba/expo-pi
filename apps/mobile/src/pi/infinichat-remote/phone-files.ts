import type { StoreFiles } from '@pi-agent/infinichat/pi/infinichat-remote/sync';
import { File } from 'expo-file-system';
import { defaultDatabaseDirectory, openDatabaseAsync } from 'expo-sqlite';

import { openExpoDatabase } from '../storage';

/** A file of the phone's InfiniChat, in the folder expo-sqlite opens databases from by name (its `databasePath`). */
function phoneFile(name: string): File {
  const directory: unknown = defaultDatabaseDirectory;
  if (typeof directory !== 'string') throw new Error('The app’s database folder is unavailable.');
  return new File(`file://${directory}`, name);
}

function remove(name: string) {
  for (const suffix of ['', '-wal', '-shm']) {
    const file = phoneFile(`${name}${suffix}`);
    if (file.exists) file.delete();
  }
}

/**
 * InfiniChat's databases on this iPhone, in expo-sqlite's database folder: files with expo-file-system, and the
 * databases' own operations with expo-sqlite.
 */
export const phoneStoreFiles: StoreFiles = {
  // Without reading the file.
  exists: (name) => phoneFile(name).exists,
  open: (name) => openExpoDatabase(name),
  // Opening and closing alone leave the WAL: SQLite opens it at the first read.
  async fold(name) {
    // Opening a database that isn't there would create it.
    if (!phoneFile(name).exists) return;
    const database = await openDatabaseAsync(name);
    try {
      const result = await database.getFirstAsync<{ busy: number }>('PRAGMA wal_checkpoint(TRUNCATE)');
      if (result?.busy !== 0) throw new Error('InfiniChat’s database on this iPhone is still in use. Try again.');
    } finally {
      await database.closeAsync();
    }
  },
  // Nothing is left of `to` that SQLite could pair with the renamed file: a copy a move replaces goes.
  async rename(from, to) {
    remove(to);
    phoneFile(from).moveSync(phoneFile(to));
    remove(from);
  },
  async remove(name) {
    remove(name);
  },
};
