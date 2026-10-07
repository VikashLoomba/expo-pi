import type { Context } from '@earendil-works/chord';
import { BACKGROUND_CONTEXT, withAbortSignal } from '@earendil-works/chord/context';
import { uuidv7 } from '@earendil-works/pi-ai';
import {
  ExecutionError, FileError, LineScanner, err, ok, toError,
  type BinaryReader, type DirReader, type ExecutionEnv, type FileErrorCode, type FileInfo, type FileWatcher,
  type Result, type ShellExecOptions, type ShellExecResult, type TextLineReader, type WatchChange, type WatchTarget,
} from '@earendil-works/pi-durable/env';
import type { FsStat } from 'just-bash';
import { executeWorkspaceCommand } from '../bash/execution';
import type { BoundedSystemFs } from './bounded-system-fs';
import { createPathResolver, joinVirtualPath, validateVirtualPath } from './mounted-paths';
import type { WorkspaceInvocation, WorkspaceRuntime } from './runtime';

const HOME = '/workspace';
const READ_CHUNK = 64 * 1024;
const MAX_READERS = 64;
const encoder = new TextEncoder();
const decoder = new TextDecoder();
type Invocation = Pick<WorkspaceInvocation, 'mounted' | 'signal'> & Partial<WorkspaceInvocation>;
type Owner = { runtime: WorkspaceRuntime; workspaceId: string };

function fileError(cause: unknown, path?: string): FileError {
  if (cause instanceof FileError) return cause;
  const error = toError(cause);
  const errno = (cause as { code?: string } | null)?.code ?? /^([A-Z_]+):/.exec(error.message)?.[1];
  const codes: Record<string, FileErrorCode> = {
    ABORT_ERR: 'aborted', ENOENT: 'not_found', EACCES: 'permission_denied', EPERM: 'permission_denied',
    ENOTDIR: 'not_directory', EISDIR: 'is_directory', EINVAL: 'invalid', ENAMETOOLONG: 'invalid',
    ELOOP: 'invalid', EEXIST: 'invalid', ENOTEMPTY: 'invalid', EBUSY: 'invalid',
    ENOSYS: 'not_supported', ENOTSUP: 'not_supported', EXDEV: 'not_supported',
  };
  return new FileError(codes[errno ?? ''] ?? 'unknown', error.message, path, error);
}

/** Preserve every leading BOM; edits require valid UTF-8 rather than lossy decoding. */
function strictText(bytes: Uint8Array, path: string): string {
  let prefix = 0;
  while (bytes[prefix] === 0xef && bytes[prefix + 1] === 0xbb && bytes[prefix + 2] === 0xbf) prefix += 3;
  const body = bytes.subarray(prefix);
  const text = decoder.decode(body);
  const encoded = encoder.encode(text);
  if (encoded.length !== body.length || encoded.some((byte, index) => byte !== body[index])) {
    throw new FileError('invalid', 'File is not valid UTF-8 text.', path);
  }
  return '\ufeff'.repeat(prefix / 3) + text;
}

function joinParts(parts: string[]): string {
  for (const part of parts) if (part) validateVirtualPath(part);
  const joined = parts.filter(Boolean).join('/');
  if (!joined) return '.';
  validateVirtualPath(joined);
  const absolute = joined.startsWith('/');
  const result: string[] = [];
  for (const part of joined.split('/')) {
    if (!part || part === '.') continue;
    if (part === '..' && result.length && result[result.length - 1] !== '..') result.pop();
    else if (part !== '..' || !absolute) result.push(part);
  }
  return `${absolute ? '/' : ''}${result.join('/')}` || '.';
}

function parentPath(path: string): string {
  const withoutTrailingSlash = path.replace(/\/+$/, '');
  return withoutTrailingSlash.slice(0, withoutTrailingSlash.lastIndexOf('/')) || '/';
}

function infoFor(path: string, stat: FsStat): FileInfo {
  return {
    name: path.replace(/\/+$/, '').split('/').pop() ?? '', path,
    kind: stat.isSymbolicLink ? 'symlink' : stat.isDirectory ? 'directory' : 'file',
    size: stat.size, mtimeMs: stat.mtime.getTime(),
  };
}

/**
 * A cwd view of runtime-owned workspace files. Direct operations take short leases;
 * tool scopes hold one lease across their compound filesystem operations.
 */
