import type { Context } from '@earendil-works/chord';
import {
  ExecutionError, FileError, LineScanner, StreamDecoder, err, ok, toError,
  type BinaryReader, type DirReader, type ExecutionEnv, type FileErrorCode, type FileInfo, type FileWatcher,
  type LineScan, type Result, type ShellExecOptions, type ShellExecResult, type TextLine, type TextLineReader,
} from '@earendil-works/pi-durable/env';
import { InMemoryFs, MountableFs } from 'just-bash/browser';

import { createBashEngine, isBashCommand } from '../bash/engine/index';
import { WorkspaceFs, WorkspaceFsError, normalizePath, resolvePath } from './files';
import type { ByteReader, WorkspaceStorage } from './storage';

const WORKSPACE_ROOT = '/workspace';
const READ_CHUNK = 64 * 1024;
/** Largest single read of a binary reader, so a huge `length` allocates only what the file yields. */
const BINARY_READ_CHUNK = 1024 * 1024;

/** Node's mapping of the same errno codes; the rest are `unknown` with a readable message. */
const FILE_ERROR_CODES: Partial<Record<WorkspaceFsError['code'], FileErrorCode>> = {
  ENOENT: 'not_found', ENOTDIR: 'not_directory', EISDIR: 'is_directory', EINVAL: 'invalid', ENOTSUP: 'not_supported',
};

function fileError(cause: unknown, path: string): FileError {
  if (cause instanceof FileError) return cause;
  const error = toError(cause);
  const code = cause instanceof WorkspaceFsError ? FILE_ERROR_CODES[cause.code] ?? 'unknown' : 'unknown';
  return new FileError(code, error.message, path, error);
}

function aborted(context: Context, path?: string): FileError | undefined {
  return context.abortSignal?.aborted ? new FileError('aborted', 'aborted', path) : undefined;
}

function nameOf(path: string): string {
  return path.slice(path.lastIndexOf('/') + 1);
}

function closedReader(what: string, path: string): Result<never, FileError> {
  return err(new FileError('invalid', `${what} is closed`, path));
}

class WorkspaceBinaryReader implements BinaryReader {
  #closed = false;

  /** `mtimeMs` is the opened file's at open time: the platform handle reports only its size. */
  constructor(private readonly reader: ByteReader, private readonly path: string, private readonly mtimeMs: number) {}

