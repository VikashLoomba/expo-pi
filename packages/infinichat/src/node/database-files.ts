import { existsSync } from 'node:fs';
import { mkdir, rename, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { backup, DatabaseSync } from 'node:sqlite';

import { openNodeSqliteDatabase } from '@earendil-works/chord/sqlite/node';

import type { StoreFiles } from '../pi/infinichat-remote/sync';

const SUFFIXES = ['', '-wal', '-shm'];

/**
 * A machine's InfiniChat databases with Node, by their names in `directory`. A database a move replaces is kept in a
 * folder of its own in `released`, where nothing opens it: a whole store takes a copy's place only where the copy
 * was not what the sender continued, and what that copy was is for the machine's owner to say.
 */
export function nodeStoreFiles(directory: string, released: string): StoreFiles {
  const at = (name: string) => join(directory, name);
  return {
    exists: (name) => existsSync(at(name)),
    open: (name) => openNodeSqliteDatabase(at(name)),
    /**
     * Chord's close checkpoints already, but a reader still on the database keeps it from finishing then, which that
     * close doesn't report, so this checkpoint waits for readers (chord's 5 s busy timeout) and fails when it can't.
     */
    async fold(name) {
      // Opening would create a database that isn't there.
      if (!existsSync(at(name))) return;
      const database = new DatabaseSync(at(name), { timeout: 5_000 });
      try {
        if (database.prepare('PRAGMA wal_checkpoint(TRUNCATE)').get()?.busy !== 0) {
          throw new Error('InfiniChat’s database on this machine is still in use. Try again.');
        }
      } finally {
        database.close();
      }
    },
    async rename(from, to) {
      if (existsSync(at(to))) {
        const kept = join(released, `${new Date().toISOString().replace(/[:.]/g, '-')}-${process.pid}`);
        await mkdir(kept, { recursive: true, mode: 0o700 });
        for (const suffix of SUFFIXES) {
          if (existsSync(at(`${to}${suffix}`))) await rename(at(`${to}${suffix}`), join(kept, `${to}${suffix}`));
        }
      }
      for (const suffix of ['-wal', '-shm']) await rm(at(`${to}${suffix}`), { force: true });
      await rename(at(from), at(to));
      for (const suffix of ['-wal', '-shm']) await rm(at(`${from}${suffix}`), { force: true });
    },
    async remove(name) {
      for (const suffix of SUFFIXES) await rm(at(`${name}${suffix}`), { force: true });
    },
  };
}

/** SQLite's backup API, from the database at `from` to the file `to`, in one step. */
export async function backupDatabase(from: string, to: string): Promise<void> {
  // Read-only, so a database that isn't there fails instead of being created.
  const source = new DatabaseSync(from, { readOnly: true });
  try {
    await backup(source, to, { rate: -1 });
  } finally {
    source.close();
  }
}
