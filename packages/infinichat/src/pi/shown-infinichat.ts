import type { UserMessage } from '@earendil-works/pi-ai';
import type { ChatMessage } from '../chat/types';
import type { ChatViewSnapshot, ChatViewSource } from './chat-view';
import type { ScheduledTask } from './infinichat-scheduled';
import type {
  InfiniChatHost, InfiniChatSettings, InfiniChatSnapshot,
} from './infinichat-service';
import type { Machine } from './infinichat-remote/contract';
import type { MachinePatch, MachinesState } from './infinichat-remote/machines';
import type { InfiniChatControls } from './infinichat-view';
import type { ScheduledInput } from './infinichat/schedule';

const noop = () => {};
const LOADING: ChatViewSnapshot = { status: 'loading' };
const NO_MESSAGES: readonly ChatMessage[] = [];
const NO_REPORT: InfiniChatSnapshot = {};

/**
 * The InfiniChat the screens show, wherever its Harness runs: one view and one set of stores for the app's lifetime,
 * so moving the conversation neither reloads nor remounts a screen, and the scroll position and the draft stay put.
 * While something subscribes, it follows the side it shows. `hold` keeps the last values on screen while a move
 * closes one side and opens the other, and `show` switches once the new side's view has its first snapshot.
 * Operations go to the side shown; while held they reject, and a draft keeps its request ID, which the new side
 * admits once.
 */
export class ShownInfiniChat implements InfiniChatHost {
  private readonly listeners = new Set<() => void>();
  private host?: InfiniChatHost;
  /** The side to show once its view has a snapshot. */
  private next?: InfiniChatHost;
  private held = false;
  private unfollow = noop;
  private snapshot = LOADING;
  private controls?: InfiniChatControls;
  private messages = NO_MESSAGES;
  private tasks?: readonly ScheduledTask[];
  private machineList?: MachinesState;
  private report = NO_REPORT;

  constructor(private readonly heldMessage: string) {}

  readonly subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    if (this.listeners.size === 1) this.follow();
    return () => {
      this.listeners.delete(listener);
      if (this.listeners.size) return;
      this.unfollow();
      this.unfollow = noop;
      // No screen is left to keep as it was.
      this.switch();
    };
  };
  readonly scheduled = { subscribe: this.subscribe, getSnapshot: () => this.tasks };
  readonly machines = { subscribe: this.subscribe, getSnapshot: () => this.machineList };
  private readonly shown: ChatViewSource<InfiniChatControls> = {
    subscribe: this.subscribe,
    getSnapshot: () => this.snapshot,
    getControls: () => this.controls,
    getMessages: () => this.messages,
  };
  readonly getSnapshot = () => this.report;
  /** The side shown, for the screens that also read its machine's connection and account. */
  readonly getHost = () => this.host;

  view(): ChatViewSource<InfiniChatControls> {
    return this.shown;
  }

  /** Keeps the values on screen as they are; operations reject until a side is shown again. */
  hold() {
    this.held = true;
    this.next = undefined;
    this.follow();
  }

  /**
   * Shows `host` once its view has its first snapshot; at once when nothing was shown yet, or no screen shows
   * InfiniChat, since there are no values on screen to keep.
   */
  show(host: InfiniChatHost) {
    if (host === this.host && !this.held) return;
    this.next = host;
    if (!this.host || !this.listeners.size) this.switch();
    else this.follow();
  }

  accept(input: UserMessage['content'], requestId: string): Promise<void> {
    return this.current().accept(input, requestId);
  }

  stop(): Promise<void> {
    return this.current().stop();
  }

  updateSettings(settings: InfiniChatSettings): Promise<void> {
    return this.current().updateSettings(settings);
  }

  cancelScheduled(id: number, replacement?: ScheduledInput): Promise<boolean> {
    return this.current().cancelScheduled(id, replacement);
  }

  reloadPlugins(): Promise<string> {
    return this.current().reloadPlugins();
  }

  putMachine(record: Machine): Promise<void> {
    return this.current().putMachine(record);
  }

  patchMachine(endpoint: string, patch: MachinePatch): Promise<void> {
    return this.current().patchMachine(endpoint, patch);
  }

  removeMachine(endpoint: string): Promise<void> {
    return this.current().removeMachine(endpoint);
  }

  dismissError() {
    if (!this.held) this.host?.dismissError();
  }

  private current(): InfiniChatHost {
    if (this.held || !this.host) throw new Error(this.heldMessage);
    return this.host;
  }

  private switch() {
    if (!this.next) return;
    this.host = this.next;
    this.next = undefined;
    this.held = false;
    this.follow();
    this.notify();
  }

  /**
   * Subscribes to what it follows now before letting go of what it followed, so a view it keeps following never
   * detaches and reads its history again. Held, it follows only the next side's view, for its first snapshot.
   */
  private follow() {
    const previous = this.unfollow;
    const host = this.next ?? (this.held ? undefined : this.host);
    if (!host || !this.listeners.size) {
      this.unfollow = noop;
      previous();
      return;
    }
    const view = host.view();
    const waiting = host === this.next;
    const update = () => {
      if (waiting) {
        if (this.next === host && view.getSnapshot().status !== 'loading') this.switch();
        return;
      }
      this.snapshot = view.getSnapshot();
      this.controls = view.getControls();
      this.messages = view.getMessages();
      this.tasks = host.scheduled.getSnapshot();
      this.machineList = host.machines.getSnapshot();
      this.report = host.getSnapshot();
      this.notify();
    };
    const stops = waiting ? [view.subscribe(update)]
      : [view.subscribe(update), host.subscribe(update), host.scheduled.subscribe(update),
        host.machines.subscribe(update)];
    this.unfollow = () => {
      for (const stop of stops) stop();
    };
    previous();
    update();
  }

  private notify() {
    for (const listener of [...this.listeners]) listener();
  }
}
