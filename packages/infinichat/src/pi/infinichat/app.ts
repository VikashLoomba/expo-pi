import type { Context, JsonRepresentation } from '@earendil-works/chord';
import { awaitWithContext, withAbortSignal } from '@earendil-works/chord/context';
import type { ImageContent, Models } from '@earendil-works/pi-ai';
import {
  AgentDoc as NativeAgentDoc, Harness, InboxDoc, LiveDoc, ROOT_CONVERSATION_ID, ResetEntry,
  configure, defineDoc, defineDocFamily, defineEntry, defineExtension, defineTask, section,
  type Conversation, type ConversationId, type ConversationInit, type EntryId, type EnvTarget, type Extension,
  type HarnessOptions, type RegistryReader, type Storage, type Submission, type SubmissionRecord, type TaskId,
  type ToolHookCall, type ToolRegistration, type Tx, type UserInput,
} from '@earendil-works/pi-durable';
import type { ExecutionEnv } from '@earendil-works/pi-durable/env';

import { SearchObservationEntry } from '../native-web-search/entries';
import {
  AgentAnchor, AgentDirectoryDoc, agentTask, agentTools, agentWork, agentsAtWork, takeAgentReports,
} from './agents';
import { MemoryDoc, advanceMessageProgress, appendMessage, memoryReady, renderMain, settleViews } from './memory';
import { sharedPrompt, subagentPrompt } from './prompt';
import { scheduleTool, scheduledTask, type ScheduledInput } from './schedule';
import { BuildNode, ConfigDoc, pumpBuilds } from './summary';
import { memoryTools, toolPolicy, type NativeContracts } from './tools';

export type Admission = {
  requestId: string;
  kind: 'user' | 'work' | 'note';
  content: JsonRepresentation<UserInput>;
  date: string;
  epoch: number;
  fresh: boolean;
  phase: 'pending' | 'prepared' | 'submitted' | 'cancelled';
  envelope: JsonRepresentation<UserInput> | null;
  /** Its native submissions so far, less one: an input withdrawn after a failed or faulted run is submitted anew. */
  attempt: number;
};
type AdmissionV2 = Omit<Admission, 'attempt'>;
export const InputDoc = defineDocFamily<{ value: Admission | null }, Admission | null>({
  kind: 'optchat.input',
  version: 3,
  scope: 'conversation',
  history: 'latest',
  fork: 'current',
  family: true,
  checkpointWhen: () => true,
  migrate: (value) => {
    // Version 1 kept the turn state each input was accepted with; a turn now reads it as it starts. Versions 1 and 2
    // submitted each input once.
    const stored = (value as { value: (AdmissionV2 & { turnState?: string }) | null }).value;
    if (stored === null) return { value: null };
    const { turnState: _accepted, ...admission } = stored;
    return { value: { ...admission, attempt: 0 } };
  },
  initial: (value) => ({ value }),
});
/** The entry a dispatched input is placed as. Its user message carries the envelope; the input is in `InputDoc`. */
export const DeliveryEntry = defineEntry<{ requestId: string; kind: Admission['kind'] }>('optchat.delivery');
/**
 * 3: the conversation stores no tool list, so the model is offered the host's tools. 2: the prompt is the extension's
 * section and `instructions` hold only the user's text. 1 composed both and stored the tools it was created with.
 */
const PROMPT_VERSION = 3;
export type AppState = {
  /** The prompt and tool layout the conversation's agent was configured for, `PROMPT_VERSION` once current. */
  promptVersion: number;
  epoch: number;
  open: boolean;
  started: boolean;
  requests: string[];
  pending: string[];
  cursor: EntryId | null;
  coordinator: TaskId | null;
  revision: number;
  stop: number;
  stopped: number;
  stopPending: string[];
  /** Why the turn ended without a reply, a stop's or a failure's note, logged once its last entries are. */
  endNote: string | null;
  /** Tool calls projected but not logged yet: each is logged right before its result, as UniiChat logs them. */
  held: Record<string, Logged>;
  /**
   * The latest failed or stopped attempt's replies and calls: a retry drops them, as UniiChat drops a retried try, and
   * the run's end logs them cut off.
   */
  cut: { why: string; records: (Logged & { kind: 'unii' | 'tool' })[] } | null;
};
type Logged = { text: string; date: string; source: string };
type AppStateV3 = Omit<AppState, 'endNote' | 'cut'> & { stopNote: string | null };
type AppStateV2 = Omit<AppStateV3, 'stopNote' | 'held'>;
export const AppDoc = defineDoc<AppState>({
  kind: 'optchat.app',
  version: 4,
  scope: 'conversation',
  history: 'latest',
  fork: 'current',
  checkpointWhen: () => true,
  migrate: (value, fromVersion) => {
    let stored: AppStateV3;
    if (fromVersion < 3) {
      // Version 1 had no prompt version; its instructions hold the composed prompt.
      const older = fromVersion < 2
        ? { ...(value as Omit<AppStateV2, 'promptVersion'>), promptVersion: 1 }
        : (value as AppStateV2);
      // Version 2 logged a call with its assistant message, so no call waits for its result, and noted no stop.
      stored = { ...older, stopNote: null, held: {} };
    } else {
      stored = value as AppStateV3;
    }
    // Version 3 noted only a stop and logged a failed attempt as a reply, so none is held.
    const { stopNote, ...rest } = stored;
    return { ...rest, endNote: stopNote, cut: null };
  },
  initial: () => ({
    promptVersion: PROMPT_VERSION,
    epoch: 0,
    open: false,
    started: false,
    requests: [],
    pending: [],
    cursor: null,
    coordinator: null,
    revision: 0,
    stop: 0,
    stopped: 0,
    stopPending: [],
    endNote: null,
    held: {},
    cut: null,
  }),
});

