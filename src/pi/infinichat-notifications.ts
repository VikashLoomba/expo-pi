import * as Notifications from 'expo-notifications';

import type { ScheduledTask } from './infinichat-scheduled';
import type { InfiniChatHost } from './infinichat-service';

const IDENTIFIER_PREFIX = 'infinichat-task-';
const identifierOf = (id: number) => `${IDENTIFIER_PREFIX}${id}`;

const OPEN = { identifier: 'open', buttonTitle: 'Open', options: { opensAppToForeground: true } };
/**
 * Category identifiers may not contain ':' or '-' (expo-notifications). On the phone the task waits for the app, so
 * "Run now" launches the app in the background for its Harness to run the task; a machine runs the task at its time
 * itself, so its notifications only open the app.
 */
const CATEGORIES = {
  phone: { identifier: 'infinichatScheduledTask', actions: [
    { identifier: 'run', buttonTitle: 'Run now', options: { opensAppToForeground: false } }, OPEN] },
  machine: { identifier: 'infinichatMachineTask', actions: [OPEN] },
};

/** The side that holds the conversation open: its waiting tasks, where they run, and where a failure shows. */
export interface ScheduledTaskSource {
  readonly tasks: InfiniChatHost['scheduled'];
  readonly runsOn: keyof typeof CATEGORIES;
  readonly report: (error: unknown) => void;
}

/**
 * Keeps one scheduled local notification per scheduled task still waiting on the side that holds the conversation, as
 * the keep-alive keeps one location stream for the Harnesses with work: added when the task appears, cancelled when it
 * ends, reconciled against what iOS holds whenever the list changes. A list not read yet, or one that stopped changing
 * because a move closed its side, leaves iOS's set as it is. Nothing handles the tap. On the phone, opening the app
 * reopens the Harness, whose wait task then sends its task at once, and "Run now" launches the app in the background
 * for the same; on a machine the task has started at its time.
 */
export class ScheduledTaskNotifications {
  private source?: ScheduledTaskSource;
  private unsubscribe = () => {};
  /** The list last queued: a machine's one store also notifies at each streamed change of its view, list unchanged. */
  private queued?: readonly ScheduledTask[];
  private queue: Promise<void> = Promise.resolve();
  private readonly categories: Partial<Record<ScheduledTaskSource['runsOn'], Promise<unknown>>> = {};
  private closed = false;

  /**
   * Mirrors `source`'s list from now on, in place of the side followed before; its owner closes it, never this. A
   * moved conversation keeps its task IDs, so each notification is replaced by this side's.
   */
  follow(source: ScheduledTaskSource): void {
    if (this.closed || source.tasks === this.source?.tasks) return;
    this.unsubscribe();
    this.source = source;
    this.queued = undefined;
    this.unsubscribe = source.tasks.subscribe(this.schedule);
    // The list may have been read before this followed it.
    this.schedule();
  }

  /** Stops following; a sync under way finishes on its own, and iOS keeps what was scheduled. */
  close(): void {
    this.closed = true;
    this.unsubscribe();
  }

  private readonly schedule = () => {
    const source = this.source;
    const pending = source?.tasks.getSnapshot();
    if (this.closed || source === undefined || pending === undefined || pending === this.queued) return;
    this.queued = pending;
    this.queue = this.queue.then(() => this.sync(source, pending)).catch(source.report);
  };

  private async sync(source: ScheduledTaskSource, pending: readonly ScheduledTask[]): Promise<void> {
    // A later list, or another side's, is queued after this one.
    if (this.closed || source !== this.source || pending !== this.queued) return;
    const category = CATEGORIES[source.runsOn];
    const held = (await Notifications.getAllScheduledNotificationsAsync())
      .filter((request) => request.identifier.startsWith(IDENTIFIER_PREFIX));
    const wanted = new Set(pending.map((item) => identifierOf(item.id)));
    for (const request of held) {
      if (!wanted.has(request.identifier)) await Notifications.cancelScheduledNotificationAsync(request.identifier);
    }
    const missing = pending.filter((item) => !held.some((request) => request.identifier === identifierOf(item.id)
      && request.content.categoryIdentifier === category.identifier));
    if (missing.length === 0 || !(await this.permitted())) return;
    await (this.categories[source.runsOn] ??= Notifications.setNotificationCategoryAsync(category.identifier,
      category.actions));
    for (const item of missing) {
      // A request under an identifier iOS already holds replaces it (UNNotificationRequest), so a task notified from
      // the other side is never notified twice.
      await Notifications.scheduleNotificationAsync({
        identifier: identifierOf(item.id),
        content: { title: 'InfiniChat', body: item.task, categoryIdentifier: category.identifier },
        trigger: { type: Notifications.SchedulableTriggerInputTypes.DATE, date: item.until },
      });
    }
  }

  /**
   * Asks for notification permission at the first scheduled task. A refusal leaves the phone's tasks to run on open;
   * a machine's run at their time anyway.
   */
  private async permitted(): Promise<boolean> {
    const current = await Notifications.getPermissionsAsync();
    if (current.granted) return true;
    if (!current.canAskAgain) return false;
    return (await Notifications.requestPermissionsAsync()).granted;
  }
}
