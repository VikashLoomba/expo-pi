import { RemoteInfiniChat, type RemoteConnection } from '@pi-agent/infinichat/pi/infinichat-remote/client';
import type { ConversationState, InfiniChatClient } from '@pi-agent/infinichat/pi/infinichat-remote/contract';
import type { InfiniChatHomeStore } from '@pi-agent/infinichat/pi/infinichat-remote/home';
import type { CredentialBackend } from '@pi-agent/infinichat/pi/provider-credentials';
import { ShownInfiniChat } from '@pi-agent/infinichat/pi/shown-infinichat';

import { macDialer } from './dialer';
import { macDirectory, type MacMachine } from './machines';

const MOVING = 'InfiniChat is moving. Send again once the move is done.';

/**
 * InfiniChat as this app shows it: the phone's runtime without a local side (`chat-provider.tsx:136-152, 215-227`).
 * One `RemoteInfiniChat` per machine the conversation lives on, which `ShownInfiniChat` shows across moves; the
 * current one is the client whose connection the screens report. Other machines come with piece 4, moves with
 * piece 5.
 */
export class MacInfiniChat {
  readonly shown = new ShownInfiniChat(MOVING);
  private readonly remotes = new Map<string, RemoteInfiniChat>();
  private current?: { machine: MacMachine; remote: RemoteInfiniChat; stop: () => void };
  private readonly listeners = new Set<() => void>();
  private closed = false;

  constructor(private readonly home: InfiniChatHomeStore,
    private readonly machines: (id: string) => MacMachine | undefined,
    private readonly client: InfiniChatClient, private readonly secrets: CredentialBackend) {}

  /** The connection to the machine InfiniChat lives on, and which machine: one store, as the phone's hooks read it. */
  readonly subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  };
  readonly getConnection = (): RemoteConnection | undefined => this.current?.remote.getConnection();
  readonly getMachine = () => this.current && { id: this.current.machine.id, name: this.current.machine.name };
  readonly getHeld = (): ConversationState | undefined => this.current?.remote.getConversation();

  /** Connects to the machine the home record names and shows its conversation once its view has a snapshot. */
  open(): void {
    const home = this.home.getSnapshot();
    if (home.home !== 'machine') return;
    const remote = this.machine(home.machineId);
    this.shown.show(remote);
    remote.reconnect();
  }

  reconnect(): void {
    this.current?.remote.reconnect();
  }

  dismissNotice(): void {
    this.current?.remote.dismissNotice();
  }

  /** Closes every client, after which the screens keep what they show and their operations wait. */
  async close(): Promise<void> {
    this.closed = true;
    this.current?.stop();
    this.current = undefined;
    const closing = [...this.remotes.values()];
    this.remotes.clear();
    this.shown.hold();
    await Promise.all(closing.map((remote) => remote.close()));
  }

  /** The client for a machine, made when there is none, and the one the screens follow from now on. */
  private machine(id: string): RemoteInfiniChat {
    if (this.closed) throw new Error('InfiniChat closed.');
    const machine = this.machines(id);
    if (machine === undefined) {
      throw new Error('This machine was removed from Remote machines while InfiniChat’s conversation is on it.');
    }
    let remote = this.remotes.get(id);
    if (remote === undefined) {
      remote = new RemoteInfiniChat(macDialer(machine, this.client, this.secrets), macDirectory(machine), this.client);
      this.remotes.set(id, remote);
    }
    this.current?.stop();
    this.current = { machine, remote, stop: remote.subscribe(() => this.notify()) };
    this.notify();
    return remote;
  }

  private notify(): void {
    for (const listener of [...this.listeners]) listener();
  }
}
