// Adapted from Pi Env 1.0.4 remote-env.ts (MIT); the daemon wire contract is unchanged.
import { uuidv7 as randomUUID } from "@earendil-works/pi-ai";
import { Buffer } from "buffer";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { posix, resolveRemotePath } from "./paths";
import { decodeStrictUtf8 } from "../strict-utf8";
import type { Context } from "@earendil-works/chord";
import {
	type BinaryReader,
	type DirReader,
	type ExecutionEnv,
	ExecutionError,
	err,
	FileError,
	type FileInfo,
	type FileWatcher,
	ok,
	type Result,
	type ShellExecOptions,
	type ShellExecResult,
	type ShellOutputInfo,
	type ShellOutputSkip,
	type TextLineReader,
	type WatchChange,
	type WatchTarget,
} from "@earendil-works/pi-durable/env";
import { type Connection, type Json, RemoteError, type RemoteInfo } from "./connection";
import { abortResult, toFileError } from "./errors";
import {
  Handle, RemoteBinaryReader, RemoteDirReader, RemoteTextLineReader, readRange, toInfo,
  type RemoteFileInfo, type RemoteDirEntry,
} from './readers';
import { RemoteWatcher, type RemoteWatchOptions } from "./watch";

/** Give normal kill replies a chance to settle, then close an unresponsive owned session. */
const CLEANUP_GRACE_MS = 1_000;
const MAX_TIMEOUT_MS = 2_147_483_647;
const MAX_TIMEOUT_SECONDS = MAX_TIMEOUT_MS / 1000;
/** Node's `writeFile` writes at most this much per call and checks for an abort before each. */
const WRITE_CHUNK = 512 * 1024;
const WRITE_DEPTH = 8;
/** Node's `readFile`: chunk of known-size reads, chunk of unknown-size reads, and the largest file it reads. */
const READ_FILE_CHUNK = 512 * 1024;
const READ_FILE_UNKNOWN_CHUNK = 64 * 1024;
const READ_FILE_MAX = 2 ** 31 - 1;

export interface MobileRemoteExecutionEnvOptions {
	connection: Connection;
	/** The file namespace: equal ids see the same files (`FileSystem.id`), e.g. `pi-env:<env name>`. */
	id: string;
	cwd: string;
	shellPath?: string;
	/** Added to the remote environment of every command that inherits it, like `NodeExecutionEnv`'s `shellEnv`. */
	shellEnv?: Record<string, string>;
	/** How the daemon watches, like `NodeExecutionEnv`'s `watch` option. */
	watch?: RemoteWatchOptions;
}

/**
 * An `ExecutionEnv` on another machine, reached through a pi-env daemon. Results match `NodeExecutionEnv` running on
 * that machine: the daemon performs the system calls, and this class applies Node's path, error, and result rules.
 */
export class MobileRemoteExecutionEnv implements ExecutionEnv {
	readonly id: string;
	readonly cwd: string;
	readonly connection: Connection;
	readonly #shellPath: string | undefined;
	readonly #shellEnv: Record<string, string> | undefined;
	readonly #watchOptions: RemoteWatchOptions;
	readonly #lifetime = new AbortController();
	readonly #pending = new Set<Promise<unknown>>();
	readonly #handles = new Set<Handle>();
	readonly #watchers = new Set<FileWatcher>();
	readonly #temporary = new Set<string>();
	#closed = false;
	#closing?: Promise<void>;
	/** Running commands this environment started, for `cleanup()`. */
	readonly #running = new Map<number, number>();

	constructor(options: MobileRemoteExecutionEnvOptions) {
		this.id = options.id;
		this.cwd = options.cwd;
		this.connection = options.connection;
		this.#shellPath = options.shellPath;
		this.#shellEnv = options.shellEnv ? { ...options.shellEnv } : undefined;
		this.#watchOptions = { ...options.watch };
	}

