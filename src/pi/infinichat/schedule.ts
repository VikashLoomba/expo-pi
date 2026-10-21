import { Type } from '@earendil-works/pi-ai';
import { defineTask, defineTool, type ConversationId } from '@earendil-works/pi-durable';

import { AgentCallDoc, spawnAgent, type AgentTask } from './agents';

/** The scheduled task's registered kind: a background task that waits, so the keep-alive never counts it as work. */
export const SCHEDULED_TASK = 'optchat.scheduled-task';

/** What a scheduled subagent does, and when it starts, as a Harness clock time. */
export type ScheduledInput = { task: string; until: number };

/**
 * A future `spawn` of one subagent. As pi-durable's own compaction retries, the time is in the durable record and
 * the phase sleeps on the Harness clock, so a reopened Harness sleeps again, or starts the agent at once when the
 * time has passed while the app was closed. The agent's report then reaches the main agent as any report does.
 */
export const scheduledTask = (agent: AgentTask) => defineTask<ScheduledInput, { phase: 'wait' }, { name: string }>({
  name: SCHEDULED_TASK,
  version: 1,
  initial: () => ({ phase: 'wait' }),
  phases: {
    async wait(task, runtime, context) {
      await runtime.sleep(task.input.until, context);
      await runtime.commit(async (tx) => {
        const name = await spawnAgent(tx, runtime.conversationId, agent, task.input.task, null);
        return { status: 'terminal', outcome: { status: 'completed', result: { name } } };
      }, context);
    },
  },
  abort: (_task, runtime, context) =>
    runtime.commit(() => ({ status: 'terminal', outcome: { status: 'aborted' } }), context),
});

/** The time as the `date` tool shows one: the device's local time, without a zone. */
const localTime = (time: number): string => new Date(time).toLocaleString('sv-SE');

/** The master's `schedule_task`: a subagent on `task`, started at `run_after`. */
export function scheduleTool(rootId: ConversationId, scheduled: ReturnType<typeof scheduledTask>) {
  return defineTool({
    name: 'schedule_task',
    description: 'Schedule a subagent to start on a task at a later time. At run_after a subagent starts on the '
      + 'task as spawn would, and its report reaches you as a message "[Name] report" when it finishes. If the '
      + 'app is closed at that time, the user gets a notification and the subagent starts when the app is next '
      + 'opened.',
    replay: 'safe',
    parameters: Type.Object({
      task: Type.String({ description: 'What the subagent should do; it knows what you want only from this.' }),
      run_after: Type.String({
        description: 'When to start, as an ISO 8601 date and time in the device\'s local time, for example '
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
        done.result = `Scheduled for ${localTime(until)}. A subagent starts on it then, and its report will reach `
          + 'you as a message when it finishes.';
        return done.result;
      }, context);
      return { output: [{ type: 'text' as const, text }] };
    },
  });
}