export class WorkspaceExecutionEnv implements ExecutionEnv {
  readonly id: string;
  readonly cwd: string;
  private closed = false;
  private readonly lifetime = new AbortController();
  private readonly readers = new Set<() => Promise<void>>();
  private readonly scopes = new Set<() => Promise<void>>();
  private readonly pending = new Set<Promise<unknown>>();
  private disown?: () => void;
  private closing?: Promise<void>;
  private readonly invocation?: Invocation;
  private readonly owner?: Owner;

  constructor(source: Invocation | Owner, cwd = HOME) {
    if ('runtime' in source) this.owner = source;
    else this.invocation = source;
    this.id = 'runtime' in source ? source.runtime.namespaceId(source.workspaceId) : source.id ?? `workspace-env:${uuidv7()}`;
    this.cwd = cwd;
  }

  private active(context: Context, path?: string): void {
    if (this.closed || this.owner?.runtime.isStopped || this.lifetime.signal.aborted || context.abortSignal?.aborted || this.invocation?.signal.aborted) {
      const reason = context.abortSignal?.reason ?? this.invocation?.signal.reason ?? this.lifetime.signal.reason;
      throw new FileError('aborted', 'Workspace operation was aborted or its environment is closed.', path, reason instanceof Error ? reason : undefined);
    }
  }

  private own(): void {
    if (!this.owner || this.disown) return;
    this.disown = this.owner.runtime.own({
      stop: (reason) => { this.closed = true; this.lifetime.abort(reason); },
      close: () => this.cleanup(BACKGROUND_CONTEXT),
    });
  }

  private track<T>(operation: Promise<T>): Promise<T> {
    this.pending.add(operation);
    const finished = () => { this.pending.delete(operation); };
    operation.then(finished, finished);
    return operation;
  }

  private resolve(path: string): string {
    const expanded = path === '~' ? HOME : path.startsWith('~/') ? `${HOME}/${path.slice(2)}` : path;
    return joinVirtualPath(this.cwd, expanded);
  }

  /** The subscription lives until its operation or acquired scope has drained. */
  private cancellation(context: Context): { signal: AbortSignal; dispose(): void } {
    const controller = new AbortController();
    const signals = [context.abortSignal, this.lifetime.signal].filter((signal): signal is AbortSignal => !!signal);
    const forward = () => {
      const aborted = signals.find((signal) => signal.aborted);
      if (aborted) controller.abort(aborted.reason);
    };
    for (const signal of signals) signal.addEventListener('abort', forward, { once: true });
    forward();
    return {
      signal: controller.signal,
      dispose: () => { for (const signal of signals) signal.removeEventListener('abort', forward); },
    };
  }

  private async lease<T>(context: Context, work: (invocation: Invocation) => Promise<T>): Promise<T> {
    this.active(context);
    if (this.invocation) return work(this.invocation);
    this.own();
    const cancellation = this.cancellation(context);
    try {
      return await this.owner!.runtime.run(this.owner!.workspaceId, cancellation.signal, work);
    } finally { cancellation.dispose(); }
  }

  private operation<T>(path: string | undefined, context: Context, work: (invocation: Invocation) => T | Promise<T>): Promise<Result<T, FileError>> {
    return this.track((async () => {
      try {
        const value = await this.lease(context, async (invocation) => {
          this.active(context, path);
          const result = await work(invocation);
          this.active(context, path);
          return result;
        });
        return ok(value);
      } catch (cause) {
        try { this.active(context, path); } catch (aborted) { return err(fileError(aborted, path)); }
        return err(fileError(cause, path));
      }
    })());
  }

  /** Until a handle is delivered, every admitted allocation still belongs to the opener. */
  private resourceOperation<T>(path: string, context: Context,
    work: (invocation: Invocation, rollback: (dispose: () => Promise<void>) => void) => Promise<T>): Promise<Result<T, FileError>> {
    return this.track((async () => {
      const disposals: (() => Promise<void>)[] = [];
      let result = await this.operation(path, context, (invocation) => work(invocation, (dispose) => disposals.push(dispose)));
      if (result.ok) {
        try { this.active(context, path); }
        catch (cause) { result = err(fileError(cause, path)); }
      }
      if (!result.ok) {
        // Cleanup is independent of the cancelled operation context and remains
        // part of this tracked open until all pins and reader slots are released.
        await Promise.allSettled(disposals.reverse().map((dispose) => dispose()));
      }
      return result;
    })());
  }

