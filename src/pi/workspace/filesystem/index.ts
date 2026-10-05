import type { SqliteDatabase } from '@earendil-works/pi-durable/storage/sqlite';
import type { BufferEncoding, ByteString, CpOptions, CreateExclusiveOptions, FileContent, IFileSystem, MkdirOptions, RmOptions } from 'just-bash';
import { metadata, statFor, write } from './content';
import { decode, encode, latin1 } from './encoding';
import { copyWorkspace, deleteWorkspace } from './lifecycle';
import * as namespace from './namespace';
import { existing, lexicalPath } from './paths';
import { bytesFor, children } from './records';
import { Store } from './store';
import { abortIfNeeded, fsError, limitsFor } from './types';
import type { NamespaceCache, Operation, ReadFileOptions, WorkspaceOptions, WriteFileOptions } from './types';

export { DEFAULT_WORKSPACE_LIMITS } from './types';
export type { WorkspaceLimits, WorkspaceOptions } from './types';

/** Async SQLite operations; only bounded namespace metadata is cached in JS. */
export class WorkspaceFileSystem implements IFileSystem {
  private owner: Store;
  readonly workspaceId: string;
  private cache: NamespaceCache;
  private options: WorkspaceOptions;
  private signal?: AbortSignal;
  private constructor(owner: Store, workspaceId: string, cache: NamespaceCache, options: WorkspaceOptions, signal?: AbortSignal) {
    this.owner = owner; this.workspaceId = workspaceId; this.cache = cache; this.options = options; this.signal = signal;
  }

  static async open(database: SqliteDatabase, workspaceId: string, options: WorkspaceOptions = {}): Promise<WorkspaceFileSystem> {
    const owner = Store.for(database);
    const fixedOptions = { limits: limitsFor(options), mountPath: options.mountPath ?? '/' };
    if (!fixedOptions.mountPath.startsWith('/')) throw fsError('EINVAL', fixedOptions.mountPath, 'mount must be absolute');
    fixedOptions.mountPath = lexicalPath('/', fixedOptions.mountPath, fixedOptions.limits);
    return new WorkspaceFileSystem(owner, workspaceId, await owner.open(workspaceId, fixedOptions), fixedOptions);
  }
  static copyWorkspace = copyWorkspace;
  static deleteWorkspace = deleteWorkspace;