const textOf = (input: UserInput): string => typeof input === 'string'
  ? input
  : input.filter((x) => x.type === 'text').map((x) => x.text).join('');
const imagesOf = (input: UserInput): ImageContent[] => typeof input === 'string'
  ? []
  : input.filter((x): x is ImageContent => x.type === 'image').map((x) => ({ ...x }));

/** The admission a request ID names; absent only when application state is inconsistent. */
async function storedInput(tx: Tx, root: ConversationId, requestId: string): Promise<Admission> {
  const stored = (await tx.doc(InputDoc, root, requestId, null)).value;
  if (!stored) throw new Error(`Unknown OptChat request: ${requestId}`);
  return stored;
}

/** pi-durable withdrew it: it was queued behind a run that failed (`afterFailedRun: 'withdraw'`). */
const withdrawn = (receipt: SubmissionRecord): boolean =>
  receipt.status === 'unanswered' && receipt.reason === 'run_failed';

/**
 * The native run and its real receipts decide whether an epoch is still open. A run that failed leaves UniiChat's
 * note for the turn, once its last entries are logged.
 */
async function closeSettledEpoch(tx: Tx, root: ConversationId): Promise<void> {
  const app = await tx.doc(AppDoc, root);
  const live = await tx.doc(LiveDoc, root);
  const inbox = await tx.doc(InboxDoc, root);
  if (!app.open || !app.started || live.run || inbox.items.some((i) => i.mode !== 'write')) return;
  let failed: string | undefined;
  for (const id of app.requests) {
    const receipt = await tx.submissionByRequest(root, nativeRequest(await storedInput(tx, root, id)));
    // A prepared effect with a lost acknowledgement is not pending if its receipt settled. A withdrawn one is, until
    // it is submitted anew.
    if (!receipt || receipt.status === 'queued' || receipt.status === 'placed' || withdrawn(receipt)) return;
    if (receipt.status === 'unanswered' && receipt.reason !== 'aborted') {
      failed ??= typeof receipt.detail === 'string' ? receipt.detail : receipt.reason;
    }
  }
  if (failed !== undefined) app.endNote ??= `No reply: ${failed.replace(/\.$/, '')}. Send a message to try again.`;
  app.open = false;
  app.requests = [];
  app.revision++;
}
/** The first submission keeps the request ID that inputs before attempts were submitted with. */
const nativeRequest = ({ requestId, attempt }: Pick<Admission, 'requestId' | 'attempt'>): string =>
  attempt === 0 ? `optchat:${requestId}` : `optchat:${requestId}:${attempt}`;

/**
 * Inputs the last turn didn't take start the next, as UniiChat's next call takes the messages its last one didn't: the
 * old epoch closes, with its note, and the first of them opens a fresh one.
 */
async function carryOver(tx: Tx, root: ConversationId, moved: string[]): Promise<void> {
  const app = await tx.doc(AppDoc, root);
  app.requests = app.requests.filter((id) => !moved.includes(id));
  await closeSettledEpoch(tx, root);
  app.epoch++;
  app.open = true;
  app.started = false;
  app.requests = [...moved];
  for (const id of moved) {
    const input = await storedInput(tx, root, id);
    input.epoch = app.epoch;
    input.fresh = id === moved[0];
    input.phase = 'pending';
    input.envelope = null;
  }
  app.revision++;
}

/**
 * pi-durable withdraws the inputs queued behind a failed run, which it would otherwise place in the next run's
 * context. Each is submitted anew as its next attempt, and with the inputs the turn had not taken yet they start a
 * fresh turn. False when nothing was withdrawn.
 */
async function requeueWithdrawn(tx: Tx, root: ConversationId): Promise<boolean> {
  const app = await tx.doc(AppDoc, root);
  let requeued = false;
  for (const id of app.requests) {
    const input = await storedInput(tx, root, id);
    const receipt = await tx.submissionByRequest(root, nativeRequest(input));
    if (!receipt || !withdrawn(receipt)) continue;
    input.attempt++;
    input.phase = 'pending';
    input.envelope = null;
    requeued = true;
  }
  if (!requeued) return false;
  const moved: string[] = [];
  for (const id of app.requests) {
    if (!(await tx.submissionByRequest(root, nativeRequest(await storedInput(tx, root, id))))) moved.push(id);
  }
  app.pending = [...moved, ...app.pending.filter((id) => !moved.includes(id))];
  await carryOver(tx, root, moved);
  return true;
}

