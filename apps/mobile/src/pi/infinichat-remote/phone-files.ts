import type { DatabaseFiles } from '@pi-agent/infinichat/pi/infinichat-remote/move';
import { deflateAsync, inflateAsync } from '@strawberrytech/react-native-nitro-zlib';
import { CryptoDigestAlgorithm, digest } from 'expo-crypto';
import { File } from 'expo-file-system';
import { backupDatabaseAsync, defaultDatabaseDirectory, openDatabaseAsync } from 'expo-sqlite';

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
 * InfiniChat's database files on this iPhone, in expo-sqlite's database folder: page diffs with expo-crypto and
 * nitro-zlib off the JS thread, files with expo-file-system, and the database's own operations with expo-sqlite.
 */
export const phoneDatabaseFiles: DatabaseFiles = {
  sha256: async (bytes) => new Uint8Array(await digest(CryptoDigestAlgorithm.SHA256, bytes)),
  // nitro-zlib takes a whole ArrayBuffer, so a view is copied into one of its own.
  gzip: async (bytes) => new Uint8Array(await deflateAsync(bytes.slice().buffer, 'gzip')),
  gunzip: async (bytes) => new Uint8Array(await inflateAsync(bytes.slice().buffer, 'gzip')),
  read: (name) => phoneFile(name).bytes(),
  async write(name, bytes) {
    const aside = phoneFile(`${name}.partial`);
    await aside.write(bytes);
    aside.moveSync(phoneFile(name), { overwrite: true });
  },
  async describe(name) {
    const file = phoneFile(name);
    return file.exists ? { sha256: await file.digest('SHA-256'), size: file.size } : undefined;
  },
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
  // Over a second connection each, so the Harness goes on writing through its own.
  async backup(from, to) {
    const source = await openDatabaseAsync(from, { useNewConnection: true });
    try {
      const backup = await openDatabaseAsync(to, { useNewConnection: true });
      try {
        await backupDatabaseAsync({ sourceDatabase: source, destDatabase: backup });
      } finally {
        await backup.closeAsync();
      }
    } finally {
      await source.closeAsync();
    }
  },
  // Nothing is left of `to` that SQLite could pair with the renamed file.
  async rename(from, to) {
    remove(to);
    phoneFile(from).moveSync(phoneFile(to));
    remove(from);
  },
  async remove(name) {
    remove(name);
  },
  async open(name) {
    const file = phoneFile(name);
    file.create({ overwrite: true });
    return file.writableStream();
  },
};