  async info(context: Context): Promise<Result<FileInfo, FileError>> {
    const failure = aborted(context, this.path);
    if (failure) return err(failure);
    if (this.#closed) return closedReader('Binary reader', this.path);
    const size = await this.reader.size();
    return ok({ name: nameOf(this.path), path: this.path, kind: 'file', size, mtimeMs: this.mtimeMs });
  }

  async read(offset: number, length: number, context: Context): Promise<Result<Uint8Array, FileError>> {
    const failure = aborted(context, this.path);
    if (failure) return err(failure);
    if (this.#closed) return closedReader('Binary reader', this.path);
    if (!Number.isSafeInteger(offset) || offset < 0 || !Number.isSafeInteger(length) || length < 0) {
      return err(new FileError('invalid', 'Offset and length must be non-negative safe integers', this.path));
    }
    const chunks: Uint8Array[] = [];
    let total = 0;
    try {
      while (total < length) {
        const chunk = await this.reader.read(offset + total, Math.min(length - total, BINARY_READ_CHUNK));
        if (chunk.length === 0) break;
        chunks.push(chunk);
        total += chunk.length;
      }
    } catch (cause) {
      return err(fileError(cause, this.path));
    }
    const bytes = new Uint8Array(total);
    let position = 0;
    for (const chunk of chunks) {
      bytes.set(chunk, position);
      position += chunk.length;
    }
    return ok(bytes);
  }

  async scanLines(options: { startLine: number; endLine?: number }, context: Context,
  ): Promise<Result<LineScan, FileError>> {
    const failure = aborted(context, this.path);
    if (failure) return err(failure);
    if (this.#closed) return closedReader('Binary reader', this.path);
    let scanner: LineScanner;
    try {
      scanner = new LineScanner(options.startLine, options.endLine);
    } catch {
      return err(new FileError('invalid', 'Invalid line range', this.path));
    }
    try {
      for (let position = 0; ;) {
        const chunk = await this.reader.read(position, READ_CHUNK);
        const stopped = aborted(context, this.path);
        if (stopped) return err(stopped);
        if (chunk.length === 0) return ok(scanner.finish());
        scanner.push(chunk);
        position += chunk.length;
      }
    } catch (cause) {
      return err(fileError(cause, this.path));
    }
  }

  async close(): Promise<void> {
    if (this.#closed) return;
    this.#closed = true;
    await this.reader.close().catch(() => undefined);
  }
}

/** LF-terminated lines decoded like the whole file, as `NodeExecutionEnv`'s line reader does. */
class WorkspaceTextLineReader implements TextLineReader {
  readonly #decoder = new StreamDecoder();
  #position = 0;
  #buffered = '';
  #ended = false;
  #closed = false;

  constructor(private readonly reader: ByteReader, private readonly path: string) {}

  async readLine(context: Context): Promise<Result<TextLine | undefined, FileError>> {
    const failure = aborted(context, this.path);
    if (failure) return err(failure);
    if (this.#closed) return closedReader('Text line reader', this.path);
    try {
      while (true) {
        const newline = this.#buffered.indexOf('\n');
        if (newline !== -1) {
          const text = this.#buffered.slice(0, newline);
          this.#buffered = this.#buffered.slice(newline + 1);
          return ok({ text, terminated: true });
        }
        if (this.#ended) {
          if (this.#buffered.length === 0) return ok(undefined);
          const text = this.#buffered;
          this.#buffered = '';
          return ok({ text, terminated: false });
        }
        const chunk = await this.reader.read(this.#position, READ_CHUNK);
        this.#position += chunk.length;
        if (chunk.length === 0) {
          this.#buffered += this.#decoder.decode();
          this.#ended = true;
        } else {
          this.#buffered += this.#decoder.decode(chunk);
        }
      }
    } catch (cause) {
      return err(fileError(cause, this.path));
    }
  }

  async close(): Promise<void> {
    if (this.#closed) return;
    this.#closed = true;
    this.#buffered = '';
    await this.reader.close().catch(() => undefined);
  }
}

/** Pages a directory's entries as they were when it was opened; entries removed since are skipped. */
class WorkspaceDirReader implements DirReader {
  #next = 0;
  #closed = false;

  constructor(private readonly storage: WorkspaceStorage, private readonly local: string,
    private readonly path: string, private readonly names: readonly string[]) {}

  async next(maxEntries: number, context: Context): Promise<Result<{ entries: FileInfo[]; done: boolean }, FileError>> {
    const failure = aborted(context, this.path);
    if (failure) return err(failure);
    if (this.#closed) return closedReader('Directory reader', this.path);
    if (!Number.isSafeInteger(maxEntries) || maxEntries <= 0) {
      return err(new FileError('invalid', 'maxEntries must be a positive safe integer', this.path));
    }
    const entries: FileInfo[] = [];
    try {
      while (this.#next < this.names.length && entries.length < maxEntries) {
        const name = this.names[this.#next++];
        const entry = await this.storage.info(this.local === '/' ? `/${name}` : `${this.local}/${name}`);
        const path = this.path === '/' ? `/${name}` : `${this.path}/${name}`;
        if (entry) entries.push({ name, path, kind: entry.kind, size: entry.size, mtimeMs: entry.mtimeMs });
      }
    } catch (cause) {
      return err(fileError(cause, this.path));
    }
    return ok({ entries, done: this.#next >= this.names.length });
  }

  async close(): Promise<void> {
    this.#closed = true;
  }
}

/**
 * One chat's workspace directory as Pi's execution environment. File methods see `/workspace` only; `exec` runs
 * just-bash with `/workspace` mounted over the same files and an in-memory `/tmp` that lives for one command.
 * The environment owns no storage handles, so a fresh one per call is fine; `cleanup()` aborts its running commands.
 */
export class WorkspaceExecutionEnv implements ExecutionEnv {
  readonly #files: WorkspaceFs;
  readonly #running = new Set<AbortController>();

  constructor(private readonly storage: WorkspaceStorage, readonly id: string, public cwd = WORKSPACE_ROOT) {
    this.#files = new WorkspaceFs(storage, WORKSPACE_ROOT);
  }

  #absolute(path: string): string {
    if (path === '~') return WORKSPACE_ROOT;
    if (path.startsWith('~/')) return resolvePath(WORKSPACE_ROOT, path.slice(2));
    return resolvePath(this.cwd, path);
  }

  /** The path inside the workspace directory; nothing outside `/workspace` is reachable through file methods. */
  #local(absolute: string): string {
    if (absolute === WORKSPACE_ROOT) return '/';
    if (absolute.startsWith(`${WORKSPACE_ROOT}/`)) return absolute.slice(WORKSPACE_ROOT.length);
    throw new FileError('permission_denied', `Only ${WORKSPACE_ROOT} is available to file tools.`, absolute);
  }

  async #run<T>(path: string, context: Context, work: (local: string, absolute: string) => Promise<T>,
  ): Promise<Result<T, FileError>> {
    const absolute = this.#absolute(path);
    const failure = aborted(context, absolute);
    if (failure) return err(failure);
    try {
      return ok(await work(this.#local(absolute), absolute));
    } catch (cause) {
      return err(fileError(cause, absolute));
    }
  }

  async #openFile(local: string, absolute: string): Promise<{ reader: ByteReader; mtimeMs: number }> {
    const entry = await this.storage.info(local);
    if (!entry) throw new FileError('not_found', `ENOENT: no such file or directory, open '${absolute}'`, absolute);
    if (entry.kind === 'directory') {
      throw new FileError('is_directory', `EISDIR: illegal operation on a directory, read '${absolute}'`, absolute);
    }
    return { reader: await this.storage.open(local), mtimeMs: entry.mtimeMs };
  }

  async absolutePath(path: string): Promise<Result<string, FileError>> {
    return ok(this.#absolute(path));
  }

  async joinPath(parts: string[]): Promise<Result<string, FileError>> {
    return ok(normalizePath(parts.filter((part) => part !== '').join('/')));
  }

  /** Like `NodeExecutionEnv`'s `readFile(path, 'utf8')`: invalid bytes become U+FFFD and a byte-order mark stays. */
  readTextFile(path: string, context: Context): Promise<Result<string, FileError>> {
    return this.#run(path, context, (local) => this.#files.readFile(local, 'utf8'));
  }

  openTextLineReader(path: string, context: Context): Promise<Result<TextLineReader, FileError>> {
    return this.#run(path, context, async (local, absolute) => {
      const { reader } = await this.#openFile(local, absolute);
      return new WorkspaceTextLineReader(reader, absolute);
    });
  }

  async readTextLines(path: string, options: { maxLines?: number } | undefined, context: Context,
  ): Promise<Result<string[], FileError>> {
    if (options?.maxLines !== undefined && options.maxLines <= 0) return ok([]);
    const opened = await this.openTextLineReader(path, context);
    if (!opened.ok) return opened;
    const lines: string[] = [];
    try {
      while (options?.maxLines === undefined || lines.length < options.maxLines) {
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

  readBinaryFile(path: string, context: Context): Promise<Result<Uint8Array, FileError>> {
    return this.#run(path, context, (local) => this.#files.readFileBuffer(local));
  }

  /** The workspace has no symbolic links, so `noFollow` changes nothing. */
  openBinaryReader(path: string, _options: { noFollow?: boolean } | undefined, context: Context,
  ): Promise<Result<BinaryReader, FileError>> {
    return this.#run(path, context, async (local, absolute) => {
      const { reader, mtimeMs } = await this.#openFile(local, absolute);
      return new WorkspaceBinaryReader(reader, absolute, mtimeMs);
    });
  }

  /** Like `NodeExecutionEnv`, creates missing parent directories. */
  writeFile(path: string, content: string | Uint8Array, context: Context): Promise<Result<void, FileError>> {
    return this.#run(path, context, async (local) => {
      await this.#files.mkdir(local.slice(0, local.lastIndexOf('/')) || '/', { recursive: true });
      await this.#files.writeFile(local, content);
    });
  }

  appendFile(path: string, content: string | Uint8Array, context: Context): Promise<Result<void, FileError>> {
    return this.#run(path, context, async (local) => {
      await this.#files.mkdir(local.slice(0, local.lastIndexOf('/')) || '/', { recursive: true });
      await this.#files.appendFile(local, content);
    });
  }

  truncateFile(path: string, size: number, context: Context): Promise<Result<void, FileError>> {
    return this.#run(path, context, async (local, absolute) => {
      if (!Number.isSafeInteger(size) || size < 0) {
        throw new FileError('invalid', 'File size must be a non-negative safe integer', absolute);
      }
      const bytes = await this.#files.readFileBuffer(local);
      const resized = new Uint8Array(size);
      resized.set(bytes.subarray(0, size));
      await this.#files.writeFile(local, resized);
    });
  }

  /** Every write completes before its promise resolves; no handle holds unwritten data. */
  flushFile(path: string, context: Context): Promise<Result<void, FileError>> {
    return this.#run(path, context, async (local, absolute) => {
      if ((await this.#files.stat(local)).isDirectory) throw new FileError('is_directory', 'Is a directory', absolute);
    });
  }

  renameFile(sourcePath: string, destinationPath: string, context: Context): Promise<Result<void, FileError>> {
    return this.#run(sourcePath, context, async (source) => {
      await this.#files.mv(source, this.#local(this.#absolute(destinationPath)));
    });
  }

  fileInfo(path: string, context: Context): Promise<Result<FileInfo, FileError>> {
    return this.#run(path, context, async (local, absolute) => {
      const entry = await this.storage.info(local);
      if (!entry) throw new FileError('not_found', `ENOENT: no such file or directory, lstat '${absolute}'`, absolute);
      return { name: nameOf(absolute), path: absolute, kind: entry.kind, size: entry.size, mtimeMs: entry.mtimeMs };
    });
  }

