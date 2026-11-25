import { BACKGROUND_CONTEXT } from '@earendil-works/chord/context';
import type { Harness, TaskGraphWatch } from '@earendil-works/pi-durable';

import { isAskSleepNode, waitingQuestions, type PendingQuestionBatch } from './infinichat/ask';

const context = BACKGROUND_CONTEXT;

/**
 * The parked `ask_user` batches waiting across the agent tree, read again from pi-durable's records whenever the
 * task graph changes, as `ScheduledTasks` follows waiting scheduled tasks.
 */
export class PendingQuestions {
  private graph?: TaskGraphWatch;
  private batches?: readonly PendingQuestionBatch[];
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

  /** Pending question batches across the tree, oldest first; undefined until first read. */
  readonly getSnapshot = () => this.batches;

  /** Stops following the Harness; an in-flight read finishes quietly. */
  close(): void {
    this.closed = true;
    void this.graph?.stop();
  }

  private readonly schedule = () => {
    if (this.closed) return;
    this.queue = this.queue.then(() => this.read()).catch(this.report);
  };

  private async read(): Promise<void> {
    const next = await this.pending();
    if (this.closed) return;
    if (JSON.stringify(next) === JSON.stringify(this.batches)) return;
    this.batches = next;
    for (const listener of [...this.listeners]) listener();
  }

  /** Inspects records only while the task graph holds a sleeping `ask_user` tool task. */
  private async pending(): Promise<PendingQuestionBatch[]> {
    const tasks = Object.values(this.graph?.value.tasks ?? {});
    return tasks.some((task) => task.kind === 'pi.tool' && isAskSleepNode(task.state))
      ? waitingQuestions(this.harness, context)
      : [];
  }
}