/**
 * A run whose task faulted keeps its inbox (pi-durable spec "afterFailedRun"), and pi-durable would place it in the
 * next run's context, so each input still queued is withdrawn here and submitted anew, as a failed run's is. Its
 * attempt is counted before the withdrawal settles the old submission, so a wait for it goes on.
 */
async function countRequeued(tx: Tx, root: ConversationId): Promise<void> {
  const app = await tx.doc(AppDoc, root);
  for (const id of app.requests) {
    const input = await storedInput(tx, root, id);
    if ((await tx.submissionByRequest(root, nativeRequest(input)))?.status !== 'queued') continue;
    input.attempt++;
    input.phase = 'pending';
    input.envelope = null;
  }
  app.revision++;
}

/** After the coordinator's withdrawal: the inputs with no submission for their attempt start a fresh turn. */
async function requeueAborted(tx: Tx, root: ConversationId): Promise<void> {
  const app = await tx.doc(AppDoc, root);
  const moved: string[] = [];
  for (const id of app.requests) {
    if (!(await tx.submissionByRequest(root, nativeRequest(await storedInput(tx, root, id))))) moved.push(id);
  }
  app.pending = [...moved, ...app.pending.filter((id) => !moved.includes(id))];
  if (moved.length > 0) await carryOver(tx, root, moved);
  else await closeSettledEpoch(tx, root);
}

/** Called in the acceptance transaction, including when a private report arrives or a scheduled task ends. */
async function admitInput(tx: Tx, root: ConversationId, input: {
  requestId: string;
  kind: 'user' | 'work' | 'note';
  content: UserInput;
  date: string;
}): Promise<void> {
  const stored = await tx.doc(InputDoc, root, input.requestId, null);
  if (stored.value) {
    const previous = stored.value;
    if (previous.kind !== input.kind || JSON.stringify(previous.content) !== JSON.stringify(input.content)) {
      throw new Error('A request ID cannot identify different input');
    }
    return;
  }
  await closeSettledEpoch(tx, root);
  const app = await tx.doc(AppDoc, root);
  if (input.kind === 'note') {
    stored.value = {
      ...input,
      content: input.content,
      epoch: app.epoch,
      fresh: false,
      phase: 'pending',
      envelope: null,
      attempt: 0,
    };
    app.pending.push(input.requestId);
    app.revision++;
    await advanceMessageProgress(tx, root);
    return;
  }
  const fresh = !app.open;
  if (fresh) {
    app.epoch++;
    app.open = true;
    app.started = false;
    app.requests = [];
  }
  stored.value = {
    ...input,
    content: input.content,
    epoch: app.epoch,
    fresh,
    phase: 'pending',
    envelope: null,
    attempt: 0,
  };
  app.requests.push(input.requestId);
  app.pending.push(input.requestId);
  app.revision++;
  // Accepted external input re-enables failed builds even while the fresh-turn gate waits.
  await advanceMessageProgress(tx, root);
}

/** Project each immutable native entry once. Reset affects context, never this cursor. */
async function projectEntries(tx: Tx, root: ConversationId): Promise<{ progressed: boolean; caughtUp: boolean }> {
  const app = await tx.doc(AppDoc, root);
  const entries = await tx.scanEntries({
    conversationId: root,
    order: 'ascending',
    ...(app.cursor ? { minEntryId: app.cursor } : {}),
  }, 128);
  let progressed = false;
  for (const entry of entries.items) {
    if (entry.id === app.cursor) continue;
    let index = 0;
    // A placed delivery logs the user's own message, as UniiChat's chat does: the original the admission keeps, not
    // the envelope.
    if (DeliveryEntry.is(entry)) {
      const input = await storedInput(tx, root, entry.data.requestId);
      await appendMessage(tx, root, {
        kind: input.kind,
        text: textOf(input.content),
        date: input.date,
        images: imagesOf(input.content),
        source: `input:${input.requestId}`,
      }, false);
    }
    for (const message of entry.model ?? []) {
      const date = new Date('timestamp' in message ? message.timestamp : 0).toISOString();
      if (message.role === 'assistant') {
        // Replies trimmed, as UniiChat logs them; thinking stays in native history, never in memory.
        const records: (Logged & { kind: 'unii' | 'tool'; call?: string })[] = [];
        let text = '';
        const reply = () => {
          if (text.trim()) records.push({ kind: 'unii', text: text.trim(), date, source: `${entry.id}:${index++}` });
          text = '';
        };
        for (const block of message.content) {
          if (block.type === 'text') {
            text += block.text;
          } else if (block.type === 'toolCall') {
            reply();
            const call = `${block.name} ${JSON.stringify(block.arguments)}`;
            records.push({ kind: 'tool', text: call, date, source: `${entry.id}:${index++}`, call: block.id });
          }
        }
        reply();
        if (message.stopReason === 'error' || message.stopReason === 'aborted') {
          // pi-durable commits a failed attempt before retrying it, and a stop's partial as aborted. Its calls never
          // run.
          const why = message.stopReason === 'aborted' ? 'stopped' : message.errorMessage ?? 'the reply failed';
          app.cut = { why, records: records.map(({ call: _never, ...record }) => record) };
        } else {
          app.cut = null;
          for (const { call, ...record } of records) {
            // pi-durable gives every call a result, an aborted one too, so a held call is always logged.
            if (call !== undefined) app.held[call] = { text: record.text, date: record.date, source: record.source };
            else await appendMessage(tx, root, { ...record, images: [] });
          }
          // UniiChat counts a reply cut at the output limit as none.
          if (message.stopReason === 'length') {
            app.endNote ??= `No reply: stopped: ${message.rawStopReason ?? 'length'}. Send a message to try again.`;
          }
        }
      } else if (message.role === 'toolResult') {
        const call = app.held[message.toolCallId];
        if (call) {
          await appendMessage(tx, root, { ...call, kind: 'tool', images: [] });
          delete app.held[message.toolCallId];
        }
        // Text only, an image as UniiChat shows a result's part: the model saw it in its turn.
        const text = message.content.map((x) => (x.type === 'text' ? x.text : '[image]')).join('\n');
        await appendMessage(tx, root, {
          kind: 'echo',
          text: `${message.isError ? 'error: ' : ''}${text || '(no output)'}`,
          date,
          images: [],
          source: `${entry.id}:${index++}`,
        });
      } else if (message.role === 'user' && SearchObservationEntry.is(entry)) {
        // OpenAI's hosted web search, logged as a tool call and its result (owner, 2026-10-30). pi-durable places the
        // findings at the boundary after the reply that searched, so they follow it.
        await appendMessage(tx, root, { kind: 'tool', text: `web_search ${JSON.stringify(entry.data.action)}`, date,
          images: [], source: `${entry.id}:${index++}` });
        await appendMessage(tx, root, { kind: 'echo', text: textOf(message.content), date, images: [],
          source: `${entry.id}:${index++}` });
      }
      // The delivery's user message is the envelope; its original was logged above.
    }
    app.cursor = entry.id;
    progressed = true;
  }
  if (progressed) app.revision++;
  return { progressed, caughtUp: entries.next === undefined };
}

