import type { ScheduledTask } from '@pi-agent/infinichat/pi/infinichat-scheduled';
import { Utils } from 'electrobun/main';

/** A value the main process follows, as the screens follow a store. */
interface Store<T> {
  readonly subscribe: (listener: () => void) => () => void;
  readonly getSnapshot: () => T;
}
/** The longest wait `setTimeout` takes; a later time is waited for in steps. */
const LONGEST_WAIT = 2 ** 31 - 1;

/**
 * Keeps one timer per scheduled task still waiting on the side that holds the conversation, the Mac's counterpart of
 * the phone's `ScheduledTaskNotifications`: Electrobun shows a notification only at once, so each fires at its task's
 * time while the app runs. A list not read yet, or one that stopped changing because a move closed its side, leaves
 * the timers as they are; a moved conversation keeps its task IDs, so each timer is replaced by the new side's when
 * its time differs. The machine runs the task itself; the notification only says so.
 */
export class ScheduledNotifier {
  private readonly timers = new Map<number, { until: number; timer: ReturnType<typeof setTimeout> }>();
  private readonly stop: () => void;

  constructor(private readonly tasks: Store<readonly ScheduledTask[] | undefined>) {
    this.stop = tasks.subscribe(() => this.sync());
    this.sync();
  }

  /** At quit: nothing fires after. */
  close(): void {
    this.stop();
    for (const { timer } of this.timers.values()) clearTimeout(timer);
    this.timers.clear();
  }

  private sync(): void {
    const pending = this.tasks.getSnapshot();
    if (pending === undefined) return;
    const wanted = new Map(pending.map((task) => [task.id, task.until]));
    for (const [id, armed] of [...this.timers]) {
      // A task whose time has come leaves the list as it starts; its timer, due the same moment, still fires.
      if (wanted.get(id) === armed.until || armed.until <= Date.now()) continue;
      clearTimeout(armed.timer);
      this.timers.delete(id);
    }
    for (const task of pending) {
      if (!this.timers.has(task.id)) this.arm(task);
    }
  }

  private arm(task: ScheduledTask): void {
    const wait = task.until - Date.now();
    const timer = wait > LONGEST_WAIT
      ? setTimeout(() => {
        this.timers.delete(task.id);
        this.arm(task);
      }, LONGEST_WAIT)
      : setTimeout(() => {
        this.timers.delete(task.id);
        Utils.showNotification({ title: 'InfiniChat', body: task.task });
      }, Math.max(wait, 0));
    this.timers.set(task.id, { until: task.until, timer });
  }
}
