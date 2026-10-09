import { Buffer } from 'buffer';
import type {
  BufferEncoding, CpOptions, CreateExclusiveOptions, FileContent, FsStat, IFileSystem, MkdirOptions, RmOptions,
} from 'just-bash/browser';

import type { EntryKind, WorkspaceStorage } from './storage';

type Errno = 'ENOENT' | 'EEXIST' | 'EISDIR' | 'ENOTDIR' | 'ENOTEMPTY' | 'EINVAL' | 'EBUSY' | 'ENOTSUP';
type EncodingOptions = Parameters<IFileSystem['readFile']>[1] | Parameters<IFileSystem['writeFile']>[2];

const DESCRIPTIONS: Record<Errno, string> = {
  ENOENT: 'no such file or directory',
  EEXIST: 'file already exists',
  EISDIR: 'illegal operation on a directory',
  ENOTDIR: 'not a directory',
  ENOTEMPTY: 'directory not empty',
  EINVAL: 'invalid argument',
  EBUSY: 'a mount point cannot be removed or moved',
  ENOTSUP: 'operation not supported in the workspace',
};

/** Shaped like Node's file errors, whose message prefix just-bash commands match. */
export class WorkspaceFsError extends Error {
  constructor(readonly code: Errno, operation: string, path: string, description = DESCRIPTIONS[code]) {
    super(`${code}: ${description}, ${operation} '${path}'`);
  }
}

/** Collapse `.`, `..` and repeated separators. An absolute path never climbs above `/`. */
export function normalizePath(path: string): string {
  const absolute = path.startsWith('/');
  const parts: string[] = [];
  for (const part of path.split('/')) {
    if (part === '' || part === '.') continue;
    if (part !== '..') parts.push(part);
    else if (parts.length > 0 && parts[parts.length - 1] !== '..') parts.pop();
    else if (!absolute) parts.push(part);
  }
  const joined = parts.join('/');
  return absolute ? `/${joined}` : joined || '.';
}

export function resolvePath(base: string, path: string): string {
  return normalizePath(path.startsWith('/') ? path : `${base}/${path}`);
}

function parentOf(path: string): string {
  return path.slice(0, path.lastIndexOf('/')) || '/';
}

function childOf(directory: string, name: string): string {
  return directory === '/' ? `/${name}` : `${directory}/${name}`;
}

function encodingOf(options: EncodingOptions): BufferEncoding {
  const encoding = typeof options === 'string' ? options : options?.encoding;
  return encoding ?? 'utf8';
}

function encode(content: FileContent, options: EncodingOptions): Uint8Array {
  return typeof content === 'string' ? Buffer.from(content, encodingOf(options)) : content;
}

/**
 * One directory of a workspace as just-bash sees it, mounted at `/workspace` or `/tmp`, and the file operations the
 * execution environment uses. Paths are normalized and relative to the mount. The directory has no symbolic links,
 * hard links or permission bits.
 */
export class WorkspaceFs implements IFileSystem {
  constructor(private readonly storage: WorkspaceStorage, private readonly mountPoint: string) {}

