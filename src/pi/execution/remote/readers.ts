// Reader behavior adapted from Pi Env 1.1.0 (MIT), with mobile resource ownership.
import type { Context } from '@earendil-works/chord';
import {
  err, ok, FileError, type BinaryReader, type DirReader, type FileInfo, type FileKind,
  type LineScan, type Result, type TextLine, type TextLineReader,
} from '@earendil-works/pi-durable/env';
import { type Json, RemoteError } from './connection';
import type { MobileRemoteExecutionEnv } from './environment';
import { abortResult, toFileError } from './errors';
import { posix, type PlatformPath } from './paths';
import { MobileUtf8Decoder } from './utf8';

const READ_DEPTH = 8;
const READ_CHUNK = 256 * 1024;
const LINE_CHUNK = 64 * 1024;

/** An info record from the daemon. */
export type RemoteFileInfo = { name: string; kind: FileKind | "other"; size: number; mtimeSec: number; mtimeNsec: number };
export type RemoteDirEntry = { name: string; raw?: number[]; info?: RemoteFileInfo; error?: Json };

export function toInfo(path: string, remote: RemoteFileInfo, paths: PlatformPath): Result<FileInfo, FileError> {
	if (remote.kind === "other") return err(new FileError("invalid", "Unsupported file type", path));
	return ok({
		name: paths.basename(path),
		path,
		kind: remote.kind,
		size: remote.size,
		mtimeMs: remote.mtimeSec * 1000 + remote.mtimeNsec / 1e6,
	});
}

export function concat(chunks: readonly Uint8Array[], total: number): Uint8Array {
	if (chunks.length === 1) return chunks[0]!;
	const bytes = new Uint8Array(total);
	let position = 0;
	for (const chunk of chunks) {
		bytes.set(chunk, position);
		position += chunk.length;
	}
	return bytes;
}

/**
 * Read `length` bytes from `offset` as consecutive reads of at most `chunk` bytes, several in flight. Ends early at
 * the end of the file. A short read continues from where it ended, as sequential reads would. `aborted` is checked
 * after each read; `undefined` means aborted.
 */
export async function readRange(
	read: (offset: number, length: number) => Promise<Uint8Array>,
	offset: number,
	length: number,
	chunk: number,
	aborted: () => boolean,
): Promise<{ chunks: Uint8Array[]; total: number } | undefined> {
	const chunks: Uint8Array[] = [];
	let total = 0;
	let next = offset;
	const inFlight: { length: number; bytes: Promise<Uint8Array> }[] = [];
	while (total < length) {
		while (inFlight.length < READ_DEPTH && next < offset + length) {
			const size = Math.min(offset + length - next, chunk);
			const bytes = read(next, size);
			bytes.catch(() => {});
			inFlight.push({ length: size, bytes });
			next += size;
		}
		const head = inFlight.shift()!;
		const bytes = await head.bytes;
		if (aborted()) return undefined;
		if (bytes.length === 0) break;
		chunks.push(bytes);
		total += bytes.length;
		if (bytes.length < head.length) {
			// Reads already in flight assumed a full read; continue right after this one.
			inFlight.length = 0;
			next = offset + total;
		}
	}
	return { chunks, total };
}

/** A daemon handle: valid only in the session that opened it. */
export class Handle {
	readonly env: MobileRemoteExecutionEnv;
	readonly id: number;
	readonly session: number;
	readonly path: string;
	#closing?: Promise<void>;

	constructor(env: MobileRemoteExecutionEnv, id: number, session: number, path: string) {
		this.env = env;
		this.id = id;
		this.session = session;
		this.path = path;
		env.ownHandle(this);
	}

	request(op: string, json: Json = {}, options: { signal?: AbortSignal; payload?: Uint8Array } = {}) {
		if (this.#closing) return Promise.reject(new FileError("invalid", "Remote handle is closed", this.path));
		return this.env.request(op, { ...json, handle: this.id }, { ...options, session: this.session });
	}

	async pread(offset: number | undefined, length: number): Promise<Uint8Array> {
		return (await this.request("pread", { ...(offset === undefined ? {} : { offset }), length })).payload;
	}

	async close(): Promise<void> {
		this.#closing ??= this.env.connection.request("close", { handle: this.id }, { session: this.session })
			.then(() => undefined, () => undefined).finally(() => this.env.releaseHandle(this));
		await this.#closing;
	}
}

export class RemoteBinaryReader implements BinaryReader {
	readonly #handle: Handle;
	#closed = false;

	constructor(handle: Handle) {
		this.#handle = handle;
	}

	get #path(): string {
		return this.#handle.path;
	}

	#closedResult<T>(): Result<T, FileError> | undefined {
		return (this.#closed || this.#handle.env.isClosed) ? err(new FileError("invalid", "Binary reader is closed", this.#path)) : undefined;
	}

