import type { AttachedReplicatedState, JsonValue } from '@earendil-works/chord';
import { BACKGROUND_CONTEXT } from '@earendil-works/chord/context';
import type { Harness, TaskGraph } from '@earendil-works/pi-durable';
import * as Notifications from 'expo-notifications';

import { SCHEDULED_TASK, type ScheduledInput } from './infinichat/schedule';

const context = BACKGROUND_CONTEXT;
/** Category identifiers may not contain ':' or '-' (expo-notifications). */
const CATEGORY = 'infinichatScheduledTask';
const IDENTIFIER_PREFIX = 'infinichat-task-';

type Pending = ScheduledInput & { identifier: string };

/** The input of a scheduled task, read from pi-durable's own record. */
function scheduledInput(value: JsonValue): ScheduledInput | undefined {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return undefined;
  const { task, until } = value;
  return typeof task === 'string' && typeof until === 'number' ? { task, until } : undefined;
}

/**
 * Keeps one scheduled local notification per scheduled task still waiting, as the keep-alive keeps one location
 * stream per Harness with work: added when the task appears, cancelled when it ends, reconciled against what iOS
 * holds whenever the task graph changes. Nothing handles the tap: opening the app reopens the Harness, whose wait
 * task then starts the subagent at once, and the "Run now" action launches the app in the background for the same.
 */
export class ScheduledTaskNotifier {
  private graph?: AttachedReplicatedState<TaskGraph>;
  private unsubscribe = () => {};
  private queue: Promise<void> = Promise.resolve();
  private category?: Promise<unknown>;
  private closed = false;

  constructor(private readonly harness: Harness, private readonly report: (error: unknown) => void) {}

  async start(): Promise<void> {
    const graph = await this.harness.taskGraph(context);
    if (this.closed) {
      graph.dispose();
      return;
    }
    this.graph = graph;
    this.unsubscribe = graph.subscribe(this.schedule);
    this.schedule();
  }

  /** Stops following the Harness; a sync under way finishes on its own, and iOS keeps what was scheduled. */
  close(): void {
    this.closed = true;
    this.unsubscribe();
    this.graph?.dispose();
  }

  private readonly schedule = () => {
    if (this.closed) return;
    this.queue = this.queue.then(() => this.sync()).catch(this.report);
  };

  private async sync(): Promise<void> {
    const pending = await this.pending();
    if (this.closed) return;
    const held = (await Notifications.getAllScheduledNotificationsAsync())
      .filter((request) => request.identifier.startsWith(IDENTIFIER_PREFIX));
    const wanted = new Map(pending.map((item) => [item.identifier, item]));
    for (const request of held) {
      if (!wanted.has(request.identifier)) await Notifications.cancelScheduledNotificationAsync(request.identifier);
    }
    const missing = pending.filter((item) => !held.some((request) => request.identifier === item.identifier));
    if (missing.length === 0 || !(await this.permitted())) return;
    this.category ??= Notifications.setNotificationCategoryAsync(CATEGORY, [
      { identifier: 'run', buttonTitle: 'Run now', options: { opensAppToForeground: false } },
      { identifier: 'open', buttonTitle: 'Open', options: { opensAppToForeground: true } },
    ]);
    await this.category;
    for (const item of missing) {
      await Notifications.scheduleNotificationAsync({
        identifier: item.identifier,
        content: { title: 'InfiniChat', body: item.task, categoryIdentifier: CATEGORY },
        trigger: { type: Notifications.SchedulableTriggerInputTypes.DATE, date: item.until },
      });
    }
  }

  /** The scheduled tasks still waiting for a time ahead, from pi-durable's records; a due one is about to run. */
  private async pending(): Promise<Pending[]> {
    const tasks = Object.values(this.graph?.value.tasks ?? {});
    if (!tasks.some((task) => task.kind === SCHEDULED_TASK)) return [];
    const inspection = await this.harness.inspect(context);
    const pending: Pending[] = [];
    for (const { record } of inspection.tasks) {
      if (record.kind !== SCHEDULED_TASK || record.abortRequested) continue;
      const input = scheduledInput(record.input);
      if (input && input.until > Date.now()) pending.push({ ...input, identifier: `${IDENTIFIER_PREFIX}${record.id}` });
    }
    return pending;
  }

  /** Asks for notification permission at the first scheduled task; a refusal leaves the tasks to run on open. */
  private async permitted(): Promise<boolean> {
    const current = await Notifications.getPermissionsAsync();
    if (current.granted) return true;
    if (!current.canAskAgain) return false;
    return (await Notifications.requestPermissionsAsync()).granted;
  }
}