async function consumeReports(tx: Tx, root: ConversationId, date: string): Promise<void> {
  for (const report of await takeAgentReports(tx, root)) {
    // A stopped agent's report is logged with no turn, as UniiChat's is.
    if (report.stopped) {
      await appendMessage(tx, root, { kind: 'work', text: report.text, date, images: [],
        source: `input:${report.requestId}` });
    } else {
      await admitInput(tx, root, { requestId: report.requestId, kind: 'work', content: report.text, date });
    }
  }
}

/**
 * A fresh turn's message, as UniiChat's: the view, the host's turn state and the agents at work, which change, so
 * they follow the cached view and never enter the prompt; then the head that tells a turn from a compaction.
 */
function envelope(view: string, content: UserInput, turnState: string, agents: string[]): UserInput {
  const state = turnState ? `${turnState}\n\n` : '';
  const working = agents.length ? agents.join(', ') : 'none';
  return [
    { type: 'text', text: view },
    { type: 'text', text: `\n${state}Agents at work now: ${working}.\n\nTurn: the user's new message:\n\n` },
    ...(typeof content === 'string' ? [{ type: 'text' as const, text: content }] : content),
  ];
}

type CoordinatorState = { phase: 'coordinate'; tick: number };
/** `turnState` is the host's; a turn reads it as it starts. */
const coordinatorTask = (turnState: () => Promise<string>) => defineTask<
  Record<string, never>, CoordinatorState, null
