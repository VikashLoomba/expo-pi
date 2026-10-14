// Adapted from Pi Env 1.2.0 list-files.ts (MIT): `listFilesOver` over the app's SSH-backed connection.
import type { Context } from '@earendil-works/chord';
import {
  err, FileError, ok, type FileKind, type FileListEntry, type FileListing, type ListFilesOptions, type Result,
} from '@earendil-works/pi-durable/env';
import { Buffer } from 'buffer';

import type { Connection } from './connection';
import { abortResult, toFileError } from './errors';

/** Kind bytes of `listFiles` records: `f`, `d`, `l`. */
const KINDS: Partial<Record<number, FileKind>> = { 102: 'file', 100: 'directory', 108: 'symlink' };

/**
 * `listFiles` of an absolute path through the daemon: fails with `not_supported` if the daemon does not list files
 * (a release before `listFiles`), so callers fall back to their own walk.
 */
export async function listFilesOver(
  connection: Connection,
  path: string,
  options: ListFilesOptions | undefined,
  context: Context,
): Promise<Result<FileListing, FileError>> {
  for (const key of ['maxEntries', 'maxBytes', 'timeoutMs'] as const) {
    const value = options?.[key];
    if (value !== undefined && (!Number.isSafeInteger(value) || value < 0)) {
      return err(new FileError('invalid', `${key} must be a non-negative safe integer`, path));
    }
  }
  const aborted = abortResult<FileListing>(context.abortSignal, path);
  if (aborted) return aborted;
  try {
    if (!(await connection.info()).features?.includes('listFiles')) {
      return err(new FileError('not_supported', 'The pi-env daemon does not list files; update it', path));
    }
    const { json, payload } = await connection.request(
      'listFiles',
      // Fields left undefined are not sent; the daemon applies the defaults.
      {
        path,
        hidden: options?.hidden,
        gitignore: options?.gitignore,
        exclude: options?.exclude,
        maxEntries: options?.maxEntries,
        maxBytes: options?.maxBytes,
        timeoutMs: options?.timeoutMs,
      },
      context.abortSignal ? { signal: context.abortSignal } : {},
    );
    const afterAbort = abortResult<FileListing>(context.abortSignal, path);
    if (afterAbort) return afterAbort;
    // Records of a kind byte, the UTF-8 path, and a NUL.
    const entries: FileListEntry[] = [];
    const bytes = Buffer.from(payload.buffer, payload.byteOffset, payload.length);
    for (let start = 0; start < bytes.length; ) {
      const end = bytes.indexOf(0, start);
      if (end === -1) break;
      const kind = KINDS[bytes[start]];
      if (kind !== undefined) entries.push({ path: bytes.toString('utf8', start + 1, end), kind });
      start = end + 1;
    }
    return ok({ entries, truncated: json.truncated === true });
  } catch (error) {
    return err(toFileError(error, path));
  }
}
