export type EntryKind = 'file' | 'directory';

export interface Entry {
  readonly kind: EntryKind;
  /** File length in bytes; 0 for a directory. */
  readonly size: number;
  readonly mtimeMs: number;
}

/** Positional reads from one opened file; it keeps reading that file after a rename. */
export interface ByteReader {
  size(): Promise<number>;
  /** Up to `length` bytes at `offset`; an empty array at or past the end. */
  read(offset: number, length: number): Promise<Uint8Array>;
  close(): Promise<void>;
}

/**
 * The files of one directory of a workspace. Paths are absolute and normalized inside it, such as `/` and
 * `/notes/a.txt`. Methods throw on failure; callers check existence and kinds first so every platform reports the same
 * error codes.
 */
export interface WorkspaceStorage {
  info(path: string): Promise<Entry | undefined>;
  /** Names of a directory's entries. */
  list(path: string): Promise<string[]>;
  read(path: string): Promise<Uint8Array>;
  open(path: string): Promise<ByteReader>;
  /** Create, replace or append to a file whose parent directory exists. */
  write(path: string, bytes: Uint8Array, append: boolean): Promise<void>;
  /** Create one directory whose parent exists; fails when the path exists, which keeps temporary names unique. */
  createDirectory(path: string): Promise<void>;
  /** Remove a file, or a directory with everything in it. */
  remove(path: string): Promise<void>;
  /** Rename a file, replacing a file at the destination, or a directory to a path that does not exist. */
  move(source: string, destination: string): Promise<void>;
  /** Copy a file, replacing a file at the destination. */
  copyFile(source: string, destination: string): Promise<void>;
}

/** A workspace's own files and its temporary directory, which nothing deletes and the system may purge. */
export interface Workspace {
  readonly files: WorkspaceStorage;
  readonly temp: WorkspaceStorage;
}

/** The directories that hold one directory per workspace. */
export interface Workspaces {
  /** A workspace's directories, creating each one that does not exist. */
  workspace(id: string): Workspace;
}

/** Workspace ids name directories, so only plain names are accepted. */
export function workspaceDirectoryName(id: string): string {
  if (!/^[A-Za-z0-9][A-Za-z0-9-]*$/.test(id)) throw new Error('Invalid workspace id.');
  return id;
}
