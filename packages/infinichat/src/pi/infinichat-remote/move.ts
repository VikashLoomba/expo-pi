import { awaitWithContext, BACKGROUND_CONTEXT, withAbortSignal } from '@earendil-works/chord/context';
import type { SyncStateStore } from '@earendil-works/chord/sync';
import type { ExecutionEnv } from '@earendil-works/pi-durable/env';

import type { RemoteInfiniChat } from './client';
import type { ConversationState, InfiniChatClient } from './contract';
import type { MachineDirectory } from './dialer';
import { PHONE_HOME, type InfiniChatHomeStore } from './home';
import { keyExchangeLines } from './keys';
import { PRINT_MARKER, runScript } from './machine';
import { cancellable, moveError, type MoveBase, type MoveStatus, type MoveStep } from './move-status';
import { conversationHead, FOLDER, give, INCOMING, SYNC, take, type HandoverFolder, type StoreFiles } from './sync';

/** What a move does to the two sides through their owner, the app's provider. */
export interface MoveSides {
  /** Keeps the screens on what they show, and their operations waiting, until `show` or `openLocal`. */
  hold(): void;
  /** Closes InfiniChat on this device: its Harness, then its store. */
  closeLocal(): Promise<void>;
  /** Opens InfiniChat on this device and shows it; it reports its own failure. */
  openLocal(): Promise<void>;
  /**
   * The provider's client for the machine's InfiniChat, made when there is none; two while the conversation moves from
   * one machine to another.
   */
  machine(machineId: string): RemoteInfiniChat;
  show(remote: RemoteInfiniChat): void;
  closeMachine(machineId: string): Promise<void>;
}

/** This device's own InfiniChat, for a device that holds the conversation at times, as a phone does. */
export interface OwnConversation {
  files: StoreFiles;
  /** This device among those that upload to a machine's folder: the client ID it keeps. */
  id: string;
  /** What this device's copy last shared with the folder of the machine. */
  bookmarks(machineId: string): SyncStateStore;
}

/** The machine holds the conversation that ends at `head` open: it adopted it, and the move there happened. */
const adopted = (held: ConversationState | undefined, head: number | undefined) => held?.active === true
  && head !== undefined && held.head === head;
/** "this iPhone" → "This iPhone", for a message that starts with the device. */
const capitalized = (text: string) => text.charAt(0).toUpperCase() + text.slice(1);

/**
 * Moves InfiniChat's conversation between this device and a machine, or straight from one machine to another with
 * this device orchestrating, one move at a time, as Chord's session sync hands a session over (`sync.ts`): the giving
 * side closes its Harness and uploads what its store committed since the two sides last shared it, and the other side
 * applies that to its copy and opens it, where pi-durable's recovery resumes the work the close interrupted. Nothing
 * drains or waits. The home record names each phase before the step that needs it, so `resume` carries a move on
 * after a relaunch or a failure. It reaches a machine's folder through the `ExecutionEnv` the app borrows from the
 * owner of its connection there, and never closes it; cancelling stops only the move's own operations.
 */
export class InfiniChatMoves {
  private readonly listeners = new Set<() => void>();
  private status?: MoveStatus;
  /** What the last move wants the user to know once it is done, until dismissed. */
  private notice?: string;
  private attempt?: { controller: AbortController; cancelled: boolean };
  private running: Promise<void> = Promise.resolve();
  /** This attempt saw the machine without the conversation open, and has not asked it to adopt since. */
  private machineClosed = false;
  private closed = false;

  /**
   * `directory` gives a machine as the app knows it, `environment` its files and commands, and `device` names this
   * device in messages, such as "this iPhone". `own` is this device's own InfiniChat; a device that never holds the
   * conversation, as the Mac app, has none, and moves it between machines only.
   */
  constructor(private readonly home: InfiniChatHomeStore,
    private readonly directory: (machineId: string) => MachineDirectory,
    private readonly environment: (machineId: string) => Promise<ExecutionEnv>,
    private readonly own: OwnConversation | undefined, private readonly device: string,
    private readonly sides: MoveSides) {}

  /** This device's InfiniChat, on the paths that move the conversation to or from this device. */
  private get mine(): OwnConversation {
    if (this.own === undefined) throw new Error(`${capitalized(this.device)} keeps no InfiniChat of its own.`);
    return this.own;
  }

