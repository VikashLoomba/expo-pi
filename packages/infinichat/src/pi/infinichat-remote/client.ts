import { createHost, isChordError, type Ctx, type Held, type Link } from '@earendil-works/chord';
import { BACKGROUND_CONTEXT, withAbortSignal } from '@earendil-works/chord/context';
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
import { follow, heard } from './follow';
import type { MachinePatch, MachinesState } from './machines';
import { RemoteMcp } from './mcp-client';
import { compareVersions } from './release';
import { attemptStep } from './sign-in-attempt';

type ConnectionStatus =
  | { status: 'connecting'; stage?: InstallStage }
  | { status: 'connected' }
  | { status: 'failed'; error: string };
/** This app's connection to a machine's InfiniChat; `notice` is what the latest install said, until dismissed. */
export type RemoteConnection = ConnectionStatus & { notice?: string };

type InfiniChatRef = Held<typeof InfiniChatRemote>;
/** The sign-ins of the machine's own credential store, by provider. */
export type MachineAccess = Readonly<Record<string, ProviderAccess>>;
/** One connection attempt's dialed server; `live` once its server's reference is. */
interface Session { server?: DialedServer; live: boolean }

const LOADING: ChatViewSnapshot = { status: 'loading' };
const NO_MESSAGES: readonly ChatMessage[] = [];
const NO_REPORT: InfiniChatSnapshot = {};
/**
 * The server and this app do not fit: its handshake failed, which the host reports as `protocol_error` (chord
 * `docs/design.md` §3, `onError`), or it serves another version of the contract, which leaves the hold waiting with
 * `contract_mismatch` (§5, "Compatibility"). One of the two has to load new code.
 */
class Mismatch extends Error {}

/** A failed attempt is tried again as pi-env's watcher reconnects its daemon (`dist/watch.js:6-7` at v1.5.0). */
const RECONNECT_FIRST_MS = 1000;
const RECONNECT_MAX_MS = 30_000;

/** An error as the error notice shows a local one: a server's error crosses the link with its message. */
function plain(error: unknown): Error {
  return error instanceof Error ? new Error(error.message, { cause: error }) : new Error(String(error));
}

/**
 * InfiniChat running on a configured machine, shown through one Chord client host whose parent is the link the
 * app's dialer makes to the machine's server (chord `docs/design.md` §3: a client has no address and loads nothing).
 * The host holds the contract once; after a lost link `host.connect` takes the next and holds it again, and the
 * screens keep the last values meanwhile (§7). It closes each dialed server's link and transport
 * through the dialer, and borrows the machine directory. The machine's own tools reach the conversation's other
 * machines with its own SSH, from the machines document it serves. `client` is this app as the server's client: its
 * ID and the name a move back records. `version` is the server release this app was built with, which tells which
 * side is behind when the server's contract doesn't cover this app's.
 */
export class RemoteInfiniChat implements InfiniChatHost {
  private readonly host = createHost<InfiniChatPrincipal>({
    onError: (error) => {
      if (error.kind === 'protocol_error') this.mismatched?.();
    },
  });
  /** A client host with nothing to load still publishes once before it may hold (design §3, "publication gate"). */
  private readonly loaded = this.host.load([], BACKGROUND_CONTEXT);
  /** Set while an attempt opens its link: the host reported that link's handshake as a protocol error. */
  private mismatched?: () => void;
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
  /** Aborted at `close`: the reference's hold and its members' watches end with it. */
  private readonly released = new AbortController();
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

  /** The machine's MCP servers, which `/mcp` shows, over this host's link. */
  readonly mcp: RemoteMcp;

