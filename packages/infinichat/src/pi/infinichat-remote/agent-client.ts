import type { Ctx, Held, Host } from '@earendil-works/chord';
import { BACKGROUND_CONTEXT, withAbortSignal } from '@earendil-works/chord/context';

import type { ChatMessage } from '../../chat/types';
import type { ChatViewSnapshot, ChatViewSource } from '../chat-view';
import type { AgentChat } from '../infinichat-service';
import type { InfiniChatControls } from '../infinichat-view';
import type { ChatModelSettings } from '../model-catalog';
import { InfiniChatAgent, type InfiniChatPrincipal } from './contract';
import { follow } from './follow';

type AgentRef = Held<typeof InfiniChatAgent>;

const LOADING: ChatViewSnapshot = { status: 'loading' };
const NO_MESSAGES: readonly ChatMessage[] = [];

/**
 * One agent's chat on the machine (`InfiniChatAgent`), through the client host that shows its InfiniChat
 * (`RemoteInfiniChat`): held while a screen follows its view, so the machine follows only the chats on screen, and
 * for the length of an operation otherwise. A reference follows its object across that host's links, so it is held
 * only once the host has had one (`linked`). `run` is that host's call, which connects on demand and rejects as its
 * calls do.
 */
export class RemoteAgent implements AgentChat {
  private ref?: AgentRef;
  private released = new AbortController();
  private values?: {
    view: ChatViewSnapshot; controls: InfiniChatControls | undefined; messages: readonly ChatMessage[];
  };
  private readonly listeners = new Set<() => void>();

  constructor(private readonly host: Host<InfiniChatPrincipal>, private readonly name: string,
    private readonly ready: () => boolean,
    private readonly run: <T>(call: (ctx: Ctx<InfiniChatPrincipal>) => Promise<T>) => Promise<T>) {}

  private readonly shown: ChatViewSource<InfiniChatControls> = {
    subscribe: (listener) => {
      this.listeners.add(listener);
      this.linked();
      return () => {
        this.listeners.delete(listener);
        if (!this.listeners.size) this.release();
      };
    },
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

  continue(): Promise<void> {
    return this.act((ref, ctx) => ref.continue(ctx));
  }

  stop(): Promise<void> {
    return this.act((ref, ctx) => ref.stop(ctx));
  }

  setModel(settings: ChatModelSettings): Promise<void> {
    return this.act((ref, ctx) => ref.setModel(settings, ctx));
  }

  /** The host has a link: holds the object when a screen follows its view and nothing holds it yet. */
  linked(): void {
    if (this.ref !== undefined || !this.listeners.size || !this.ready()) return;
    const context = withAbortSignal(this.released.signal, BACKGROUND_CONTEXT);
    const ref = this.host.hold(InfiniChatAgent, { name: this.name }, context);
    this.ref = ref;
    for (const member of [ref.snapshot, ref.controls, ref.messages]) follow(member, this.refresh, context);
    follow(ref.state, this.refresh, context);
  }

  /** Lets the object go, keeping the last values for a screen that shows them again. */
  release(): void {
    this.released.abort();
    this.released = new AbortController();
    this.ref?.release();
    this.ref = undefined;
  }

  private readonly refresh = () => {
    const ref = this.ref;
    if (ref === undefined || ref.state.value.kind !== 'live') return;
    this.values = { view: ref.snapshot.value, controls: ref.controls.value ?? undefined,
      messages: ref.messages.value };
    for (const listener of [...this.listeners]) listener();
  };

  /**
   * A method of the agent's object, on the reference a screen holds, or on one held for the call: a call on a
   * loading reference waits until it is live.
   */
  private async act(call: (ref: AgentRef, ctx: Ctx<InfiniChatPrincipal>) => Promise<null>): Promise<void> {
    await this.run(async (ctx) => {
      const held = this.ref;
      const ref = held ?? this.host.hold(InfiniChatAgent, { name: this.name }, BACKGROUND_CONTEXT);
      try {
        return await call(ref, ctx);
      } finally {
        if (held === undefined) ref.release();
      }
    });
  }
}