  /** Metadata methods do not acquire a database, a queue, or a temporary tree. */
  private async metadata<T>(path: string | undefined, context: Context, work: () => T): Promise<Result<T, FileError>> {
    try { this.active(context, path); return ok(work()); }
    catch (cause) { return err(fileError(cause, path)); }
  }
  absolutePath(path: string, context: Context) { return this.metadata(path, context, () => this.resolve(path)); }
  joinPath(parts: string[], context: Context) { return this.metadata(undefined, context, () => joinParts(parts)); }
  readBinaryFile(path: string, context: Context) {
    return this.operation(path, context, ({ mounted }) => mounted.readFileBuffer(this.resolve(path)));
  }
  readTextFile(path: string, context: Context) {
    return this.operation(path, context, async ({ mounted }) => strictText(await mounted.readFileBuffer(this.resolve(path)), path));
  }

  private readerClose(dispose: () => void | Promise<void>): () => Promise<void> {
    if (this.readers.size >= MAX_READERS) throw new FileError('invalid', `An environment may own at most ${MAX_READERS} open readers.`);
    let closing: Promise<void> | undefined;
    const close = () => {
      if (!closing) {
        this.readers.delete(close);
        closing = this.track(Promise.resolve().then(dispose));
      }
      return closing;
    };
    this.readers.add(close);
    return close;
  }

  openBinaryReader(path: string, options: { noFollow?: boolean } | undefined, context: Context): Promise<Result<BinaryReader, FileError>> {
    return this.resourceOperation(path, context, async (invocation, rollback) => {
      const lexical = this.resolve(path);
      const stat = await invocation.mounted.lstat(lexical);
      if (options?.noFollow && stat.isSymbolicLink) throw new FileError('invalid', 'The final component is a symbolic link.', path);
      const physical = await invocation.mounted.realpath(lexical);
      const original = await invocation.mounted.stat(physical);
      if (original.isDirectory) throw new FileError('is_directory', 'Cannot open a directory as a binary file.', path);
      if (!original.isFile) throw new FileError('invalid', 'Only regular files can be opened.', path);
      const inode = physical.startsWith(`${HOME}/`) && invocation.files && original.ino !== undefined ? Number(original.ino) : undefined;
      let releaseInode: (() => Promise<void>) | undefined;
      let temporary: Awaited<ReturnType<BoundedSystemFs['openReadHandle']>> | undefined;
      let close: (() => Promise<void>) | undefined;
      let closed = false;
      const dispose = async () => {
        closed = true;
        try { await temporary?.close(); }
        finally { await releaseInode?.(); }
      };
      rollback(async () => { if (close) await close(); else await dispose(); });
      releaseInode = inode !== undefined ? await invocation.files!.retainOpenedInode(inode) : undefined;
      temporary = !physical.startsWith(`${HOME}/`) ? await invocation.system?.openReadHandle(physical) : undefined;
      close = this.readerClose(dispose);
      const check = () => { if (closed) throw new FileError('invalid', 'Binary reader is closed.', path); };
      const locate = async (current: Invocation) => {
        // Legacy mounted-only callers still retain identity through rename.
        for (const candidate of [physical, ...current.mounted.getAllPaths()]) {
          try { if ((await current.mounted.lstat(candidate)).identity === original.identity) return candidate; }
          catch (cause) { if (fileError(cause).code !== 'not_found') throw cause; }
        }
        throw new FileError('not_found', 'The opened file is no longer available.', path);
      };
      const read = async (current: Invocation, offset: number, length: number) => {
        if (inode !== undefined) return current.files!.readInodeRange(inode, offset, length);
        if (temporary) return temporary.read(offset, length);
        return (await current.mounted.readFileBuffer(await locate(current))).slice(offset, offset + length);
      };
      return {
        info: (readContext) => this.operation(path, readContext, async (current) => {
          check();
          const stat = inode !== undefined ? await current.files!.statInode(inode)
            : temporary ? await temporary.info() : await current.mounted.stat(await locate(current));
          return infoFor(lexical, stat);
        }),
        read: (offset, length, readContext) => this.operation(path, readContext, async (current) => {
          check();
          if (!Number.isSafeInteger(offset) || offset < 0 || !Number.isSafeInteger(length) || length < 0) {
            throw new FileError('invalid', 'Read offset and length must be non-negative safe integers.', path);
          }
          return read(current, offset, length);
        }),
        scanLines: (scan, readContext) => this.operation(path, readContext, async (current) => {
          check();
          let scanner: LineScanner;
          try { scanner = new LineScanner(scan.startLine, scan.endLine); }
          catch (cause) { throw new FileError('invalid', toError(cause).message, path); }
          for (let offset = 0; ; offset += READ_CHUNK) {
            this.active(readContext, path);
            const chunk = await read(current, offset, READ_CHUNK);
            if (!chunk.length) break;
            scanner.push(chunk);
          }
          return scanner.finish();
        }),
        close: async () => { await close!(); },
      } satisfies BinaryReader;
    });
  }

