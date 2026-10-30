import { createHost, isChordError, type Ctx, type Link, type Ref } from '@earendil-works/chord';
import type { UserMessage } from '@earendil-works/pi-ai';

import type { ChatMessage } from '../../chat/types';
import type { ChatViewSnapshot, ChatViewSource } from '../chat-view';
import type { ScheduledTask } from '../infinichat-scheduled';
import type { InfiniChatHost, InfiniChatSettings, InfiniChatSnapshot } from '../infinichat-service';
import type { InfiniChatControls } from '../infinichat-view';
import type { ScheduledInput } from '../infinichat/schedule';
import type { ModelCatalog } from '../model-catalog';
import type { ProviderAccess } from '../provider-credentials';
import {
  InfiniChatRemote, type ConversationFiles, type ConversationState, type InfiniChatClient, type InfiniChatPrincipal,
  type Machine, type PendingHostKeys, type Reach, type SignInAttempt,
} from './contract';
import type { DialedServer, InstallStage, MachineDirectory, ServerDialer } from './dialer';
import type { MachinePatch, MachinesState } from './machines';
import { compareVersions } from './release';

type ConnectionStatus =
  | { status: 'connecting'; stage?: InstallStage }
  | { status: 'connected' }
  | { status: 'failed'; error: string };
/** This app's connection to a machine's InfiniChat; `notice` is what the latest install said, until dismissed. */
export type RemoteConnection = ConnectionStatus & { notice?: string };

type InfiniChatRef = Ref<typeof InfiniChatRemote>;
/** The sign-ins of the machine's own credential store, by provider. */
export type MachineAccess = Readonly<Record<string, ProviderAccess>>;
/** One connection attempt's dialed server; `live` once its server's reference is. */
interface Session { server?: DialedServer; live: boolean }

/** Chord's code prefix, which `fromWireError` adds to a server's error again (chord `src/errors.ts:36`). */
const CODE_PREFIX = /^[a-z_]+(\/[a-z_]+)?: /;
const LOADING: ChatViewSnapshot = { status: 'loading' };
const NO_MESSAGES: readonly ChatMessage[] = [];
const NO_REPORT: InfiniChatSnapshot = {};
/** A failed attempt is tried again as pi-env's watcher reconnects its daemon (`dist/watch.js:4-5` at v1.4.0). */
const RECONNECT_FIRST_MS = 1000;
const RECONNECT_MAX_MS = 30_000;

/** An error as the error notice shows a local one: a Chord error's message without its code. */
function plain(error: unknown): Error {
  if (isChordError(error)) return new Error(error.message.replace(CODE_PREFIX, ''), { cause: error });
  return error instanceof Error ? error : new Error(String(error));
}

/**
 * InfiniChat running on a configured machine, shown through one Chord client host whose upstream is the link the
 * app's dialer makes to the machine's server. The host holds the contract once; after a lost link `host.connect`
 * re-holds it, and the screens keep the last values meanwhile. It closes each dialed server's link and transport
 * through the dialer, and borrows the machine directory. The machine's own tools reach the conversation's other
 * machines with its own SSH, from the machines document it serves. `client` is this app as the server's client: its
 * ID and the name a move back records. `version` is the server release this app was built with, which tells which
 * side is behind when the server's contract doesn't cover this app's.
 */