  async listDir(path: string, context: Context): Promise<Result<FileInfo[], FileError>> {
    const opened = await this.openDirReader(path, context);
    if (!opened.ok) return opened;
    const entries: FileInfo[] = [];
    try {
      while (true) {
        const page = await opened.value.next(256, context);
        if (!page.ok) return page;
        entries.push(...page.value.entries);
        if (page.value.done) return ok(entries);
      }
    } finally {
      await opened.value.close(context);
    }
  }

  openDirReader(path: string, context: Context): Promise<Result<DirReader, FileError>> {
    return this.#run(path, context, async (local, absolute) => {
      const names = await this.#files.readdir(local);
      return new WorkspaceDirReader(this.storage, local, absolute, names);
    });
  }

  async watch(): Promise<Result<FileWatcher, FileError>> {
    return err(new FileError('not_supported', 'The workspace does not report file changes.'));
  }

  canonicalPath(path: string, context: Context): Promise<Result<string, FileError>> {
    return this.#run(path, context, async (local, absolute) => {
      await this.#files.realpath(local);
      return absolute;
    });
  }

  async exists(path: string, context: Context): Promise<Result<boolean, FileError>> {
    const result = await this.fileInfo(path, context);
    if (result.ok) return ok(true);
    if (result.error.code === 'not_found') return ok(false);
    return err(result.error);
  }

  createDir(path: string, options: { recursive?: boolean } | undefined, context: Context,
  ): Promise<Result<void, FileError>> {
    return this.#run(path, context, (local) => this.#files.mkdir(local, { recursive: options?.recursive ?? true }));
  }

  remove(path: string, options: { recursive?: boolean; force?: boolean } | undefined, context: Context,
  ): Promise<Result<void, FileError>> {
    return this.#run(path, context, (local) => this.#files.rm(local, options));
  }

  /** Nothing in the app asks for these, and `/tmp` lasts only one command, so the environment offers none. */
  async createTempDir(): Promise<Result<string, FileError>> {
    return err(new FileError('not_supported', 'Temporary directories are not available; use /workspace.'));
  }

  async createTempFile(): Promise<Result<string, FileError>> {
    return err(new FileError('not_supported', 'Temporary files are not available; use /workspace.'));
  }

  /**
   * Runs a script, or an available command with arguments that bypass shell parsing. The shell buffers output, so
   * each stream arrives in one piece after the command ends, and output is never spilled to a file.
   */
  async exec(command: string | readonly string[], options: ShellExecOptions | undefined, context: Context,
  ): Promise<Result<ShellExecResult, ExecutionError>> {
    if (context.abortSignal?.aborted) return err(new ExecutionError('aborted', 'aborted'));
    const program = typeof command === 'string' ? command : command[0];
    if (typeof command !== 'string' && (program === undefined || !isBashCommand(program))) {
      const name = program ?? '(empty argv)';
      return err(new ExecutionError('spawn_error', `Program is not available in this shell: ${name}`));
    }
    const timeout = options?.timeout;
    if (timeout !== undefined && (!Number.isFinite(timeout) || timeout <= 0)) {
      return err(new ExecutionError('timeout', 'Invalid timeout: must be a finite number of seconds'));
    }
    const temporary = new InMemoryFs();
    temporary.mkdirSync('/tmp', { recursive: true });
    const fs = new MountableFs({ base: temporary, mounts: [{ mountPoint: WORKSPACE_ROOT, filesystem: this.#files }] });
    const cwd = resolvePath(this.cwd, options?.cwd ?? this.cwd);
    const directory = await fs.stat(cwd).catch(() => undefined);
    if (!directory?.isDirectory) {
      return err(new ExecutionError('spawn_error', `Working directory does not exist: ${cwd}`));
    }

    const controller = new AbortController();
    const abort = () => controller.abort();
    context.abortSignal?.addEventListener('abort', abort, { once: true });
    this.#running.add(controller);
    let timedOut = false;
    // Like a killed process, an aborted script stops at its next statement or sleep.
    const timer = timeout === undefined ? undefined : setTimeout(() => {
      timedOut = true;
      controller.abort();
    }, timeout * 1000);
    const interrupted = () => {
      if (timedOut) return new ExecutionError('timeout', `timeout:${timeout}`);
      return controller.signal.aborted ? new ExecutionError('aborted', 'aborted') : undefined;
    };
    try {
      const result = await createBashEngine(fs).exec(program ?? '', {
        signal: controller.signal, rawScript: true, cwd,
        // The phone's process variables never reach the shell; `inheritEnv` only keeps the shell's own defaults.
        replaceEnv: options?.inheritEnv === false,
        ...(options?.env === undefined ? {} : { env: options.env }),
        ...(typeof command === 'string' ? {} : { args: command.slice(1) }),
      });
      const stopped = interrupted();
      if (stopped) return err(stopped);
      try {
        if (result.stdout) options?.onOutput?.(result.stdout, context, { stream: 'stdout' });
        if (result.stderr) options?.onOutput?.(result.stderr, context, { stream: 'stderr' });
      } catch (cause) {
        return err(new ExecutionError('callback_error', toError(cause).message, toError(cause)));
      }
      return ok({ exitCode: result.exitCode });
    } catch (cause) {
      return err(interrupted() ?? new ExecutionError('unknown', toError(cause).message, toError(cause)));
    } finally {
      if (timer !== undefined) clearTimeout(timer);
      context.abortSignal?.removeEventListener('abort', abort);
      this.#running.delete(controller);
    }
  }

  async cleanup(): Promise<void> {
    for (const controller of this.#running) controller.abort();
    this.#running.clear();
  }
}
