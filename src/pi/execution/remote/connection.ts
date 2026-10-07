import type { DaemonChannel, DaemonChannelFactory } from './channel';
import { getRandomValues } from '../../bash/engine/native-crypto';
import { encodeFrame, FrameDecoder, FrameType, type Frame, type Json } from './protocol';

export type { Json } from './protocol';

export class RemoteError extends Error {
  readonly code: string;
  readonly path?: string;
  readonly fields: Json;

  constructor(fields: Json) {
    super(typeof fields.message === 'string' ? fields.message : 'Remote operation failed');
    this.name = 'RemoteError';
    this.code = typeof fields.code === 'string' ? fields.code : 'unknown';
    if (typeof fields.path === 'string') this.path = fields.path;
    this.fields = fields;
  }
}

export interface RemoteInfo {
  protocol: number;
  version: string;
  os: string;
  arch: string;
  home: string;
  tmpdir: string;
  separator: string;
  cwd: string;
  driveCwds: Record<string, string>;
  pid: number;
}

export interface Reply { json: Json; payload: Uint8Array; session: number }

export interface RequestOptions {
  payload?: Uint8Array;
  /** Cancellation waits for the daemon's terminal reply, preserving mutation uncertainty. */
  signal?: AbortSignal;
  onEvent?: (json: Json, payload: Uint8Array) => void;
  onStart?: (id: number, session: number) => void;
  /** Handle requests must name their original session and can never reconnect. */
  session?: number;
}

export interface ConnectionOptions {
  openChannel: DaemonChannelFactory;
  /** Defaults match the unchanged Pi v1 daemon. Overrides support deterministic transport tests. */
  startTimeoutMs?: number;
  pingIntervalMs?: number;
  silenceLimitMs?: number;
  token?: () => string;
}

type Pending = {
  resolve(value: Reply): void;
  reject(error: unknown): void;
  onEvent?: RequestOptions['onEvent'];
  callbackError?: RemoteError;
};

type Ready = { info: RemoteInfo; session: Session };

class Session {
  readonly id: number;
  readonly token: string;
  readonly decoder: FrameDecoder;
  readonly controller = new AbortController();
  readonly pending = new Map<number, Pending>();
  readonly waiters = new Set<object>();
  readonly failed: Promise<never>;
  fail!: (error: unknown) => void;
  channel?: DaemonChannel;
  opening?: Promise<DaemonChannel>;
  timer?: ReturnType<typeof setInterval>;
  lastSeen = Date.now();
  live = true;
  ready = false;
  failure?: unknown;

  constructor(id: number, token: string) {
    this.id = id;
    this.token = token;
    this.decoder = new FrameDecoder(token);
    this.failed = new Promise((_, reject) => { this.fail = reject; });
    void this.failed.catch(() => {});
  }
}

function lost(message = 'Pi daemon connection lost. An in-flight operation may already have changed remote files.'): RemoteError {
  return new RemoteError({ code: 'unknown', message, lost: true });
}
function closed(): RemoteError { return new RemoteError({ code: 'unknown', message: 'Remote environment connection is closed.' }); }
function aborted(): RemoteError { return new RemoteError({ code: 'aborted', message: 'Remote operation cancelled.' }); }

export function isConnectionLost(error: unknown): boolean {
  return error instanceof RemoteError && error.fields.lost === true;
}

function secureToken(): string {
  const bytes = getRandomValues(new Uint8Array(16));
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('');
}

function remoteInfo(json: Json): RemoteInfo {
  if (json.protocol !== 1 || !['version', 'os', 'arch', 'home', 'tmpdir', 'cwd', 'separator'].every((key) => typeof json[key] === 'string')
    || !['/', '\\'].includes(json.separator as string) || !Number.isSafeInteger(json.pid) || (json.pid as number) < 1
    || typeof json.driveCwds !== 'object' || json.driveCwds === null || Array.isArray(json.driveCwds)
    || !Object.values(json.driveCwds).every((value) => typeof value === 'string')) {
    throw lost('Pi daemon returned an incompatible hello response. Test this machine again to verify automatic remote setup.');
  }
  return json as unknown as RemoteInfo;
}

