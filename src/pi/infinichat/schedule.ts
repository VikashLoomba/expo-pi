import { Type } from '@earendil-works/pi-ai';
import { defineTask, defineTool, type ConversationId, type Tx } from '@earendil-works/pi-durable';

import { AgentCallDoc } from './agents';

/** The scheduled task's registered kind: a background task that waits, so the keep-alive never counts it as work. */
export const SCHEDULED_TASK = 'optchat.scheduled-task';

/** What the main agent is sent, and when, as a Harness clock time. */
export type ScheduledInput = { task: string; until: number };

/** Admits a work message to the main agent in the caller's commit, as OptChat admits an agent's report. */
type AdmitWork = (tx: Tx, root: ConversationId, input: { requestId: string; content: string; date: string }) =>
  Promise<void>;

/**
 * A future message to the main agent. As pi-durable's own compaction retries, the time is in the durable record and
 * the phase sleeps on the Harness clock, so a reopened Harness sleeps again, or sends it at once when the time has
 * passed while the app was closed. The commit that ends the task admits the message, so it is sent once.
 */
export const scheduledTask = (admit: AdmitWork) => defineTask<ScheduledInput, { phase: 'wait' }, null>({
  name: SCHEDULED_TASK,
  version: 1,
  initial: () => ({ phase: 'wait' }),
  phases: {
    async wait(task, runtime, context) {
      await runtime.sleep(task.input.until, context);
      await runtime.commit(async (tx) => {
        await admit(tx, runtime.conversationId, {
          requestId: `optchat:scheduled:${task.id}`,
          content: `[Scheduled task]\n${task.input.task}`,
          date: new Date(runtime.now()).toISOString(),
        });
        return { status: 'terminal', outcome: { status: 'completed', result: null } };
      }, context);
    },
  },
  abort: (_task, runtime, context) =>
    runtime.commit(() => ({ status: 'terminal', outcome: { status: 'aborted' } }), context),
});

/** The time as the `date` tool shows one: the device's local time, without a zone. */
const localTime = (time: number): string => new Date(time).toLocaleString('sv-SE');

/** The master's `schedule_task`: `task` sent back to the master at `run_after`. */
export function scheduleTool(rootId: ConversationId, scheduled: ReturnType<typeof scheduledTask>) {
  return defineTool({
    name: 'schedule_task',
    description: 'Schedule a task for yourself at a later time. At run_after the task reaches you as a message '
      + '"[Scheduled task]" followed by the task, as a new turn or between your tool calls. If the app is closed at '
      + 'that time, the user gets a notification and the task reaches you when the app is next opened.',
    replay: 'safe',
    parameters: Type.Object({
      task: Type.String({ description: 'What to do then; it reaches you as written.' }),
      run_after: Type.String({
        description: 'When it reaches you, as an ISO 8601 date and time in the device\'s local time, for example '
          + '2026-10-21T09:00:00, or with an offset.',
      }),
    }),
    async execute({ task, run_after }, api, context) {
      const until = Date.parse(run_after);
      if (Number.isNaN(until)) {
        const text = `Invalid run_after: ${run_after}. Give an ISO 8601 date and time, for example `
          + '2026-10-21T09:00:00.';
        return { output: [{ type: 'text' as const, text }] };
      }
      const text = await api.commit(async (tx) => {
        // A native tool task may replay after a lost result commit; its own ID makes it act once.
        const done = await tx.doc(AgentCallDoc, rootId, String(api.taskId), null);
        if (done.result !== null) return done.result;
        await tx.createTask(scheduled, { task, until }, {
          conversationId: rootId,
          ownership: { kind: 'conversation' },
          background: true,
        });
        done.result = `Scheduled for ${localTime(until)}. The task will reach you then as a message.`;
        return done.result;
      }, context);
      return { output: [{ type: 'text' as const, text }] };
    },
  });
}
