import type { Context } from '@earendil-works/chord/context';
import type { JsonValue } from '@earendil-works/chord/json';
import { num, obj, opt, str, type Static } from '@earendil-works/pi-schema';
import {
  defineTask, defineTool, type ConversationId, type Harness, type TaskId, type Tx,
} from '@earendil-works/pi-durable';

import { AgentCallDoc } from './agents';

/** The scheduled task's registered kind: a background task that waits, so the keep-alive never counts it as work. */
export const SCHEDULED_TASK = 'optchat.scheduled-task';

/** What the main agent is sent, and when, as a Harness clock time. */
export const ScheduledInputProperties = { task: str(), until: num() };
export const ScheduledInputSchema = obj(ScheduledInputProperties);
export type ScheduledInput = Static<typeof ScheduledInputSchema>;

/** Admits a work message to the main agent in the caller's commit, as OptChat admits an agent's report. */
type AdmitWork = (tx: Tx, root: ConversationId, input: { requestId: string; content: string; date: string }) =>
  Promise<void>;

/**
 * A future message to the main agent. As pi-durable's own compaction retries, the task sleeps durably on the Harness
 * clock, holding no invocation, so a reopened Harness resumes it at the time, or at once when the time has passed while
 * the app was closed. The commit that ends the task admits the message, so it is sent once.
 */
