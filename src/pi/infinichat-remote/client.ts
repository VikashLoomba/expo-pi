import { createHost, isChordError, webSocketLink, type Ctx, type Link, type Ref } from '@earendil-works/chord';
import type { UserMessage } from '@earendil-works/pi-ai';
import type { SshConnection, SshLocalForward } from '@osuki-dev/react-native-ssh';

import type { ChatMessage } from '../../chat/types';
import type { ChatViewSnapshot, ChatViewSource } from '../chat-view';
import { connectionFailure } from '../execution/remote/channel';
import type { RemoteHostRepository } from '../execution/remote/hosts';
import type { ScheduledTask } from '../infinichat-scheduled';
import type { InfiniChatHost, InfiniChatSnapshot } from '../infinichat-service';
import type { InfiniChatControls } from '../infinichat-view';
import type { ScheduledInput } from '../infinichat/schedule';
import type { ChatModelSettings, ModelCatalog } from '../model-catalog';
import type { ProviderAccess } from '../provider-credentials';
import { InfiniChatRemote, type InfiniChatPrincipal, type SignInAttempt } from './contract';
import {
  connectAdmitted, installServer, runningServer, savedSecret, SERVER_BUNDLE, type InstallStage,
} from './install';

type ConnectionStatus =
  | { status: 'connecting'; stage?: InstallStage }
  | { status: 'connected' }
  | { status: 'failed'; error: string };
/** The phone's connection to a machine's InfiniChat; `notice` is what the latest install said, until dismissed. */
export type RemoteConnection = ConnectionStatus & { notice?: string };

type InfiniChatRef = Ref<typeof InfiniChatRemote>;
/** The sign-ins of the machine's own credential store, by provider. */
export type MachineAccess = Readonly<Record<string, ProviderAccess>>;
/** One connection attempt's SSH connection, tunnel and link; `live` once its server's reference is. */
interface Session { connection?: SshConnection; forward?: SshLocalForward; link?: Link; live: boolean }
type Target = { port: number; secret: string };

/**
 * React Native's own declaration of its WebSocket constructor, restated from
 * `react-native/src/types/globals.d.ts:569-578`: request headers are the third argument
 * (`Libraries/WebSocket/WebSocket.js:100`). Expo's tsconfig loads the DOM lib first, whose constructor declares two,
 * and a constructor of fewer parameters is assignable to this type as it is.
 */
type HeaderWebSocket = new (url: string, protocols: undefined, options: { headers: Record<string, string> }) =>
  WebSocket;
const NativeWebSocket: HeaderWebSocket = WebSocket;

/** Chord's code prefix, which `fromWireError` adds to a server's error again (chord `src/errors.ts:36`). */
const CODE_PREFIX = /^[a-z_]+(\/[a-z_]+)?: /;
const LOADING: ChatViewSnapshot = { status: 'loading' };
const NO_MESSAGES: readonly ChatMessage[] = [];
const NO_REPORT: InfiniChatSnapshot = {};

/** An error as the error notice shows a local one: a Chord error's message without its code. */
function plain(error: unknown): Error {
  if (isChordError(error)) return new Error(error.message.replace(CODE_PREFIX, ''), { cause: error });
  return error instanceof Error ? error : new Error(String(error));
}

/**
 * InfiniChat running on a configured machine, shown through one Chord client host whose upstream is a WebSocket
 * tunnelled over SSH to the server's loopback port (piece 1's `server/listen.ts`). The host holds the contract once;
 * after a lost link `host.connect` re-holds it, and the screens keep the last values meanwhile. It borrows the
 * machine record and the phone's secret, and closes only the connections it opened, which are its own: the tools'
 * daemon connections in owner.ts are not used while the machine runs InfiniChat.
 */
export class RemoteInfiniChat implements InfiniChatHost {
  private readonly host = createHost<InfiniChatPrincipal>({ name: 'phone', self: { kind: 'owner' }, kind: 'client' });
  private readonly listeners = new Set<() => void>();
  private ref?: InfiniChatRef;
  private session?: Session;
  /** The attempt under way, which `close` cancels. */
  private attempt?: AbortController;
  private running: Promise<void> = Promise.resolve();
  /** Aborted with a failed attempt's error, so the calls waiting for that connection reject with it. */
  private calls = new AbortController();
  private notice?: string;
  private values?: {
    view: ChatViewSnapshot; controls: InfiniChatControls | undefined; messages: readonly ChatMessage[];
    scheduled: readonly ScheduledTask[]; catalog: ModelCatalog; access: MachineAccess; signIn: SignInAttempt;
  };
  private report = NO_REPORT;
  private status: ConnectionStatus = { status: 'connecting' };
  private connection: RemoteConnection = this.status;
  private closed = false;
  private closing?: Promise<void>;