export class RemoteInfiniChat implements InfiniChatHost {
  private readonly host = createHost<InfiniChatPrincipal>({ name: 'phone', self: { kind: 'owner' }, kind: 'client' });
  private readonly listeners = new Set<() => void>();
  private readonly scheduledListeners = new Set<() => void>();
  private ref?: InfiniChatRef;
  private session?: Session;
  /** The attempt under way, which `close` and `resume` cancel. */
  private attempt?: AbortController;
  private running: Promise<void> = Promise.resolve();
  /** The next attempt after a failure, and how long after the next failure the one after it comes. */
  private retry?: ReturnType<typeof setTimeout>;
  private delay = RECONNECT_FIRST_MS;
  /** Aborted with a failed attempt's error, so the calls waiting for that connection reject with it. */
  private calls = new AbortController();
  private notice?: string;
  private values?: {
    view: ChatViewSnapshot; controls: InfiniChatControls | undefined; messages: readonly ChatMessage[];
    scheduled: readonly ScheduledTask[] | undefined; catalog: ModelCatalog; access: MachineAccess;
    signIn: SignInAttempt; conversation: ConversationState; machines: MachinesState | undefined; reach: Reach;
    pendingHostKeys: PendingHostKeys;
  };
  private report = NO_REPORT;
  private status: ConnectionStatus = { status: 'connecting' };
  private connection: RemoteConnection = this.status;
  private closed = false;
  private closing?: Promise<void>;
  private readonly machineListeners = new Set<() => void>();

  constructor(private readonly dialer: ServerDialer, private readonly directory: MachineDirectory,
    private readonly client: InfiniChatClient, private readonly version: string) {}

  /** The machine's endpoint, its ID in this app. */
  get machineId(): string {
    return this.directory.id;
  }