  /** Cancellation belongs to one invocation, never to a shared workspace instance. */
  forInvocation(signal: AbortSignal): WorkspaceFileSystem {
    return new WorkspaceFileSystem(this.owner, this.workspaceId, this.cache, this.options, signal);
  }
  drain(): Promise<void> { return this.owner.drain(); }
  async refresh(): Promise<void> {
    abortIfNeeded(this.signal);
    const cache = await this.owner.open(this.workspaceId, this.options, false);
    if (cache.root !== this.cache.root) throw fsError('ESTALE', this.workspaceId, 'workspace was replaced');
    this.cache = cache;
  }
  private run<T>(mutation: boolean, work: (op: Operation) => Promise<T>, allocation = 0): Promise<T> {
    try { return this.owner.run(this.workspaceId, this.options, this.signal, mutation, work, this.cache.root, allocation); }
    catch (error) { return Promise.reject(error); }
  }
  readFileBuffer(path: string): Promise<Uint8Array> {
    return this.run(false, async (op) => bytesFor(op, (await existing(op, path)).inode));
  }
  async readFile(path: string, options?: ReadFileOptions | BufferEncoding): Promise<string> {
    return decode(await this.readFileBuffer(path), options);
  }
  async readFileBytes(path: string): Promise<ByteString> {
    return latin1(await this.readFileBuffer(path)) as unknown as ByteString;
  }
  async writeFile(path: string, content: FileContent, options?: WriteFileOptions | BufferEncoding): Promise<void> {
    abortIfNeeded(this.signal);
    const bytes = encode(content, options, limitsFor(this.options).maxFileBytes);
    return this.run(true, (op) => write(op, path, bytes, false), bytes.length);
  }
  async appendFile(path: string, content: FileContent, options?: WriteFileOptions | BufferEncoding): Promise<void> {
    abortIfNeeded(this.signal);
    const bytes = encode(content, options, limitsFor(this.options).maxFileBytes);
    return this.run(true, (op) => write(op, path, bytes, true), bytes.length);
  }
  exists(path: string): Promise<boolean> {
    return this.run(false, async (op) => {
      try { await existing(op, path); return true; }
      catch (error) { if (['ENOENT', 'ENOTDIR', 'ELOOP'].includes((error as { code?: string } | null)?.code ?? '')) return false; throw error; }
    });
  }
  stat(path: string) { return this.run(false, async (op) => statFor((await existing(op, path)).inode)); }
  lstat(path: string) { return this.run(false, async (op) => statFor((await existing(op, path, false)).inode)); }
  mkdir(path: string, options?: MkdirOptions): Promise<void> { return this.run(true, (op) => namespace.mkdir(op, path, options)); }
  createExclusive(path: string, options: CreateExclusiveOptions): Promise<void> { return this.run(true, (op) => namespace.createExclusive(op, path, options)); }
  readdir(path: string): Promise<string[]> {
    return this.run(false, async (op) => {
      const node = (await existing(op, path)).inode;
      if (node.kind !== 'directory') throw fsError('ENOTDIR', path);
      return (await children(op, node.id)).map((entry) => entry.name);
    });
  }
  readdirWithFileTypes(path: string) {
    return this.run(false, async (op) => {
      const node = (await existing(op, path)).inode;
      if (node.kind !== 'directory') throw fsError('ENOTDIR', path);
      const rows = await op.sql.all<{ name: string; kind: string }>('SELECT e.name,i.kind FROM entries e JOIN inodes i ON i.workspace_id=e.workspace_id AND i.id=e.inode WHERE e.workspace_id=? AND e.parent=? ORDER BY e.name', op.workspace, node.id);
      return rows.map((row) => ({ name: row.name, isFile: row.kind === 'file', isDirectory: row.kind === 'directory', isSymbolicLink: row.kind === 'symlink' }));
    });
  }
  rm(path: string, options?: RmOptions): Promise<void> { return this.run(true, (op) => namespace.rm(op, path, options)); }
  cp(source: string, destination: string, options?: CpOptions): Promise<void> { return this.run(true, (op) => namespace.cp(op, source, destination, options)); }
  mv(source: string, destination: string): Promise<void> { return this.run(true, (op) => namespace.mv(op, source, destination)); }
  chmod(path: string, mode: number): Promise<void> { return this.run(true, (op) => metadata(op, path, mode)); }
  utimes(path: string, _atime: Date, mtime: Date): Promise<void> { return this.run(true, (op) => metadata(op, path, undefined, mtime)); }
  symlink(target: string, path: string): Promise<void> { return this.run(true, (op) => namespace.link(op, target, path, true)); }
  link(target: string, path: string): Promise<void> { return this.run(true, (op) => namespace.link(op, target, path, false)); }
  readlink(path: string): Promise<string> {
    return this.run(false, async (op) => {
      const node = (await existing(op, path, false)).inode;
      if (node.kind !== 'symlink') throw fsError('EINVAL', path, 'not a symbolic link');
      return node.target!;
    });
  }
  realpath(path: string): Promise<string> { return this.run(false, async (op) => (await existing(op, path)).path); }
  resolvePath(base: string, path: string): string { return lexicalPath(base, path, limitsFor(this.options)); }
  getAllPaths(): string[] {
    abortIfNeeded(this.signal);
    const byParent = new Map<number, { name: string; inode: number }[]>();
    for (const entry of this.cache.entries.values()) {
      const group = byParent.get(entry.parent) ?? [];
      group.push(entry); byParent.set(entry.parent, group);
    }
    const paths = ['/'];
    const pending = [{ inode: this.cache.root, path: '' }];
    while (pending.length) {
      const next = pending.pop()!;
      for (const entry of byParent.get(next.inode) ?? []) {
        const path = `${next.path}/${entry.name}`;
        paths.push(path);
        if (byParent.has(entry.inode)) pending.push({ inode: entry.inode, path });
      }
    }
    return paths;
  }
}