  openTextLineReader(path: string, context: Context): Promise<Result<TextLineReader, FileError>> {
    return this.track((async () => {
      const opened = await this.openBinaryReader(path, undefined, context);
      if (!opened.ok) return opened;
      try { this.active(context, path); }
      catch (cause) { await opened.value.close(BACKGROUND_CONTEXT); return err(fileError(cause, path)); }
      let offset = 0;
      let closed = false;
      return ok({
        readLine: async (readContext) => {
          if (closed) return err(new FileError('invalid', 'Text line reader is closed.', path));
          // A single line can reach the local file ceiling, but no whole-file copy is retained.
          const chunks: Uint8Array[] = [];
          let size = 0;
          let terminated = false;
          while (true) {
            const result = await opened.value.read(offset, READ_CHUNK, readContext);
            if (!result.ok) return result;
            const bytes = result.value;
            const newline = bytes.indexOf(10);
            const end = newline < 0 ? bytes.length : newline;
            if (end) { chunks.push(bytes.slice(0, end)); size += end; }
            offset += end;
            if (newline >= 0) { offset++; terminated = true; break; }
            if (bytes.length < READ_CHUNK) break;
          }
          if (!size && !terminated) return ok(undefined);
          const bytes = new Uint8Array(size);
          let cursor = 0;
          for (const chunk of chunks) { bytes.set(chunk, cursor); cursor += chunk.length; }
          try { return ok({ text: strictText(bytes, path), terminated }); }
          catch (cause) { return err(fileError(cause, path)); }
        },
        close: async (closeContext) => { closed = true; await opened.value.close(closeContext); },
      });
    })());
  }

  async readTextLines(path: string, options: { maxLines?: number } | undefined, context: Context): Promise<Result<string[], FileError>> {
    const maximum = options?.maxLines;
    if (maximum !== undefined && (!Number.isSafeInteger(maximum) || maximum < 0)) return err(new FileError('invalid', 'maxLines must be a non-negative safe integer.', path));
    const opened = await this.openTextLineReader(path, context);
    if (!opened.ok) return opened;
    const lines: string[] = [];
    try {
      while (maximum === undefined || lines.length < maximum) {
        const line = await opened.value.readLine(context);
        if (!line.ok) return line;
        if (line.value === undefined) break;
        lines.push(line.value.text);
      }
      return ok(lines);
    } finally { await opened.value.close(context); }
  }

