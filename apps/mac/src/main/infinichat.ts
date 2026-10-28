import type { ImageProcessor } from '@earendil-works/pi-durable/tools';
import { NodeExecutionEnv } from '@earendil-works/pi-durable/env/node';
import { findCatalogModel, type ImageInput } from '@pi-agent/infinichat/pi/model-catalog';
import { RemoteInfiniChat, type RemoteConnection } from '@pi-agent/infinichat/pi/infinichat-remote/client';
import type { ConversationState, InfiniChatClient } from '@pi-agent/infinichat/pi/infinichat-remote/contract';
import type { InfiniChatHomeStore } from '@pi-agent/infinichat/pi/infinichat-remote/home';
import { InfiniChatMoves, type MoveStatus } from '@pi-agent/infinichat/pi/infinichat-remote/move';
import type { CredentialBackend } from '@pi-agent/infinichat/pi/provider-credentials';
import { ShownInfiniChat } from '@pi-agent/infinichat/pi/shown-infinichat';
import { homedir } from 'node:os';

import { Attachments } from './attachments';
import { macDialer, remoteDialer } from './dialer';
import { macDirectory, type MacMachine, type MacMachines } from './machines';
import { SERVER_BUNDLE } from './server-assets';

const MOVING = 'InfiniChat is moving. Send again once the move is done.';

/**
 * InfiniChat as this app shows it: the phone's runtime without a local side (`chat-provider.tsx:136-227`). One
 * `RemoteInfiniChat` per machine the conversation lives on or moves to or from, which `ShownInfiniChat` shows across
 * moves; the current one is the client whose connection the screens report. This Mac's own server is reached over
 * the loopback, the other machines through a tunnel; `InfiniChatMoves` moves the conversation between them, with
 * this Mac orchestrating and never holding it. When the shown server reports the conversation handed to another
 * listed machine, the app follows it there.
 */
export class MacInfiniChat {
  readonly shown = new ShownInfiniChat(MOVING);
  readonly moves: InfiniChatMoves;
  private readonly attachments: Attachments;
  private readonly remotes = new Map<string, RemoteInfiniChat>();
  private current?: { id: string; remote: RemoteInfiniChat; stop: () => void };
  private readonly listeners = new Set<() => void>();
  private closed = false;
  private machines?: MacMachines;
  private following?: string;

  constructor(private readonly home: InfiniChatHomeStore, private readonly mac: MacMachine,
    private readonly client: InfiniChatClient, private readonly secrets: CredentialBackend, images: ImageProcessor) {
    this.attachments = new Attachments(images);
    this.moves = new InfiniChatMoves(home, (id) => macDirectory(this.manager(), id),
      (id) => this.environment(id), undefined, 'this Mac', SERVER_BUNDLE, {
        hold: () => this.shown.hold(),
        // This Mac never holds the conversation; a move to or from "this device" is never offered.
        closeLocal: () => Promise.reject(new Error('This Mac keeps no InfiniChat of its own.')),
        openLocal: () => Promise.reject(new Error('This Mac keeps no InfiniChat of its own.')),
        machine: (id) => this.machine(id),
        show: (remote) => this.show(remote),
        closeMachine: (id) => this.closeMachine(id),
      });
  }

  /** The manager of the machines, which gives each record; set once it exists, since it reads the shown side. */
  useMachines(machines: MacMachines): void {
    this.machines = machines;
  }

