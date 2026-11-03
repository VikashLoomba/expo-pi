import { arr, compile, int, lit, map, obj, oneOf, opt, str } from '@earendil-works/pi-schema';
import { getRandomValues } from 'expo-crypto';

import type { DaemonChannel, DaemonChannelEnd, DaemonChannelFactory } from './channel';
import { encodeFrame, FrameDecoder, FrameType, type Frame, type Json } from './protocol';

export type { Json } from './protocol';

const PING_INTERVAL_MS = 5_000;
/** The daemon pings every five seconds; this much silence means the connection is gone. */
const SILENCE_LIMIT_MS = 30_000;
/** How long the daemon may take to answer `hello` once its channel is open; provisioning bounds its own steps. */
const START_TIMEOUT_MS = 60_000;
/** How much of a daemon's stderr a failed start keeps, as pi-env's client does (`connection.ts` at v1.5.0). */
const STDERR_TAIL_CHARS = 2000;
const STDERR_TAIL_LINES = 20;
/** Node's `stripVTControlCharacters` pattern (`lib/internal/util/inspect.js`), which Hermes has no `node:util` for. */
const VT_CONTROL = new RegExp('[\\u001B\\u009B][[\\]()#;?]*'
  + '(?:(?:(?:(?:;[-a-zA-Z\\d\\/\\#&.:=?%@~_]+)*|[a-zA-Z\\d]+(?:;[-a-zA-Z\\d\\/\\#&.:=?%@~_]*)*)?'
  + '(?:\\u0007|\\u001B\\u005C|\\u009C))|(?:(?:\\d{1,4}(?:;\\d{0,4})*)?[\\dA-PR-TZcf-ntqry=><~]))', 'g');

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
  /** Operations added to protocol 1 that this daemon supports, such as `listFiles`; absent from older daemons. */
  features?: string[];
}

export interface Reply { json: Json; payload: Uint8Array; session: number }

export interface RequestOptions {
  payload?: Uint8Array;
  /** Aborting, even before sending, sends `cancel`; the request still settles with the daemon's result or error. */
  signal?: AbortSignal;
  onEvent?: (json: Json, payload: Uint8Array) => void;
  onStart?: (id: number, session: number) => void;
  /** Handle requests must name their original session and can never reconnect. */
  session?: number;
}

export interface ConnectionOptions {
  /** Runs at each start, like pi-env's `command`; its failure fails that start and the next request tries again. */
  openChannel: DaemonChannelFactory;
}

type Pending = {
  resolve(value: Reply): void;
  reject(error: unknown): void;
  onEvent?: RequestOptions['onEvent'];
};

type Ready = { info: RemoteInfo; session: Session };

class Session {
  readonly id: number;
  readonly token: string;
  readonly decoder: FrameDecoder;
  readonly controller = new AbortController();
  readonly pending = new Map<number, Pending>();
  readonly failed: Promise<never>;
  readonly fail: (error: unknown) => void;
  channel?: DaemonChannel;
  opening?: Promise<DaemonChannel>;
  timer?: ReturnType<typeof setInterval>;
  lastSeen = 0;
  live = true;
  ready = false;
  failure?: unknown;
  /** The end of the daemon's stderr until it is ready, for a start that fails. */
  stderrTail = '';

  constructor(id: number, token: string) {
    this.id = id;
    this.token = token;
    this.decoder = new FrameDecoder(token);
    let fail: (error: unknown) => void = () => {};
    this.failed = new Promise((_, reject) => { fail = reject; });
    this.fail = fail;
    void this.failed.catch(() => {});
  }
}

function lost(message = 'Pi daemon connection lost. An in-flight operation may already have changed remote files.'): RemoteError {
  return new RemoteError({ code: 'unknown', message, lost: true });
}
function closed(): RemoteError { return new RemoteError({ code: 'unknown', message: 'Remote environment connection is closed.' }); }

/**
 * `message` plus the last lines of `stderr`, as pi-env's `withStderr` (`connection.ts` at v1.5.0). The remote machine
 * wrote that text, so terminal escapes and control characters are removed.
 */
function withStderr(message: string, stderr: string): string {
  let text = '';
  for (const char of stderr.replace(/\r\n?/g, '\n').replace(VT_CONTROL, '')) {
    const code = char.charCodeAt(0);
    if (char === '\n' || char === '\t' || (code >= 0x20 && (code < 0x7f || code > 0x9f))) text += char;
  }
  const lines = text.split('\n').map((line) => line.trimEnd()).filter((line) => line !== '');
  if (lines.length === 0) return message;
  return `${message}\nremote stderr:\n${lines.slice(-STDERR_TAIL_LINES).join('\n')}`;
}

/**
 * Why a session's channel ended, as pi-env's client tells a daemon that exits before it answers `hello` from a
 * connection lost later.
 */
function ended(session: Session, end: DaemonChannelEnd | undefined): RemoteError {
  if (session.ready || end === undefined) return lost();
  if ('error' in end) return lost(end.error.message);
  return lost(end.exitCode === undefined
    ? 'pi-env exited before it was ready'
    : `pi-env exited with code ${end.exitCode} before it was ready`);
}

export function isConnectionLost(error: unknown): boolean {
  return error instanceof RemoteError && error.fields.lost === true;
}

function secureToken(): string {
  const bytes = getRandomValues(new Uint8Array(16));
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('');
}