>({
  name: 'optchat.coordinator',
  version: 1,
  initial: () => ({ phase: 'coordinate', tick: 0 }),
  phases: {
    async coordinate(task, runtime, context) {
      const root = runtime.conversationId;
      const invocation = withAbortSignal(runtime.signal, context);
      // Read only while an input or a report waits, outside the commit; a host that can't tell (a locked keychain) is
      // reported, and the turn starts without it rather than never.
      const pending = (await runtime.snapshot(AppDoc, root, invocation))?.pending.length ?? 0;
      const reports = (await runtime.snapshot(AgentDirectoryDoc, root, invocation))?.pendingReports.length ?? 0;
      const read = pending + reports > 0;
      const state = !read ? '' : await turnState().catch((error: unknown) => {
        runtime.report(error);
        return '';
      });
      const acquired = await Promise.all([
        runtime.watchDoc(AppDoc, root, invocation),
        runtime.watchDoc(MemoryDoc, root, invocation),
        runtime.watchDoc(LiveDoc, root, invocation),
        runtime.watchDoc(InboxDoc, root, invocation),
        runtime.watchDoc(AgentDirectoryDoc, root, invocation),
      ]);
      if (acquired.some((watch) => !watch)) {
        await Promise.all(acquired.map((watch) => watch?.stop()));
        throw new Error('OptChat documents were not initialized');
      }
      const watches = acquired.flatMap((watch) => (watch ? [watch] : []));
      const changed = new Promise<void>((resolve) => {
        for (const watch of watches) {
          const seen = JSON.stringify(watch.value);
          watch.start(async (value) => {
            if (JSON.stringify(value) !== seen) resolve();
          });
        }
      });
      let dispatchId: string | undefined;
      let stop = 0;
      let withdraw = false;
      let progressed = false;
      try {
        await runtime.commit(async (tx) => {
          // All native table reads happen before reset/task creation table writes.
          const projection = await projectEntries(tx, root);
          progressed = projection.progressed;
          const now = new Date(runtime.now()).toISOString();
          await consumeReports(tx, root, now);
          await closeSettledEpoch(tx, root);
          const app = await tx.doc(AppDoc, root);
          const running = (await tx.doc(LiveDoc, root)).run !== undefined;
          const ended = app.stopped >= app.stop && projection.caughtUp && !running;
          if (ended && (app.cut || app.endNote !== null)) {
            // As UniiChat ends a turn without a reply: what the cut attempt wrote, marked, then why.
            for (const record of app.cut?.records ?? []) {
              const mark = `\n[cut off: ${app.cut?.why.slice(0, 300)}]`;
              await appendMessage(tx, root, { ...record, text: record.text + mark, images: [] });
            }
            if (app.endNote !== null) {
              await appendMessage(tx, root, { kind: 'note', text: app.endNote, date: now, images: [],
                source: `end:${app.epoch}:${app.stop}` });
            }
            app.cut = null;
            app.endNote = null;
            app.revision++;
            progressed = true;
          }
          const next = app.pending[0];
          if (ended && (await requeueWithdrawn(tx, root))) {
            progressed = true;
          } else if (ended && (await tx.doc(InboxDoc, root)).items.some((item) => item.mode !== 'write')) {
            // pi-durable withdrew a failed run's queue above; one still queued is behind a run whose task faulted.
            await countRequeued(tx, root);
            withdraw = true;
          } else if (app.stop > app.stopped) {
            if (projection.caughtUp) {
              stop = app.stop;
              // A withdrawn input was never handed to the model, so it never enters memory.
              for (const id of app.stopPending) {
                const input = await storedInput(tx, root, id);
                input.phase = 'cancelled';
                input.envelope = null;
              }
              app.pending = app.pending.filter((id) => !app.stopPending.includes(id));
              app.stopPending = [];
              app.revision++;
              progressed = true;
            }
          } else if (next !== undefined) {
            const input = await storedInput(tx, root, next);
            if (input.kind === 'note' && projection.caughtUp) {
              await appendMessage(tx, root, {
                kind: 'note',
                text: textOf(input.content),
                date: input.date,
                images: imagesOf(input.content),
                source: `input:${input.requestId}`,
              }, false);
              input.phase = 'submitted';
              app.pending.shift();
              app.revision++;
              progressed = true;
            } else if (!input.fresh && !running && app.started && projection.caughtUp
              && (input.phase !== 'prepared' || !(await tx.submissionByRequest(root, nativeRequest(input))))) {
              // Its turn ended before it reached it; one prepared but not submitted is prepared anew.
              await carryOver(tx, root, app.requests.filter((id) => app.pending.includes(id)));
              progressed = true;
            } else if (input.phase === 'prepared') {
              dispatchId = input.requestId;
            } else if (input.fresh && !read) {
              // Accepted after the turn state was skipped: the next tick reads it.
              progressed = true;
            } else if (projection.caughtUp && (!input.fresh || (await memoryReady(tx, root)))) {
              await settleViews(tx, root);
              // The view is frozen here; the original enters memory once pi-durable places the delivery. A message
              // sent while a turn runs goes to it as it is, between its tool calls.
              input.envelope = input.fresh
                ? envelope(await renderMain(tx, root), input.content, state, await agentsAtWork(tx, root))
                : input.content;
              input.phase = 'prepared';
              app.started = true;
              app.revision++;
              if (input.fresh) await tx.appendEntry(ResetEntry, root, { head: 'self' });
              dispatchId = input.requestId;
              progressed = true;
            }
          }
          const launched = await pumpBuilds(tx, root);
          if (launched.length > 0) progressed = true;
          // Effect must run outside this native commit; checkpoint the preparation first.
          if (dispatchId !== undefined || withdraw || progressed) {
            return {
              status: 'running',
              checkpoint: { phase: 'coordinate', tick: task.state.checkpoint.tick + 1 },
            };
          }
        }, context);
        if (withdraw) {
          const conversation = await runtime.conversation(root, context);
          if (!conversation) throw new Error('OptChat root conversation is missing');
          // With no run, an abort only withdraws the queued inputs.
          await conversation.abort(context);
          await runtime.commit(async (tx) => {
            await requeueAborted(tx, root);
            return { status: 'running', checkpoint: { phase: 'coordinate', tick: task.state.checkpoint.tick + 2 } };
          }, context);
        } else if (stop) {
          const conversation = await runtime.conversation(root, context);
          if (!conversation) throw new Error('OptChat root conversation is missing');
          await conversation.abort(context);
          await runtime.commit(async (tx) => {
            const app = await tx.doc(AppDoc, root);
            app.stopped = stop;
            app.revision++;
            return { status: 'running', checkpoint: { phase: 'coordinate', tick: task.state.checkpoint.tick + 2 } };
          }, context);
        } else if (dispatchId !== undefined) {
          const requestId = dispatchId;
          // The prepared admission is read back committed: a draft is not readable after its commit.
          const prepared = (await runtime.snapshot(InputDoc, root, requestId, context))?.value;
          if (!prepared?.envelope) throw new Error(`Prepared input has no envelope: ${requestId}`);
          const conversation = await runtime.conversation(root, context);
          if (!conversation) throw new Error('OptChat root conversation is missing');
          await conversation.submit({
            type: 'input',
            requestId: nativeRequest(prepared),
            content: prepared.envelope,
            whenBusy: 'steer',
            entry: { kind: DeliveryEntry.kind, data: { requestId, kind: prepared.kind } },
          }, context);
          await runtime.commit(async (tx) => {
            const app = await tx.doc(AppDoc, root);
            const saved = await storedInput(tx, root, requestId);
            saved.phase = 'submitted';
            saved.envelope = null;
            const position = app.pending.indexOf(requestId);
            if (position >= 0) app.pending.splice(position, 1);
            app.revision++;
            return { status: 'running', checkpoint: { phase: 'coordinate', tick: task.state.checkpoint.tick + 2 } };
          }, context);
        } else if (!progressed) {
          const ended = Promise.race(watches.map((watch) => watch.closed)).then((end) => {
            if (end.reason === 'session_failed' || end.reason === 'listener_error') throw end.error;
            throw new Error(`OptChat watch ended: ${end.reason}`);
          });
          await awaitWithContext(Promise.race([changed, ended]), invocation);
          await runtime.commit(() => ({
            status: 'running',
            checkpoint: { phase: 'coordinate', tick: task.state.checkpoint.tick + 1 },
          }), context);
        }
      } finally {
        await Promise.all(watches.map((watch) => watch.stop()));
      }
    },
  },
  async abort(_task, runtime, context) {
    await runtime.commit(() => ({ status: 'terminal', outcome: { status: 'aborted' } }), context);
  },
});

