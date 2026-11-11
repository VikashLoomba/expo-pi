import type { Context } from '@earendil-works/chord/context';
import type { JsonValue } from '@earendil-works/chord/json';
import { compile, int, lit, nul, num, obj, opt, str, union, type Static } from '@earendil-works/pi-schema';
import {
  defineTask, defineTool, type ConversationId, type Harness, type TaskId, type Tx,
} from '@earendil-works/pi-durable';

import { AgentCallDoc } from './agents';

/** The scheduled task's registered kind: a background task that waits, so the keep-alive never counts it as work. */
export const SCHEDULED_TASK = 'optchat.scheduled-task';

/** How often a scheduled task comes again: every `every` units after its first time, on the device's local clock. */
export const RepeatSchema = obj({
  every: int({ minimum: 1 }),
  unit: union([lit('hour'), lit('day'), lit('week'), lit('month')]),
});
export type Repeat = Static<typeof RepeatSchema>;

/** What the main agent is sent, when (its first time, as a Harness clock time), and how often after that. */
export const ScheduledInputProperties = { task: str(), until: num(), repeat: opt(RepeatSchema) };
export const ScheduledInputSchema = obj(ScheduledInputProperties);
export type ScheduledInput = Static<typeof ScheduledInputSchema>;

/** A repeat as the tools say it, "every week" or "every 3 days", and as the Scheduled tasks sheets title it. */
export const repeatText = ({ every, unit }: Repeat): string =>
  every === 1 ? `every ${unit}` : `every ${every} ${unit}s`;
export const repeatLabel = (repeat: Repeat): string => {
  const text = repeatText(repeat);
  return text.charAt(0).toUpperCase() + text.slice(1);
};
/** A repeat as one string, for a picker's selection; `ONCE` for a task that comes once. */
export const ONCE = 'once';
export const repeatKey = (repeat: Repeat | undefined): string => repeat ? `${repeat.every} ${repeat.unit}` : ONCE;
/** The repeats the Scheduled tasks sheets offer; the agent may set any other. */
export const REPEAT_CHOICES: readonly Repeat[] = [
  { every: 1, unit: 'day' }, { every: 1, unit: 'week' }, { every: 1, unit: 'month' },
];

/**
 * A task's time after `run` repeats: counted from its first on the local clock, so a task at 09:00 stays at 09:00
 * across a clock change. A month without the day ends on its last one: the 31st comes on the 30th.
 */
export function occurrence({ until, repeat }: ScheduledInput, run: number): number {
  if (repeat === undefined || run === 0) return until;
  const count = repeat.every * run;
  if (repeat.unit === 'hour') return until + count * 3_600_000;
  const time = new Date(until);
  if (repeat.unit === 'month') {
    const day = time.getDate();
    time.setDate(1);
    time.setMonth(time.getMonth() + count);
    time.setDate(Math.min(day, new Date(time.getFullYear(), time.getMonth() + 1, 0).getDate()));
  } else {
    time.setDate(time.getDate() + count * (repeat.unit === 'week' ? 7 : 1));
  }
  return time.getTime();
}

/** Admits a work message to the main agent in the caller's commit, as OptChat admits an agent's report. */
type AdmitWork = (tx: Tx, root: ConversationId, input: { requestId: string; content: string; date: string }) =>
  Promise<void>;

/**
 * A future message to the main agent. As pi-durable's own compaction retries, the task sleeps durably on the Harness
 * clock, holding no invocation, so a reopened Harness resumes it at the time, or at once when the time has passed while
 * the app was closed. The commit that ends the task admits the message, so it is sent once. A repeating task never
 * ends on its own: the commit that admits a run puts the task back to sleep until its next time.
 */
/** `run` counts the repeats behind a task: it waits for its time after that many. */
type Waiting = { phase: 'wait'; run: number };

export const scheduledTask = (admit: AdmitWork) => defineTask<ScheduledInput, Waiting, null>({
  name: SCHEDULED_TASK,
  version: 2,
  // Version 1 was sent once, so it counted no repeats.
  migrate: (input, checkpoint) => ({
    input: input as ScheduledInput,
    checkpoint: { ...(checkpoint as { phase: 'wait' }), run: 0 },
  }),
  initial: () => ({ phase: 'wait', run: 0 }),
  phases: {
    async wait(task, runtime, context) {
      const { run } = task.state.checkpoint;
      const due = occurrence(task.input, run);
      // A run before the time (the first one, or an early wake) sleeps until it.
      if (due > runtime.now()) return runtime.sleepUntil(due, task.state.checkpoint, context);
      await runtime.commit(async (tx) => {
        const now = runtime.now();
        await admit(tx, runtime.conversationId, {
          // Each repeat is an input of its own; the first time keeps the ID a task sent once has.
          requestId: run === 0 ? `optchat:scheduled:${task.id}` : `optchat:scheduled:${task.id}:${run}`,
          content: `[Scheduled task]\n${task.input.task}`,
          date: new Date(now).toISOString(),
        });
        if (task.input.repeat === undefined) {
          return { status: 'terminal', outcome: { status: 'completed', result: null } };
        }
        // As pi-durable's ticker sleeps between ticks (`12-recovery.ts`), in the commit that sent this run, so a turn
        // that fails cannot end the repeat. Times that passed while the Harness was closed are skipped: the task was
        // sent once for them, just now.
        let next = run + 1;
        while (occurrence(task.input, next) <= now) next++;
        return { status: 'sleeping', checkpoint: { phase: 'wait', run: next }, until: occurrence(task.input, next) };
      }, context);
    },
  },
  abort: (_task, runtime, context) =>
    runtime.commit(() => ({ status: 'terminal', outcome: { status: 'aborted' } }), context),
});

