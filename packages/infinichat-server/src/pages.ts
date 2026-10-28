import { readFile, rm } from 'node:fs/promises';

import { nodeDatabaseFiles as node } from '@pi-agent/infinichat/node/database-files';
import { apply, diff, pages } from '@pi-agent/infinichat/pi/infinichat-remote/pages';

// The commands the phone runs through its ExecutionEnv with the Node that runs the server, beside the server's
// process. Their inputs and outputs are files the phone names, writes or reads, and removes.

/** `pages <db> <out>`: the page list of a closed database without a WAL, such as this machine's copy. */
export async function writePages(db: string, out: string): Promise<void> {
  await node.write(out, await pages(node, db));
}

/**
 * `diff <db> <pages> <out> [--live]`: the patch of `db` against the receiver's page list. With `--live`, `db` is the
 * database the server holds open, and the patch is of a backup of it, which SQLite's backup API takes consistently
 * and at the same page numbers.
 */
export async function writeDiff(db: string, list: string, out: string, live: boolean): Promise<void> {
  const copy = `${out}.${process.pid}.db`;
  try {
    if (live) await node.backup(db, copy);
    await node.write(out, await diff(node, live ? copy : db, await readFile(list)));
  } finally {
    await rm(copy, { force: true });
  }
}

/** `patch <base> <patch> <out>`: applies a patch to `base`, verifies the result and renames it to `out`. */
export async function writePatch(base: string, patch: string, out: string): Promise<void> {
  await apply(node, base, await readFile(patch), out);
}