/** What OptChat's extensions are built from: host capabilities, none of them the Harness they run in. */
export type OptChatExtensionOptions = {
  /** The agent's name until the user names it in `ConfigDoc`. */
  name?: string;
  hasDeviceTools?: boolean;
  tools?: readonly ToolRegistration[];
  env?: HarnessOptions['env'];
  /** The environment a completed call ran in, for reading its spilled output. Default: `env` for the conversation. */
  callEnv?: (call: ToolHookCall, target: EnvTarget, context: Context) =>
    ExecutionEnv | undefined | Promise<ExecutionEnv | undefined>;
  nativeContracts?: NativeContracts;
  /** The host's own extensions, such as OpenAI's web search bridge. */
  extensions?: readonly Extension[];
  /** What changes between turns, such as the devices: read as a turn or a subagent starts, it follows the view. */
  turnState?: () => Promise<string>;
};

/**
 * OptChat's extensions, which a host installs in the registry its Harness reads, and the definitions the Harness
 * starts their tasks with. A task runs the code its registry holds under the definition's name.
 */
export type OptChatParts = {
  readonly name: string;
  readonly extensions: readonly Extension[];
  readonly coordinator: ReturnType<typeof coordinatorTask>;
  readonly scheduled: ReturnType<typeof scheduledTask>;
};

export type OptChatOptions = {
  models: Models;
  /** Where the Harness reads `parts.extensions` and the host's others, which may arrive after it opens. */
  registry: RegistryReader;
  parts: OptChatParts;
  env?: HarnessOptions['env'];
  onReport?: HarnessOptions['onReport'];
  /** Runs in the root conversation's creating commit after OptChat's own documents, for the host's documents. */
  init?: ConversationInit;
};

/**
 * All injected values are host capabilities, not omitted OptChat algorithms. The host selects the main model with
 * pi-durable's `configure` and the summary model in `ConfigDoc`, in one commit on `root`, before accepting input.
 */
export type OptChat = {
  harness: Harness;
  root: Conversation;
  accept(input: {
    requestId: string;
    content: UserInput;
    kind?: 'user' | 'work' | 'note';
    date?: string;
  }): Promise<string>;
  /**
   * The user's own instructions, pi-durable's `instructions` section rendered after the prompt, in the host's
   * settings commit; empty text clears them. The host shows them from the agent document.
   */
  setInstructions(tx: Tx, text: string): Promise<void>;
  waitForAnswer(requestId: string, context?: Context): ReturnType<Submission['wait']>;
  abort(): Promise<void>;
  /**
   * Aborts a scheduled task still waiting, as pi-durable's example 24 cancels a task, and schedules `replacement`
   * in its place, since a task's input never changes. False when the task was sent first.
   */
  cancelScheduled(id: TaskId, replacement?: ScheduledInput): Promise<boolean>;
  close(): Promise<void>;
};

/**
 * OptChat's extensions from host capabilities alone, so a registry can hold them before or without a Harness: the
 * tool policy reads each call's agent through the hook's own reader.
 */
