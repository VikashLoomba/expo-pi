import * as Notifications from 'expo-notifications';

import type { ScheduledTasks } from './infinichat-scheduled';

/** Category identifiers may not contain ':' or '-' (expo-notifications). */
const CATEGORY = 'infinichatScheduledTask';
const IDENTIFIER_PREFIX = 'infinichat-task-';

const identifierOf = (id: number) => `${IDENTIFIER_PREFIX}${id}`;

/**
 * Keeps one scheduled local notification per scheduled task still waiting, as the keep-alive keeps one location
 * stream per Harness with work: added when the task appears, cancelled when it ends, reconciled against what iOS
 * holds whenever the list changes. Nothing handles the tap: opening the app reopens the Harness, whose wait task then
 * sends its task at once, and the "Run now" action launches the app in the background for the same.
 */
export class ScheduledTaskNotifications {
  private queue: Promise<void> = Promise.resolve();
  private category?: Promise<unknown>;
  private closed = false;
  private readonly unsubscribe: () => void;

  constructor(private readonly tasks: ScheduledTasks, private readonly report: (error: unknown) => void) {
    this.unsubscribe = tasks.subscribe(this.schedule);
    // The list may have been read before this followed it.
    this.schedule();
  }

  /** Stops following the list; a sync under way finishes on its own, and iOS keeps what was scheduled. */
  close(): void {
    this.closed = true;
    this.unsubscribe();
  }

  private readonly schedule = () => {
    if (this.closed) return;
    this.queue = this.queue.then(() => this.sync()).catch(this.report);
  };

  private async sync(): Promise<void> {
    const pending = this.tasks.getSnapshot();
    if (this.closed || pending === undefined) return;
    const held = (await Notifications.getAllScheduledNotificationsAsync())
      .filter((request) => request.identifier.startsWith(IDENTIFIER_PREFIX));
    const wanted = new Set(pending.map((item) => identifierOf(item.id)));
    for (const request of held) {
      if (!wanted.has(request.identifier)) await Notifications.cancelScheduledNotificationAsync(request.identifier);
    }
    const missing = pending.filter((item) => !held.some((request) => request.identifier === identifierOf(item.id)));
    if (missing.length === 0 || !(await this.permitted())) return;
    this.category ??= Notifications.setNotificationCategoryAsync(CATEGORY, [
      { identifier: 'run', buttonTitle: 'Run now', options: { opensAppToForeground: false } },
      { identifier: 'open', buttonTitle: 'Open', options: { opensAppToForeground: true } },
    ]);
    await this.category;
    for (const item of missing) {
      await Notifications.scheduleNotificationAsync({
        identifier: identifierOf(item.id),
        content: { title: 'InfiniChat', body: item.task, categoryIdentifier: CATEGORY },
        trigger: { type: Notifications.SchedulableTriggerInputTypes.DATE, date: item.until },
      });
    }
  }

  /** Asks for notification permission at the first scheduled task; a refusal leaves the tasks to run on open. */
  private async permitted(): Promise<boolean> {
    const current = await Notifications.getPermissionsAsync();
    if (current.granted) return true;
    if (!current.canAskAgain) return false;
    return (await Notifications.requestPermissionsAsync()).granted;
  }
}
