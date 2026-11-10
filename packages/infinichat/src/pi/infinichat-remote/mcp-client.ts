import type { Ctx, Held, Host } from '@earendil-works/chord';
import { BACKGROUND_CONTEXT, withAbortSignal } from '@earendil-works/chord/context';

import type { InfiniChatPrincipal } from './contract';
import { follow } from './follow';
import { InfiniChatMcp, type McpServerStatus, type McpSignInAttempt } from './mcp-contract';
import { attemptStep, type AttemptSource } from './sign-in-attempt';

type McpRef = Held<typeof InfiniChatMcp>;
type Attempt = Exclude<McpSignInAttempt, null>;

/** The machine's MCP servers as `/mcp` shows them; `unavailable` says why there are none to show. */
export interface McpView {
  readonly servers: readonly McpServerStatus[];
  readonly problems: readonly string[];
  readonly signInAttempt: McpSignInAttempt;
  readonly unavailable?: string;
}

const NO_SERVERS: readonly McpServerStatus[] = [];
const NO_PROBLEMS: readonly string[] = [];

/**
 * The machine's `/mcp` object (`InfiniChatMcp`, which its tools plugin serves) through the client host that shows its
 * InfiniChat (`RemoteInfiniChat`): held once, beside InfiniChat's own reference, which it follows across that host's
 * links, and released with it. `run` is that host's call, which connects on demand and rejects as its calls do. A
 * server that serves no such object, or another version of it, leaves the hold waiting, which the view says.
 */
export class RemoteMcp implements AttemptSource<Attempt> {
  private ref?: McpRef;
  private view?: McpView;
  private readonly listeners = new Set<() => void>();
  /** Aborted at `release`: the hold and its members' watches end with it. */
  private readonly released = new AbortController();

  constructor(private readonly host: Host<InfiniChatPrincipal>, private readonly machine: () => string,
    private readonly run: <T>(call: (ctx: Ctx<InfiniChatPrincipal>) => Promise<T>) => Promise<T>) {}

  readonly subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  };
  /** Undefined until the machine's object is live. */
  readonly getSnapshot = () => this.view;
  readonly getAttempt = () => this.view?.signInAttempt;

  /** Holds the object unless it is held; `RemoteInfiniChat` calls it as it connects. */
  hold(): void {
    if (this.ref !== undefined) return;
    const context = withAbortSignal(this.released.signal, BACKGROUND_CONTEXT);
    const ref = this.host.hold(InfiniChatMcp, {}, context);
    this.ref = ref;
    for (const member of [ref.servers, ref.problems, ref.signInAttempt]) follow(member, this.refresh, context);
    follow(ref.state, () => {
      const state = ref.state.value;
      if (state.kind === 'live') this.refresh();
      else if (state.kind === 'failed' && state.cause.kind === 'waiting') this.unserved();
    }, context);
  }

  release(): void {
    this.released.abort();
    this.ref?.release();
    this.ref = undefined;
    this.listeners.clear();
  }

  signIn(server: string): Promise<number> {
    return this.call((ref, ctx) => ref.signIn({ server }, ctx));
  }

  answer(promptId: number, value: string): Promise<void> {
    return this.act((ref, ctx) => ref.answer({ promptId, value }, ctx));
  }

  cancelSignIn(): Promise<void> {
    return this.act((ref, ctx) => ref.cancelSignIn(ctx));
  }

  signOut(server: string): Promise<void> {
    return this.act((ref, ctx) => ref.signOut({ server }, ctx));
  }

  reconnect(server: string): Promise<void> {
    return this.act((ref, ctx) => ref.reconnect({ server }, ctx));
  }

  /** What `read` finds in sign-in attempt `attempt` while it runs (`attemptStep`). */
  signInStep<T>(attempt: number, read: (shown: Attempt) => T | undefined, signal: AbortSignal): Promise<T> {
    return attemptStep(this, attempt, read, signal);
  }

  /** A method without a result: Chord answers `null`, its wire form. */
  private async act(call: (ref: McpRef, ctx: Ctx<InfiniChatPrincipal>) => Promise<null>): Promise<void> {
    await this.call(call);
  }

  private call<T>(call: (ref: McpRef, ctx: Ctx<InfiniChatPrincipal>) => Promise<T>): Promise<T> {
    return this.run((ctx) => {
      const ref = this.ref;
      if (ref === undefined) {
        throw new Error(this.view?.unavailable ?? `MCP on ${this.machine()} is not connected yet.`);
      }
      return call(ref, ctx);
    });
  }

  private readonly refresh = () => {
    const ref = this.ref;
    if (ref?.state.value.kind !== 'live') return;
    this.view = { servers: ref.servers.value, problems: ref.problems.value, signInAttempt: ref.signInAttempt.value };
    this.notify();
  };

  /**
   * The machine's server serves no `/mcp` object that fits this app's contract (chord `docs/design.md` §3: the hold
   * waits, `failed { waiting }`); it updates itself, and a publication that fits binds the hold again.
   */
  private unserved() {
    this.view = { servers: NO_SERVERS, problems: NO_PROBLEMS, signInAttempt: null,
      unavailable: `InfiniChat on ${this.machine()} doesn’t show its MCP servers yet. It updates itself; try again `
        + 'after it does.' };
    this.notify();
  }

  private notify() {
    for (const listener of [...this.listeners]) listener();
  }
}