export function optChatParts(options: OptChatExtensionOptions): OptChatParts {
  const name = options.name ?? 'OptChat';
  const hasDeviceTools = options.hasDeviceTools ?? false;
  const turnState = async () => (await options.turnState?.()) ?? '';
  const coordinator = coordinatorTask(turnState);
  const tools: ToolRegistration[] = [...memoryTools(ROOT_CONVERSATION_ID), ...(options.tools ?? [])];
  const agents = agentTask({
    master: () => master,
    prompt: async (tx, root) => subagentPrompt((await tx.doc(ConfigDoc, root)).name ?? name, hasDeviceTools),
    turnState,
  });
  const scheduled = scheduledTask((tx, id, input) => admitInput(tx, id, { ...input, kind: 'work' }));
  const agentCalls = [...agentTools(ROOT_CONVERSATION_ID, agents), scheduleTool(ROOT_CONVERSATION_ID, scheduled)];
  // The prompt is an extension's own section and the offered tools follow the host, so an edited prompt or tool set
  // reaches an existing conversation as pi-durable's system entry instead of staying as created. The master's prompt
  // and agent tools are an extension of their own, which a subagent's conversation goes without. The section reads the
  // agent's name from the conversation, so a rename reaches it the same way.
  const master: Extension = defineExtension({
    name: 'optchat.master',
    sections: [section('optchat', async ({ read, conversationId }, sectionContext) => sharedPrompt(
      (await read.snapshot(ConfigDoc, conversationId, sectionContext))?.name ?? name, hasDeviceTools), { tag: false })],
    tools: agentCalls,
  });
  const policy = toolPolicy([...tools, ...agentCalls], async (call, api, ctx) => {
    const { conversationId } = api;
    const stored = await api.snapshot(NativeAgentDoc, conversationId, ctx);
    const target: EnvTarget = { conversationId, cwd: stored?.cwd, read: api };
    return options.callEnv ? options.callEnv(call, target, ctx) : options.env?.(target, ctx);
  }, options.nativeContracts);
  const extensions = [
    defineExtension({ name: 'optchat', tools, tasks: [coordinator, BuildNode, agents, AgentAnchor, scheduled] }),
    master, policy, ...(options.extensions ?? []),
  ];
  return { name, extensions, coordinator, scheduled };
}

