import type { Context } from '@earendil-works/chord';
import { uuidv7 } from '@earendil-works/pi-ai';
import {
  ExecutionError, FileError, LineScanner, StreamDecoder, err, ok, toError,
  type BinaryReader, type DirReader, type ExecutionEnv, type FileErrorCode, type FileInfo, type FileWatcher,
  type LineScan, type Result, type ShellExecOptions, type ShellExecResult, type ShellSpillOptions, type TextLine,
  type TextLineReader,
} from '@earendil-works/pi-durable/env';
import { MountableFs } from 'just-bash/browser';

import { createBashEngine, isBashCommand } from '../bash/engine/index';
import { WorkspaceFs, WorkspaceFsError, normalizePath, resolvePath } from './files';
import type { ByteReader, Workspace, WorkspaceStorage } from './storage';

const WORKSPACE_ROOT = '/workspace';
const TEMP_ROOT = '/tmp';
const READ_CHUNK = 64 * 1024;
/** Largest single read of a binary reader, so a huge `length` allocates only what the file yields. */
const BINARY_READ_CHUNK = 1024 * 1024;

/** Node's mapping of the same errno codes; the rest are `unknown` with a readable message. */
const FILE_ERROR_CODES: Partial<Record<WorkspaceFsError['code'], FileErrorCode>> = {
  ENOENT: 'not_found', ENOTDIR: 'not_directory', EISDIR: 'is_directory', EINVAL: 'invalid', ENOTSUP: 'not_supported',
};

function fileError(cause: unknown, path?: string): FileError {
  if (cause instanceof FileError) return cause;
  const error = toError(cause);
  const code = cause instanceof WorkspaceFsError ? FILE_ERROR_CODES[cause.code] ?? 'unknown' : 'unknown';
  return new FileError(code, error.message, path, error);
}

function aborted(context: Context, path?: string): FileError | undefined {
  return context.abortSignal?.aborted ? new FileError('aborted', 'aborted', path) : undefined;
}

/** Like `NodeExecutionEnv`, a read or write that finishes after an abort reports the abort. */
function throwIfAborted(context: Context, path: string): void {
  const failure = aborted(context, path);
  if (failure) throw failure;
}

/** Node's `fileURLToPath` on POSIX; like `NodeExecutionEnv`, a malformed URL stays an ordinary path. */
function fromFileUrl(path: string): string {
  if (!path.startsWith('file://')) return path;
  try {
    const url = new URL(path);
    if (url.hostname !== '' || /%2f/i.test(url.pathname)) return path;
    return decodeURIComponent(url.pathname);
  } catch {
    return path;
  }
}

function nameOf(path: string): string {
  return path.slice(path.lastIndexOf('/') + 1);
}

function closedReader(what: string, path: string): Result<never, FileError> {
  return err(new FileError('invalid', `${what} is closed`, path));
}

/** One directory of the workspace: where the environment shows it, its storage, and the file system mounted there. */
interface Mount {
  readonly root: string;
  readonly storage: WorkspaceStorage;
  readonly files: WorkspaceFs;
}

/** A path inside one mount, relative to it. */
interface Located extends Mount {
  readonly local: string;
}