  #fail(code: Errno, operation: string, path: string): never {
    throw new WorkspaceFsError(code, operation, path === '/' ? this.mountPoint : `${this.mountPoint}${path}`);
  }

  async #kindOf(path: string): Promise<EntryKind | undefined> {
    return (await this.storage.info(path))?.kind;
  }

  async #kind(path: string, operation: string): Promise<EntryKind> {
    return await this.#kindOf(path) ?? this.#fail('ENOENT', operation, path);
  }

  /** The parent of a path about to be created must be an existing directory. */
  async #requireParent(path: string, operation: string): Promise<void> {
    if (path === '/') this.#fail('EEXIST', operation, path);
    const parent = await this.#kindOf(parentOf(path));
    if (!parent) this.#fail('ENOENT', operation, path);
    if (parent !== 'directory') this.#fail('ENOTDIR', operation, path);
  }

  async #store(path: string, bytes: Uint8Array, append: boolean, operation: string): Promise<void> {
    const existing = await this.storage.info(path);
    if (existing?.kind === 'directory') this.#fail('EISDIR', operation, path);
    if (!existing) await this.#requireParent(path, operation);
    await this.storage.write(path, bytes, append);
  }

  async #copy(source: string, destination: string, kind: EntryKind): Promise<void> {
    const target = await this.#kindOf(destination);
    if (kind === 'file') {
      if (target === 'directory') this.#fail('EISDIR', 'cp', destination);
      if (!target) await this.#requireParent(destination, 'cp');
      await this.storage.copyFile(source, destination);
      return;
    }
    if (target && target !== 'directory') this.#fail('ENOTDIR', 'cp', destination);
    if (!target) {
      await this.#requireParent(destination, 'cp');
      await this.storage.createDirectory(destination);
    }
    for (const name of await this.storage.list(source)) {
      const child = childOf(source, name);
      const childKind = await this.#kindOf(child);
      if (childKind) await this.#copy(child, childOf(destination, name), childKind);
    }
  }

  async readFile(path: string, options?: Parameters<IFileSystem['readFile']>[1]): Promise<string> {
    const bytes = await this.readFileBuffer(path);
    return Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength).toString(encodingOf(options));
  }

  async readFileBuffer(path: string): Promise<Uint8Array> {
    if (await this.#kind(path, 'open') === 'directory') this.#fail('EISDIR', 'read', path);
    return this.storage.read(path);
  }

  writeFile(path: string, content: FileContent, options?: Parameters<IFileSystem['writeFile']>[2]): Promise<void> {
    return this.#store(path, encode(content, options), false, 'open');
  }

  appendFile(path: string, content: FileContent, options?: Parameters<IFileSystem['appendFile']>[2]): Promise<void> {
    return this.#store(path, encode(content, options), true, 'append');
  }

  async exists(path: string): Promise<boolean> {
    return (await this.#kindOf(path)) !== undefined;
  }

  async stat(path: string): Promise<FsStat> {
    const entry = await this.storage.info(path) ?? this.#fail('ENOENT', 'stat', path);
    const directory = entry.kind === 'directory';
    return { isFile: !directory, isDirectory: directory, isSymbolicLink: false, mode: directory ? 0o755 : 0o644,
      size: entry.size, mtime: new Date(entry.mtimeMs) };
  }

  /** Nothing in the workspace is a symbolic link. */
  lstat(path: string): Promise<FsStat> {
    return this.stat(path);
  }

  async mkdir(path: string, options?: MkdirOptions): Promise<void> {
    if (!options?.recursive) {
      if (await this.#kindOf(path)) this.#fail('EEXIST', 'mkdir', path);
      await this.#requireParent(path, 'mkdir');
      await this.storage.createDirectory(path);
      return;
    }
    let current = '';
    for (const part of path.split('/').filter(Boolean)) {
      current = `${current}/${part}`;
      const kind = await this.#kindOf(current);
      if (!kind) await this.storage.createDirectory(current);
      else if (kind !== 'directory') this.#fail(current === path ? 'EEXIST' : 'ENOTDIR', 'mkdir', path);
    }
  }

  async createExclusive(path: string, options: CreateExclusiveOptions): Promise<void> {
    if (await this.#kindOf(path)) this.#fail('EEXIST', 'open', path);
    await this.#requireParent(path, 'open');
    if (options.directory) await this.storage.createDirectory(path);
    else await this.storage.write(path, new Uint8Array(0), false);
  }

  async readdir(path: string): Promise<string[]> {
    if (await this.#kind(path, 'scandir') !== 'directory') this.#fail('ENOTDIR', 'scandir', path);
    return this.storage.list(path);
  }

  async rm(path: string, options?: RmOptions): Promise<void> {
    if (path === '/') this.#fail('EBUSY', 'rm', path);
    const kind = await this.#kindOf(path);
    if (!kind) {
      if (options?.force) return;
      this.#fail('ENOENT', 'rm', path);
    }
    if (kind === 'directory' && !options?.recursive && (await this.storage.list(path)).length > 0) {
      this.#fail('ENOTEMPTY', 'rm', path);
    }
    await this.storage.remove(path);
  }

  async cp(source: string, destination: string, options?: CpOptions): Promise<void> {
    const kind = await this.#kind(source, 'cp');
    if (kind === 'directory' && !options?.recursive) this.#fail('EISDIR', 'cp', source);
    if (destination === source || destination.startsWith(`${source}/`) || destination === '/') {
      this.#fail('EINVAL', 'cp', destination);
    }
    await this.#copy(source, destination, kind);
  }

  /** Like rename(2): a file replaces a file, and a directory replaces an empty directory. */
  async mv(source: string, destination: string): Promise<void> {
    if (source === '/' || destination === '/') this.#fail('EBUSY', 'mv', source);
    const kind = await this.#kind(source, 'mv');
    if (source === destination) return;
    if (kind === 'directory' && destination.startsWith(`${source}/`)) this.#fail('EINVAL', 'mv', destination);
    const target = await this.#kindOf(destination);
    if (target) {
      if (kind === 'directory' && target !== 'directory') this.#fail('ENOTDIR', 'mv', destination);
      if (kind === 'file' && target === 'directory') this.#fail('EISDIR', 'mv', destination);
      if (target === 'directory') {
        if ((await this.storage.list(destination)).length > 0) this.#fail('ENOTEMPTY', 'mv', destination);
        // expo-file-system moves a directory into an existing directory instead of replacing it.
        await this.storage.remove(destination);
      }
    } else {
      await this.#requireParent(destination, 'mv');
    }
    await this.storage.move(source, destination);
  }

  resolvePath(base: string, path: string): string {
    return resolvePath(base, path);
  }

  /** just-bash allows an empty list; nothing in it depends on enumerating the directory. */
  getAllPaths(): string[] {
    return [];
  }

  async chmod(path: string): Promise<void> {
    this.#fail('ENOTSUP', 'chmod', path);
  }

  async symlink(_target: string, path: string): Promise<void> {
    this.#fail('ENOTSUP', 'symlink', path);
  }

  async link(_existing: string, path: string): Promise<void> {
    this.#fail('ENOTSUP', 'link', path);
  }

  async readlink(path: string): Promise<string> {
    await this.#kind(path, 'readlink');
    return this.#fail('EINVAL', 'readlink', path);
  }

  async realpath(path: string): Promise<string> {
    await this.#kind(path, 'realpath');
    return path;
  }

  /** The platform API cannot set times, so `touch` on an existing file leaves it unchanged. */
  async utimes(path: string): Promise<void> {
    await this.#kind(path, 'utime');
  }
}
