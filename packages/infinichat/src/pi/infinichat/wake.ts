import { defineDoc, defineSignal, type ConversationId, type TaskId, type Tx } from '@earendil-works/pi-durable';
import { obj } from '@earendil-works/pi-schema';

/**
 * Wakes an agent's coordinator while it sleeps (pi-durable `docs/spec.md` §5.7, `test/examples/38-signals.ts`). It
 * carries nothing: the coordinator reads what changed from the documents, in the commit that follows.
 */
export const Wake = defineSignal({ name: 'optchat.wake', version: 1, schema: obj({}) });
export const wakeKey = (n: number) => `w${n}`;

/** An agent's coordinator, and what its sleep waits for. */
export type Coordinating = {
  /** The coordinator of the turn under way, which the commit that opened it started; none while the agent rests. */
  task: TaskId | null;
  /** The number of the wake key its next sleep waits on: a key serves one wait (§5.7, "One wait per key"). */
  key: number;
  /** The native request IDs it submitted with `notify` and has not seen settle: its sleep waits for each. */
  settling: string[];
};
/** Apart from OptChat's application state, so that memory's builds, which the application imports, can wake it. */
export const CoordinatorDoc = defineDoc<Coordinating>({
  kind: 'optchat.coordinating',
  version: 1,
  scope: 'conversation',
  history: 'latest',
  fork: 'initial',
  checkpointWhen: () => true,
  initial: () => ({ task: null, key: 0, settling: [] }),
});

/**
 * Wakes the agent's coordinator in the caller's commit; false when none lives. Before the commit's first table write,
 * and never beside an admission: pi-durable takes a signal for one (`ReadAfterWrite`). A key that already holds a
 * value means the coordinator is awake, or will wake at once, and reads this commit's changes.
 */
export async function rouse(tx: Tx, chat: ConversationId): Promise<boolean> {
  const coordinating = await tx.doc(CoordinatorDoc, chat);
  if (coordinating.task === null) return false;
  const result = await tx.signal(coordinating.task, Wake, wakeKey(coordinating.key), {});
  return result === 'delivered' || result === 'duplicate';
}