function mountOf(root: string, storage: WorkspaceStorage): Mount {
  return { root, storage, files: new WorkspaceFs(storage, root) };
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
        const stopped = aborted(context, this.path);
        if (stopped) return err(stopped);
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
        // Checked before the position moves, so an aborted read can be retried without skipping bytes.
        const stopped = aborted(context, this.path);
        if (stopped) return err(stopped);
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
        const stopped = aborted(context, this.path);
        if (stopped) return err(stopped);
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
 * One chat's workspace as Pi's execution environment. File methods and `exec` see the workspace's files at
 * `/workspace` and its temporary directory at `/tmp`; nothing here deletes temporary files, and the system may purge
 * them. The environment owns no storage handles, so a fresh one per call is fine; `cleanup()` aborts its running
 * commands.
 */
export class WorkspaceExecutionEnv implements ExecutionEnv {
  readonly #workspace: Mount;
  readonly #temp: Mount;
  readonly #running = new Set<AbortController>();

  constructor(workspace: Workspace, readonly id: string, public cwd = WORKSPACE_ROOT) {
    this.#workspace = mountOf(WORKSPACE_ROOT, workspace.files);
    this.#temp = mountOf(TEMP_ROOT, workspace.temp);
  }

  #absolute(path: string): string {
    if (path === '~') return WORKSPACE_ROOT;
    if (path.startsWith('~/')) return resolvePath(WORKSPACE_ROOT, path.slice(2));
    return resolvePath(this.cwd, fromFileUrl(path));
  }

  /** The mount a path is in; nothing outside `/workspace` and `/tmp` is reachable through file methods. */
  #locate(absolute: string): Located {
    for (const mount of [this.#workspace, this.#temp]) {
      if (absolute === mount.root) return { ...mount, local: '/' };
      if (absolute.startsWith(`${mount.root}/`)) return { ...mount, local: absolute.slice(mount.root.length) };
    }
    const message = `Only ${WORKSPACE_ROOT} and ${TEMP_ROOT} are available to file tools.`;
    throw new FileError('permission_denied', message, absolute);
  }

  async #run<T>(path: string, context: Context, work: (target: Located, absolute: string) => Promise<T>,
  ): Promise<Result<T, FileError>> {
    const absolute = this.#absolute(path);
    const failure = aborted(context, absolute);
    if (failure) return err(failure);
    try {
      return ok(await work(this.#locate(absolute), absolute));
    } catch (cause) {
      return err(fileError(cause, absolute));
    }
  }

  async #openFile({ storage, local }: Located, absolute: string): Promise<{ reader: ByteReader; mtimeMs: number }> {
    const entry = await storage.info(local);
    if (!entry) throw new FileError('not_found', `ENOENT: no such file or directory, open '${absolute}'`, absolute);
    if (entry.kind === 'directory') {
      throw new FileError('is_directory', `EISDIR: illegal operation on a directory, read '${absolute}'`, absolute);
    }
    return { reader: await storage.open(local), mtimeMs: entry.mtimeMs };
  }

  async absolutePath(path: string): Promise<Result<string, FileError>> {
    return ok(this.#absolute(path));
  }

  /** Like Node's `join`: empty parts are skipped and a trailing separator stays. */
  async joinPath(parts: string[]): Promise<Result<string, FileError>> {
    const joined = parts.filter((part) => part !== '').join('/');
    const normalized = normalizePath(joined);
    return ok(joined.endsWith('/') && !normalized.endsWith('/') ? `${normalized}/` : normalized);
  }

  /** Like `NodeExecutionEnv`'s `readFile(path, 'utf8')`: invalid bytes become U+FFFD and a byte-order mark stays. */
  readTextFile(path: string, context: Context): Promise<Result<string, FileError>> {
    return this.#run(path, context, async ({ files, local }, absolute) => {
      const text = await files.readFile(local, 'utf8');
      throwIfAborted(context, absolute);
      return text;
    });
  }

  openTextLineReader(path: string, context: Context): Promise<Result<TextLineReader, FileError>> {
    return this.#run(path, context, async (target, absolute) => {
      const { reader } = await this.#openFile(target, absolute);
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
    return this.#run(path, context, async ({ files, local }, absolute) => {
      const bytes = await files.readFileBuffer(local);
      throwIfAborted(context, absolute);
      return bytes;
    });
  }

  /** The workspace has no symbolic links, so `noFollow` changes nothing. */
  openBinaryReader(path: string, _options: { noFollow?: boolean } | undefined, context: Context,
  ): Promise<Result<BinaryReader, FileError>> {
    return this.#run(path, context, async (target, absolute) => {
      const { reader, mtimeMs } = await this.#openFile(target, absolute);
      return new WorkspaceBinaryReader(reader, absolute, mtimeMs);
    });
  }

  /** Like `NodeExecutionEnv`, creates missing parent directories. */
  writeFile(path: string, content: string | Uint8Array, context: Context): Promise<Result<void, FileError>> {
    return this.#run(path, context, async ({ files, local }, absolute) => {
      await files.mkdir(local.slice(0, local.lastIndexOf('/')) || '/', { recursive: true });
      throwIfAborted(context, absolute);
      await files.writeFile(local, content);
      throwIfAborted(context, absolute);
    });
  }

  appendFile(path: string, content: string | Uint8Array, context: Context): Promise<Result<void, FileError>> {
    return this.#run(path, context, async ({ files, local }, absolute) => {
      await files.mkdir(local.slice(0, local.lastIndexOf('/')) || '/', { recursive: true });
      throwIfAborted(context, absolute);
      await files.appendFile(local, content);
      throwIfAborted(context, absolute);
    });
  }

  truncateFile(path: string, size: number, context: Context): Promise<Result<void, FileError>> {
    return this.#run(path, context, async ({ files, local }, absolute) => {
      if (!Number.isSafeInteger(size) || size < 0) {
        throw new FileError('invalid', 'File size must be a non-negative safe integer', absolute);
      }
      const bytes = await files.readFileBuffer(local);
      throwIfAborted(context, absolute);
      const resized = new Uint8Array(size);
      resized.set(bytes.subarray(0, size));
      await files.writeFile(local, resized);
      throwIfAborted(context, absolute);
    });
  }

  /** Every write completes before its promise resolves; no handle holds unwritten data. */
  flushFile(path: string, context: Context): Promise<Result<void, FileError>> {
    return this.#run(path, context, async ({ files, local }, absolute) => {
      if ((await files.stat(local)).isDirectory) throw new FileError('is_directory', 'Is a directory', absolute);
    });
  }

  /** `/workspace` and `/tmp` are separate directories, so like rename(2) across file systems, moving between fails. */
  renameFile(sourcePath: string, destinationPath: string, context: Context): Promise<Result<void, FileError>> {
    return this.#run(sourcePath, context, async (source, absolute) => {
      const destinationAbsolute = this.#absolute(destinationPath);
      const destination = this.#locate(destinationAbsolute);
      if (destination.root !== source.root) {
        const message = `EXDEV: cross-device link not permitted, rename '${absolute}' -> '${destinationAbsolute}'`;
        throw new FileError('unknown', message, absolute);
      }
      await source.files.mv(source.local, destination.local);
    });
  }

  fileInfo(path: string, context: Context): Promise<Result<FileInfo, FileError>> {
    return this.#run(path, context, async ({ storage, local }, absolute) => {
      const entry = await storage.info(local);
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
    return this.#run(path, context, async ({ files, storage, local }, absolute) => {
      const names = await files.readdir(local);
      throwIfAborted(context, absolute);
      return new WorkspaceDirReader(storage, local, absolute, names);
    });
  }

  async watch(): Promise<Result<FileWatcher, FileError>> {
    return err(new FileError('not_supported', 'The workspace does not report file changes.'));
  }

  canonicalPath(path: string, context: Context): Promise<Result<string, FileError>> {
    return this.#run(path, context, async ({ files, local }, absolute) => {
      await files.realpath(local);
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
    return this.#run(path, context, ({ files, local }) => files.mkdir(local, { recursive: options?.recursive ?? true }));
  }

  /** Like Node's `rm`, a directory goes only with `recursive`, even an empty one and even with `force`. */
  remove(path: string, options: { recursive?: boolean; force?: boolean } | undefined, context: Context,
  ): Promise<Result<void, FileError>> {
    return this.#run(path, context, async ({ files, storage, local }, absolute) => {
      if (!options?.recursive && (await storage.info(local))?.kind === 'directory') {
        throw new FileError('is_directory', `EISDIR: illegal operation on a directory, rm '${absolute}'`, absolute);
      }
      await files.rm(local, options);
    });
  }

  async createTempDir(prefix: string | undefined, context: Context): Promise<Result<string, FileError>> {
    const failure = aborted(context);
    if (failure) return err(failure);
    try {
      return ok(await this.#createTempDir(prefix ?? 'tmp-'));
    } catch (cause) {
      return err(fileError(cause));
    }
  }

  async createTempFile(options: { prefix?: string; suffix?: string } | undefined, context: Context,
  ): Promise<Result<string, FileError>> {
    const failure = aborted(context);
    if (failure) return err(failure);
    try {
      return ok(await this.#createTempFile(options?.prefix ?? '', options?.suffix ?? ''));
    } catch (cause) {
      return err(fileError(cause));
    }
  }

  /** Like `mkdtemp`: creating a directory fails when its path exists, so no two calls share one. */
  async #createTempDir(prefix: string): Promise<string> {
    const path = normalizePath(`${TEMP_ROOT}/${prefix}${uuidv7()}`);
    const { files, local } = this.#locate(path);
    await files.mkdir(local);
    return path;
  }

  /** An empty file in a new temporary directory, as `NodeExecutionEnv` makes it. */
  async #createTempFile(prefix: string, suffix: string): Promise<string> {
    const directory = await this.#createTempDir('tmp-');
    const path = normalizePath(`${directory}/${prefix}${uuidv7()}${suffix}`);
    const { files, local } = this.#locate(path);
    await files.writeFile(local, new Uint8Array(0));
    return path;
  }

  /**
   * Like `NodeExecutionEnv`, the complete output goes to a temporary file once it passes either threshold. It is
   * written even after an abort or timeout, so the output of a stopped command can still be read.
   */
  async #spill(output: string, spill: ShellSpillOptions | undefined): Promise<string | undefined> {
    if (spill === undefined || output === '') return undefined;
    const bytes = new TextEncoder().encode(output);
    // Complete or partial lines, as `NodeExecutionEnv` counts them.
    const lines = output.split('\n').length - (output.endsWith('\n') ? 1 : 0);
    if (bytes.length <= spill.afterBytes && lines <= spill.afterLines) return undefined;
    const path = await this.#createTempFile('pi-output-', '.log');
    const { files, local } = this.#locate(path);
    await files.writeFile(local, bytes);
    return path;
  }

  /**
   * Runs a script, or an available command with arguments that bypass shell parsing. The shell buffers output, so
   * each stream arrives in one piece after the command ends, including what a stopped command wrote before it stopped.
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
    const mounts = [this.#workspace, this.#temp].map(({ root, files }) => ({ mountPoint: root, filesystem: files }));
    const fs = new MountableFs({ mounts });
    const cwd = this.#absolute(options?.cwd ?? this.cwd);
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
      // A stopped script returns what it wrote so far, which reaches the caller as a killed process's output does.
      try {
        if (result.stdout) options?.onOutput?.(result.stdout, context, { stream: 'stdout' });
        if (result.stderr) options?.onOutput?.(result.stderr, context, { stream: 'stderr' });
      } catch (cause) {
        return err(new ExecutionError('callback_error', toError(cause).message, toError(cause)));
      }
      let spillPath: string | undefined;
      let spillError: ExecutionError | undefined;
      try {
        spillPath = await this.#spill(result.stdout + result.stderr, options?.spill);
      } catch (cause) {
        const error = toError(cause);
        const message = `Failed to preserve complete shell output: ${error.message}`;
        spillError = new ExecutionError('unknown', message, error);
      }
      const stopped = interrupted();
      if (stopped) {
        if (spillPath !== undefined) stopped.spillPath = spillPath;
        return err(stopped);
      }
      if (spillError) return err(spillError);
      return ok({ exitCode: result.exitCode, ...(spillPath === undefined ? {} : { spillPath }) });
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