export async function openOptChat(storage: Storage, options: OptChatOptions, context: Context): Promise<OptChat> {
  const { name, coordinator, scheduled } = options.parts;
  const opened = await Harness.open(storage, {
    models: options.models,
    registry: options.registry,
    env: options.env,
    onReport: options.onReport,
    settings: {
      toolExecution: 'sequential',
      steeringMode: 'all',
      followUpMode: 'all',
      compaction: { enabled: false },
      // An input queued behind a failed run starts a fresh turn, as UniiChat's next call takes it, never the failed
      // turn's context.
      afterFailedRun: 'withdraw',
      // The coordinator is stored running while idle, so every iOS kill of the app would count toward parking it.
      restartLimit: Infinity,
    },
  }, context);
  const root = await opened.root(context, {
    init: async (tx, id) => {
      await tx.doc(MemoryDoc, id);
      await tx.doc(AgentDirectoryDoc, id);
      await tx.doc(ConfigDoc, id);
      const app = await tx.doc(AppDoc, id);
      app.coordinator = await tx.createTask(coordinator, {}, {
        conversationId: id,
        ownership: { kind: 'conversation' },
        background: true,
      });
      await options.init?.(tx, id);
    },
  });
  // A conversation from before version 2 holds the composed prompt as its instructions, and one from version 1 the
  // tool list it was created with, which hides every tool added since, such as spawn and tell. Clearing them once
  // leaves the prompt to the section and the tools to the host. pi-durable migrates the document on read, so its
  // version is what tells.
  await root.commit(async (tx) => {
    const app = await tx.doc(AppDoc, root.id);
    if (app.promptVersion === PROMPT_VERSION) return;
    await configure(tx, root.id, { ...(app.promptVersion < 2 ? { instructions: null } : {}), modelTools: null });
    app.promptVersion = PROMPT_VERSION;
  }, context);
  /** The admission once an attempt from `attempt` on is submitted, or once a stop cancelled it. */
  async function submitted(requestId: string, attempt: number, waitContext: Context): Promise<Admission> {
    const watch = await opened.watchDoc(InputDoc, root.id, requestId, waitContext);
    if (!watch) throw new Error('Accept the request before waiting for its answer');
    const accepted = watch.value?.value;
    if (!accepted) {
      await watch.stop();
      throw new Error('Accept the request before waiting for its answer');
    }
    if (accepted.kind === 'note') {
      await watch.stop();
      throw new Error('Notes do not dispatch a model answer');
    }
    const cancellation = new AbortController();
    const waiting = withAbortSignal(cancellation.signal, waitContext);
    const settled = new Promise<void>((resolve) => {
      const inspect = (value: Readonly<{ value: Admission | null }> | null) => {
        const phase = value?.value?.phase;
        if ((phase === 'submitted' && (value?.value?.attempt ?? 0) >= attempt) || phase === 'cancelled') resolve();
      };
      watch.start(async (value) => {
        inspect(value);
      });
      inspect(watch.value);
    });
    try {
      const ended = watch.closed.then((end) => {
        if (end.reason === 'listener_error' || end.reason === 'session_failed') throw end.error;
        throw new Error(`Admission watch ended: ${end.reason}`);
      });
      await awaitWithContext(Promise.race([settled, ended, coordinatorFailure(opened, root.id, waiting)]),
        waitContext);
    } finally {
      cancellation.abort();
      await watch.stop();
    }
    const admission = (await opened.snapshot(InputDoc, root.id, requestId, waitContext))?.value;
    if (!admission) throw new Error(`Unknown OptChat request: ${requestId}`);
    return admission;
  }

  opened.resume();
  return {
    harness: opened,
    root,
    async accept(input) {
      if (!input.requestId) throw new Error('Provide a stable request ID for each original input');
      const date = new Date(input.date ?? Date.now()).toISOString();
      await opened.commit((tx) => admitInput(tx, root.id, { ...input, kind: input.kind ?? 'user', date }), context);
      return input.requestId;
    },
    async setInstructions(tx, text) {
      await configure(tx, root.id, { instructions: text || null });
    },
    async waitForAnswer(requestId, waitContext = context) {
      let attempt = 0;
      for (;;) {
        const admission = await submitted(requestId, attempt, waitContext);
        if (admission.phase === 'cancelled') throw new Error('Input was cancelled before native submission');
        const record = await opened.commit((tx) => tx.submissionByRequest(root.id, nativeRequest(admission)),
          waitContext);
        if (!record) throw new Error('Submitted admission is missing its native receipt');
        const submission = await opened.submission(record.id, waitContext);
        if (!submission) throw new Error('Submitted admission is missing its native submission');
        const settled = await submission.wait(waitContext);
        // Withdrawn, by pi-durable after a failed run or by the coordinator after a faulted one, it is submitted anew
        // as its next attempt; the coordinator counts that attempt before its withdrawal settles this one.
        const now = (await opened.snapshot(InputDoc, root.id, requestId, waitContext))?.value;
        const aborted = settled.status === 'unanswered' && settled.reason === 'aborted'
          && now !== undefined && now !== null && now.attempt > admission.attempt;
        if (withdrawn(settled) || aborted) {
          attempt = admission.attempt + 1;
          continue;
        }
        return settled;
      }
    },
    async abort() {
      const { requested, work } = await opened.commit(async (tx) => {
        const app = await tx.doc(AppDoc, root.id);
        // As UniiChat's stop: the turn and every agent at work, which its note names for later turns.
        const work = await agentWork(tx, root.id);
        const turn = (await tx.doc(LiveDoc, root.id)).run ? [`${name}'s turn`] : [];
        const stopped = [...turn, ...new Set(work.map((each) => each.name))];
        // A failed turn's note not logged yet stays, the stop's after it.
        const note = `Stopped by the user: ${stopped.join(', ')}.`;
        if (stopped.length > 0) app.endNote = app.endNote === null ? note : `${app.endNote}\n${note}`;
        app.stop++;
        app.stopPending.push(...app.pending);
        app.open = false;
        app.started = false;
        app.requests = [];
        app.revision++;
        return { requested: app.stop, work };
      }, context);
      // Each agent's task cuts its run and reports it stopped.
      for (const { id } of work) await opened.abortTask(id, context);
      const watch = await opened.watchDoc(AppDoc, root.id, context);
      if (!watch) throw new Error('OptChat application state is missing');
      const cancellation = new AbortController();
      const waiting = withAbortSignal(cancellation.signal, context);
      const done = new Promise<void>((resolve) => {
        const check = (value: typeof watch.value) => {
          if (value && value.stopped >= requested) resolve();
        };
        watch.start(async (value) => {
          check(value);
        });
        check(watch.value);
      });
      try {
        await awaitWithContext(Promise.race([
          done,
          coordinatorFailure(opened, root.id, waiting),
          watch.closed.then((end) => {
            if (end.reason === 'session_failed' || end.reason === 'listener_error') throw end.error;
            throw new Error(`Stop watch ended: ${end.reason}`);
          }),
        ]), context);
      } finally {
        cancellation.abort();
        await watch.stop();
      }
    },
    async cancelScheduled(id, replacement) {
      await opened.abortTask(id, context);
      if ((await opened.waitForTask(id, context)).state.outcome.status !== 'aborted') return false;
      if (replacement) {
        await root.commit((tx) => tx.createTask(scheduled, replacement, {
          ownership: { kind: 'conversation' },
          background: true,
        }), context);
      }
      return true;
    },
    async close() {
      await opened.close(context);
    },
  };
}

async function coordinatorFailure(harness: Harness, root: ConversationId, context: Context): Promise<never> {
  const app = await harness.snapshot(AppDoc, root, context);
  if (!app?.coordinator) throw new Error('OptChat has no coordinator task');
  const task = await harness.waitForTask(app.coordinator, context);
  throw new Error(`OptChat coordinator ended: ${JSON.stringify(task.state.outcome)}`);
}