  readonly subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  };
  readonly getSnapshot = () => this.status;
  readonly getNotice = () => this.notice;

  dismissNotice() {
    this.notice = undefined;
    this.notify();
  }

  /** Moves the conversation to the machine, or to this device for `null`, from where it lives. */
  choose(machineId: string | null) {
    const home = this.home.getSnapshot();
    if (this.attempt || this.status) return;
    if (machineId !== null && home.home === 'phone') this.run(machineId, 'machine');
    else if (home.home === 'machine' && home.phase === 'there') {
      if (machineId === null) this.run(home.machineId, 'phone');
      else if (machineId !== home.machineId) this.run(machineId, 'machine', false, home.machineId);
    }
  }

  /** Carries a move on from the phase the home record keeps, at launch and when the app becomes active. */
  resume() {
    const home = this.home.getSnapshot();
    if (this.attempt || home.home !== 'machine' || home.phase === 'there') return;
    if (home.phase === 'moving-there') this.run(home.machineId, 'machine', false, home.from);
    else this.run(home.machineId, 'phone');
  }

  /**
   * Brings the conversation back to this device from `machineId` before that machine is removed, since a move needs
   * its credentials: from `there` or a stopped move back, the move back runs; a move there is undone as Cancel undoes
   * it, then moved back if the machine had already adopted it. Resolves once the conversation isn't on that machine,
   * and rejects with the failure that stopped a move, which keeps its status as any failed move does.
   */
  async bringBack(machineId: string): Promise<void> {
    for (;;) {
      await this.running;
      const home = this.home.getSnapshot();
      if (home.home === 'phone' || home.machineId !== machineId) return;
      if (this.closed) throw new Error('InfiniChat closed.');
      // A move started meanwhile, from the header or a resume, finishes first.
      if (this.attempt) continue;
      const undo = home.phase === 'moving-there';
      this.run(machineId, undo ? 'machine' : 'phone', undo, undo ? home.from : undefined);
      await this.running;
      const error = moveError(this.status);
      if (error !== undefined) throw new Error(error);
    }
  }

  /** Runs a move a failure stopped again, forward, also when the failure was a Cancel's. */
  retry() {
    const status = this.status;
    if (this.attempt || status === undefined || moveError(status) === undefined) return;
    this.run(status.machineId, status.to, false, status.from);
  }

  /** Puts the conversation back where it was, before the opening step only; the only way into the undo. */
  cancel() {
    const status = this.status;
    if (!status || !cancellable(status)) return;
    if (!this.attempt) {
      // Nothing moved yet: the failure only goes away.
      const home = this.home.getSnapshot();
      if (home.home === 'phone' || home.phase === 'there') {
        this.status = undefined;
        this.notify();
        if (home.home === 'phone') void this.sides.closeMachine(status.machineId);
        return;
      }
      this.run(status.machineId, status.to, true, status.from);
      return;
    }
    this.attempt.cancelled = true;
    this.attempt.controller.abort();
  }

  /** Stops a move where it is, as the app stopping would; the home record carries it on at the next launch. */
  close(): Promise<void> {
    this.closed = true;
    this.attempt?.controller.abort();
    return this.running;
  }

  private run(machineId: string, to: MoveStatus['to'], cancelling = false, from?: string) {
    const attempt = { controller: new AbortController(), cancelled: cancelling };
    this.attempt = attempt;
    this.machineClosed = false;
    this.notice = undefined;
    const base = { machineId, to, ...(from === undefined ? {} : { from }) };
    const first: MoveStep = to === 'machine' ? 'connecting' : 'closing';
    this.status = { ...base, step: first, phase: cancelling ? 'undoing' : 'moving' };
    this.notify();
    this.running = (async () => {
      if (!cancelling) {
        try {
          // A move that got this far finished: a Cancel too late to stop it changes nothing.
          const signal = attempt.controller.signal;
          await (to === 'phone' ? this.back(machineId, signal)
            : from === undefined ? this.there(machineId, signal) : this.between(from, machineId, signal));
          this.status = undefined;
          return;
        } catch (error) {
          if (this.closed) return;
          if (!attempt.cancelled) {
            const stopped = { ...base, step: this.status?.step ?? first };
            this.status = { ...stopped, phase: 'failed', error: this.failure(stopped, error) };
            return;
          }
        }
      }
      // Cancelled, with a new signal, which only closing aborts.
      attempt.controller = new AbortController();
      const step = this.status?.step ?? first;
      this.status = { ...base, step, phase: 'undoing' };
      this.notify();
      try {
        await this.undo(machineId, to, attempt.controller.signal, from);
        this.status = undefined;
      } catch (error) {
        if (this.closed) return;
        const message = error instanceof Error ? error.message : String(error);
        this.status = { ...base, step, phase: 'undo-failed', error: `The move could not be cancelled. ${message}` };
      }
    })().finally(() => {
      this.attempt = undefined;
      this.notify();
    });
  }

  /**
   * This device → machine. The machine is on the newest server release before this device closes anything
   * (`receives`). This device uploads to the machine's folder, and the machine brings its copy up to that and opens
   * it. Until the machine has adopted it, this device's store is the conversation; a machine that already holds it
   * open finished the move.
   */
  private async there(machineId: string, signal: AbortSignal) {
    const remote = this.sides.machine(machineId);
    const name = this.name(machineId);
    await remote.connected(signal);
    await this.receives(remote, name);
    if (this.home.getSnapshot().home === 'phone') {
      this.step('closing');
      this.home.set({ version: 1, home: 'machine', machineId, phase: 'moving-there' });
      this.sides.hold();
      await this.sides.closeLocal();
    }
    signal.throwIfAborted();
    const { files, id } = this.mine;
    const head = await conversationHead(files);
    if (head === undefined) throw new Error(`${capitalized(this.device)} has no InfiniChat conversation to move.`);
    const held = remote.getConversation();
    if (!adopted(held, head)) {
      if (held?.active) throw new Error(`InfiniChat on ${name} already has another conversation open.`);
      this.machineClosed = true;
      this.step('copying');
      await give(files, id, await this.folder(machineId, signal));
      signal.throwIfAborted();
      await remote.pull(head);
      signal.throwIfAborted();
      this.machineClosed = false;
      this.step('opening');
      await remote.adopt(head);
    }
    this.arrived(machineId, remote);
  }

  /**
   * Machine → machine, this device orchestrating: the target is on the newest server release (`receives`), the source
   * closes the conversation, uploads it and names where it ends, and the target brings its copy up to that and opens
   * it. The upload is in the source's own folder, which the target reads over its own SSH, or in the target's, which
   * the source took the conversation from and gives it back through. The source's store stays its copy, and this
   * device's own stays as it was under the source.
   */
  private async between(fromId: string, toId: string, signal: AbortSignal) {
    const source = this.sides.machine(fromId);
    const target = this.sides.machine(toId);
    // This device's connection to the target gives it its key, which the source lets in before the target's server
    // first looks for the source, so that never costs it a refused login.
    await awaitWithContext(this.environment(toId), withAbortSignal(signal, BACKGROUND_CONTEXT));
    await this.authorize(fromId, toId, signal);
    await target.connected(signal);
    this.step('closing');
    // A source that can't be reached can't hand the conversation on; it stays there, shown as it was.
    await source.connected(signal);
    await this.receives(target, this.name(toId));
    const home = this.home.getSnapshot();
    if (home.home === 'machine' && home.phase === 'there') {
      this.home.set({ version: 1, home: 'machine', machineId: toId, phase: 'moving-there', from: fromId });
    }
    this.sides.hold();
    const { head, folder } = await source.relinquish(this.holder(toId));
    signal.throwIfAborted();
    const held = target.getConversation();
    if (!adopted(held, head)) {
      if (held?.active) throw new Error(`InfiniChat on ${this.name(toId)} already has another conversation open.`);
      this.machineClosed = true;
      this.step('copying');
      const record = this.directory(fromId).machine();
      if (record === undefined) throw new Error(`${this.name(fromId)} is no longer among the machines.`);
      await target.pull(head, folder === toId ? undefined : record);
      signal.throwIfAborted();
      this.machineClosed = false;
      this.step('opening');
      await target.adopt(head);
    }
    this.arrived(toId, target);
    await this.sides.closeMachine(fromId);
  }

  /**
   * Lets the target into the source over the target's own SSH before it pulls: the target's InfiniChat key, which this
   * device learned when it connected there, goes into the source's `authorized_keys` as the key exchange puts it,
   * through the environment this device borrows for the source. A later connection to the source finds it there.
   */
  private async authorize(fromId: string, toId: string, signal: AbortSignal) {
    const key = this.directory(toId).machine()?.publicKey;
    const to = this.name(toId);
    if (key === undefined) {
      throw new Error(`Test ${to} in Remote machines first, so this device learns its InfiniChat key.`);
    }
    const from = this.name(fromId);
    const source = await awaitWithContext(this.environment(fromId), withAbortSignal(signal, BACKGROUND_CONTEXT));
    const [status] = await runScript(source, signal, from, keyExchangeLines([key], PRINT_MARKER),
      { failure: `${from} could not authorize ${to}’s InfiniChat key. Check its ssh-keygen and home folder.` });
    if (status !== 'ok') {
      throw new Error(`The SSH account on ${from} can neither write nor read its ~/.ssh/authorized_keys, so ${to} `
        + 'can’t be let in. Make that file the account’s own, then try again.');
    }
  }

  /** The machine as `relinquish` records who takes the conversation: by its endpoint, which every client knows. */
  private holder(machineId: string): InfiniChatClient {
    return { id: machineId, name: this.name(machineId) };
  }

  /**
   * The machine holds the conversation: the record says so, and the screens show it there. This device's store is
   * its copy from now on, which nothing opens while the record names a machine and the next move back brings up to
   * date.
   */
  private arrived(machineId: string, remote: RemoteInfiniChat) {
    this.home.set({ version: 1, home: 'machine', machineId, phase: 'there' });
    this.sides.show(remote);
  }

  /**
   * Machine → this device. The machine closes the conversation, uploads it to its folder and names where it ends;
   * its store stays unchanged there, so a relaunch takes it again and Cancel has the machine open it again. Nothing
   * here compares this app with the machine's server: whether this device can read the conversation is pi-durable's
   * to say when it opens it (its spec §3.6, §11.2). An app too old for it reports that as its failure to open
   * (`openLocal`); the store is then this device's, unopened, and a move to a machine sends it as any other.
   */
  private async back(machineId: string, signal: AbortSignal) {
    const remote = this.sides.machine(machineId);
    this.step('closing');
    // A machine that can't be reached can't hand the conversation back; it stays there, shown as it was.
    await remote.connected(signal);
    const home = this.home.getSnapshot();
    if (home.home === 'machine' && home.phase === 'there') {
      this.home.set({ version: 1, home: 'machine', machineId, phase: 'moving-back' });
    }
    this.sides.hold();
    const { head } = await remote.relinquish();
    signal.throwIfAborted();
    this.step('copying');
    await take(this.mine.files, head, await this.folder(machineId, signal));
    signal.throwIfAborted();
    this.step('opening');
    // This device's store is the conversation now, and nothing has opened it, so the record names this device before
    // it opens it: a relaunch never takes the machine's over work this device has done.
    this.home.set(PHONE_HOME);
    await this.sides.openLocal();
    await this.sides.closeMachine(machineId);
  }

  private async undo(machineId: string, to: MoveStatus['to'], signal: AbortSignal, from?: string) {
    const remote = this.sides.machine(machineId);
    const home = this.home.getSnapshot();
    if (to === 'machine' && from !== undefined) {
      await this.undoBetween(from, machineId, signal);
    } else if (to === 'machine') {
      if (home.home === 'machine' && home.phase === 'moving-there') {
        // This device's store is the conversation only while the machine never opened its copy of it. A machine that
        // did (its answer to `adopt` lost with the link) holds it now and may already be working, so finishing the
        // move is the only outcome that never opens the conversation twice.
        if (!this.machineClosed) {
          await remote.connected(signal);
          if (adopted(remote.getConversation(), await conversationHead(this.mine.files))) {
            this.arrived(machineId, remote);
            this.notice = `InfiniChat had already opened on ${this.name(machineId)}, so the move finished and it `
              + `runs there now. Choose ${capitalized(this.device)} to move it back.`;
            return;
          }
        }
        this.home.set(PHONE_HOME);
        await this.sides.openLocal();
      }
      await this.sides.closeMachine(machineId);
    } else if (home.home === 'machine' && home.phase === 'moving-back') {
      // The machine's store is unchanged since it relinquished it, so it opens it again.
      await remote.connected(signal);
      if (!remote.getConversation()?.active) await remote.adopt((await remote.relinquish()).head);
      this.home.set({ version: 1, home: 'machine', machineId, phase: 'there' });
      // What a take had restored of the whole store so far; a copy it was bringing up to date stays this device's.
      await this.mine.files.remove(INCOMING);
      this.sides.show(remote);
    }
  }

  /**
   * Puts a move between machines back: the source opens the store it released, unless the target already holds the
   * conversation, which finishes the move instead, as the undo of a move from this device does.
   */
  private async undoBetween(fromId: string, toId: string, signal: AbortSignal) {
    const home = this.home.getSnapshot();
    if (home.home === 'machine' && home.phase === 'moving-there' && home.machineId === toId) {
      const source = this.sides.machine(fromId);
      const target = this.sides.machine(toId);
      await source.connected(signal);
      // Named again, unchanged since the source released it.
      const { head } = await source.relinquish(this.holder(toId));
      if (!this.machineClosed) {
        await target.connected(signal);
        if (adopted(target.getConversation(), head)) {
          this.arrived(toId, target);
          this.notice = `InfiniChat had already opened on ${this.name(toId)}, so the move finished and it runs `
            + 'there now.';
          await this.sides.closeMachine(fromId);
          return;
        }
      }
      await source.adopt(head);
      this.home.set({ version: 1, home: 'machine', machineId: fromId, phase: 'there' });
      this.sides.show(source);
    }
    await this.sides.closeMachine(toId);
  }

  /**
   * The machine's folder as this device reaches it, through the machine's files borrowed from their owner; a cancel
   * stops waiting for them. What it copies shows with the step.
   */
  private async folder(machineId: string, signal: AbortSignal): Promise<HandoverFolder> {
    const files = await awaitWithContext(this.environment(machineId), withAbortSignal(signal, BACKGROUND_CONTEXT));
    let copied = 0;
    return { files, root: `~/${FOLDER}/${SYNC}`, bookmarks: this.mine.bookmarks(machineId), signal,
      machine: this.name(machineId), copied: (bytes) => this.step('copying', copied += bytes) };
  }

  /**
   * A machine takes the conversation on the newest server release: one behind it is asked to update itself first.
   * pi-durable's migrations are one-way, and the newest release is the newest code a released app or another machine
   * can have written the conversation with. It compares the machine's server with its own releases only, never with
   * this app.
   */
  private async receives(remote: RemoteInfiniChat, name: string): Promise<void> {
    if (!await remote.outdated()) return;
    await remote.requestUpdate();
    throw new Error(`InfiniChat on ${name} is updating to its newest version first. Try the move again in a moment.`);
  }

  private name(machineId: string): string {
    return this.directory(machineId).machine()?.name ?? 'the machine';
  }

  /** Names the step that failed, then why. */
  private failure(status: MoveBase, error: unknown): string {
    const name = this.name(status.machineId);
    const there = status.to === 'machine';
    const from = status.from === undefined ? this.device : this.name(status.from);
    const copying = status.from === undefined ? `Copying InfiniChat ${there ? 'to' : 'from'} ${name} failed.`
      : `Copying InfiniChat from ${from} to ${name} failed.`;
    const step = status.step === 'connecting' ? `Connecting to ${name} failed.`
      : status.step === 'closing' ? `Closing InfiniChat on ${there ? from : name} failed.`
        : status.step === 'copying' ? copying
          : `Opening InfiniChat on ${there ? name : this.device} failed.`;
    return `${step} ${error instanceof Error ? error.message : String(error)}`;
  }

  /** The forward move reached `step`; `copied` is the bytes its copy has moved so far. */
  private step(step: MoveStep, copied?: number) {
    const status = this.status;
    if (!status || this.closed) return;
    this.status = { machineId: status.machineId, to: status.to,
      ...(status.from === undefined ? {} : { from: status.from }), step, phase: 'moving',
      ...(copied === undefined ? {} : { copied }) };
    this.notify();
  }

  private notify() {
    for (const listener of [...this.listeners]) listener();
  }
}