export const scheduledTask = (admit: AdmitWork) => defineTask<ScheduledInput, { phase: 'wait' }, null>({
  name: SCHEDULED_TASK,
  version: 1,
  initial: () => ({ phase: 'wait' }),
  phases: {
    async wait(task, runtime, context) {
      // A run before the time (the first one, or an early wake) sleeps until it.
      if (task.input.until > runtime.now()) return runtime.sleepUntil(task.input.until, task.state.checkpoint, context);
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

/** The input of a scheduled task, read from pi-durable's own record. */
function scheduledInput(value: JsonValue): ScheduledInput | undefined {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return undefined;
  const { task, until } = value;
  return typeof task === 'string' && typeof until === 'number' ? { task, until } : undefined;
}

/** A scheduled task still waiting, under pi-durable's own ID for it. */
export type WaitingTask = ScheduledInput & { id: TaskId };

/**
 * The scheduled tasks still waiting for a time ahead, soonest first, from pi-durable's records; a due one is about to
 * run. The Scheduled tasks sheet and the master's own tools both read them here.
 */
export async function waitingTasks(harness: Harness, context: Context): Promise<WaitingTask[]> {
  const waiting: WaitingTask[] = [];
  for (const { record } of (await harness.inspect(context)).tasks) {
    if (record.kind !== SCHEDULED_TASK || record.abortRequested) continue;
    const input = scheduledInput(record.input);
    if (input && input.until > Date.now()) waiting.push({ ...input, id: record.id });
  }
  return waiting.sort((left, right) => left.until - right.until);
}

/** Aborts a scheduled task still waiting, as pi-durable's example 23 cancels a task; false when it was sent first. */
export async function abortScheduled(harness: Harness, id: TaskId, context: Context): Promise<boolean> {
  await harness.abortTask(id, context);
  return (await harness.waitForTask(id, context)).state.outcome.status === 'aborted';
}

/** The time as the `date` tool shows one: the device's local time, without a zone. */
const localTime = (time: number): string => new Date(time).toLocaleString('sv-SE');

const reply = (text: string) => ({ output: [{ type: 'text' as const, text }] });
const invalidTime = (value: string) =>
  `Invalid run_after: ${value}. Give an ISO 8601 date and time, for example 2026-10-21T09:00:00.`;
const notWaiting = (id: number) => `No scheduled task ${id} is waiting.`;
const TIME_FORMAT = 'as an ISO 8601 date and time in the device\'s local time, for example 2026-10-21T09:00:00, or '
  + 'with an offset.';
const TASK_NUMBER = 'The task\'s number, as schedule_task and list_scheduled_tasks give it.';

/**
 * The master's schedule tools. `schedule_task` sends `task` back to the master at `run_after`; the others list, change
 * and cancel the tasks still waiting, as the Scheduled tasks sheet does. A tool's own API has no abort for a task its
 * conversation owns, so they reach the Harness they run in, through `harness`, for its `abortTask`.
 */
export function scheduleTools(
  rootId: ConversationId, scheduled: ReturnType<typeof scheduledTask>, harness: () => Harness | undefined,
) {
  const open = () => {
    const opened = harness();
    if (!opened) throw new Error('The schedule tools have no open Harness.');
    return opened;
  };
  const create = (tx: Tx, input: ScheduledInput) => tx.createTask(scheduled, input, {
    conversationId: rootId,
    ownership: { kind: 'conversation' },
    background: true,
  });
  /** Aborts the waiting task a call names by number; undefined when none waits under it, or it was sent first. */
  const stop = async (id: number, context: Context): Promise<WaitingTask | undefined> => {
    const found = (await waitingTasks(open(), context)).find((task) => task.id === id);
    return found && await abortScheduled(open(), found.id, context) ? found : undefined;
  };
  const schedule = defineTool({
    name: 'schedule_task',
    description: 'Schedule a task for yourself at a later time. At run_after, or as soon as you run again if you '
      + 'aren\'t running then, the task reaches you as a message "[Scheduled task]" followed by the task, as a new '
      + 'turn or between your tool calls.',
    replay: 'safe',
    parameters: obj({
      task: str({ description: 'What to do then; it reaches you as written.' }),
      run_after: str({ description: `When it reaches you, ${TIME_FORMAT}` }),
    }, { open: true }),
    async execute({ task, run_after }, api, context) {
      const until = Date.parse(run_after);
      if (Number.isNaN(until)) return reply(invalidTime(run_after));
      return reply(await api.commit(async (tx) => {
        // A native tool task may replay after a lost result commit; its own ID makes it act once.
        const done = await tx.doc(AgentCallDoc, rootId, String(api.taskId), null);
        if (done.result !== null) return done.result;
        const id = await create(tx, { task, until });
        done.result = `Scheduled as task ${id} for ${localTime(until)}. It will reach you then as a message.`;
        return done.result;
      }, context));
    },
  });
  const list = defineTool({
    name: 'list_scheduled_tasks',
    description: 'List your scheduled tasks still waiting: each one\'s number, time and task.',
    replay: 'safe',
    parameters: obj({}, { open: true }),
    async execute(_args, _api, context) {
      const tasks = await waitingTasks(open(), context);
      if (tasks.length === 0) return reply('No scheduled tasks are waiting.');
      return reply(tasks.map(({ id, task, until }) => `Task ${id}, for ${localTime(until)}:\n${task}`).join('\n\n'));
    },
  });
  const change = defineTool({
    name: 'change_scheduled_task',
    description: 'Change a scheduled task still waiting, by its number: its task, its time, or both. The changed '
      + 'task gets a new number.',
    // As the `stop` of pi-durable's background-subagent example, a call a crash interrupted is not rerun: the model
    // sees that, and lists the tasks to learn whether the change was made.
    replay: 'unsafe',
    parameters: obj({
      id: num({ description: TASK_NUMBER }),
      task: opt(str({ description: 'What to do then, in place of the task as it was.' })),
      run_after: opt(str({ description: `When it reaches you instead, ${TIME_FORMAT}` })),
    }, { open: true }),
    async execute({ id, task, run_after }, api, context) {
      if (task === undefined && run_after === undefined) return reply('Give a task, a run_after, or both.');
      const until = run_after === undefined ? undefined : Date.parse(run_after);
      if (run_after !== undefined && Number.isNaN(until)) return reply(invalidTime(run_after));
      // A task's input never changes, so the changed task is a new one in the old one's place.
      const old = await stop(id, context);
      if (!old) return reply(notWaiting(id));
      const input = { task: task ?? old.task, until: until ?? old.until };
      const next = await api.commit((tx) => create(tx, input), context);
      return reply(`Task ${id} is now task ${next}, for ${localTime(input.until)}.`);
    },
  });
  const cancel = defineTool({
    name: 'cancel_scheduled_task',
    description: 'Cancel a scheduled task still waiting, by its number, so it never reaches you.',
    // A rerun after a crash finds no task under the number, which never names another.
    replay: 'safe',
    parameters: obj({ id: num({ description: TASK_NUMBER }) }, { open: true }),
    async execute({ id }, _api, context) {
      return reply(await stop(id, context) ? `Cancelled task ${id}.` : notWaiting(id));
    },
  });
  return [schedule, list, change, cancel];
}
