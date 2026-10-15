/** Linux host adapter. Portable OptChat modules do not import this module. */
import { closeSync, fsyncSync, mkdirSync, openSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import type { Context } from '@earendil-works/chord';
import { openNodeSqliteDatabase } from '@earendil-works/pi-durable/storage/sqlite/node';
import { SqliteStorage } from '@earendil-works/pi-durable/storage/sqlite';

function syncDirectory(directory: string): void {
  const fd = openSync(directory, 'r');
  try { fsyncSync(fd); } finally { closeSync(fd); }
}

function createDurableDirectory(directory: string): void {
  const firstCreated = mkdirSync(directory, { recursive: true, mode: 0o700 });
  if (firstCreated === undefined) return;
  const existingParent = dirname(resolve(firstCreated));
  for (let current = directory;; current = dirname(current)) {
    syncDirectory(current);
    if (current === existingParent) break;
  }
}

/**
 * One writer per local directory. Linux flock attaches to the open file description:
 * its inherited descriptor and ours refer to the same lock. After flock exits, our
 * descriptor retains ownership. Process death releases it without stale-lock repair.
 * Never unlink .writer.lock: replacing that inode could create two independent locks.
 */
function acquireWriter(directory: string): () => void {
  const fd = openSync(join(directory, '.writer.lock'), 'a+', 0o600);
  try {
    const result = spawnSync('flock', ['--exclusive', '--nonblock', '--conflict-exit-code', '73', '3'], {
      stdio: ['ignore', 'pipe', 'pipe', fd], encoding: 'utf8',
    });
    if (result.error) throw result.error;
    if (result.status === 73) throw new Error('This OptChat directory already has a writer.');
    if (result.status !== 0) throw new Error(`flock failed: ${result.stderr || result.signal || result.status}`);
    syncDirectory(directory);
  } catch (error) {
    closeSync(fd);
    throw error;
  }
  let released = false;
  return () => { if (!released) { closeSync(fd); released = true; } };
}

export type NodeStore = {
  storage: SqliteStorage;
  /** Stop/close the Harness before closing its storage and releasing ownership. */
  close(context: Context): Promise<void>;
};

/**
 * Open on a local Linux filesystem with working flock and fsync semantics.
 * SQLite FULL in WAL mode syncs each committed transaction before acknowledgment.
 * Hardware/filesystem honoring synchronization remains a host requirement.
 */
export async function openNodeStore(path: string): Promise<NodeStore> {
  if (process.platform !== 'linux') throw new Error('This host adapter requires Linux; use a platform storage/ownership adapter elsewhere.');
  const directory = resolve(path);
  createDurableDirectory(directory);
  const releaseWriter = acquireWriter(directory);
  let database: Awaited<ReturnType<typeof openNodeSqliteDatabase>> | undefined;
  try {
    database = await openNodeSqliteDatabase(join(directory, 'session.sqlite'));
    await database.exec('PRAGMA synchronous = FULL');
    const mode = await database.get<{ synchronous: number }>('PRAGMA synchronous');
    if (mode?.synchronous !== 2) throw new Error('SQLite did not enable synchronous=FULL.');
    const storage = await SqliteStorage.open(database);
    syncDirectory(directory);
    let closed = false;
    return {
      storage,
      async close(context) {
        if (closed) return;
        await storage.close(context);
        releaseWriter();
        closed = true;
      },
    };
  } catch (error) {
    try { await database?.close(); } finally { releaseWriter(); }
    throw error;
  }
}