	/** POSIX lexical paths are available before opening SSH; home expansion needs remote hello. */
	async #resolve(path: string, signal?: AbortSignal): Promise<string> {
		if (this.#closed) throw new FileError("aborted", "Remote environment is closed.", path);
		const home = path === "~" || path.startsWith("~/") ? (await this.#info(signal)).home : undefined;
		return resolveRemotePath(this.cwd, path, home);
	}

	async #fileOp<T>(
		path: string,
		context: Context,
		run: (resolved: string) => Promise<T>,
		check: "before" | "both" = "before",
	): Promise<Result<T, FileError>> {
		let resolved: string;
		try {
			resolved = await this.#resolve(path, context.abortSignal);
		} catch (error) {
			return err(toFileError(error, path));
		}
		const aborted = abortResult<T>(context.abortSignal, resolved);
		if (aborted) return aborted;
		try {
			const value = await run(resolved);
			if (check === "both") {
				const after = abortResult<T>(context.abortSignal, resolved);
				if (after) return after;
			}
			return ok(value);
		} catch (error) {
			return err(toFileError(error, resolved));
		}
	}

	async #open(resolved: string, json: Json, signal?: AbortSignal): Promise<{ handle: Handle; json: Json }> {
		const reply = await this.request("open", { path: resolved, ...json }, { signal });
		return { handle: new Handle(this, reply.json.handle as number, reply.session, resolved), json: reply.json };
	}

	async absolutePath(path: string, _context: Context): Promise<Result<string, FileError>> {
		try {
			return ok(await this.#resolve(path, _context.abortSignal));
		} catch (error) {
			return err(toFileError(error, path));
		}
	}

	async joinPath(parts: string[], _context: Context): Promise<Result<string, FileError>> {
		try {
			return ok(posix.join(...parts));
		} catch (error) {
			return err(toFileError(error));
		}
	}

	/** Node's `readFile` without decoding, over a file opened like `open(path, "r")`. */
	async #readFile(path: string, context: Context): Promise<Result<Uint8Array, FileError>> {
		const signal = context.abortSignal;
		return this.#fileOp(path, context, async (resolved) => {
			const { handle, json } = await this.#open(resolved, { mode: "read" }, context.abortSignal);
			const aborted = () => signal?.aborted === true;
			const abort = () => new FileError("aborted", "The operation was aborted", resolved);
			try {
				if (json.statError !== undefined) throw new RemoteError(json.statError as Json);
				if (aborted()) throw abort();
				const stat = json.stat as RemoteFileInfo;
				const size = stat.kind === "file" ? stat.size : 0;
				if (size > READ_FILE_MAX) {
					throw new FileError("unknown", `File size (${size}) is greater than 2 GiB`, resolved);
				}
				if (size === 0) {
					// Unknown size: sequential reads until the end, as for FIFOs and devices.
					const chunks: Uint8Array[] = [];
					let total = 0;
					while (true) {
						if (aborted()) throw abort();
						const bytes = await handle.pread(undefined, READ_FILE_UNKNOWN_CHUNK);
						if (bytes.length === 0) break;
						total += bytes.length;
						chunks.push(bytes);
					}
					return Buffer.concat(chunks, total);
				}
				// A single read of the whole size, or reads of 512 KiB until the size or the end of the file.
				if (size <= READ_FILE_CHUNK) return Buffer.from(await handle.pread(0, size));
				const read = await readRange(
					(at, length) => handle.pread(at, length),
					0,
					size,
					READ_FILE_CHUNK,
					aborted,
				);
				if (read === undefined) throw abort();
				return Buffer.concat(read.chunks, read.total);
			} finally {
				await handle.close();
			}
		});
	}

	/** Strict like the local workspace, so `edit` refuses a file that is not UTF-8 instead of corrupting it. */
	async readTextFile(path: string, context: Context): Promise<Result<string, FileError>> {
		const bytes = await this.readBinaryFile(path, context);
		if (!bytes.ok) return bytes;
		try {
			return ok(decodeStrictUtf8(bytes.value, path));
		} catch (error) {
			return err(toFileError(error, path));
		}
	}

	async readBinaryFile(path: string, context: Context): Promise<Result<Uint8Array, FileError>> {
		return this.#readFile(path, context);
	}

	async openBinaryReader(
		path: string,
		options: { noFollow?: boolean } | undefined,
		context: Context,
	): Promise<Result<BinaryReader, FileError>> {
		const opened = await this.#fileOp(path, context, async (resolved) => {
			return (await this.#open(resolved, { noFollow: options?.noFollow === true }, context.abortSignal)).handle;
		});
		if (!opened.ok) return opened;
		const aborted = this.#closed ? err<BinaryReader, FileError>(new FileError("aborted", "Remote environment is closed.")) : abortResult<BinaryReader>(context.abortSignal, opened.value.path);
		if (aborted) {
			await opened.value.close();
			return aborted;
		}
		return ok(new RemoteBinaryReader(opened.value));
	}

	async openTextLineReader(path: string, context: Context): Promise<Result<TextLineReader, FileError>> {
		const opened = await this.#fileOp(path, context, async (resolved) => {
			return (await this.#open(resolved, { mode: "read" }, context.abortSignal)).handle;
		});
		if (!opened.ok) return opened;
		const aborted = this.#closed ? err<TextLineReader, FileError>(new FileError("aborted", "Remote environment is closed.")) : abortResult<TextLineReader>(context.abortSignal, opened.value.path);
		if (aborted) {
			await opened.value.close();
			return aborted;
		}
		return ok(new RemoteTextLineReader(opened.value));
	}

	async readTextLines(
		path: string,
		options: { maxLines?: number } | undefined,
		context: Context,
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

	/**
	 * Node's `writeFile` (abort checked before each 512 KiB write) or `appendFile` (no checks, one after): the first
	 * request creates parents, opens, and writes the first chunk; later chunks go to the same open file.
	 */
	async #write(path: string, content: string | Uint8Array, append: boolean, context: Context) {
		const bytes = typeof content === "string" ? Buffer.from(content, "utf8") : content;
		const signal = append ? undefined : context.abortSignal;
		return this.#fileOp(
			path,
			context,
			async (resolved) => {
				const first = bytes.subarray(0, WRITE_CHUNK);
				const keep = bytes.length > WRITE_CHUNK;
				const reply = await this.request("write", { path: resolved, append, keep }, { payload: first, signal: context.abortSignal });
				if (!keep) return;
				const handle = new Handle(this, reply.json.handle as number, reply.session, resolved);
				const inFlight: Promise<unknown>[] = [];
				try {
					for (let offset = WRITE_CHUNK; offset < bytes.length; offset += WRITE_CHUNK) {
						if (signal?.aborted) {
							// A chunk that failed before this check fails the write, as it would have in sequence.
							const failed = (await Promise.allSettled(inFlight)).find((result) => result.status === "rejected");
							if (failed !== undefined) throw failed.reason;
							throw new FileError("aborted", "The operation was aborted", resolved);
						}
						const written = handle.request(
							"writeChunk",
							{},
							{ payload: bytes.subarray(offset, offset + WRITE_CHUNK) },
						);
						written.catch(() => {});
						inFlight.push(written);
						if (inFlight.length >= WRITE_DEPTH) await inFlight.shift();
					}
					// The first failure; later chunks are refused by the daemon, so the file has no gaps.
					for (const written of inFlight) await written;
				} finally {
					await Promise.allSettled(inFlight);
					await handle.close();
				}
			},
			append ? "both" : "before",
		);
	}

	writeFile(path: string, content: string | Uint8Array, context: Context): Promise<Result<void, FileError>> {
		return this.#write(path, content, false, context);
	}

	appendFile(path: string, content: string | Uint8Array, context: Context): Promise<Result<void, FileError>> {
		return this.#write(path, content, true, context);
	}

	async truncateFile(path: string, size: number, context: Context): Promise<Result<void, FileError>> {
		return this.#fileOp(
			path,
			context,
			async (resolved) => {
				if (!Number.isSafeInteger(size) || size < 0) {
					throw new FileError("invalid", "File size must be a non-negative safe integer", resolved);
				}
				await this.request("truncate", { path: resolved, size }, { signal: context.abortSignal });
			},
			"both",
		);
	}

	flushFile(path: string, context: Context): Promise<Result<void, FileError>> {
		return this.#fileOp(
			path,
			context,
			async (resolved) => {
				await this.request("fsync", { path: resolved }, { signal: context.abortSignal });
			},
			"both",
		);
	}

	async renameFile(sourcePath: string, destinationPath: string, context: Context): Promise<Result<void, FileError>> {
		let source: string;
		let destination: string;
		try {
			source = await this.#resolve(sourcePath, context.abortSignal);
			destination = await this.#resolve(destinationPath, context.abortSignal);
		} catch (error) {
			return err(toFileError(error, sourcePath));
		}
		const aborted = abortResult<void>(context.abortSignal, destination);
		if (aborted) return aborted;
		try {
			await this.request("rename", { path: source, to: destination }, { signal: context.abortSignal });
			return ok(undefined);
		} catch (error) {
			return err(toFileError(error, source));
		}
	}

	async fileInfo(path: string, context: Context): Promise<Result<FileInfo, FileError>> {
		const result = await this.#fileOp(path, context, async (resolved) => {
			const { json } = await this.request("lstat", { path: resolved }, { signal: context.abortSignal });
			return toInfo(resolved, json as unknown as RemoteFileInfo, posix);
		});
		return result.ok ? result.value : result;
	}

	listDir(path: string, context: Context): Promise<Result<FileInfo[], FileError>> {
		return this.#fileOp(path, context, async (resolved) => {
			const { handle } = await this.#openDir(resolved, context.abortSignal);
			const entries: RemoteDirEntry[] = [];
			try {
				for (let done = false; !done; ) {
					const { json } = await handle.request("readdir", { max: 1000 });
					entries.push(...(json.entries as RemoteDirEntry[]));
					done = json.done === true;
				}
			} finally {
				await handle.close();
			}
			// Node's `readdir` fails on any entry it cannot lstat. libuv sorts names by their bytes on POSIX; on Windows it
			// keeps the file system's order, which the daemon reports.
			const paths = posix;
			if (paths === posix) {
				const key = (entry: RemoteDirEntry) => Buffer.from(entry.raw ?? Buffer.from(entry.name, "utf8"));
				entries.sort((a, b) => Buffer.compare(key(a), key(b)));
			}
			const infos: FileInfo[] = [];
			for (const entry of entries) {
				if (context.abortSignal?.aborted) throw new FileError("aborted", "aborted", resolved);
				const entryPath = paths.resolve(resolved, entry.name);
				if (entry.error !== undefined) throw toFileError(new RemoteError(entry.error), entryPath);
				const info = toInfo(entryPath, entry.info!, paths);
				if (info.ok) infos.push(info.value);
			}
			return infos;
		});
	}

	async #openDir(resolved: string, signal?: AbortSignal): Promise<{ handle: Handle }> {
		const reply = await this.request("opendir", { path: resolved }, { signal });
		return { handle: new Handle(this, reply.json.handle as number, reply.session, resolved) };
	}

	async openDirReader(path: string, context: Context): Promise<Result<DirReader, FileError>> {
		const opened = await this.#fileOp(path, context, async (resolved) => (await this.#openDir(resolved, context.abortSignal)).handle);
		if (!opened.ok) return opened;
		const aborted = this.#closed ? err<DirReader, FileError>(new FileError("aborted", "Remote environment is closed.")) : abortResult<DirReader>(context.abortSignal, opened.value.path);
		if (aborted) {
			await opened.value.close();
			return aborted;
		}
		return ok(new RemoteDirReader(opened.value));
	}

	canonicalPath(path: string, context: Context): Promise<Result<string, FileError>> {
		return this.#fileOp(path, context, async (resolved) => {
			const { json } = await this.request("realpath", { path: resolved }, { signal: context.abortSignal });
			return json.path as string;
		});
	}

	async exists(path: string, context: Context): Promise<Result<boolean, FileError>> {
		const result = await this.fileInfo(path, context);
		if (result.ok) return ok(true);
		if (result.error.code === "not_found") return ok(false);
		return err(result.error);
	}

	createDir(
		path: string,
		options: { recursive?: boolean } | undefined,
		context: Context,
	): Promise<Result<void, FileError>> {
		return this.#fileOp(path, context, async (resolved) => {
			await this.request("mkdir", { path: resolved, recursive: options?.recursive ?? true }, { signal: context.abortSignal });
		});
	}

	remove(
		path: string,
		options: { recursive?: boolean; force?: boolean } | undefined,
		context: Context,
	): Promise<Result<void, FileError>> {
		return this.#fileOp(path, context, async (resolved) => {
			await this.request("rm", {
				path: resolved,
				recursive: options?.recursive ?? false,
				force: options?.force ?? false,
			}, { signal: context.abortSignal });
			// A removed temporary root no longer belongs to us. In particular, do
			// not remove someone else's replacement at this path during shutdown.
			const prefix = resolved === "/" ? "/" : `${resolved}/`;
			for (const temporary of this.#temporary) {
				if (temporary === resolved || (options?.recursive && temporary.startsWith(prefix))) {
					this.#temporary.delete(temporary);
				}
			}
		});
	}

	async createTempDir(prefix: string | undefined, context: Context): Promise<Result<string, FileError>> {
		const aborted = abortResult<string>(context.abortSignal);
		if (aborted) return aborted;
		try {
			const { tmpdir } = await this.#info(context.abortSignal);
			const paths = posix;
			const { json } = await this.request("mkdtemp", { path: paths.join(tmpdir, prefix ?? "tmp-") }, { signal: context.abortSignal });
			this.#temporary.add(json.path as string);
			return ok(json.path as string);
		} catch (error) {
			return err(toFileError(error));
		}
	}

	async createTempFile(
		options: { prefix?: string; suffix?: string } | undefined,
		context: Context,
	): Promise<Result<string, FileError>> {
		const dir = await this.createTempDir("tmp-", context);
		if (!dir.ok) return dir;
		let filePath = "";
		try {
			const paths = posix;
			filePath = paths.join(dir.value, `${options?.prefix ?? ""}${randomUUID()}${options?.suffix ?? ""}`);
			// Node's `writeFile(filePath, "")`, which does not create parents.
			await this.request(
				"write",
				{ path: filePath, append: false, parents: false },
				{ payload: new Uint8Array(0) },
			);
			return ok(filePath);
		} catch (error) {
			return err(toFileError(error, filePath));
		}
	}

	async watch(
		targets: readonly WatchTarget[],
		onChange: (change: WatchChange) => void,
		context: Context,
	): Promise<Result<FileWatcher, FileError>> {
		const aborted = abortResult<FileWatcher>(context.abortSignal);
		if (aborted) return aborted;
		try {
			const resolved = await Promise.all(
				targets.map(async (target) => ({ ...target, path: await this.#resolve(target.path, context.abortSignal) })),
			);
			const afterResolve = abortResult<FileWatcher>(context.abortSignal);
			if (afterResolve) return afterResolve;
			const watcher = await RemoteWatcher.open(this, resolved, onChange, this.#watchOptions, context.abortSignal,
				(closed) => this.#watchers.delete(closed));
			const afterOpen = this.#closed ? err<FileWatcher, FileError>(new FileError("aborted", "Remote environment is closed.")) : abortResult<FileWatcher>(context.abortSignal);
			if (afterOpen) {
				await watcher.close(context);
				return afterOpen;
			}
			// A terminal event may arrive immediately after coverage, before open()
			// returns. Such a watcher has already released its owner registration.
			if (!watcher.isClosed) this.#watchers.add(watcher);
			return ok(watcher);
		} catch (error) {
			return err(toFileError(error));
		}
	}

	async exec(
		command: string | readonly string[],
		options: ShellExecOptions | undefined,
		context: Context,
	): Promise<Result<ShellExecResult, ExecutionError>> {
		const signal = context.abortSignal;
		if (signal?.aborted || this.#closed) return err(new ExecutionError("aborted", "aborted"));
		const timeout = options?.timeout;
		if (timeout !== undefined) {
			if (!Number.isFinite(timeout) || timeout <= 0) {
				return err(new ExecutionError("timeout", "Invalid timeout: must be a finite number of seconds"));
			}
			if (timeout * 1000 > MAX_TIMEOUT_MS) {
				return err(new ExecutionError("timeout", `Invalid timeout: maximum is ${MAX_TIMEOUT_SECONDS} seconds`));
			}
		}
		const inheritEnv = options?.inheritEnv ?? true;
		let cwd: string;
		try {
			cwd = options?.cwd ? await this.#resolve(options.cwd, context.abortSignal) : this.cwd;
		} catch (error) {
			return err(new ExecutionError("unknown", error instanceof Error ? error.message : String(error)));
		}
		if (signal?.aborted || this.#closed) return err(new ExecutionError("aborted", "aborted"));
		const env: Record<string, string> = {};
		for (const [key, value] of Object.entries(
			inheritEnv ? { ...this.#shellEnv, ...options?.env } : { ...options?.env },
		)) {
			if (value !== undefined) env[Buffer.from(key, "utf8").toString("utf8")] = value;
		}
		let callbackError: ExecutionError | undefined;
		let settled = false;
		let running: number | undefined;
		const controller = new AbortController();
		const onAbort = () => controller.abort();
		signal?.addEventListener("abort", onAbort, { once: true });
		try {
			const { json } = await this.request(
				"exec",
				{
					...(typeof command === "string" ? { command } : { argv: [...command] }),
					cwd,
					env,
					inheritEnv,
					...(this.#shellPath === undefined ? {} : { shellPath: this.#shellPath }),
					...(timeout === undefined ? {} : { timeoutMs: timeout * 1000 }),
					...(options?.spill === undefined ? {} : { spill: options.spill }),
					...(options?.window === undefined ? {} : { window: options.window }),
				},
				{
					signal: controller.signal,
					onStart: (requestId, session) => {
						running = requestId;
						this.#running.set(requestId, session);
						if (this.#closed) this.connection.kill(requestId, session);
					},
					onEvent: (event, payload) => {
						if (settled || callbackError !== undefined || event.kind !== "output") return;
						const text = Buffer.from(payload.buffer, payload.byteOffset, payload.length).toString("utf8");
						if (text === "" || options?.onOutput === undefined) return;
						const info: ShellOutputInfo = { stream: event.stream === "stderr" ? "stderr" : "stdout" };
						if (event.skipped !== undefined) info.skipped = event.skipped as ShellOutputSkip;
						try {
							options.onOutput(text, context, info);
						} catch (error) {
							const cause = error instanceof Error ? error : new Error(String(error));
							callbackError = new ExecutionError("callback_error", cause.message, cause);
							controller.abort();
						}
					},
				},
			);
			if (typeof json.spillPath === "string") this.trackSpill(json.spillPath);
			if (callbackError) return err(callbackError);
			return ok({
				exitCode: json.exitCode as number,
				...(typeof json.spillPath === "string" ? { spillPath: json.spillPath } : {}),
			});
		} catch (error) {
			if (error instanceof RemoteError && typeof error.fields.spillPath === "string") {
				this.trackSpill(error.fields.spillPath);
			}
			if (callbackError) return err(callbackError);
			if (error instanceof FileError && error.code === "aborted") return err(new ExecutionError("aborted", error.message));
			if (!(error instanceof RemoteError)) {
				return err(new ExecutionError("unknown", error instanceof Error ? error.message : String(error)));
			}
			const failure =
				error.code === "timeout"
					? new ExecutionError("timeout", `timeout:${timeout}`)
					: error.code === "aborted"
						? new ExecutionError("aborted", "aborted")
						: error.code === "shell_unavailable" || error.code === "spawn_error"
							? new ExecutionError(error.code, error.message)
							: new ExecutionError("unknown", error.message);
			if (typeof error.fields.spillPath === "string") {
				failure.spillPath = error.fields.spillPath;
				this.trackSpill(failure.spillPath);
			}
			return err(failure);
		} finally {
			settled = true;
			signal?.removeEventListener("abort", onAbort);
			if (running !== undefined) this.#running.delete(running);
		}
	}

	private trackSpill(path: string): void {
		this.#temporary.add(path.slice(0, path.lastIndexOf("/")));
	}

	get isClosed(): boolean { return this.#closed; }

	/** Seal admission synchronously, including a pending SSH connection. */
	stop(): void {
		this.#closed = true;
		this.#lifetime.abort();
	}

	private assertOpen(): void {
		if (this.#closed) throw new FileError("aborted", "Remote environment is closed.");
	}

	async #info(signal?: AbortSignal): Promise<RemoteInfo> {
		this.assertOpen();
		const { json } = await this.request("hello", { protocol: 1 }, { signal });
		return json as unknown as RemoteInfo;
	}

	/** Internal resource ownership shared with reader helpers. */
	ownHandle(handle: Handle): void { this.#handles.add(handle); }
	releaseHandle(handle: Handle): void { this.#handles.delete(handle); }

	request(...args: Parameters<Connection["request"]>): ReturnType<Connection["request"]> {
		try { this.assertOpen(); } catch (error) { return Promise.reject(error); }
		const [op, json, options = {}] = args;
		const controller = new AbortController();
		const abort = () => controller.abort();
		const signals = [options.signal, this.#lifetime.signal].filter((signal): signal is AbortSignal => !!signal);
		for (const signal of signals) {
			if (signal.aborted) abort();
			else signal.addEventListener("abort", abort, { once: true });
		}
		const request = (async () => {
			if (options.session === undefined) {
				const info = await this.connection.info(controller.signal);
				if (info.os === "windows") throw new FileError("not_supported", "Remote Windows path semantics are not supported by this mobile adapter.");
			}
			if (this.#closed) throw new FileError("aborted", "Remote environment is closed.");
			return this.connection.request(op, json, { ...options, signal: controller.signal });
		})();
		this.#pending.add(request);
		const settled = () => {
			this.#pending.delete(request);
			for (const signal of signals) signal.removeEventListener("abort", abort);
		};
		request.then(settled, settled);
		return request;
	}

	cleanup(_context: Context): Promise<void> {
		if (this.#closing) return this.#closing;
		this.#closed = true;
		if (!this.#running.size) this.#lifetime.abort();
		for (const [id, session] of this.#running) this.connection.kill(id, session);
		this.#closing = (async () => {
			// Some daemon filesystem calls (for example open of a FIFO) cannot be
			// cancelled individually. Pings keep that daemon alive, so owner shutdown
			// must eventually close its channel rather than wait forever for a result.
			const timer = setTimeout(() => { void this.connection.close(); }, CLEANUP_GRACE_MS);
			try {
				await Promise.allSettled([...this.#watchers].map((watcher) => watcher.close(BACKGROUND_CONTEXT)));
				await Promise.allSettled([...this.#pending]);
				await Promise.allSettled([...this.#handles].map((handle) => handle.close()));
				// Temporary paths survive a daemon restart, unlike opened handles. Use
				// an already connected replacement session for the same immutable host;
				// cleanup alone must not reconnect an unreachable host.
				const session = this.connection.currentSession;
				if (session !== undefined) await Promise.allSettled([...this.#temporary].map((path) =>
					this.connection.request("rm", { path, recursive: true, force: true }, { session })));
			} finally {
				try { await this.connection.close(); }
				finally {
					clearTimeout(timer);
					this.#lifetime.abort();
					this.#watchers.clear();
					this.#temporary.clear();
				}
			}
		})();
		return this.#closing;
	}
}

export type { RemoteInfo };