  private write(path: string, content: string | Uint8Array, append: boolean, context: Context) {
    return this.operation(path, context, async ({ mounted }) => {
      const resolved = this.resolve(path);
      await mounted.mkdir(parentPath(resolved), { recursive: true });
      this.active(context, path);
      if (append) await mounted.appendFile(resolved, content);
      else await mounted.writeFile(resolved, content);
    });
  }
  writeFile(path: string, content: string | Uint8Array, context: Context) { return this.write(path, content, false, context); }
  appendFile(path: string, content: string | Uint8Array, context: Context) { return this.write(path, content, true, context); }
  truncateFile(path: string, size: number, context: Context) {
    return this.operation(path, context, async ({ mounted }) => {
      if (!Number.isSafeInteger(size) || size < 0 || size > 8 * 1024 * 1024) throw new FileError('invalid', 'Truncate size exceeds the local file limit.', path);
      const resolved = this.resolve(path);
      const bytes = await mounted.readFileBuffer(resolved);
      const replacement = new Uint8Array(size);
      replacement.set(bytes.subarray(0, size));
      await mounted.writeFile(resolved, replacement);
    });
  }
  flushFile(path: string, context: Context) {
    return this.operation(path, context, async ({ mounted, files }) => {
      const stat = await mounted.stat(this.resolve(path));
      if (!stat.isFile) throw new FileError('is_directory', 'Cannot flush a directory.', path);
      // Every SQLite mutation commits before its promise resolves; temporary memory has no disk cache.
      await files?.drain();
    });
  }
  renameFile(sourcePath: string, destinationPath: string, context: Context) {
    return this.operation(sourcePath, context, async ({ mounted, signal }) => {
      const paths = createPathResolver(mounted, signal);
      const source = await paths.physical(this.resolve(sourcePath), { followFinal: false });
      const destination = await paths.physical(this.resolve(destinationPath), { followFinal: false, missing: true });
      const persistent = (path: string) => path === HOME || path.startsWith(`${HOME}/`);
      if (persistent(source) !== persistent(destination)) throw new FileError('not_supported', 'Cannot rename across virtual filesystem mounts.', destinationPath);
      await mounted.mv(source, destination);
    });
  }
  fileInfo(path: string, context: Context) {
    return this.operation(path, context, async ({ mounted }) => {
      const resolved = this.resolve(path);
      return infoFor(resolved, await mounted.lstat(resolved));
    });
  }
  openDirReader(path: string, context: Context): Promise<Result<DirReader, FileError>> {
    return this.resourceOperation(path, context, async ({ mounted }, rollback) => {
      const resolved = await mounted.realpath(this.resolve(path));
      let names = await mounted.readdir(resolved); // Namespace itself is bounded (4096 workspace entries).
      let offset = 0;
      let closed = false;
      const close = this.readerClose(() => { closed = true; names = []; });
      rollback(close);
      return {
        next: (maxEntries, readContext) => this.operation(path, readContext, async ({ mounted: current }) => {
          if (closed) throw new FileError('invalid', 'Directory reader is closed.', path);
          if (!Number.isSafeInteger(maxEntries) || maxEntries < 1) throw new FileError('invalid', 'maxEntries must be a positive safe integer.', path);
          const entries: FileInfo[] = [];
          while (offset < names.length && entries.length < maxEntries) {
            const child = joinVirtualPath(resolved, names[offset++]);
            try { entries.push(infoFor(child, await current.lstat(child))); }
            catch (cause) { if (fileError(cause).code !== 'not_found') throw cause; }
          }
          return { entries, done: offset === names.length };
        }),
        close: async () => { await close(); },
      } satisfies DirReader;
    });
  }
  async listDir(path: string, context: Context): Promise<Result<FileInfo[], FileError>> {
    const opened = await this.openDirReader(path, context);
    if (!opened.ok) return opened;
    const entries: FileInfo[] = [];
    try {
      while (true) {
        const page = await opened.value.next(128, context);
        if (!page.ok) return page;
        entries.push(...page.value.entries);
        if (page.value.done) return ok(entries);
      }
    } finally { await opened.value.close(context); }
  }
  watch(_targets: readonly WatchTarget[], _onChange: (change: WatchChange) => void, context: Context): Promise<Result<FileWatcher, FileError>> {
    return this.metadata(undefined, context, () => { throw new FileError('not_supported', 'The local virtual filesystem does not provide reliable change notifications.'); });
  }
  canonicalPath(path: string, context: Context) { return this.operation(path, context, ({ mounted }) => mounted.realpath(this.resolve(path))); }
  async exists(path: string, context: Context): Promise<Result<boolean, FileError>> {
    const result = await this.fileInfo(path, context);
    return result.ok ? ok(true) : result.error.code === 'not_found' ? ok(false) : result;
  }
  createDir(path: string, options: { recursive?: boolean } | undefined, context: Context) {
    return this.operation(path, context, ({ mounted }) => mounted.mkdir(this.resolve(path), { recursive: options?.recursive ?? true }));
  }
  remove(path: string, options: { recursive?: boolean; force?: boolean } | undefined, context: Context) {
    return this.operation(path, context, ({ mounted }) => mounted.rm(this.resolve(path), options));
  }
  private createTemp(prefix: string, suffix: string, directory: boolean, context: Context) {
    return this.operation('/tmp', context, async ({ mounted }) => {
      if (/[\/\\\0]/.test(prefix + suffix)) throw new FileError('invalid', 'Temporary names must be single path components.');
      const path = `/tmp/${prefix}${uuidv7()}${suffix}`;
      validateVirtualPath(path);
      if (!mounted.createExclusive) throw new FileError('not_supported', 'The virtual filesystem has no exclusive-create primitive.', path);
      await mounted.createExclusive(path, { directory, mode: directory ? 0o700 : 0o600 });
      return path;
    });
  }
  createTempDir(prefix: string | undefined, context: Context) { return this.createTemp(prefix ?? 'tmp-', '', true, context); }
  createTempFile(options: { prefix?: string; suffix?: string } | undefined, context: Context) { return this.createTemp(options?.prefix ?? 'tmp-', options?.suffix ?? '', false, context); }