/**
 * One lazily opened Pi session. Transport loss fails every admitted request; only a
 * later operation can start a new daemon. There is deliberately no request replay.
 */
export class Connection {
  readonly #options: ConnectionOptions;
  readonly #draining = new Set<Promise<void>>();
  #session?: Session;
  #ready?: Promise<Ready>;
  #sessions = 0;
  #nextId = 1;
  #closed = false;
  #closing?: Promise<void>;

  constructor(options: ConnectionOptions) { this.#options = { ...options }; }

  /** Observe an already connected daemon without starting or reconnecting one. */
  get currentSession(): number | undefined {
    return this.#session?.live && this.#session.ready ? this.#session.id : undefined;
  }

  async info(signal?: AbortSignal): Promise<RemoteInfo> { return (await this.#connect(signal)).info; }
  async session(signal?: AbortSignal): Promise<number> { return (await this.#connect(signal)).session.id; }

  async request(op: string, json: Json, options: RequestOptions = {}): Promise<Reply> {
    if (options.signal?.aborted) throw aborted();
    if (this.#closed) throw closed();
    if (options.session !== undefined) {
      const session = this.#session;
      if (!session?.live || !session.ready || session.id !== options.session) throw lost('This remote handle belongs to a disconnected Pi daemon session.');
      return this.#send(session, op, json, options);
    }
    const { session } = await this.#connect(options.signal);
    return this.#send(session, op, json, options);
  }

  kill(id: number, sessionId: number): void {
    const session = this.#session;
    if (session?.live && session.id === sessionId) this.#write(session, encodeFrame(FrameType.cancel, id, { mode: 'kill' }));
  }

  close(): Promise<void> {
    if (this.#closing) return this.#closing;
    this.#closed = true;
    if (this.#session) this.#teardown(this.#session, closed());
    this.#closing = (async () => {
      while (this.#draining.size) await Promise.all([...this.#draining]);
    })();
    return this.#closing;
  }

  #connect(signal?: AbortSignal): Promise<Ready> {
    if (signal?.aborted) return Promise.reject(aborted());
    if (this.#closed) return Promise.reject(closed());
    if (!this.#ready) {
      const session = new Session(++this.#sessions, (this.#options.token ?? secureToken)());
      this.#session = session;
      const ready = this.#start(session);
      this.#ready = ready;
      void ready.catch(() => { if (this.#ready === ready) this.#ready = undefined; });
    }
    const session = this.#session!;
    const ready = this.#ready;
    const waiter = {};
    session.waiters.add(waiter);
    return new Promise((resolve, reject) => {
      let settled = false;
      const finish = () => {
        settled = true;
        session.waiters.delete(waiter);
        signal?.removeEventListener('abort', onAbort);
      };
      const onAbort = () => {
        if (settled) return;
        finish();
        if (!session.ready && session.waiters.size === 0) this.#teardown(session, aborted());
        reject(aborted());
      };
      signal?.addEventListener('abort', onAbort, { once: true });
      ready.then((value) => { if (!settled) { finish(); resolve(value); } },
        (error) => { if (!settled) { finish(); reject(error); } });
      if (signal?.aborted) onAbort();
    });
  }

  async #start(session: Session): Promise<Ready> {
    const timer = setTimeout(() => this.#teardown(session, lost('Automatic Pi daemon setup timed out. Check the SSH connection and remote account’s home-directory permissions.')),
      this.#options.startTimeoutMs ?? 60_000);
    session.opening = Promise.resolve().then(() => this.#options.openChannel({
      token: session.token, signal: session.controller.signal,
      onData: (bytes) => this.#onData(session, bytes),
      onClosed: () => this.#teardown(session, lost()),
    }));
    try {
      session.channel = await Promise.race([session.opening, session.failed]);
      if (!session.live || this.#closed) throw session.failure ?? closed();
      session.timer = setInterval(() => {
        if (Date.now() - session.lastSeen > (this.#options.silenceLimitMs ?? 30_000)) {
          this.#teardown(session, lost('Pi daemon connection timed out. Check the phone Tailscale VPN and remote host.'));
        } else this.#write(session, encodeFrame(FrameType.ping, 0, {}));
      }, this.#options.pingIntervalMs ?? 5_000);
      const reply = await this.#send(session, 'hello', { protocol: 1 }, {});
      if (reply.payload.length) throw lost('Pi hello unexpectedly contained binary data.');
      const info = remoteInfo(reply.json);
      if (!session.live) throw session.failure ?? lost();
      session.ready = true;
      return { info, session };
    } catch (error) {
      this.#teardown(session, error);
      throw error;
    } finally { clearTimeout(timer); }
  }

  #send(session: Session, op: string, json: Json, options: RequestOptions): Promise<Reply> {
    if (!session.live) return Promise.reject(session.failure ?? lost());
    if (options.signal?.aborted) return Promise.reject(aborted());
    if (this.#nextId > 0xffffffff) {
      this.#teardown(session, lost('Pi request identifiers exhausted; establish a new session.'));
      this.#nextId = 1;
      return Promise.reject(lost());
    }
    const id = this.#nextId++;
    let bytes: Uint8Array;
    try { bytes = encodeFrame(FrameType.request, id, { ...json, op }, options.payload); }
    catch (error) { return Promise.reject(error); }
    return new Promise((resolve, reject) => {
      const onAbort = () => this.#write(session, encodeFrame(FrameType.cancel, id, {}));
      const done = () => options.signal?.removeEventListener('abort', onAbort);
      const pending: Pending = {
        resolve: (value) => { done(); resolve(value); },
        reject: (error) => { done(); reject(error); },
        onEvent: options.onEvent,
      };
      session.pending.set(id, pending);
      options.signal?.addEventListener('abort', onAbort, { once: true });
      this.#write(session, bytes);
      try { if (session.live) options.onStart?.(id, session.id); }
      catch { pending.callbackError = new RemoteError({ code: 'callback_error', message: 'Remote operation callback failed.' }); onAbort(); }
      if (options.signal?.aborted) onAbort();
    });
  }

  #write(session: Session, bytes: Uint8Array): void {
    if (!session.live) return;
    try { session.channel!.write(bytes); }
    catch { this.#teardown(session, lost('SSH could not send the Pi request. The remote operation outcome is unknown.')); }
  }

  #teardown(session: Session, error: unknown): void {
    if (!session.live) return;
    session.live = false;
    session.failure = error;
    clearInterval(session.timer);
    if (this.#session === session) { this.#session = undefined; this.#ready = undefined; }
    session.fail(error);
    for (const request of session.pending.values()) request.reject(error);
    session.pending.clear();
    session.controller.abort();
    // Own an opening channel even if cancellation won before its native promise delivered it.
    const drain = (async () => {
      try { const channel = session.channel ?? await session.opening; await channel?.close(); }
      catch { /* Connection termination is already reflected in every pending request. */ }
    })();
    this.#draining.add(drain);
    void drain.finally(() => this.#draining.delete(drain));
  }

  #onData(session: Session, bytes: Uint8Array): void {
    if (!session.live) return;
    session.lastSeen = Date.now();
    try { session.decoder.push(bytes, (frame) => { if (session.live) this.#dispatch(session, frame); }); }
    catch { this.#teardown(session, lost('Corrupt frame from the Pi daemon.')); }
  }

  #dispatch(session: Session, { type, id, json, payload }: Frame): void {
    if (type === FrameType.ping && id === 0) return;
    if (![FrameType.event, FrameType.result, FrameType.error].includes(type as 2 | 3 | 4) || id === 0) throw new Error('Unexpected Pi frame.');
    const pending = session.pending.get(id);
    if (!pending) return;
    if (type === FrameType.event) {
      if (!pending.callbackError) {
        try { pending.onEvent?.(json, payload); }
        catch {
          pending.callbackError = new RemoteError({ code: 'callback_error', message: 'Remote operation output callback failed.' });
          this.#write(session, encodeFrame(FrameType.cancel, id, {}));
        }
      }
      return;
    }
    session.pending.delete(id);
    if (pending.callbackError) pending.reject(pending.callbackError);
    else if (type === FrameType.error) pending.reject(new RemoteError(json));
    else pending.resolve({ json, payload, session: session.id });
  }
}