const isScheduledInput = compile(ScheduledInputSchema);
/** The input of a scheduled task, read from pi-durable's own record. */
const scheduledInput = (value: JsonValue): ScheduledInput | undefined =>
  isScheduledInput.check(value) ? value : undefined;

/** The repeats behind a waiting record, from its checkpoint; none in a record from before tasks repeated. */
const runOf = (checkpoint: unknown): number => typeof checkpoint === 'object' && checkpoint !== null
  && 'run' in checkpoint && typeof checkpoint.run === 'number' ? checkpoint.run : 0;

/** A scheduled task still waiting, under pi-durable's own ID for it; `until` is the next time it comes. */
export type WaitingTask = ScheduledInput & { id: TaskId };

/**
 * The scheduled tasks still waiting for a time ahead, soonest first, from pi-durable's records; a due one is about to
 * run. The Scheduled tasks sheet and the master's own tools both read them here.
 */
export async function waitingTasks(harness: Harness, context: Context): Promise<WaitingTask[]> {
  const waiting: WaitingTask[] = [];
  for (const { record } of (await harness.inspect(context)).tasks) {
    if (record.kind !== SCHEDULED_TASK || record.abortRequested || record.state.status === 'terminal') continue;
    const input = scheduledInput(record.input);
    if (!input) continue;
    const until = occurrence(input, 'checkpoint' in record.state ? runOf(record.state.checkpoint) : 0);
    // A repeating task always waits for a next time; one that comes once and is due is about to run.
    if (input.repeat !== undefined || until > Date.now()) waiting.push({ ...input, until, id: record.id });
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
/** A waiting task's repeat as its answers add it after the time. */
const again = (repeat: Repeat | undefined): string => repeat ? `, then ${repeatText(repeat)}` : '';

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
      + 'turn or between your tool calls. With repeat, for example {"every": 1, "unit": "week"}, it reaches you again '
      + 'that often after run_after, at the same local time, until you cancel it.',
    replay: 'safe',
    parameters: obj({
      task: str({ description: 'What to do then; it reaches you as written.' }),
      run_after: str({ description: `When it reaches you, ${TIME_FORMAT}` }),
      repeat: opt(RepeatSchema),
    }, { open: true }),
    async execute({ task, run_after, repeat }, api, context) {
      const until = Date.parse(run_after);
      if (Number.isNaN(until)) return reply(invalidTime(run_after));
      return reply(await api.commit(async (tx) => {
        // A native tool task may replay after a lost result commit; its own ID makes it act once.
        const done = await tx.doc(AgentCallDoc, rootId, String(api.taskId), null);
        if (done.result !== null) return done.result;
        const id = await create(tx, repeat === undefined ? { task, until } : { task, until, repeat });
        done.result = `Scheduled as task ${id} for ${localTime(until)}${again(repeat)}. It will reach you then as a `
          + 'message.';
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
      return reply(tasks.map(({ id, task, until, repeat }) =>
        `Task ${id}, for ${localTime(until)}${again(repeat)}:\n${task}`).join('\n\n'));
    },
  });
  const change = defineTool({
    name: 'change_scheduled_task',
    description: 'Change a scheduled task still waiting, by its number: its task, its time, how often it repeats, or '
      + 'several of them; a repeat of null makes it come once. The changed task gets a new number.',
    // As the `stop` of pi-durable's background-subagent example, a call a crash interrupted is not rerun: the model
    // sees that, and lists the tasks to learn whether the change was made.
    replay: 'unsafe',
    parameters: obj({
      id: num({ description: TASK_NUMBER }),
      task: opt(str({ description: 'What to do then, in place of the task as it was.' })),
      run_after: opt(str({ description: `When it reaches you instead, ${TIME_FORMAT}` })),
      repeat: opt(union([RepeatSchema, nul()])),
    }, { open: true }),
    async execute({ id, task, run_after, repeat }, api, context) {
      if (task === undefined && run_after === undefined && repeat === undefined) {
        return reply('Give a task, a run_after, a repeat, or several of them.');
      }
      const until = run_after === undefined ? undefined : Date.parse(run_after);
      if (run_after !== undefined && Number.isNaN(until)) return reply(invalidTime(run_after));
      // A task's input never changes, so the changed task is a new one in the old one's place.
      const old = await stop(id, context);
      if (!old) return reply(notWaiting(id));
      const repeats = repeat === undefined ? old.repeat : repeat ?? undefined;
      const input: ScheduledInput = { task: task ?? old.task, until: until ?? old.until,
        ...(repeats === undefined ? {} : { repeat: repeats }) };
      const next = await api.commit((tx) => create(tx, input), context);
      return reply(`Task ${id} is now task ${next}, for ${localTime(input.until)}${again(repeats)}.`);
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
