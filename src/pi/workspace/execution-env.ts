import type { Context } from '@earendil-works/chord';
import { uuidv7 } from '@earendil-works/pi-ai';
import {
  ExecutionError, FileError, err, ok, toError,
  type ExecutionEnv, type FileErrorCode, type FileInfo, type Result,
  type ShellExecOptions, type ShellExecResult, type TextLineReader,
} from '@earendil-works/pi-durable/env';
import type { FsStat } from 'just-bash';
import { createPathResolver, joinVirtualPath, validateVirtualPath } from './mounted-paths';
import type { WorkspaceInvocation } from './runtime';

const HOME = '/workspace';
const encoder = new TextEncoder();
const decoder = new TextDecoder();

function fileError(cause: unknown, path?: string): FileError {
  if (cause instanceof FileError) return cause;
  const error = toError(cause);
  // InMemoryFs supplies message-only errno errors; the SQLite filesystem also sets code.
  const errno = (cause as { code?: string } | null)?.code ?? /^([A-Z_]+):/.exec(error.message)?.[1];
  const codes: Record<string, FileErrorCode> = {
    ABORT_ERR: 'aborted', ENOENT: 'not_found', EACCES: 'permission_denied', EPERM: 'permission_denied',
    ENOTDIR: 'not_directory', EISDIR: 'is_directory', EINVAL: 'invalid', ENAMETOOLONG: 'invalid',
    ELOOP: 'invalid', EEXIST: 'invalid', ENOTEMPTY: 'invalid', EBUSY: 'invalid',
    ENOSYS: 'not_supported', ENOTSUP: 'not_supported', EXDEV: 'not_supported',
  };
  return new FileError(codes[errno ?? ''] ?? 'unknown', error.message, path, error);
}

/** Preserve every leading BOM without relying on platform-specific TextDecoder options. */
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

/** SDK mutation keys need lexical parent joins, separate from physical filesystem lookup. */
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
  // Do not erase symlink/.. components before the mounted resolver sees them.
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

/** One Pi environment over one invocation's persistent workspace and temporary virtual tree. */
export class WorkspaceExecutionEnv implements ExecutionEnv {
  readonly id = `workspace-invocation:${uuidv7()}`;
  cwd = HOME;
  private closed = false;
  private readonly readers = new Set<() => void>();
  private readonly paths;

  constructor(private readonly invocation: Pick<WorkspaceInvocation, 'mounted' | 'signal'>) {
    this.paths = createPathResolver(invocation.mounted, invocation.signal);
  }

  private checkCancellation(context: Context): void {
    context.abortSignal?.throwIfAborted();
    this.invocation.signal.throwIfAborted();
  }

  protected active(context: Context, path?: string): void {
    this.checkCancellation(context);
    if (this.closed) throw new FileError('aborted', 'Workspace environment is closed.', path);
  }

  private resolve(path: string): string {
    const expanded = path === '~' ? HOME : path.startsWith('~/') ? `${HOME}/${path.slice(2)}` : path;
    return joinVirtualPath(this.cwd, expanded);
  }

  private async operation<T>(path: string | undefined, context: Context, work: () => T | Promise<T>): Promise<Result<T, FileError>> {
    try {
      this.active(context, path);
      const value = await work();
      this.active(context, path);
      return ok(value);
    } catch (cause) {
      // Cancellation reasons can be null or errno-shaped; never translate their identity.
      this.checkCancellation(context);
      return err(fileError(cause, path));
    }
  }

  absolutePath(path: string, context: Context): Promise<Result<string, FileError>> {
    return this.operation(path, context, () => this.resolve(path));
  }

  joinPath(parts: string[], context: Context): Promise<Result<string, FileError>> {
    return this.operation(undefined, context, () => joinParts(parts));
  }

  readBinaryFile(path: string, context: Context): Promise<Result<Uint8Array, FileError>> {
    return this.operation(path, context, () => this.invocation.mounted.readFileBuffer(this.resolve(path)));
  }

  readTextFile(path: string, context: Context): Promise<Result<string, FileError>> {
    return this.operation(path, context, async () => {
      const resolved = this.resolve(path);
      const bytes = await this.invocation.mounted.readFileBuffer(resolved);
      this.active(context, path);
      return strictText(bytes, resolved);
    });
  }

  async openTextLineReader(path: string, context: Context): Promise<Result<TextLineReader, FileError>> {
    const result = await this.readTextFile(path, context);
    if (!result.ok) return result;
    try { this.active(context, path); }
    catch (cause) {
      this.checkCancellation(context);
      return err(fileError(cause, path));
    }
    let text = result.value;
    let offset = 0;
    let closed = false;
    const close = () => {
      closed = true;
      text = '';
      this.readers.delete(close);
    };
    this.readers.add(close);
    return ok({
      readLine: async (readContext) => {
        try {
          this.active(readContext, path);
          if (closed) throw new FileError('invalid', 'Text line reader is closed.', path);
          if (offset >= text.length) return ok(undefined);
          const newline = text.indexOf('\n', offset);
          const terminated = newline !== -1;
          const line = text.slice(offset, terminated ? newline : text.length);
          offset = terminated ? newline + 1 : text.length;
          return ok({ text: line, terminated });
        } catch (cause) {
          this.checkCancellation(readContext);
          return err(fileError(cause, path));
        }
      },
      close: async () => { close(); },
    });
  }

