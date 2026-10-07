// Adapted from Pi Env 1.0.4 watch.ts (MIT); watches execute in the remote daemon.
import type { Context } from "@earendil-works/chord";
import { FileError, type FileWatcher, type WatchChange, type WatchTarget } from "@earendil-works/pi-durable/env";
import { type Connection, isConnectionLost } from "./connection";
import { toFileError } from "./errors";

/** How the daemon watches, like `NodeExecutionEnv`'s `NodeWatchOptions`. */
export interface RemoteWatchOptions {
	/** Force a mode; by default Windows and file systems that do not report remote changes poll. */
	mode?: "native" | "polling";
	/** Interval between snapshots in `polling` mode; default 2000 ms. */
	pollIntervalMs?: number;
	/** Most directories one watcher covers; default 10,000. */
	maxDirectories?: number;
}

const RECONNECT_FIRST_MS = 1000;
const RECONNECT_MAX_MS = 30_000;

/**
 * A watcher running in the daemon (Durable's `NodeFileWatcher` next to the files). When the connection is lost, it is
 * opened again once the connection can be started again, and reports `overflow`: changes in between were not seen.
 */
export class RemoteWatcher implements FileWatcher {
	readonly #connection: Pick<Connection, "request">;
	readonly #targets: readonly WatchTarget[];
	readonly #onChange: (change: WatchChange) => void;
	readonly #options: RemoteWatchOptions;
	#onClose: ((watcher: RemoteWatcher) => void) | undefined;
	#mode: "native" | "polling" = "native";
	#closed = false;
	#controller: AbortController | undefined;
	#request: Promise<void> | undefined;
	#wake: (() => void) | undefined;

	private constructor(
		connection: Pick<Connection, "request">,
		targets: readonly WatchTarget[],
		onChange: (change: WatchChange) => void,
		options: RemoteWatchOptions,
		onClose?: (watcher: RemoteWatcher) => void,
	) {
		this.#connection = connection;
		this.#targets = targets;
		this.#onChange = onChange;
		this.#options = options;
		this.#onClose = onClose;
	}

	/** Watch `targets` (resolved paths); fails like `NodeFileWatcher.open` if coverage cannot be established. */
	static async open(
		connection: Pick<Connection, "request">,
		targets: readonly WatchTarget[],
		onChange: (change: WatchChange) => void,
		options: RemoteWatchOptions = {},
		signal?: AbortSignal,
		onClose?: (watcher: RemoteWatcher) => void,
	): Promise<RemoteWatcher> {
		const watcher = new RemoteWatcher(connection, targets, onChange, options, onClose);
		const abort = () => watcher.#controller?.abort();
		signal?.addEventListener("abort", abort, { once: true });
		try {
			if (signal?.aborted) throw new FileError("aborted", "Watch admission was aborted.");
			await watcher.#start();
			if (signal?.aborted) { await watcher.close({} as Context); throw new FileError("aborted", "Watch admission was aborted."); }
			return watcher;
		} catch (error) {
			await watcher.close({} as Context);
			throw error;
		} finally { signal?.removeEventListener("abort", abort); }
	}

	get mode(): "native" | "polling" {
		return this.#mode;
	}

	get isClosed(): boolean { return this.#closed; }

	#markClosed(): void {
		this.#closed = true;
		const onClose = this.#onClose;
		this.#onClose = undefined;
		onClose?.(this);
	}

	async close(_context: Context): Promise<void> {
		this.#markClosed();
		this.#wake?.();
		this.#controller?.abort();
		await this.#request;
	}

	#deliver(change: WatchChange): void {
		if (this.#closed) return;
		try {
			this.#onChange(change);
		} catch {
			// A throwing callback must not stop watching.
		}
	}

	/** Open the daemon's watcher; resolves once it reports coverage. */
	#start(): Promise<void> {
		return new Promise((resolve, reject) => {
			let ready = false;
			const controller = new AbortController();
			this.#controller = controller;
			const request = this.#connection.request(
				"watch",
				{
					targets: this.#targets.map((target) => ({
						path: target.path,
						recursive: target.recursive === true,
						exclude: { hidden: target.exclude?.hidden === true, names: [...(target.exclude?.names ?? [])] },
					})),
					...this.#options,
				},
				{
					signal: controller.signal,
					onEvent: (event) => {
						if (event.kind === "ready") {
							ready = true;
							this.#mode = event.mode === "polling" ? "polling" : "native";
							resolve();
						} else if (event.kind === "change") {
							if (event.mode === "polling") this.#mode = "polling";
							if (event.overflow === true) this.#deliver({ overflow: true });
							else this.#deliver({ paths: event.paths as string[] });
						} else if (event.kind === "error") {
							const code = event.code === "permission_denied" ? "permission_denied" : "invalid";
							this.#deliver({ error: new FileError(code, String(event.message)) });
							this.#markClosed();
						}
					},
				},
			);
			this.#request = request.then(
				() => {
					this.#markClosed();
					if (!ready) reject(new FileError("aborted", "Watch closed before coverage was established."));
				},
				(error: unknown) => {
					if (!ready) {
						reject(error);
						return;
					}
					if (this.#closed) return;
					if (isConnectionLost(error)) {
						void this.#reconnect();
						return;
					}
					this.#deliver({ error: toFileError(error) });
					this.#markClosed();
				},
			);
		});
	}

	async #reconnect(): Promise<void> {
		for (let delay = RECONNECT_FIRST_MS; !this.#closed; delay = Math.min(delay * 2, RECONNECT_MAX_MS)) {
			await new Promise<void>((resolve) => {
				const timer = setTimeout(resolve, delay);
				this.#wake = () => {
					clearTimeout(timer);
					resolve();
				};
			});
			this.#wake = undefined;
			if (this.#closed) return;
			try {
				await this.#start();
				// Changes while disconnected were not seen.
				this.#deliver({ overflow: true });
				return;
			} catch (error) {
				if (isConnectionLost(error)) continue;
				this.#deliver({ error: toFileError(error) });
				this.#markClosed();
				return;
			}
		}
	}
}
