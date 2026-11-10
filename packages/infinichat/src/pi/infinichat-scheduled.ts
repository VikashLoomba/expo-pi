import { BACKGROUND_CONTEXT } from '@earendil-works/chord/context';
import type { JsonValue } from '@earendil-works/chord/json';
import { num, obj, type Static } from '@earendil-works/pi-schema';
import type { Harness, TaskGraphWatch } from '@earendil-works/pi-durable';

import { SCHEDULED_TASK, ScheduledInputProperties, type ScheduledInput } from './infinichat/schedule';

const context = BACKGROUND_CONTEXT;

/** A scheduled task still waiting, by the number of pi-durable's own task ID. */
export const ScheduledTaskSchema = obj({ id: num(), ...ScheduledInputProperties }, { open: true });
export type ScheduledTask = Static<typeof ScheduledTaskSchema>;

/** The input of a scheduled task, read from pi-durable's own record. */
function scheduledInput(value: JsonValue): ScheduledInput | undefined {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return undefined;
  const { task, until } = value;
  return typeof task === 'string' && typeof until === 'number' ? { task, until } : undefined;
}

/**
 * The scheduled tasks still waiting, read again from pi-durable's records whenever the task graph changes. The
 * Scheduled tasks sheet shows them, and the phone mirrors them as local notifications wherever they run.
 */
export class ScheduledTasks {
  private graph?: TaskGraphWatch;
  private tasks?: readonly ScheduledTask[];
  private readonly listeners = new Set<() => void>();
  private queue: Promise<void> = Promise.resolve();
  private closed = false;

  constructor(private readonly harness: Harness, private readonly report: (error: unknown) => void) {}

  async start(): Promise<void> {
    const graph = await this.harness.watchTaskGraph(context);
    if (this.closed) {
      await graph.stop();
      return;
    }
    this.graph = graph;
    graph.start(async (call) => {
      if (call.kind === 'value') this.schedule();
    });
    this.schedule();
  }

  readonly subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  };
  /** The scheduled tasks still waiting, soonest first; undefined until they are first read. */
  readonly getSnapshot = () => this.tasks;

  /** Stops following the Harness; a read under way finishes on its own. */
  close(): void {
    this.closed = true;
    void this.graph?.stop();
  }

  private readonly schedule = () => {
    if (this.closed) return;
    this.queue = this.queue.then(() => this.read()).catch(this.report);
  };

  private async read(): Promise<void> {
    const pending = await this.pending();
    if (this.closed) return;
    this.tasks = pending;
    for (const listener of [...this.listeners]) listener();
  }

  /** The scheduled tasks still waiting for a time ahead, from pi-durable's records; a due one is about to run. */
  private async pending(): Promise<ScheduledTask[]> {
    const tasks = Object.values(this.graph?.value.tasks ?? {});
    if (!tasks.some((task) => task.kind === SCHEDULED_TASK)) return [];
    const inspection = await this.harness.inspect(context);
    const pending: ScheduledTask[] = [];
    for (const { record } of inspection.tasks) {
      if (record.kind !== SCHEDULED_TASK || record.abortRequested) continue;
      const input = scheduledInput(record.input);
      if (input && input.until > Date.now()) pending.push({ ...input, id: record.id });
    }
    return pending.sort((left, right) => left.until - right.until);
  }
}