  /** The connection to the machine InfiniChat lives on, and which machine: one store, as the phone's hooks read it. */
  readonly subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  };
  readonly getConnection = (): RemoteConnection | undefined => this.current?.remote.getConnection();
  readonly getMachine = () => {
    const current = this.current;
    if (current === undefined) return undefined;
    return { id: current.id, name: macDirectory(this.manager(), current.id).machine()?.name ?? 'the machine' };
  };
  readonly getHeld = (): ConversationState | undefined => this.current?.remote.getConversation();
  /** What the holder's server found of the other machines, and the host keys waiting for a client there. */
  readonly getReach = () => this.current?.remote.getReach();
  readonly getPendingHostKeys = () => this.current?.remote.getPendingHostKeys();
  readonly getMove = (): MoveStatus | undefined => this.moves.getSnapshot();
  readonly getMoveNotice = () => this.moves.getNotice();

  acceptHostKey(endpoint: string, fingerprints: string[]): Promise<void> {
    const remote = this.current?.remote;
    if (remote === undefined) throw new Error('InfiniChat is not connected to a machine.');
    return remote.acceptHostKey(endpoint, fingerprints);
  }

  /**
   * Connects to the machine the home record names and shows its conversation once its view has a snapshot, or
   * carries on a move the app quit during.
   */
  open(): void {
    const home = this.home.getSnapshot();
    if (home.home !== 'machine') return;
    if (home.phase !== 'there') {
      this.moves.resume();
      return;
    }
    const remote = this.machine(home.machineId);
    this.show(remote);
    remote.reconnect();
  }

  reconnect(): void {
    this.current?.remote.reconnect();
  }

  /** Moves the conversation to the machine, from the one it lives on. */
  chooseMove(machineId: string): void {
    this.moves.choose(machineId);
  }

  /** A dropped or pasted photo, fitted to the shown model. */
  attach(bytes: Uint8Array, mimeType: string) {
    return this.attachments.fit(bytes, mimeType, this.imageLimits());
  }

  pickPhotos() {
    return this.attachments.pick(this.imageLimits());
  }

  /** The shown model's image limits (`photo-attachments.ts`), from the machine's catalog and the settings shown. */
  private imageLimits(): ImageInput {
    const catalog = this.current?.remote.getCatalog();
    const controls = this.shown.view().getControls();
    const model = catalog && controls ? findCatalogModel(catalog, controls.settings.model) : undefined;
    if (model === undefined) throw new Error('Choose InfiniChat’s model in its settings to attach a photo.');
    if (model.images === undefined) throw new Error(`${model.name} does not accept images.`);
    return model.images;
  }

  dismissNotice(): void {
    this.current?.remote.dismissNotice();
  }

  /** Closes every client, after which the screens keep what they show and their operations wait. */
  async close(): Promise<void> {
    this.closed = true;
    await this.moves.close();
    this.current?.stop();
    this.current = undefined;
    const closing = [...this.remotes.values()];
    this.remotes.clear();
    this.shown.hold();
    await Promise.all(closing.map((remote) => remote.close()));
  }

  private manager(): MacMachines {
    if (this.machines === undefined) throw new Error('The machines are not set up yet.');
    return this.machines;
  }

  /** A machine's files and commands for a move: this Mac's own, or the pooled pi-env connection to another. */
  private environment(id: string) {
    const machines = this.manager();
    if (machines.isSelf(id)) return Promise.resolve(new NodeExecutionEnv({ cwd: homedir() }));
    return machines.environment(id, new AbortController().signal);
  }

  /** The client for a machine, made when there is none; two while the conversation moves between machines. */
  private machine(id: string): RemoteInfiniChat {
    if (this.closed) throw new Error('InfiniChat closed.');
    const machines = this.manager();
    let remote = this.remotes.get(id);
    if (remote === undefined) {
      const directory = macDirectory(machines, id);
      const dialer = machines.isSelf(id) ? macDialer(this.mac, this.client, this.secrets)
        : remoteDialer(id, directory.machine, machines, this.client, this.secrets);
      remote = new RemoteInfiniChat(dialer, directory, this.client);
      this.remotes.set(id, remote);
    }
    return remote;
  }

  /** The screens follow this client from now on; its connection is the one they report. */
  private show(remote: RemoteInfiniChat): void {
    const id = [...this.remotes.entries()].find(([, candidate]) => candidate === remote)?.[0];
    if (id === undefined) return;
    this.shown.show(remote);
    this.current?.stop();
    this.current = { id, remote, stop: remote.subscribe(() => {
      this.notify();
      this.follow();
    }) };
    this.notify();
  }

  /**
   * The conversation went elsewhere while this app was away: the shown server says who holds it. A listed machine is
   * followed, as the phone's `RemoteInfiniChat` is told where it went; a phone is shown as the holder, since nothing
   * reaches it.
   */
  private follow(): void {
    const current = this.current;
    const held = current?.remote.getConversation();
    const home = this.home.getSnapshot();
    if (current === undefined || held === undefined || held.active || held.heldBy === undefined) return;
    if (home.home !== 'machine' || home.phase !== 'there' || home.machineId !== current.id) return;
    const heldBy = held.heldBy.id;
    if (this.following === heldBy || this.moves.getSnapshot() !== undefined) return;
    const listed = this.manager().isSelf(heldBy) || this.manager().shownMachines()?.machines[heldBy] !== undefined;
    if (!listed) return;
    this.following = heldBy;
    this.home.set({ version: 1, home: 'machine', machineId: heldBy, phase: 'there' });
    const remote = this.machine(heldBy);
    this.show(remote);
    remote.reconnect();
    void this.closeMachine(current.id);
  }

  private async closeMachine(id: string): Promise<void> {
    const closing = this.remotes.get(id);
    this.remotes.delete(id);
    if (this.current?.id === id) {
      this.current.stop();
      this.current = undefined;
      this.notify();
    }
    await closing?.close();
  }

  private notify(): void {
    for (const listener of [...this.listeners]) listener();
  }
}
