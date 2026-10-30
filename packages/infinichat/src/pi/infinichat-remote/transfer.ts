import { BACKGROUND_CONTEXT, withAbortSignal } from '@earendil-works/chord/context';
import type { BinaryReader, ExecutionEnv } from '@earendil-works/pi-durable/env';

import { CURRENT, NODE } from './install';
import { fileFailure, PRINT_MARKER, runScript, temporary } from './machine';
import type { DatabaseFiles } from './move';
import { apply, diff, pages } from './pages';

/** The machine's InfiniChat folder, in its account's home, which only that account enters. */
export const FOLDER = '.infinichat';
/** The machine's conversation folder. */
export const DATA = `${FOLDER}/data`;
/** The conversation's database, as both sides' folders name it. */
export const INFINICHAT_DATABASE = 'infinichat.db';
/**
 * The bytes of one call of a copy, between progress reports. Each call keeps upstream's pipeline busy: writes of
 * 512 KiB and reads of 256 KiB, eight in flight (pi-env `remote-env.js`, which the phone's port matches).
 */
const CHUNK = 4 * 1024 * 1024;

export type Copied = { bytes: number; total: number };

/**
 * The transport of a move: the whole file in chunks, or a patch of the pages that changed since the receiver's copy
 * (`pages.ts`), run from the side that has the environment of the other: the phone for its moves, the target's
 * server for a move between machines (`pull`). The page commands run on the other machine with its server.
 */
/** Never shown: a move that can't patch copies the whole file, and a refresh changes nothing. */
const PATCH_FAILED = 'The patch failed.';
const COPY_INCOMPLETE = 'The SSH connection closed before the copy was complete.';

/** One copy's machine, through the environment the app borrows for it, and this device's files. */
export interface Copy {
  machine: ExecutionEnv;
  files: DatabaseFiles;
  signal: AbortSignal;
  /** The machine's name, for messages. */
  name: string;
  /** Where this device keeps a patch from the machine until it is applied, as `files` names it. */
  transfer: string;
}

/**
 * The lines that find the other machine's server and the Node that `server.json` says runs it (listen.ts), for the
 * page commands, and fail the script when either is missing: nothing here installs one.
 */
const SERVER_LINES = [`js="$HOME/${CURRENT}"`, '[ -f "$js" ]', `s="$HOME/${FOLDER}/server.json"`, `node=$(${NODE})`,
  '[ -n "$node" ]'];

const run = (copy: Copy, lines: string[], failure: string, timeout?: null) =>
  runScript(copy.machine, copy.signal, copy.name, lines, { failure, timeout });

/**
 * Removes a patch step's `inputs` from the machine's home however the step ended, with what the server's commands left
 * beside them and beside its `outputs`: a command writes `<file>.<pid>` and renames it into place, and `diff --live`
 * backs the database up to `<patch>.<pid>.db` (server/pages.ts). A command stopped by an abort, a timeout or a lost
 * connection dies by SIGKILL, so its own `finally` never removes them. Not awaited, as machine.ts's `discard`.
 */
function discardPatch(copy: Copy, inputs: string[], outputs: string[] = []) {
  const files = [...inputs.map((path) => `"$HOME/${path}"`),
    ...[...inputs, ...outputs].map((path) => `"$HOME/${path}".*`)];
  void copy.machine.exec(`rm -f ${files.join(' ')}`, undefined, BACKGROUND_CONTEXT);
}

/** Writes `bytes` to the machine's `path` a chunk at a time, reporting the bytes written so far. */
export async function copyTo(copy: Copy, path: string, bytes: Uint8Array, failure: string,
  onWritten: (bytes: number) => void) {
  const context = withAbortSignal(copy.signal, BACKGROUND_CONTEXT);
  for (let offset = 0; offset === 0 || offset < bytes.byteLength; offset += CHUNK) {
    const chunk = bytes.subarray(offset, offset + CHUNK);
    const written = offset === 0 ? await copy.machine.writeFile(path, chunk, context)
      : await copy.machine.appendFile(path, chunk, context);
    if (!written.ok) throw fileFailure(copy.signal, written.error, copy.name, failure);
    onWritten(offset + chunk.byteLength);
  }
}