	async info(context: Context): Promise<Result<FileInfo, FileError>> {
		const early = abortResult<FileInfo>(context.abortSignal, this.#path) ?? this.#closedResult<FileInfo>();
		if (early) return early;
		try {
			const { json } = await this.#handle.request("fstat");
			return toInfo(this.#path, json as unknown as RemoteFileInfo, posix);
		} catch (error) {
			return err(toFileError(error, this.#path));
		}
	}

	async read(offset: number, length: number, context: Context): Promise<Result<Uint8Array, FileError>> {
		const early = abortResult<Uint8Array>(context.abortSignal, this.#path) ?? this.#closedResult<Uint8Array>();
		if (early) return early;
		if (!Number.isSafeInteger(offset) || offset < 0 || !Number.isSafeInteger(length) || length < 0) {
			return err(new FileError("invalid", "Offset and length must be non-negative safe integers", this.#path));
		}
		try {
			const read = await readRange(
				(at, size) => this.#handle.pread(at, size),
				offset,
				length,
				READ_CHUNK,
				() => context.abortSignal?.aborted === true,
			);
			if (read === undefined) return err(new FileError("aborted", "aborted", this.#path));
			return ok(concat(read.chunks, read.total));
		} catch (error) {
			return err(toFileError(error, this.#path));
		}
	}

	async scanLines(
		options: { startLine: number; endLine?: number },
		context: Context,
	): Promise<Result<LineScan, FileError>> {
		const early = abortResult<LineScan>(context.abortSignal, this.#path) ?? this.#closedResult<LineScan>();
		if (early) return early;
		const { startLine, endLine } = options;
		if (
			!Number.isSafeInteger(startLine) ||
			startLine < 0 ||
			(endLine !== undefined && (!Number.isSafeInteger(endLine) || endLine <= startLine))
		) {
			return err(new FileError("invalid", "Invalid line range", this.#path));
		}
		try {
			const { json } = await this.#handle.request(
				"scanLines",
				{ startLine, ...(endLine === undefined ? {} : { endLine }) },
				context.abortSignal ? { signal: context.abortSignal } : {},
			);
			return ok(json as unknown as LineScan);
		} catch (error) {
			return err(toFileError(error, this.#path));
		}
	}

	async close(_context: Context): Promise<void> {
		if (this.#closed) return;
		this.#closed = true;
		await this.#handle.close();
	}
}

export class RemoteDirReader implements DirReader {
	readonly #handle: Handle;
	#done = false;
	#closed = false;

	constructor(handle: Handle) {
		this.#handle = handle;
	}

	async next(
		maxEntries: number,
		context: Context,
	): Promise<Result<{ entries: FileInfo[]; done: boolean }, FileError>> {
		const path = this.#handle.path;
		const aborted = abortResult<{ entries: FileInfo[]; done: boolean }>(context.abortSignal, path);
		if (aborted) return aborted;
		if (this.#closed || this.#handle.env.isClosed) return err(new FileError("invalid", "Directory reader is closed", path));
		if (!Number.isSafeInteger(maxEntries) || maxEntries <= 0) {
			return err(new FileError("invalid", "maxEntries must be a positive safe integer", path));
		}
		const entries: FileInfo[] = [];
		try {
			const paths = posix;
			// Like `NodeDirReader`, count only entries that are part of the listing.
			while (!this.#done && entries.length < maxEntries) {
				const { json } = await this.#handle.request("readdir", { max: maxEntries - entries.length });
				const loopAbort = abortResult<{ entries: FileInfo[]; done: boolean }>(context.abortSignal, path);
				if (loopAbort) return loopAbort;
				for (const entry of json.entries as RemoteDirEntry[]) {
					const entryPath = paths.resolve(path, entry.name);
					if (entry.error !== undefined) {
						// Removed between enumeration and lstat: not part of the listing any more.
						if (entry.error.code === "ENOENT") continue;
						return err(toFileError(new RemoteError(entry.error), entryPath));
					}
					const info = toInfo(entryPath, entry.info!, paths);
					if (info.ok) entries.push(info.value);
				}
				this.#done = json.done === true;
			}
			return ok({ entries, done: this.#done });
		} catch (error) {
			return err(toFileError(error, path));
		}
	}

	async close(_context: Context): Promise<void> {
		if (this.#closed) return;
		this.#closed = true;
		await this.#handle.close();
	}
}

/** `NodeTextLineReader`: positional reads of a file opened like `open(path, "r")`. */
export class RemoteTextLineReader implements TextLineReader {
	readonly #handle: Handle;
	readonly #decoder = new MobileUtf8Decoder(true);
	#offset = 0;
	#buffered = "";
	#ended = false;
	#closed = false;

	constructor(handle: Handle) {
		this.#handle = handle;
	}

	async readLine(context: Context): Promise<Result<TextLine | undefined, FileError>> {
		const path = this.#handle.path;
		const aborted = abortResult<TextLine | undefined>(context.abortSignal, path);
		if (aborted) return aborted;
		if (this.#closed || this.#handle.env.isClosed) return err(new FileError("invalid", "Text line reader is closed", path));
		try {
			while (true) {
				const newline = this.#buffered.indexOf("\n");
				if (newline !== -1) {
					const text = this.#buffered.slice(0, newline);
					this.#buffered = this.#buffered.slice(newline + 1);
					return ok({ text, terminated: true });
				}
				if (this.#ended) {
					if (this.#buffered.length === 0) return ok(undefined);
					const text = this.#buffered;
					this.#buffered = "";
					return ok({ text, terminated: false });
				}
				const bytes = await this.#handle.pread(this.#offset, LINE_CHUNK);
				const afterReadAbort = abortResult<TextLine | undefined>(context.abortSignal, path);
				if (afterReadAbort) return afterReadAbort;
				this.#offset += bytes.length;
				if (bytes.length === 0) {
					this.#buffered += this.#decoder.end();
					this.#ended = true;
				} else {
					this.#buffered += this.#decoder.write(bytes);
				}
			}
		} catch (error) {
			return err(toFileError(error, path));
		}
	}

	async close(_context: Context): Promise<void> {
		if (this.#closed) return;
		this.#closed = true;
		this.#buffered = "";
		await this.#handle.close();
	}
}