  constructor(private readonly dialer: ServerDialer, private readonly directory: MachineDirectory,
    private readonly client: InfiniChatClient, private readonly version: string) {
    this.mcp = new RemoteMcp(this.host, () => this.name, (run) => this.root(run));
  }

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
    // The machine's view loads them into the transcript every client reads.
    loadEarlier: () => this.act((ref, ctx) => ref.loadEarlier(ctx)),
    fillGap: (gap) => this.act((ref, ctx) => ref.fillGap(gap, ctx)),
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
    return this.act((ref, ctx) => ref.adopt(files, ctx));
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
    return this.act((ref, ctx) => ref.pull({ from, files }, ctx));
  }

  archive(): Promise<void> {
    return this.act((ref, ctx) => ref.archive(ctx));
  }

  /** Starts a sign-in on the machine, ending one under way there, and resolves with its attempt number. */
  signIn(providerId: string): Promise<number> {
    return this.call((ref, ctx) => ref.signIn({ providerId }, ctx));
  }

  answer(promptId: number, value: string): Promise<void> {
    return this.act((ref, ctx) => ref.answer({ promptId, value }, ctx));
  }

  cancelSignIn(): Promise<void> {
    return this.act((ref, ctx) => ref.cancelSignIn(ctx));
  }

  setApiKey(providerId: string, key: string): Promise<void> {
    return this.act((ref, ctx) => ref.setApiKey({ providerId, key }, ctx));
  }

  signOut(providerId: string): Promise<void> {
    return this.act((ref, ctx) => ref.signOut({ providerId }, ctx));
  }

  /** Fetches pi.dev's newer models for the machine's providers; the catalog follows. */
  refreshCatalog(): Promise<void> {
    return this.act((ref, ctx) => ref.refreshCatalog(ctx));
  }

  /** Trusts the host keys with these fingerprints that the machine at `endpoint` presented to this machine. */
  acceptHostKey(endpoint: string, fingerprints: string[]): Promise<void> {
    return this.act((ref, ctx) => ref.acceptHostKey({ endpoint, fingerprints }, ctx));
  }

  putMachine(record: Machine): Promise<void> {
    return this.act((ref, ctx) => ref.putMachine(record, ctx));
  }

  patchMachine(endpoint: string, patch: MachinePatch): Promise<void> {
    return this.act((ref, ctx) => ref.patchMachine({ endpoint, patch }, ctx));
  }

  removeMachine(endpoint: string): Promise<void> {
    return this.act((ref, ctx) => ref.removeMachine({ endpoint }, ctx));
  }

  /**
   * Resolves with what `read` finds in sign-in attempt `attempt` while it runs. Its number can arrive before the state
   * that shows it, so an earlier attempt or none means not yet; it rejects once the attempt has ended, once a later one
   * shows, once it is gone after it showed (a restarted server), or with `signal`'s reason.
   */
  signInStep<T>(attempt: number, read: (shown: Exclude<SignInAttempt, null>) => T | undefined,
    signal: AbortSignal): Promise<T> {
    return attemptStep({ subscribe: this.subscribe, getAttempt: this.getSignIn }, attempt, read, signal);
  }

  accept(input: UserMessage['content'], requestId: string): Promise<void> {
    return this.act((ref, ctx) => ref.accept({ content: input, requestId }, ctx));
  }

  continue(): Promise<void> {
    return this.act((ref, ctx) => ref.continue(ctx));
  }

  stop(): Promise<void> {
    return this.act((ref, ctx) => ref.stop(ctx));
  }

  updateSettings(settings: InfiniChatSettings): Promise<void> {
    return this.act((ref, ctx) => ref.updateSettings(settings, ctx));
  }

  cancelScheduled(id: number, replacement?: ScheduledInput): Promise<boolean> {
    return this.call((ref, ctx) => ref.cancelScheduled(replacement === undefined ? { id } : { id, replacement }, ctx));
  }

  reloadPlugins(): Promise<string> {
    return this.call((ref, ctx) => ref.reloadPlugins(ctx));
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
   * its daemon (`dist/watch.js:109-114` at v1.5.0); the user's Try Again comes sooner. Coming back from the background
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
      this.released.abort();
      this.ref?.release();
      this.mcp.release();
      try {
        await this.host.close(BACKGROUND_CONTEXT);
      } finally {
        if (session) await this.dispose(session);
      }
    })();
    return this.closing;
  }

  private get name(): string {
    return this.directory.machine()?.name ?? 'The machine';
  }

  /** A method without a result: Chord answers `null`, its wire form (chord `docs/design.md` §5, "Methods"). */
  private async act(run: (ref: InfiniChatRef, ctx: Ctx<InfiniChatPrincipal>) => Promise<null>): Promise<void> {
    await this.call(run);
  }

  /**
   * A method of the machine's InfiniChat. Acting while disconnected reconnects; the call waits for that, as a Chord
   * call on a loading reference waits until it is live, and rejects with the attempt's failure.
   */
  private call<T>(run: (ref: InfiniChatRef, ctx: Ctx<InfiniChatPrincipal>) => Promise<T>): Promise<T> {
    return this.root((ctx) => {
      const ref = this.ref;
      if (ref === undefined) throw new Error(`InfiniChat on ${this.name} is not connected yet.`);
      return run(ref, ctx);
    });
  }

  /** A call on this host's link, for InfiniChat's reference and the `/mcp` one (`call`). */
  private async root<T>(run: (ctx: Ctx<InfiniChatPrincipal>) => Promise<T>): Promise<T> {
    this.reconnect();
    if (this.closed || this.ref === undefined) throw new Error(`InfiniChat on ${this.name} is not connected yet.`);
    const { signal } = this.calls;
    try {
      return await this.host.root(run, withAbortSignal(signal, BACKGROUND_CONTEXT));
    } catch (error) {
      if (isChordError(error, 'aborted') && signal.reason instanceof Error) throw signal.reason;
      // The server may have received a call whose link closed under it; the screens resend with the same request ID,
      // which OptChat admits once.
      if ((isChordError(error, 'unavailable') || isChordError(error, 'gone') || isChordError(error, 'released'))
          && !this.session?.live) {
        throw new Error(`The connection to ${this.name} was lost. Try again.`);
      }
      throw plain(error);
    }
  }

  /**
   * One attempt: dials the machine's server, which sets it up only when needed, then connects the client host over its
   * link and holds the reference. When the server refuses the socket, this app's key is written again and the server
   * started, unless this attempt already did. A server that doesn't fit this app (`Mismatch`) is either behind it, and
   * asked to update itself, or ahead of it. A server behind this app that closes the link before the reference is live
   * counts as one too: a release from before Chord v2 answers this app's handshake with its own protocol's close.
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
        const behind = compareVersions(server.version, this.version) < 0;
        let opened: boolean;
        try {
          opened = await this.open(session, link, signal);
          if (!opened && behind) throw new Mismatch('The server closed the link.');
        } catch (error) {
          if (!(error instanceof Mismatch)) throw error;
          if (!behind) {
            throw new Error(`InfiniChat on ${server.name} is newer than this app. Update this app to use it.`);
          }
          await server.requestUpdate();
          throw new Error(`InfiniChat on ${server.name} is updating to work with this app. Try again in a moment.`);
        }
        if (opened) break;
        if (installed) throw new Error(`InfiniChat on ${server.name} did not accept this app. Try again.`);
        link = await server.install();
      }
      session.live = true;
      this.refresh();
      // The next connect sends it again, so one lost with its link changes nothing.
      this.ref?.setTimeZone({ zone: Intl.DateTimeFormat().resolvedOptions().timeZone }, BACKGROUND_CONTEXT)
        .catch(() => {});
    } catch (error) {
      if (this.session === session) this.session = undefined;
      await this.dispose(session);
      throw error;
    }
  }

  /**
   * Connects the client host over a dialed link, which holds the reference again. Resolves true once the reference is
   * live; false when the link closed first, as a stale port or a removed client file makes it; rejects with `Mismatch`
   * when the handshake failed or the server serves another version of the contract, and with the reference's error
   * when it cannot be served at all.
   */
  private async open(session: Session, link: Link, signal: AbortSignal): Promise<boolean> {
    await this.loaded;
    return new Promise<boolean>((resolve, reject) => {
      let settled = false;
      let stopState = () => {};
      const settle = (finish: () => void) => {
        if (settled) return;
        settled = true;
        stopState();
        this.mismatched = undefined;
        signal.removeEventListener('abort', abort);
        finish();
      };
      const mismatch = (why: string) => settle(() => reject(new Mismatch(why)));
      const abort = () => settle(() => reject(signal.reason));
      if (signal.aborted) {
        abort();
        return;
      }
      signal.addEventListener('abort', abort, { once: true });
      this.mismatched = () => mismatch('The server speaks another Chord protocol.');
      // The link's close, for this attempt and for the session it becomes. The link first: a reference made on a host
      // that never had a parent link has nowhere to go (design §3).
      this.host.connect(heard(link, () => {
        settle(() => resolve(false));
        this.dropped(session);
      }), { principal: { kind: 'host' } }, BACKGROUND_CONTEXT);
      const ref = this.ref ?? this.hold();
      this.mcp.hold();
      stopState = follow(ref.state, () => {
        const state = ref.state.value;
        if (state.kind === 'live') settle(() => resolve(true));
        else if (state.kind === 'ended') settle(() => reject(state.error));
        else if (state.kind !== 'failed' || state.cause.kind === 'transient') return;
        // Waiting for a provider that fits, or one that serves the type at all: this server has neither.
        else if (state.cause.kind === 'waiting') mismatch(state.cause.error.message);
        else settle(() => reject(state.cause.error));
      }, withAbortSignal(signal, BACKGROUND_CONTEXT));
    });
  }

  /** The one reference to the machine's InfiniChat, which follows its object across this host's links (§7). */
  private hold(): InfiniChatRef {
    const context = withAbortSignal(this.released.signal, BACKGROUND_CONTEXT);
    const ref = this.host.hold(InfiniChatRemote, {}, context);
    this.ref = ref;
    for (const member of [ref.snapshot, ref.controls, ref.messages, ref.scheduled, ref.access, ref.signInAttempt,
      ref.conversation, ref.machines, ref.reach, ref.pendingHostKeys]) {
      follow(member, this.refresh, context);
    }
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