/** Reads the machine's file at `path` into this device's file `name`, a chunk at a time, reporting its progress. */
export async function copyFrom(copy: Copy, path: string, name: string, onCopied: (copied: Copied) => void) {
  const { machine, signal } = copy;
  const context = withAbortSignal(signal, BACKGROUND_CONTEXT);
  const incomplete = () => {
    signal.throwIfAborted();
    return new Error(COPY_INCOMPLETE);
  };
  const writer = (await copy.files.open(name)).getWriter();
  let reader: BinaryReader | undefined;
  try {
    const opened = await machine.openBinaryReader(path, undefined, context);
    if (!opened.ok) throw incomplete();
    reader = opened.value;
    const info = await reader.info(context);
    if (!info.ok) throw incomplete();
    const total = info.value.size;
    for (let bytes = 0; bytes < total;) {
      const read = await reader.read(bytes, CHUNK, context);
      if (!read.ok) throw incomplete();
      // A file that shrank since it was opened fails the check of what arrived.
      if (read.value.byteLength === 0) break;
      await writer.write(read.value);
      bytes += read.value.byteLength;
      onCopied({ bytes, total });
    }
    await writer.close();
  } catch (error) {
    await writer.abort().catch(() => {});
    throw error;
  } finally {
    await reader?.close(BACKGROUND_CONTEXT);
  }
}

/**
 * Sends this device's database `from` as a patch against the machine's copy at `base`, which the machine applies,
 * verifies and renames to `out`: the copy's page list comes down, and the patch goes up as the whole file would. It
 * fails when the machine has no copy or no server. The page list and the patch wait in the machine's InfiniChat
 * folder, which the server being there shows to exist.
 */
export async function sendPatch(copy: Copy, from: string, base: string, out: string,
  onCopied: (copied: Copied) => void) {
  const list = temporary(FOLDER, 'pages');
  const patch = temporary(FOLDER, 'patch');
  try {
    await run(copy, [...SERVER_LINES, 'umask 077', `"$node" "$js" pages "$HOME/${base}" "$HOME/${list}"`, PRINT_MARKER],
      PATCH_FAILED, null);
    const listed = await copy.machine.readBinaryFile(`~/${list}`, withAbortSignal(copy.signal, BACKGROUND_CONTEXT));
    if (!listed.ok) throw fileFailure(copy.signal, listed.error, copy.name, PATCH_FAILED);
    const bytes = await diff(copy.files, from, new Uint8Array(listed.value));
    await copyTo(copy, `~/${patch}`, bytes, PATCH_FAILED,
      (written) => onCopied({ bytes: written, total: bytes.byteLength }));
    await run(copy, [...SERVER_LINES, 'umask 077', `mkdir -p "$(dirname "$HOME/${out}")"`,
      `"$node" "$js" patch "$HOME/${base}" "$HOME/${patch}" "$HOME/${out}"`, PRINT_MARKER], PATCH_FAILED, null);
  } finally {
    discardPatch(copy, [list, patch], [out]);
  }
}

/**
 * Brings this device's copy `base` up to the machine's database with a patch, applied, verified and renamed to `out`:
 * the page list goes up, the machine diffs (with `live`, a backup of the database it holds open), and the patch comes
 * down. It fails when the machine has no server, which it checks before writing into the machine's InfiniChat
 * folder.
 */
export async function receivePatch(copy: Copy, live: boolean, base: string, out: string,
  onCopied: (copied: Copied) => void) {
  const list = temporary(FOLDER, 'pages');
  const patch = temporary(FOLDER, 'patch');
  try {
    await run(copy, [...SERVER_LINES, PRINT_MARKER], PATCH_FAILED);
    const written = await copy.machine.writeFile(`~/${list}`, await pages(copy.files, base),
      withAbortSignal(copy.signal, BACKGROUND_CONTEXT));
    if (!written.ok) throw fileFailure(copy.signal, written.error, copy.name, PATCH_FAILED);
    await run(copy, [...SERVER_LINES, 'umask 077', `"$node" "$js" diff "$HOME/${DATA}/${INFINICHAT_DATABASE}" `
      + `"$HOME/${list}" "$HOME/${patch}"${live ? ' --live' : ''}`, PRINT_MARKER], PATCH_FAILED, null);
    await copyFrom(copy, `~/${patch}`, copy.transfer, onCopied);
    await apply(copy.files, base, await copy.files.read(copy.transfer), out);
  } finally {
    discardPatch(copy, [list, patch]);
    await copy.files.remove(copy.transfer);
  }
}
