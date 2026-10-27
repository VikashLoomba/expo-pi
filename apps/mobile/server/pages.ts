import { createHash } from 'node:crypto';
import { readFile, rename, rm, writeFile } from 'node:fs/promises';
import { backup, DatabaseSync } from 'node:sqlite';
import { promisify } from 'node:util';
import { gunzip, gzip } from 'node:zlib';

import { apply, diff, pages, type PagePlatform } from '@pi-agent/infinichat/pi/infinichat-remote/pages';

const node: PagePlatform = {
  sha256: async (bytes) => createHash('sha256').update(bytes).digest(),
  gzip: promisify(gzip),
  gunzip: promisify(gunzip),
  read: (path) => readFile(path),
  async write(path, bytes) {
    const aside = `${path}.${process.pid}`;
    await writeFile(aside, bytes);
    await rename(aside, path);
  },
};

// The commands the phone runs through its ExecutionEnv with the Node that runs the server, beside the server's
// process. Their inputs and outputs are files the phone names, writes or reads, and removes.

/** `pages <db> <out>`: the page list of a closed database without a WAL, such as this machine's copy. */
export async function writePages(db: string, out: string): Promise<void> {
  await node.write(out, await pages(node, db));
}

/**
 * `diff <db> <pages> <out> [--live]`: the patch of `db` against the receiver's page list. With `--live`, `db` is the
 * database the server holds open, and the patch is of a backup of it, which SQLite's backup API takes consistently
 * and at the same page numbers. It copies in one step, as expo-sqlite's backup does: a backup in steps starts over
 * at each commit another connection makes between them, as the server's Harness does while it streams.
 */
export async function writeDiff(db: string, list: string, out: string, live: boolean): Promise<void> {
  const copy = `${out}.${process.pid}.db`;
  try {
    if (live) {
      // Read-only, so a database that isn't there fails instead of being created.
      const source = new DatabaseSync(db, { readOnly: true });
      try {
        await backup(source, copy, { rate: -1 });
      } finally {
        source.close();
      }
    }
    await node.write(out, await diff(node, live ? copy : db, await readFile(list)));
  } finally {
    await rm(copy, { force: true });
  }
}

/** `patch <base> <patch> <out>`: applies a patch to `base`, verifies the result and renames it to `out`. */
export async function writePatch(base: string, patch: string, out: string): Promise<void> {
  await apply(node, base, await readFile(patch), out);
}