/** The daemon's `hello` reply (pi-env `docs/protocol.md`), which the upstream client takes as `RemoteInfo`. */
const hello = compile(obj({
  protocol: lit(1), version: str(), os: str(), arch: str(), home: str(), tmpdir: str(),
  separator: oneOf(['/', '\\']), cwd: str(), driveCwds: map(str()), pid: int({ minimum: 1 }),
  features: opt(arr(str())),
}, { open: true }));

function remoteInfo(json: Json): RemoteInfo {
  if (hello.check(json)) return json;
  throw lost(
    'Pi daemon returned an incompatible hello response. Test this machine again to verify automatic remote setup.');
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

  async info(): Promise<RemoteInfo> { return (await this.#connect()).info; }
  async session(): Promise<number> { return (await this.#connect()).session.id; }

  async request(op: string, json: Json, options: RequestOptions = {}): Promise<Reply> {
    if (this.#closed) throw closed();
    if (options.session !== undefined) {
      const session = this.#session;
      if (!session?.live || !session.ready || session.id !== options.session) throw lost('This remote handle belongs to a disconnected Pi daemon session.');
      return this.#send(session, op, json, options);
    }
    const { session } = await this.#connect();
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

  #connect(): Promise<Ready> {
    if (this.#closed) return Promise.reject(closed());
    if (!this.#ready) {
      const session = new Session(++this.#sessions, secureToken());
      this.#session = session;
      const ready = this.#start(session);
      this.#ready = ready;
      void ready.catch(() => { if (this.#ready === ready) this.#ready = undefined; });
    }
    return this.#ready;
  }

  async #start(session: Session): Promise<Ready> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    session.opening = Promise.resolve().then(() => this.#options.openChannel({
      token: session.token, signal: session.controller.signal,
      onData: (bytes) => this.#onData(session, bytes),
      onStderr: (text) => {
        if (!session.ready) session.stderrTail = (session.stderrTail + text).slice(-STDERR_TAIL_CHARS);
      },
      onClosed: (end) => this.#teardown(session, ended(session, end)),
    }));
    try {
      session.channel = await Promise.race([session.opening, session.failed]);
      if (!session.live || this.#closed) throw session.failure ?? closed();
      // Like pi-env's session after spawning its daemon, the silence clock starts here: provisioning is not counted.
      session.lastSeen = Date.now();
      session.timer = setInterval(() => {
        if (Date.now() - session.lastSeen > SILENCE_LIMIT_MS) {
          this.#teardown(session, lost('Pi daemon connection timed out. Check the phone Tailscale VPN and remote host.'));
        } else this.#write(session, encodeFrame(FrameType.ping, 0, {}));
      }, PING_INTERVAL_MS);
      timer = setTimeout(() => {
        this.#teardown(session, lost(`The Pi daemon did not answer within ${START_TIMEOUT_MS / 1000} s.`));
      }, START_TIMEOUT_MS);
      const reply = await this.#send(session, 'hello', { protocol: 1 }, {});
      if (reply.payload.length) throw lost('Pi hello unexpectedly contained binary data.');
      const info = remoteInfo(reply.json);
      if (!session.live) throw session.failure ?? lost();
      session.ready = true;
      session.stderrTail = '';
      return { info, session };
    } catch (error) {
      // A start that fails is lost, so a watcher keeps retrying and a caller can tell the connection failed, not the
      // request, and says what the daemon wrote to stderr meanwhile (pi-env `connection.ts:345-354` at v1.5.0). The
      // SSH or setup failure, which pi-env's `ssh` reports as its exit and stderr, stays as the cause.
      const failure = error instanceof RemoteError
        ? new RemoteError({ ...error.fields, message: withStderr(error.message, session.stderrTail) })
        : Object.assign(lost(withStderr(error instanceof Error ? error.message : String(error), session.stderrTail)),
          { cause: error });
      this.#teardown(session, failure);
      throw failure;
    } finally { clearTimeout(timer); }
  }

  #send(session: Session, op: string, json: Json, options: RequestOptions): Promise<Reply> {
    if (!session.live) return Promise.reject(session.failure ?? lost());
    const id = this.#nextId++;
    const bytes = encodeFrame(FrameType.request, id, { ...json, op }, options.payload);
    return new Promise((resolve, reject) => {
      const onAbort = () => this.#write(session, encodeFrame(FrameType.cancel, id, {}));
      const done = () => options.signal?.removeEventListener('abort', onAbort);
      session.pending.set(id, {
        resolve: (value) => { done(); resolve(value); },
        reject: (error) => { done(); reject(error); },
        onEvent: options.onEvent,
      });
      options.signal?.addEventListener('abort', onAbort, { once: true });
      this.#write(session, bytes);
      if (session.live) options.onStart?.(id, session.id);
      if (options.signal?.aborted) onAbort();
    });
  }

  #write(session: Session, bytes: Uint8Array): void {
    if (!session.live || session.channel === undefined) return;
    try { session.channel.write(bytes); }
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
    const pending = session.pending.get(id);
    if (type === FrameType.event) {
      pending?.onEvent?.(json, payload);
      return;
    }
    if (type !== FrameType.result && type !== FrameType.error) return;
    if (pending === undefined) return;
    session.pending.delete(id);
    if (type === FrameType.result) pending.resolve({ json, payload, session: session.id });
    else pending.reject(new RemoteError(json));
  }
}