  exec(command: string | readonly string[], options: ShellExecOptions | undefined, context: Context): Promise<Result<ShellExecResult, ExecutionError>> {
    return this.track((async () => {
      try { return await this.lease(context, (invocation) => executeWorkspaceCommand(invocation, this.cwd, command, options, context)); }
      catch (cause) {
        try { this.active(context); } catch { return err(new ExecutionError('aborted', 'Workspace shell execution was aborted.', toError(cause))); }
        return err(cause instanceof ExecutionError ? cause : new ExecutionError('unknown', toError(cause).message, toError(cause)));
      }
    })());
  }

  /** Acquisition and delivered scopes remain owned by this facade until release. */
  acquire(context: Context): Promise<{ env: WorkspaceExecutionEnv; context: Context; release(): Promise<void> }> {
    return this.track((async () => {
      context.abortSignal?.throwIfAborted();
      this.active(context);
      if (!this.owner) throw new Error('Only an owned workspace facade can acquire a separate tool scope.');
      this.own();
      const cancellation = this.cancellation(context);
      let lease: Awaited<ReturnType<WorkspaceRuntime['acquire']>>;
      try { lease = await this.owner.runtime.acquire(this.owner.workspaceId, cancellation.signal); }
      catch (cause) { cancellation.dispose(); throw cause; }
      const env = new WorkspaceExecutionEnv(lease.invocation, this.cwd);
      const scopedContext = withAbortSignal(lease.invocation.signal, context);
      let released: Promise<void> | undefined;
      const release = () => released ??= this.track((async () => {
        try {
          try { await env.cleanup(BACKGROUND_CONTEXT); }
          finally { await lease.release(); }
        } finally {
          cancellation.dispose();
          this.scopes.delete(release);
        }
      })());
      this.scopes.add(release);
      try {
        context.abortSignal?.throwIfAborted();
        this.active(context);
        return { env, context: scopedContext, release };
      } catch (cause) {
        // A cancellation may arrive after runtime admission but before delivery.
        // Never leave that acquired lease waiting for a caller who got no scope.
        await release().catch(() => {});
        throw cause;
      }
    })());
  }

  async cleanup(_context: Context): Promise<void> {
    if (!this.closing) {
      this.closed = true;
      this.lifetime.abort(new Error('Workspace environment is closed.'));
      this.invocation?.abort?.(new Error('Workspace environment is closed.'));
      this.closing = (async () => {
        // Pending direct work/acquisitions may be queued behind one of our
        // delivered scopes. Start releasing those leases before awaiting either.
        const releasing = [...this.scopes].map((release) => release());
        await Promise.allSettled([...this.pending, ...releasing]);
        await Promise.allSettled([...this.readers].map((close) => close()));
        this.disown?.();
        this.disown = undefined;
      })();
    }
    await this.closing;
  }

  /** Local composition-only capability, absent on a direct metadata facade. */
  boundInvocation(): WorkspaceInvocation | undefined { return this.invocation as WorkspaceInvocation | undefined; }
}

export function createWorkspaceExecutionEnv(runtime: WorkspaceRuntime, workspaceId: string, cwd = HOME): WorkspaceExecutionEnv {
  return new WorkspaceExecutionEnv({ runtime, workspaceId }, cwd);
}
export function acquireWorkspaceExecutionScope(env: WorkspaceExecutionEnv, context: Context) { return env.acquire(context); }
export function workspaceInvocation(env: WorkspaceExecutionEnv): WorkspaceInvocation | undefined { return env.boundInvocation(); }
