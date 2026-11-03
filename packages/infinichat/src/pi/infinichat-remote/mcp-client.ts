import { isChordError, type Ctx, type Host, type Ref } from '@earendil-works/chord';

import type { InfiniChatPrincipal } from './contract';
import { InfiniChatMcp, type McpServerStatus, type McpSignInAttempt } from './mcp-contract';
import { attemptStep, type AttemptSource } from './sign-in-attempt';

type McpRef = Ref<typeof InfiniChatMcp>;
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
 * InfiniChat (`RemoteInfiniChat`): held beside InfiniChat's own reference on every connect, re-held after it went away,
 * and released with it. `run` is that host's call, which connects on demand and rejects as its calls do. A server
 * from before `/mcp` serves no such object, which the view says.
 */
export class RemoteMcp implements AttemptSource<Attempt> {
  private ref?: McpRef;
  private view?: McpView;
  private readonly listeners = new Set<() => void>();

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
    if (this.ref !== undefined && this.ref.status !== 'gone') return;
    const ref = this.host.hold(InfiniChatMcp, {});
    this.ref = ref;
    ref.servers.subscribe(this.refresh);
    ref.problems.subscribe(this.refresh);
    ref.signInAttempt.subscribe(this.refresh);
    ref.onStatus((status, error) => {
      if (status === 'live') this.refresh();
      else if (status === 'gone' && this.ref === ref) this.gone(error);
    });
  }

  release(): void {
    this.ref?.release();
    this.ref = undefined;
    this.listeners.clear();
  }

  signIn(server: string): Promise<number> {
    return this.call((ref, ctx) => ref.signIn({ server }, ctx));
  }

  answer(promptId: number, value: string): Promise<void> {
    return this.call((ref, ctx) => ref.answer({ promptId, value }, ctx));
  }

  cancelSignIn(): Promise<void> {
    return this.call((ref, ctx) => ref.cancelSignIn(ctx));
  }

  signOut(server: string): Promise<void> {
    return this.call((ref, ctx) => ref.signOut({ server }, ctx));
  }

  reconnect(server: string): Promise<void> {
    return this.call((ref, ctx) => ref.reconnect({ server }, ctx));
  }

  /** What `read` finds in sign-in attempt `attempt` while it runs (`attemptStep`). */
  signInStep<T>(attempt: number, read: (shown: Attempt) => T | undefined, signal: AbortSignal): Promise<T> {
    return attemptStep(this, attempt, read, signal);
  }

  private call<T>(call: (ref: McpRef, ctx: Ctx<InfiniChatPrincipal>) => Promise<T>): Promise<T> {
    return this.run((ctx) => {
      const ref = this.ref;
      if (ref === undefined || ref.status === 'gone') {
        throw new Error(this.view?.unavailable ?? `MCP on ${this.machine()} is not connected yet.`);
      }
      return call(ref, ctx);
    });
  }

  private readonly refresh = () => {
    const ref = this.ref;
    if (ref?.status !== 'live') return;
    this.view = { servers: ref.servers.value, problems: ref.problems.value, signInAttempt: ref.signInAttempt.value };
    this.notify();
  };

  /**
   * Gone because the machine's server has no `/mcp` object, as one from before it (Chord's `unavailable`, reason
   * `unknown_type`) or one whose contract doesn't cover this app's; it updates itself. Gone as the server shuts down,
   * the view stays, and the next connect holds the object again.
   */
  private gone(error: unknown) {
    if (!isChordError(error, 'unavailable') && !isChordError(error, 'contract_mismatch')
      && !isChordError(error, 'upgrade_required')) return;
    this.view = { servers: NO_SERVERS, problems: NO_PROBLEMS, signInAttempt: null,
      unavailable: `InfiniChat on ${this.machine()} doesn’t show its MCP servers yet. It updates itself; try again `
        + 'after it does.' };
    this.notify();
  }

  private notify() {
    for (const listener of [...this.listeners]) listener();
  }
}
