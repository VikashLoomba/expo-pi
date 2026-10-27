import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { readFile, rename, writeFile } from 'node:fs/promises';
import { backup, DatabaseSync } from 'node:sqlite';
import { promisify } from 'node:util';
import { gunzip, gzip } from 'node:zlib';

import type { DatabaseFiles } from '../pi/infinichat-remote/move';

/**
 * InfiniChat's database files with Node: page diffs with `node:crypto` and `node:zlib`, and the database's own
 * operations with `node:sqlite`. Names are paths, as `node:fs` takes them. A move's `rename`, `remove` and `open` come
 * with their first caller, the Mac app's side of a move; the server's side is its page commands and its conversation.
 */
export const nodeDatabaseFiles: Omit<DatabaseFiles, 'rename' | 'remove' | 'open'> = {
  sha256: async (bytes) => createHash('sha256').update(bytes).digest(),
  gzip: promisify(gzip),
  gunzip: promisify(gunzip),
  read: (path) => readFile(path),
  async write(path, bytes) {
    const aside = `${path}.${process.pid}`;
    await writeFile(aside, bytes);
    await rename(aside, path);
  },
  async describe(path) {
    let bytes: Buffer;
    try {
      bytes = await readFile(path);
    } catch (error) {
      if (error instanceof Error && 'code' in error && error.code === 'ENOENT') return undefined;
      throw error;
    }
    return { sha256: createHash('sha256').update(bytes).digest('hex'), size: bytes.byteLength };
  },
  /**
   * Chord's close checkpoints already, but a reader such as a `diff --live` still copying keeps it from finishing then,
   * which that close doesn't report, so this checkpoint waits for readers (chord's 5 s busy timeout) and fails when it
   * can't.
   */
  async fold(path) {
    // Opening would create a database that isn't there.
    if (!existsSync(path)) return;
    const database = new DatabaseSync(path, { timeout: 5_000 });
    try {
      if (database.prepare('PRAGMA wal_checkpoint(TRUNCATE)').get()?.busy !== 0) {
        throw new Error('InfiniChat’s database on this machine is still in use. Try again.');
      }
    } finally {
      database.close();
    }
  },
  /**
   * In one step, as expo-sqlite's backup does: a backup in steps starts over at each commit another connection makes
   * between them, as the Harness holding the database open does while it streams.
   */
  async backup(from, to) {
    // Read-only, so a database that isn't there fails instead of being created.
    const source = new DatabaseSync(from, { readOnly: true });
    try {
      await backup(source, to, { rate: -1 });
    } finally {
      source.close();
    }
  },
};