  constructor(private readonly hosts: RemoteHostRepository, private readonly machineId: string) {}

  /** One store for the view, the report, the scheduled tasks and the connection. */
  readonly subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  };
  /** The server's latest report, until it is dismissed there. */
  readonly getSnapshot = () => this.report;
  readonly getConnection = () => this.connection;
  readonly scheduled = { subscribe: this.subscribe, getSnapshot: () => this.values?.scheduled };
  private readonly shown: ChatViewSource<InfiniChatControls> = {
    subscribe: this.subscribe,
    getSnapshot: () => this.values?.view ?? LOADING,
    getControls: () => this.values?.controls,
    getMessages: () => this.values?.messages ?? NO_MESSAGES,
  };

  view(): ChatViewSource<InfiniChatControls> {
    return this.shown;
  }

  /** The machine's providers and models, its own sign-ins and its latest sign-in attempt; undefined until shown. */
  readonly getCatalog = () => this.values?.catalog;
  readonly getAccess = () => this.values?.access;
  readonly getSignIn = () => this.values?.signIn;

  /** Starts a sign-in on the machine, ending one under way there, and resolves with its attempt number. */
  signIn(providerId: string): Promise<number> {
    return this.call((ref, ctx) => ref.signIn({ providerId }, ctx));
  }

  answer(promptId: number, value: string): Promise<void> {
    return this.call((ref, ctx) => ref.answer({ promptId, value }, ctx));
  }

  cancelSignIn(): Promise<void> {
    return this.call((ref, ctx) => ref.cancelSignIn(ctx));
  }

  setApiKey(providerId: string, key: string): Promise<void> {
    return this.call((ref, ctx) => ref.setApiKey({ providerId, key }, ctx));
  }

  signOut(providerId: string): Promise<void> {
    return this.call((ref, ctx) => ref.signOut({ providerId }, ctx));
  }

  /**
   * Resolves with what `read` finds in sign-in attempt `attempt` while it runs. Its number can arrive before the state
   * that shows it, so an earlier attempt or none means not yet; it rejects once the attempt has ended, once a later one
   * shows, once it is gone after it showed (a restarted server), or with `signal`'s reason.
   */
  signInStep<T>(attempt: number, read: (shown: Exclude<SignInAttempt, null>) => T | undefined,
    signal: AbortSignal): Promise<T> {
    return new Promise((resolve, reject) => {
      let seen = false;
      const settle = (finish: () => void) => {
        stop();
        signal.removeEventListener('abort', abort);
        finish();
      };
      const check = () => {
        const shown = this.values?.signIn ?? null;
        if (shown?.attempt === attempt && shown.running) {
          seen = true;
          const value = read(shown);
          if (value !== undefined) settle(() => resolve(value));
        } else if (seen || (shown !== null && shown.attempt >= attempt)) {
          settle(() => reject(new Error('Sign-in ended.')));
        }
      };
      const abort = () => settle(() => reject(signal.reason));
      const stop = this.subscribe(check);
      signal.addEventListener('abort', abort, { once: true });
      if (signal.aborted) abort();
      else check();
    });
  }

  accept(input: UserMessage['content'], requestId: string): Promise<void> {
    return this.call((ref, ctx) => ref.accept({ content: input, requestId }, ctx));
  }

  stop(): Promise<void> {
    return this.call((ref, ctx) => ref.stop(ctx));
  }

  updateSettings(main: ChatModelSettings, summary: ChatModelSettings, instructions: string): Promise<void> {
    return this.call((ref, ctx) => ref.updateSettings({ main, summary, instructions }, ctx));
  }

  cancelScheduled(id: number, replacement?: ScheduledInput): Promise<boolean> {
    return this.call((ref, ctx) => ref.cancelScheduled(replacement === undefined ? { id } : { id, replacement }, ctx));
  }

  /** The report stays until the server clears it, so a dismissal that fails can be repeated. */
  dismissError(): void {
    void this.call((ref, ctx) => ref.dismissError(ctx)).catch(() => {});
  }

  dismissNotice(): void {
    this.notice = undefined;
    this.publishConnection();
  }

  /**
   * The app is back from the background. iOS suspended Chord's pinger and the SSH keepalive meanwhile, so a link that
   * looks live may be dead: replace it as after a drop. `host.connect` re-holds the reference, which keeps its values.
   */
  resume(): void {
    this.dropped(this.session);
    this.reconnect();
  }

  /**
   * Connects unless connected or connecting, on demand as the daemon connection restarts: when the socket, the tunnel
   * or the SSH session closes, when the app becomes active, and when the user acts. A failure stays until then. Coming
   * back from the background replaces even a live link (`resume`).
   */
  reconnect(): void {
    if (this.closed || this.attempt || this.session?.live) return;
    const attempt = new AbortController();
    this.attempt = attempt;
    this.publishConnection({ status: 'connecting' });
    this.running = (async () => {
      try {
        await this.connect(attempt.signal);
        this.attempt = undefined;
        this.publishConnection({ status: 'connected' });
      } catch (error) {
        this.attempt = undefined;
        if (attempt.signal.aborted) return;
        const failure = plain(error);
        const waiting = this.calls;
        this.calls = new AbortController();
        waiting.abort(failure);
        this.publishConnection({ status: 'failed', error: failure.message });
      }
    })();
  }

  /**
   * Runs when the choice changes or the provider unmounts: cancels an attempt, releases the reference, closes the
   * client host and its link, then the tunnel and the SSH connection.
   */
  close(): Promise<void> {
    this.closing ??= (async () => {
      this.closed = true;
      this.attempt?.abort();
      this.calls.abort(new Error(`InfiniChat no longer runs on ${this.name}.`));
      this.listeners.clear();
      await this.running;
      const session = this.session;
      this.session = undefined;
      this.ref?.release();
      try {
        await this.host.close();
      } finally {
        if (session) await this.dispose(session);
      }
    })();
    return this.closing;
  }

  private get name(): string {
    return this.hosts.get(this.machineId)?.name ?? 'The machine';
  }

  /**
   * A method of the machine's InfiniChat. Acting while disconnected reconnects; the call waits for that, as a Chord
   * call on a loading reference waits until it is live, and rejects with the attempt's failure.
   */
  private async call<T>(run: (ref: InfiniChatRef, ctx: Ctx<InfiniChatPrincipal>) => Promise<T>): Promise<T> {
    this.reconnect();
    const ref = this.ref;
    if (this.closed || ref === undefined) throw new Error(`InfiniChat on ${this.name} is not connected yet.`);
    const { signal } = this.calls;
    try {
      return await this.host.root((ctx) => run(ref, ctx), { signal });
    } catch (error) {
      if (isChordError(error, 'aborted') && error.cause instanceof Error) throw error.cause;
      // The server may have received a call whose link closed under it, or whose reference it forced away; the screens
      // resend with the same request ID, which OptChat admits once.
      if ((isChordError(error, 'unavailable') || isChordError(error, 'gone')) && !this.session?.live) {
        throw new Error(`The connection to ${this.name} was lost. Try again.`);
      }
      throw plain(error);
    }
  }

  /**
   * One attempt: installs or updates the machine's server only when needed, then opens the tunnel, the socket and the
   * reference. Install runs when this phone has no secret for the machine, when `server.json` names no live server of
   * this bundle, and when the server refuses the socket or is another bundle or device.
   */
  private async connect(signal: AbortSignal): Promise<void> {
    const session: Session = { live: false };
    this.session = session;
    let installed = false;
    const install = async (): Promise<Target> => {
      const server = await installServer(this.hosts, this.machineId,
        { signal, onProgress: (stage) => this.publishConnection({ status: 'connecting', stage }) });
      installed = true;
      this.notice = server.notice;
      this.publishConnection({ status: 'connecting' });
      return server;
    };
    try {
      // As owner.ts checks a chat's machine, with InfiniChat's own way out.
      await this.hosts.restore();
      if (!this.hosts.get(this.machineId)) {
        throw new Error('This machine was removed from Remote machines. Choose This iPhone or another machine in the '
          + 'InfiniChat header.');
      }
      const secret = await savedSecret(this.machineId);
      const admission = await this.hosts.admit(this.machineId);
      const name = admission.host.name;
      const connection = await connectAdmitted(admission, { signal, onDisconnected: () => this.dropped(session) });
      session.connection = connection;
      const port = secret === undefined ? undefined : await runningServer(connection, name, signal);
      let target = secret !== undefined && port !== undefined ? { port, secret } : await install();
      while (!(await this.open(session, connection, target, name, signal))) {
        if (installed) throw new Error(`InfiniChat on ${name} did not accept this iPhone. Try again.`);
        target = await install();
      }
      session.live = true;
      this.refresh();
      // The next connect sends it again, so one lost with its link changes nothing.
      this.ref?.setTimeZone({ zone: Intl.DateTimeFormat().resolvedOptions().timeZone }).catch(() => {});
    } catch (error) {
      if (this.session === session) this.session = undefined;
      await this.dispose(session);
      throw error;
    }
  }

  /**
   * Tunnels to the server's port and connects the client host over a new socket, which re-holds the reference.
   * Resolves true once the reference is live and this bundle's server for this device answers; false when the
   * socket closed first, as a stale port or another phone's secret makes it.
   */
  private async open(session: Session, connection: SshConnection, target: Target, name: string,
    signal: AbortSignal): Promise<boolean> {
    session.link?.close();
    await session.forward?.close().catch(() => {});
    session.forward = await connection.forwardLocal({ remoteHost: '127.0.0.1', remotePort: target.port },
      { onClosed: (reason) => { if (reason !== undefined) this.dropped(session); } })
      .catch((error: unknown) => {
        throw connectionFailure(error);
      });
    const socket = new NativeWebSocket(`ws://127.0.0.1:${session.forward.localPort}`, undefined,
      { headers: { authorization: `Bearer ${target.secret}` } });
    // The client side of a link never deflates, which Hermes could not inflate anyway.
    const link = webSocketLink(socket);
    session.link = link;
    link.onClose(() => this.dropped(session));
    this.host.connect(link, { principal: { kind: 'host' } });
    const ref = this.ref === undefined || this.ref.status === 'gone' ? this.hold() : this.ref;
    const live = await new Promise<boolean>((resolve, reject) => {
      const settle = (finish: () => void) => {
        stopStatus();
        signal.removeEventListener('abort', abort);
        finish();
      };
      const stopStatus = ref.onStatus((status, error) => {
        if (status === 'live') settle(() => resolve(true));
        else if (status === 'gone') settle(() => reject(error));
      });
      const abort = () => settle(() => reject(signal.reason));
      signal.addEventListener('abort', abort, { once: true });
      link.onClose(() => settle(() => resolve(false)));
      if (signal.aborted) abort();
    });
    if (!live) return false;
    const { bundle, device } = ref.server.value;
    return bundle === SERVER_BUNDLE && device === name;
  }

  /** The one reference to the machine's InfiniChat, held again only after the server forced it away. */
  private hold(): InfiniChatRef {
    const ref = this.host.hold(InfiniChatRemote, {});
    this.ref = ref;
    ref.snapshot.subscribe(this.refresh);
    ref.controls.subscribe(this.refresh);
    ref.messages.subscribe(this.refresh);
    ref.scheduled.subscribe(this.refresh);
    ref.access.subscribe(this.refresh);
    ref.signInAttempt.subscribe(this.refresh);
    // Forced away while connected, as when the server shuts down: connecting again holds a new one.
    ref.onStatus((status) => {
      if (status === 'gone') this.dropped(this.session);
    });
    return ref;
  }

  /** Copies the reference's state once an attempt has checked which server answers. */
  private readonly refresh = () => {
    const ref = this.ref;
    if (ref === undefined || !this.session?.live) return;
    const { view, report } = ref.snapshot.value;
    this.values = { view, controls: ref.controls.value ?? undefined, messages: ref.messages.value,
      scheduled: ref.scheduled.value, catalog: ref.catalog.value, access: ref.access.value,
      signIn: ref.signInAttempt.value };
    if (report !== this.report.error) this.report = report === undefined ? NO_REPORT : { error: report };
    this.notify();
  };

  /** A live session lost its socket, its tunnel or its SSH connection: dispose of it and connect again. */
  private dropped(session: Session | undefined) {
    if (session === undefined || session !== this.session || !session.live) return;
    this.session = undefined;
    void this.dispose(session);
    this.reconnect();
  }

  private async dispose(session: Session): Promise<void> {
    session.link?.close();
    await session.forward?.close().catch(() => {});
    await session.connection?.disconnect().catch(() => {});
  }

  private publishConnection(status?: ConnectionStatus) {
    if (status) this.status = status;
    this.connection = this.notice === undefined ? this.status : { ...this.status, notice: this.notice };
    this.notify();
  }

  private notify() {
    for (const listener of [...this.listeners]) listener();
  }
}