  /** One store for the view, the report, the scheduled tasks and the connection; `scheduled` also has its own. */
  readonly subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  };
  /** The server's latest report, until it is dismissed there. */
  readonly getSnapshot = () => this.report;
  readonly getConnection = () => this.connection;
  /**
   * The machine's waiting tasks; undefined until connected, and while the machine hasn't opened and read them. A store
   * of its own, which notifies only when the list changes, not at every streamed change of the view.
   */
  readonly scheduled = {
    subscribe: (listener: () => void) => {
      this.scheduledListeners.add(listener);
      return () => { this.scheduledListeners.delete(listener); };
    },
    getSnapshot: () => this.values?.scheduled,
  };
  /** The conversation's machines document as the machine serves it; undefined until connected and while it is away. */
  readonly machines = {
    subscribe: (listener: () => void) => {
      this.machineListeners.add(listener);
      return () => { this.machineListeners.delete(listener); };
    },
    getSnapshot: () => this.values?.machines,
  };
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
  /** Whether the machine holds the conversation open, and the files it adopted; undefined until connected. */
  readonly getConversation = () => this.values?.conversation;
  /**
   * Whether the machine reached each other machine the last time it tried, and the host keys it found there that wait
   * for a client, by endpoint (`machineEndpoint`); undefined until connected.
   */
  readonly getReach = () => this.values?.reach;
  readonly getPendingHostKeys = () => this.values?.pendingHostKeys;

  /** The release of the server answering now, once connected. */
  serverVersion(): string | undefined {
    return this.session?.live ? this.ref?.server.value.version : undefined;
  }

  /** Asks the machine's server to update itself now, through the connection's machine. */
  async requestUpdate(): Promise<void> {
    await this.session?.server?.requestUpdate();
  }

  /**
   * Resolves once connected to the machine's server, setting it up as needed. Rejects as a call waiting for the
   * connection does: with a failed attempt's error, or when this client closes.
   */
  connected(signal: AbortSignal): Promise<void> {
    this.reconnect();
    const calls = this.calls.signal;
    return new Promise((resolve, reject) => {
      const settle = (finish: () => void) => {
        stop();
        signal.removeEventListener('abort', abort);
        calls.removeEventListener('abort', ended);
        finish();
      };
      const check = () => {
        const { status } = this;
        if (status.status === 'connected') settle(resolve);
        else if (status.status === 'failed') settle(() => reject(new Error(status.error)));
      };
      const abort = () => settle(() => reject(signal.reason));
      const ended = () => settle(() => reject(calls.reason));
      const stop = this.subscribe(check);
      signal.addEventListener('abort', abort, { once: true });
      calls.addEventListener('abort', ended, { once: true });
      if (signal.aborted) abort();
      else if (calls.aborted) ended();
      else check();
    });
  }

  /** Opens the files this phone copied to the machine, once they match these. */
  adopt(files: ConversationFiles): Promise<void> {
    return this.call((ref, ctx) => ref.adopt(files, ctx));
  }

  /**
   * Closes the conversation on the machine for `to`, this app unless another machine takes it directly, which it
   * records, and names the files it left there.
   */
  relinquish(to: InfiniChatClient = this.client): Promise<ConversationFiles> {
    return this.call((ref, ctx) => ref.relinquish({ to }, ctx));
  }

  /** Has the machine bring the database the machine at `from` released into its own `data/`, once it matches. */
  pull(from: Machine, files: ConversationFiles): Promise<void> {
    return this.call((ref, ctx) => ref.pull({ from, files }, ctx));
  }

  archive(): Promise<void> {
    return this.call((ref, ctx) => ref.archive(ctx));
  }

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

  /** Fetches pi.dev's newer models for the machine's providers; the catalog follows. */
  refreshCatalog(): Promise<void> {
    return this.call((ref, ctx) => ref.refreshCatalog(ctx));
  }

  /** Trusts the host keys with these fingerprints that the machine at `endpoint` presented to this machine. */
  acceptHostKey(endpoint: string, fingerprints: string[]): Promise<void> {
    return this.call((ref, ctx) => ref.acceptHostKey({ endpoint, fingerprints }, ctx));
  }

  putMachine(record: Machine): Promise<void> {
    return this.call((ref, ctx) => ref.putMachine(record, ctx));
  }

  patchMachine(endpoint: string, patch: MachinePatch): Promise<void> {
    return this.call((ref, ctx) => ref.patchMachine({ endpoint, patch }, ctx));
  }

  removeMachine(endpoint: string): Promise<void> {
    return this.call((ref, ctx) => ref.removeMachine({ endpoint }, ctx));
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

  updateSettings(settings: InfiniChatSettings): Promise<void> {
    return this.call((ref, ctx) => ref.updateSettings(settings, ctx));
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
   * looks live may be dead: replace it as after a drop, and an attempt that was under way when the app was suspended
   * starts over, since its transport may be as dead. `host.connect` re-holds the reference, which keeps its values.
   */
  resume(): void {
    this.attempt?.abort();
    this.attempt = undefined;
    this.dropped(this.session);
    this.reconnect();
  }

  /**
   * Connects unless connected or connecting, on demand as the daemon connection restarts: when the link or the
   * transport under it closes, when the app becomes active, and when the user acts. A failure shows until the next
   * attempt, which follows by itself after a delay that doubles up to half a minute, as pi-env's watcher reconnects
   * its daemon (`dist/watch.js:105-110` at v1.4.0); the user's Try Again comes sooner. Coming back from the background
   * replaces even a live link (`resume`).
   */
  reconnect(): void {
    if (this.closed || this.attempt || this.session?.live) return;
    clearTimeout(this.retry);
    this.retry = undefined;
    const attempt = new AbortController();
    this.attempt = attempt;
    this.publishConnection({ status: 'connecting' });
    this.running = (async () => {
      try {
        await this.connect(attempt.signal);
        if (this.attempt === attempt) this.attempt = undefined;
        this.delay = RECONNECT_FIRST_MS;
        this.publishConnection({ status: 'connected' });
      } catch (error) {
        if (this.attempt === attempt) this.attempt = undefined;
        if (attempt.signal.aborted) return;
        const failure = plain(error);
        const waiting = this.calls;
        this.calls = new AbortController();
        waiting.abort(failure);
        this.publishConnection({ status: 'failed', error: failure.message });
        this.retry = setTimeout(() => {
          this.retry = undefined;
          this.reconnect();
        }, this.delay);
        this.delay = Math.min(this.delay * 2, RECONNECT_MAX_MS);
      }
    })();
  }

  /**
   * Runs when the choice changes or the provider unmounts: cancels an attempt, releases the reference, closes the
   * client host, then the dialed server's link and transport.
   */
  close(): Promise<void> {
    this.closing ??= (async () => {
      this.closed = true;
      clearTimeout(this.retry);
      this.attempt?.abort();
      this.calls.abort(new Error(`InfiniChat no longer runs on ${this.name}.`));
      this.listeners.clear();
      this.scheduledListeners.clear();
      this.machineListeners.clear();
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
    return this.directory.machine()?.name ?? 'The machine';
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
   * One attempt: dials the machine's server, which sets it up only when needed, then connects the client host over its
   * link and holds the reference. When the server refuses the socket, this app's key is written again and the server
   * started, unless this attempt already did. A server whose contract doesn't cover this app's (Chord's
   * `upgrade_required`) is either behind this app, and asked to update itself, or ahead of it.
   */
  private async connect(signal: AbortSignal): Promise<void> {
    const session: Session = { live: false };
    this.session = session;
    let installed = false;
    try {
      const server = await this.dialer.dial({
        signal,
        onStage: (stage) => this.publishConnection({ status: 'connecting', stage }),
        onInstalled: (notice) => {
          installed = true;
          this.notice = notice;
          this.publishConnection({ status: 'connecting' });
        },
        onDropped: () => this.dropped(session),
      });
      session.server = server;
      let { link } = server;
      for (;;) {
        let opened: boolean;
        try {
          opened = await this.open(session, link, signal);
        } catch (error) {
          if (!isChordError(error, 'upgrade_required')) throw error;
          if (compareVersions(server.version, this.version) >= 0) {
            throw new Error(`InfiniChat on ${this.name} is newer than this app. Update this app to use it.`);
          }
          await server.requestUpdate();
          throw new Error(`InfiniChat on ${this.name} is updating to work with this app. Try again in a moment.`);
        }
        if (opened) break;
        if (installed) throw new Error(`InfiniChat on ${this.name} did not accept this app. Try again.`);
        link = await server.install();
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
   * Connects the client host over a dialed link, which re-holds the reference. Resolves true once the reference is
   * live; false when the link closed first, as a stale port or a removed client file makes it.
   */
  private async open(session: Session, link: Link, signal: AbortSignal): Promise<boolean> {
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
    return live;
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
    ref.conversation.subscribe(this.refresh);
    ref.machines.subscribe(this.refresh);
    ref.reach.subscribe(this.refresh);
    ref.pendingHostKeys.subscribe(this.refresh);
    // Forced away while connected, as when the server shuts down: connecting again holds a new one.
    ref.onStatus((status) => {
      if (status === 'gone') this.dropped(this.session);
    });
    return ref;
  }

  /** Copies the reference's state once an attempt's reference is live. */
  private readonly refresh = () => {
    const ref = this.ref;
    if (ref === undefined || !this.session?.live) return;
    const { view, report } = ref.snapshot.value;
    const scheduled = ref.scheduled.value ?? undefined;
    // The values are copied here only, once the reference is live, so the list's own store compares; Chord replaces a
    // member's value only when that member changes.
    const rescheduled = scheduled !== this.values?.scheduled;
    const machines = ref.machines.value ?? undefined;
    const relisted = machines !== this.values?.machines;
    this.values = { view, controls: ref.controls.value ?? undefined, messages: ref.messages.value, scheduled,
      catalog: ref.catalog.value, access: ref.access.value, signIn: ref.signInAttempt.value,
      conversation: ref.conversation.value, machines, reach: ref.reach.value,
      pendingHostKeys: ref.pendingHostKeys.value };
    if (report !== this.report.error) this.report = report === undefined ? NO_REPORT : { error: report };
    this.notify();
    if (rescheduled) for (const listener of [...this.scheduledListeners]) listener();
    if (relisted) for (const listener of [...this.machineListeners]) listener();
  };

  /** A live session lost its link or the transport under it: dispose of it and connect again. */
  private dropped(session: Session | undefined) {
    if (session === undefined || session !== this.session || !session.live) return;
    this.session = undefined;
    void this.dispose(session);
    this.reconnect();
  }

  /** Closes the dialed server's link and transport; a close that fails leaves nothing to retry. */
  private async dispose(session: Session): Promise<void> {
    await session.server?.close().catch(() => {});
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
