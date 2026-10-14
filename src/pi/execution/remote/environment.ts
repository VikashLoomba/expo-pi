// Adapted from Pi Env 1.2.0 remote-env.ts (MIT); the daemon wire contract is protocol 1.
import { uuidv7 as randomUUID } from "@earendil-works/pi-ai";
import { Buffer } from "buffer";
import { posix, resolveRemotePath } from "./paths";
import type { Context } from "@earendil-works/chord";
import {
	type BinaryReader,
	type DirReader,
	type ExecutionEnv,
	ExecutionError,
	err,
	FileError,
	type FileInfo,
	type FileListing,
	type FileWatcher,
	type ListFilesOptions,
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
import { listFilesOver } from "./list-files";
import { invalidReply, jsonField, numberField, stringField } from "./protocol";
import {
  Handle, READ_DEPTH, RemoteBinaryReader, RemoteDirReader, RemoteTextLineReader, readRange, toDirEntries, toInfo,
  toRemoteFileInfo, type RemoteDirEntry,
} from './readers';
import { RemoteWatcher, type RemoteWatchOptions } from "./watch";

const MAX_TIMEOUT_MS = 2_147_483_647;
const MAX_TIMEOUT_SECONDS = MAX_TIMEOUT_MS / 1000;
/** Node's `writeFile` writes at most this much per call and checks for an abort before each. */
const WRITE_CHUNK = 512 * 1024;
const WRITE_DEPTH = 8;
/** Node's `readFile`: chunk of known-size reads, chunk of unknown-size reads, and the largest file it reads. */
const READ_FILE_CHUNK = 512 * 1024;
const READ_FILE_UNKNOWN_CHUNK = 64 * 1024;
const READ_FILE_MAX = 2 ** 31 - 1;

function toOutputSkip(json: Json): ShellOutputSkip {
	const { endsWithNewline } = json;
	if (typeof endsWithNewline !== "boolean") throw invalidReply("endsWithNewline");
	return { bytes: numberField(json, "bytes"), newlines: numberField(json, "newlines"), endsWithNewline };
}

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
	cwd: string;
	readonly connection: Connection;
	readonly #shellPath: string | undefined;
	readonly #shellEnv: Record<string, string> | undefined;
	readonly #watchOptions: RemoteWatchOptions;
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

	/** POSIX lexical paths are available before opening SSH; `~` needs the home the daemon reported. */
	async #resolve(path: string): Promise<string> {
		const home = path === "~" || path.startsWith("~/") ? (await this.connection.info()).home : undefined;
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
			resolved = await this.#resolve(path);
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

	async #open(resolved: string, json: Json): Promise<{ handle: Handle; json: Json }> {
		const reply = await this.connection.request("open", { path: resolved, ...json });
		return { handle: new Handle(this, numberField(reply.json, "handle"), reply.session, resolved), json: reply.json };
	}

	async absolutePath(path: string, _context: Context): Promise<Result<string, FileError>> {
		try {
			return ok(await this.#resolve(path));
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

	/**
	 * Node's `readFile` over a file opened like `open(path, "r")`, as bytes. With `encoding`, it reads the way Node's
	 * `readFile` does when it decodes.
	 */
	async #readFile(path: string, encoding: boolean, context: Context): Promise<Result<Uint8Array, FileError>> {
		const signal = context.abortSignal;
		return this.#fileOp(path, context, async (resolved) => {
			const { handle, json } = await this.#open(resolved, { mode: "read" });
			const aborted = () => signal?.aborted === true;
			const abort = () => new FileError("aborted", "The operation was aborted", resolved);
			try {
				if (json.statError !== undefined) throw new RemoteError(jsonField(json, "statError"));
				if (aborted()) throw abort();
				const stat = toRemoteFileInfo(jsonField(json, "stat"));
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
				if (!encoding) {
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
				}
				// Decoding: reads of min(size, 512 KiB) until the size, a short read, or the end of the file.
				const length = Math.min(size, READ_FILE_CHUNK);
				const readAt = (at: number) => {
					const bytes = handle.pread(at, length);
					bytes.catch(() => {});
					return bytes;
				};
				const inFlight = Array.from({ length: READ_DEPTH }, (_, index) => readAt(index * length));
				const chunks: Uint8Array[] = [];
				let total = 0;
				for (let next = READ_DEPTH * length; ; next += length) {
					const bytes = await inFlight[0];
					if (aborted()) throw abort();
					chunks.push(bytes);
					total += bytes.length;
					if (bytes.length === 0 || total === size || bytes.length !== length) {
						return Buffer.concat(chunks, total);
					}
					inFlight.shift();
					inFlight.push(readAt(next));
				}
			} finally {
				await handle.close();
			}
		});
	}

	/** Node's `readFile(path, "utf8")`: invalid bytes become U+FFFD and a byte-order mark is kept. */
	async readTextFile(path: string, context: Context): Promise<Result<string, FileError>> {
		const bytes = await this.#readFile(path, true, context);
		if (!bytes.ok) return bytes;
		return ok(new TextDecoder("utf-8", { ignoreBOM: true }).decode(bytes.value));
	}

	async readBinaryFile(path: string, context: Context): Promise<Result<Uint8Array, FileError>> {
		return this.#readFile(path, false, context);
	}

	async openBinaryReader(
		path: string,
		options: { noFollow?: boolean } | undefined,
		context: Context,
	): Promise<Result<BinaryReader, FileError>> {
		const opened = await this.#fileOp(path, context, async (resolved) => {
			return (await this.#open(resolved, { noFollow: options?.noFollow === true })).handle;
		});
		if (!opened.ok) return opened;
		const aborted = abortResult<BinaryReader>(context.abortSignal, opened.value.path);
		if (aborted) {
			await opened.value.close();
			return aborted;
		}
		return ok(new RemoteBinaryReader(opened.value));
	}

	async openTextLineReader(path: string, context: Context): Promise<Result<TextLineReader, FileError>> {
		const opened = await this.#fileOp(path, context, async (resolved) => {
			return (await this.#open(resolved, { mode: "read" })).handle;
		});
		if (!opened.ok) return opened;
		const aborted = abortResult<TextLineReader>(context.abortSignal, opened.value.path);
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
				const reply = await this.connection.request("write", { path: resolved, append, keep }, { payload: first });
				if (!keep) return;
				const handle = new Handle(this, numberField(reply.json, "handle"), reply.session, resolved);
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
				await this.connection.request("truncate", { path: resolved, size });
			},
			"both",
		);
	}

	flushFile(path: string, context: Context): Promise<Result<void, FileError>> {
		return this.#fileOp(
			path,
			context,
			async (resolved) => {
				await this.connection.request("fsync", { path: resolved });
			},
			"both",
		);
	}

	async renameFile(sourcePath: string, destinationPath: string, context: Context): Promise<Result<void, FileError>> {
		let source: string;
		let destination: string;
		try {
			source = await this.#resolve(sourcePath);
			destination = await this.#resolve(destinationPath);
		} catch (error) {
			return err(toFileError(error, sourcePath));
		}
		const aborted = abortResult<void>(context.abortSignal, destination);
		if (aborted) return aborted;
		try {
			await this.connection.request("rename", { path: source, to: destination });
			return ok(undefined);
		} catch (error) {
			return err(toFileError(error, source));
		}
	}

	async fileInfo(path: string, context: Context): Promise<Result<FileInfo, FileError>> {
		const result = await this.#fileOp(path, context, async (resolved) => {
			const { json } = await this.connection.request("lstat", { path: resolved });
			return toInfo(resolved, toRemoteFileInfo(json), posix);
		});
		return result.ok ? result.value : result;
	}

	listDir(path: string, context: Context): Promise<Result<FileInfo[], FileError>> {
		return this.#fileOp(path, context, async (resolved) => {
			const { handle } = await this.#openDir(resolved);
			const entries: RemoteDirEntry[] = [];
			try {
				for (let done = false; !done; ) {
					const { json } = await handle.request("readdir", { max: 1000 });
					entries.push(...toDirEntries(json));
					done = json.done === true;
				}
			} finally {
				await handle.close();
			}
			// Node's `readdir` fails on any entry it cannot lstat, and libuv sorts names by their bytes on POSIX.
			const key = (entry: RemoteDirEntry) => Buffer.from(entry.raw ?? Buffer.from(entry.name, "utf8"));
			entries.sort((a, b) => Buffer.compare(key(a), key(b)));
			const infos: FileInfo[] = [];
			for (const entry of entries) {
				if (context.abortSignal?.aborted) throw new FileError("aborted", "aborted", resolved);
				const entryPath = posix.resolve(resolved, entry.name);
				if ("error" in entry) throw toFileError(new RemoteError(entry.error), entryPath);
				const info = toInfo(entryPath, entry.info, posix);
				if (info.ok) infos.push(info.value);
			}
			return infos;
		});
	}

	/** Through the daemon; `not_supported` with a daemon released before `listFiles`. */
	async listFiles(
		path: string,
		options: ListFilesOptions | undefined,
		context: Context,
	): Promise<Result<FileListing, FileError>> {
		let resolved: string;
		try {
			resolved = await this.#resolve(path);
		} catch (error) {
			return err(toFileError(error, path));
		}
		return listFilesOver(this.connection, resolved, options, context);
	}

	async #openDir(resolved: string): Promise<{ handle: Handle }> {
		const reply = await this.connection.request("opendir", { path: resolved });
		return { handle: new Handle(this, numberField(reply.json, "handle"), reply.session, resolved) };
	}

	async openDirReader(path: string, context: Context): Promise<Result<DirReader, FileError>> {
		const opened = await this.#fileOp(path, context, async (resolved) => (await this.#openDir(resolved)).handle);
		if (!opened.ok) return opened;
		const aborted = abortResult<DirReader>(context.abortSignal, opened.value.path);
		if (aborted) {
			await opened.value.close();
			return aborted;
		}
		return ok(new RemoteDirReader(opened.value));
	}

	canonicalPath(path: string, context: Context): Promise<Result<string, FileError>> {
		return this.#fileOp(path, context, async (resolved) => {
			const { json } = await this.connection.request("realpath", { path: resolved });
			return stringField(json, "path");
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
			await this.connection.request("mkdir", { path: resolved, recursive: options?.recursive ?? true });
		});
	}

	remove(
		path: string,
		options: { recursive?: boolean; force?: boolean } | undefined,
		context: Context,
	): Promise<Result<void, FileError>> {
		return this.#fileOp(path, context, async (resolved) => {
			await this.connection.request("rm", {
				path: resolved,
				recursive: options?.recursive ?? false,
				force: options?.force ?? false,
			});
		});
	}

	async createTempDir(prefix: string | undefined, context: Context): Promise<Result<string, FileError>> {
		const aborted = abortResult<string>(context.abortSignal);
		if (aborted) return aborted;
		try {
			const { tmpdir } = await this.connection.info();
			const { json } = await this.connection.request("mkdtemp", { path: posix.join(tmpdir, prefix ?? "tmp-") });
			return ok(stringField(json, "path"));
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
			filePath = posix.join(dir.value, `${options?.prefix ?? ""}${randomUUID()}${options?.suffix ?? ""}`);
			// Node's `writeFile(filePath, "")`, which does not create parents.
			await this.connection.request(
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
				targets.map(async (target) => ({ ...target, path: await this.#resolve(target.path) })),
			);
			const afterResolve = abortResult<FileWatcher>(context.abortSignal);
			if (afterResolve) return afterResolve;
			const watcher = await RemoteWatcher.open(this.connection, resolved, onChange, this.#watchOptions);
			const afterOpen = abortResult<FileWatcher>(context.abortSignal);
			if (afterOpen) {
				await watcher.close(context);
				return afterOpen;
			}
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
		if (signal?.aborted) return err(new ExecutionError("aborted", "aborted"));
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
			cwd = options?.cwd ? await this.#resolve(options.cwd) : this.cwd;
		} catch (error) {
			return err(new ExecutionError("unknown", error instanceof Error ? error.message : String(error)));
		}
		if (signal?.aborted) return err(new ExecutionError("aborted", "aborted"));
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
			const { json } = await this.connection.request(
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
					},
					onEvent: (event, payload) => {
						if (settled || callbackError !== undefined || event.kind !== "output") return;
						const text = Buffer.from(payload.buffer, payload.byteOffset, payload.length).toString("utf8");
						if (text === "" || options?.onOutput === undefined) return;
						const info: ShellOutputInfo = { stream: event.stream === "stderr" ? "stderr" : "stdout" };
						if (event.skipped !== undefined) info.skipped = toOutputSkip(jsonField(event, "skipped"));
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
			if (callbackError) return err(callbackError);
			return ok({
				exitCode: numberField(json, "exitCode"),
				...(typeof json.spillPath === "string" ? { spillPath: json.spillPath } : {}),
			});
		} catch (error) {
			if (callbackError) return err(callbackError);
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
			if (typeof error.fields.spillPath === "string") failure.spillPath = error.fields.spillPath;
			return err(failure);
		} finally {
			settled = true;
			signal?.removeEventListener("abort", onAbort);
			if (running !== undefined) this.#running.delete(running);
		}
	}

	async cleanup(_context: Context): Promise<void> {
		// Kill without aborting, so the commands settle with their killed status, as `NodeExecutionEnv` does.
		for (const [id, session] of this.#running) this.connection.kill(id, session);
		this.#running.clear();
	}
}

export type { RemoteInfo };