  async readTextLines(path: string, options: { maxLines?: number } | undefined, context: Context): Promise<Result<string[], FileError>> {
    const maximum = options?.maxLines;
    const validation = await this.operation(path, context, () => {
      if (maximum !== undefined && (!Number.isSafeInteger(maximum) || maximum < 0)) {
        throw new FileError('invalid', 'maxLines must be a non-negative safe integer.', path);
      }
    });
    if (!validation.ok) return validation;
    if (maximum === 0) return ok([]);
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
    } finally {
      await opened.value.close(context);
    }
  }

  private write(path: string, content: string | Uint8Array, append: boolean, context: Context): Promise<Result<void, FileError>> {
    return this.operation(path, context, async () => {
      const resolved = this.resolve(path);
      await this.invocation.mounted.mkdir(parentPath(resolved), { recursive: true });
      this.active(context, path);
      if (append) await this.invocation.mounted.appendFile(resolved, content);
      else await this.invocation.mounted.writeFile(resolved, content);
    });
  }

  writeFile(path: string, content: string | Uint8Array, context: Context): Promise<Result<void, FileError>> {
    return this.write(path, content, false, context);
  }

  appendFile(path: string, content: string | Uint8Array, context: Context): Promise<Result<void, FileError>> {
    return this.write(path, content, true, context);
  }

  truncateFile(path: string, _size: number, context: Context): Promise<Result<void, FileError>> {
    return this.operation(path, context, () => { throw new FileError('not_supported', 'The virtual filesystem has no truncate primitive.', path); });
  }

  flushFile(path: string, context: Context): Promise<Result<void, FileError>> {
    return this.operation(path, context, () => { throw new FileError('not_supported', 'The virtual filesystem has no file-handle flush primitive.', path); });
  }

  renameFile(sourcePath: string, destinationPath: string, context: Context): Promise<Result<void, FileError>> {
    return this.operation(sourcePath, context, async () => {
      const source = await this.paths.physical(this.resolve(sourcePath), { followFinal: false });
      this.active(context, sourcePath);
      const destination = await this.paths.physical(this.resolve(destinationPath), { followFinal: false, missing: true });
      this.active(context, destinationPath);
      const persistent = (path: string) => path === HOME || path.startsWith(`${HOME}/`);
      // mounted.mv can copy across mounts, but that is not an atomic rename.
      if (persistent(source) !== persistent(destination)) {
        throw new FileError('not_supported', 'Cannot rename across virtual filesystem mounts.', destinationPath);
      }
      await this.invocation.mounted.mv(source, destination);
    });
  }

  fileInfo(path: string, context: Context): Promise<Result<FileInfo, FileError>> {
    return this.operation(path, context, async () => {
      const resolved = this.resolve(path);
      return infoFor(resolved, await this.invocation.mounted.lstat(resolved));
    });
  }

  listDir(path: string, context: Context): Promise<Result<FileInfo[], FileError>> {
    return this.operation(path, context, async () => {
      const resolved = await this.invocation.mounted.realpath(this.resolve(path));
      this.active(context, path);
      const names = await this.invocation.mounted.readdir(resolved);
      const entries: FileInfo[] = [];
      for (const name of names) {
        this.active(context, path);
        const child = joinVirtualPath(resolved, name);
        entries.push(infoFor(child, await this.invocation.mounted.lstat(child)));
      }
      return entries;
    });
  }

  canonicalPath(path: string, context: Context): Promise<Result<string, FileError>> {
    return this.operation(path, context, () => this.invocation.mounted.realpath(this.resolve(path)));
  }

  async exists(path: string, context: Context): Promise<Result<boolean, FileError>> {
    const result = await this.fileInfo(path, context);
    return result.ok ? ok(true) : result.error.code === 'not_found' ? ok(false) : result;
  }

  createDir(path: string, options: { recursive?: boolean } | undefined, context: Context): Promise<Result<void, FileError>> {
    return this.operation(path, context, () => this.invocation.mounted.mkdir(this.resolve(path), { recursive: options?.recursive ?? true }));
  }

  remove(path: string, options: { recursive?: boolean; force?: boolean } | undefined, context: Context): Promise<Result<void, FileError>> {
    return this.operation(path, context, () => this.invocation.mounted.rm(this.resolve(path), options));
  }

  private createTemp(prefix: string, suffix: string, directory: boolean, context: Context): Promise<Result<string, FileError>> {
    return this.operation('/tmp', context, async () => {
      if (/[\/\\\0]/.test(prefix + suffix)) throw new FileError('invalid', 'Temporary names must be single path components.');
      const path = `/tmp/${prefix}${uuidv7()}${suffix}`;
      validateVirtualPath(path);
      const filesystem = this.invocation.mounted;
      if (!filesystem.createExclusive) throw new FileError('not_supported', 'The virtual filesystem has no exclusive-create primitive.', path);
      await filesystem.createExclusive(path, { directory, mode: directory ? 0o700 : 0o600 });
      return path;
    });
  }

  createTempDir(prefix: string | undefined, context: Context): Promise<Result<string, FileError>> {
    return this.createTemp(prefix ?? 'tmp-', '', true, context);
  }

  createTempFile(options: { prefix?: string; suffix?: string } | undefined, context: Context): Promise<Result<string, FileError>> {
    return this.createTemp(options?.prefix ?? 'tmp-', options?.suffix ?? '', false, context);
  }

  async exec(_command: string, _options: ShellExecOptions | undefined, context: Context): Promise<Result<ShellExecResult, ExecutionError>> {
    this.checkCancellation(context);
    return err(new ExecutionError(this.closed ? 'aborted' : 'shell_unavailable',
      this.closed ? 'Workspace environment is closed.' : 'Use the registered bash tool for shell execution.'));
  }

  async cleanup(_context: Context): Promise<void> {
    this.closed = true;
    for (const close of this.readers) close();
    // The runtime owns the temporary tree. Cleanup never writes after cancellation.
  }
}
