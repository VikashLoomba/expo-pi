import { awaitWithContext, withAbortSignal, type Context } from '@earendil-works/chord/context';
import type { JsonRepresentation } from '@earendil-works/chord/json';
import type { ImageContent, Models } from '@earendil-works/pi-ai';
import {
  AgentDoc as NativeAgentDoc, ConversationIdle, Harness, InboxDoc, LiveDoc, ROOT_CONVERSATION_ID, ResetEntry,
  configure, defineDoc, defineDocFamily, defineEntry, defineExtension, defineTask, section,
  type Conversation, type ConversationId, type ConversationInit, type EntryId, type EnvTarget, type Extension,
  type HarnessOptions, type RegistryReader, type Storage, type SubmissionId, type SubmissionRecord,
  type TaskId, type ToolHookCall, type ToolRegistration, type Tx, type UserInput,
} from '@earendil-works/pi-durable';
import type { ExecutionEnv } from '@earendil-works/pi-durable/env';

import { SearchObservationEntry } from '../native-web-search/entries';
import { AgentAnchor, TreeDoc, agentNamed, agentTools, place } from './agents';
import { MemoryDoc, advanceMessageProgress, appendMessage, memoryReady, renderMain, settleViews } from './memory';
import { sharedPrompt } from './prompt';
import { abortScheduled, scheduleTools, scheduledTask, type ScheduledInput } from './schedule';
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
 * 4: the tree of agents, whose replies stay in their own chats: a chat from before answered the user with them
 * (`TreeDoc.since`). 3: the conversation stores no tool list, so the model is offered the host's tools. 2: the prompt
 * is the extension's section and `instructions` hold only the user's text. 1 composed both and stored the tools it
 * was created with.
 */
const PROMPT_VERSION = 4;
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
  cut: { why: string; records: (Logged & { kind: 'infinichat' | 'tool' })[] } | null;
};
type Logged = { text: string; date: string; source: string };
type AppStateV4 = Omit<AppState, 'cut'> & {
  cut: { why: string; records: (Logged & { kind: 'unii' | 'tool' })[] } | null;
};
type AppStateV3 = Omit<AppState, 'endNote' | 'cut'> & { stopNote: string | null };
type AppStateV2 = Omit<AppStateV3, 'stopNote' | 'held'>;
export const AppDoc = defineDoc<AppState>({
  kind: 'optchat.app',
  version: 5,
  scope: 'conversation',
  history: 'latest',
  fork: 'current',
  checkpointWhen: () => true,
  migrate: (value, fromVersion) => {
    if (fromVersion === 4) {
      // Version 4 named the agent's replies `unii`.
      const { cut, ...rest } = value as AppStateV4;
      return { ...rest, cut: cut && { ...cut, records: cut.records.map((record) =>
        record.kind === 'unii' ? { ...record, kind: 'infinichat' as const } : { ...record, kind: 'tool' as const }) } };
    }
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

/**
 * A turn is open or still being closed: an input waits for the coordinator, or the turn's end is not logged yet. Until
 * then a Continue is refused, and the screens show the conversation at work.
 */
export const turnOpen = (app: AppState): boolean =>
  app.open || app.pending.length > 0 || app.cut !== null || app.endNote !== null;

const textOf = (input: UserInput): string => typeof input === 'string'
  ? input
  : input.filter((x) => x.type === 'text').map((x) => x.text).join('');
const imagesOf = (input: UserInput): ImageContent[] => typeof input === 'string'
  ? []
  : input.filter((x): x is ImageContent => x.type === 'image').map((x) => ({ ...x }));

/** The admission a request ID names; absent only when application state is inconsistent. */
async function storedInput(tx: Tx, chat: ConversationId, requestId: string): Promise<Admission> {
  const stored = (await tx.doc(InputDoc, chat, requestId, null)).value;
  if (!stored) throw new Error(`Unknown OptChat request: ${requestId}`);
  return stored;
}

/** pi-durable withdrew it: it was queued behind a run that failed (`afterFailedRun: 'withdraw'`). */
const withdrawn = (receipt: SubmissionRecord): boolean =>
  receipt.status === 'unanswered' && receipt.reason === 'run_failed';

/**
 * The native run and its real receipts decide whether an epoch is still open. A run that failed leaves UniiChat's
 * note for the turn, once its last entries are logged: why, from `pi.live.runFailure`, which names a missing model
 * where an input's settlement doesn't (durable README "Busy Conversations"). A Continue's turn has no input of its
 * own, so its run is the one that ended it.
 */
async function closeSettledEpoch(tx: Tx, chat: ConversationId): Promise<void> {
  const app = await tx.doc(AppDoc, chat);
  const live = await tx.doc(LiveDoc, chat);
  const inbox = await tx.doc(InboxDoc, chat);
  if (!app.open || !app.started || live.run || inbox.items.some((i) => i.mode !== 'write')) return;
  const submissions: SubmissionId[] = [];
  for (const id of app.requests) {
    const receipt = await tx.submissionByRequest(chat, nativeRequest(await storedInput(tx, chat, id)));
    // A prepared effect with a lost acknowledgement is not pending if its receipt settled. A withdrawn one is, until
    // it is submitted anew.
    if (!receipt || receipt.status === 'queued' || receipt.status === 'placed' || withdrawn(receipt)) return;
    submissions.push(receipt.id);
  }
  const failure = live.runFailure;
  if (failure && failure.reason !== 'aborted' && failure.reason !== 'nothing_to_answer'
    && (app.requests.length === 0 || failure.inputs.some((id) => submissions.includes(id)))) {
    const why = failure.detail ?? failure.reason;
    app.endNote ??= `No reply: ${why.replace(/\.$/, '')}. Send a message to try again.`;
  }
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
async function carryOver(tx: Tx, chat: ConversationId, moved: string[]): Promise<void> {
  const app = await tx.doc(AppDoc, chat);
  app.requests = app.requests.filter((id) => !moved.includes(id));
  await closeSettledEpoch(tx, chat);
  app.epoch++;
  app.open = true;
  app.started = false;
  app.requests = [...moved];
  for (const id of moved) {
    const input = await storedInput(tx, chat, id);
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
async function requeueWithdrawn(tx: Tx, chat: ConversationId): Promise<boolean> {
  const app = await tx.doc(AppDoc, chat);
  let requeued = false;
  for (const id of app.requests) {
    const input = await storedInput(tx, chat, id);
    const receipt = await tx.submissionByRequest(chat, nativeRequest(input));
    if (!receipt || !withdrawn(receipt)) continue;
    input.attempt++;
    input.phase = 'pending';
    input.envelope = null;
    requeued = true;
  }
  if (!requeued) return false;
  const moved: string[] = [];
  for (const id of app.requests) {
    if (!(await tx.submissionByRequest(chat, nativeRequest(await storedInput(tx, chat, id))))) moved.push(id);
  }
  app.pending = [...moved, ...app.pending.filter((id) => !moved.includes(id))];
  await carryOver(tx, chat, moved);
  return true;
}

/**
 * A run whose task faulted keeps its inbox (pi-durable spec "afterFailedRun"), and pi-durable would place it in the
 * next run's context, so each input still queued is withdrawn here and submitted anew, as a failed run's is. Its
 * attempt is counted before the withdrawal settles the old submission, so a wait for it goes on.
 */
async function countRequeued(tx: Tx, chat: ConversationId): Promise<void> {
  const app = await tx.doc(AppDoc, chat);
  for (const id of app.requests) {
    const input = await storedInput(tx, chat, id);
    if ((await tx.submissionByRequest(chat, nativeRequest(input)))?.status !== 'queued') continue;
    input.attempt++;
    input.phase = 'pending';
    input.envelope = null;
  }
  app.revision++;
}

/** After the coordinator's withdrawal: the inputs with no submission for their attempt start a fresh turn. */
async function requeueAborted(tx: Tx, chat: ConversationId): Promise<void> {
  const app = await tx.doc(AppDoc, chat);
  const moved: string[] = [];
  for (const id of app.requests) {
    if (!(await tx.submissionByRequest(chat, nativeRequest(await storedInput(tx, chat, id))))) moved.push(id);
  }
  app.pending = [...moved, ...app.pending.filter((id) => !moved.includes(id))];
  if (moved.length > 0) await carryOver(tx, chat, moved);
  else await closeSettledEpoch(tx, chat);
}

/**
 * Called in the acceptance transaction: the user's message to root, an agent's `tell` to its parent or a child, and a
 * scheduled task's. `chat` is the conversation of the agent it is for.
 */
async function admitInput(tx: Tx, chat: ConversationId, input: {
  requestId: string;
  kind: 'user' | 'work' | 'note';
  content: UserInput;
  date: string;
}): Promise<void> {
  const stored = await tx.doc(InputDoc, chat, input.requestId, null);
  if (stored.value) {
    const previous = stored.value;
    if (previous.kind !== input.kind || JSON.stringify(previous.content) !== JSON.stringify(input.content)) {
      throw new Error('A request ID cannot identify different input');
    }
    return;
  }
  await closeSettledEpoch(tx, chat);
  const app = await tx.doc(AppDoc, chat);
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
    await advanceMessageProgress(tx, chat);
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
  await advanceMessageProgress(tx, chat);
}

/** Project each immutable native entry once. Reset affects context, never this cursor. */
async function projectEntries(tx: Tx, chat: ConversationId): Promise<{ progressed: boolean; caughtUp: boolean }> {
  const app = await tx.doc(AppDoc, chat);
  const entries = await tx.scanEntries({
    conversationId: chat,
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
      const input = await storedInput(tx, chat, entry.data.requestId);
      await appendMessage(tx, chat, {
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
        const records: (Logged & { kind: 'infinichat' | 'tool'; call?: string })[] = [];
        let text = '';
        const reply = () => {
          if (text.trim()) {
            records.push({ kind: 'infinichat', text: text.trim(), date, source: `${entry.id}:${index++}` });
          }
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
            else await appendMessage(tx, chat, { ...record, images: [] });
          }
          // UniiChat counts a reply cut at the output limit as none.
          if (message.stopReason === 'length') {
            app.endNote ??= `No reply: stopped: ${message.rawStopReason ?? 'length'}. Send a message to try again.`;
          }
        }
      } else if (message.role === 'toolResult') {
        const call = app.held[message.toolCallId];
        if (call) {
          await appendMessage(tx, chat, { ...call, kind: 'tool', images: [] });
          delete app.held[message.toolCallId];
        }
        // Text only, an image as UniiChat shows a result's part: the model saw it in its turn.
        const text = message.content.map((x) => (x.type === 'text' ? x.text : '[image]')).join('\n');
        await appendMessage(tx, chat, {
          kind: 'echo',
          text: `${message.isError ? 'error: ' : ''}${text || '(no output)'}`,
          date,
          images: [],
          source: `${entry.id}:${index++}`,
        });
      } else if (message.role === 'user' && SearchObservationEntry.is(entry)) {
        // OpenAI's hosted web search, logged as a tool call and its result (owner, 2026-10-30). pi-durable places the
        // findings at the boundary after the reply that searched, so they follow it.
        await appendMessage(tx, chat, { kind: 'tool', text: `web_search ${JSON.stringify(entry.data.action)}`, date,
          images: [], source: `${entry.id}:${index++}` });
        await appendMessage(tx, chat, { kind: 'echo', text: textOf(message.content), date, images: [],
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

/**
 * A fresh turn's message, as UniiChat's: the view, the host's turn state and the agent's place in the tree, which
 * change, so they follow the cached view and never enter the prompt; then the head that tells a turn from a
 * compaction.
 */
function envelope(view: string, content: UserInput, turnState: string, where: string): UserInput {
  const state = turnState ? `${turnState}\n\n` : '';
  return [
    { type: 'text', text: view },
    { type: 'text', text: `\n${state}${where}\n\nTurn: your new messages:\n\n` },
    ...(typeof content === 'string' ? [{ type: 'text' as const, text: content }] : content),
  ];
}

/** The agent's place as its turn starts (`place`): a child is awake while its turn runs or waits to. */
async function placeOf(tx: Tx, chat: ConversationId): Promise<string> {
  const tree = await tx.doc(TreeDoc, ROOT_CONVERSATION_ID);
  const name = agentNamed(tree.agents, chat);
  if (name === undefined) throw new Error('This conversation is no agent of the tree');
  const awake = new Set<string>();
  for (const child of tree.agents[name].children) {
    const { conversationId } = tree.agents[child.name];
    if ((await tx.doc(LiveDoc, conversationId)).run || turnOpen(await tx.doc(AppDoc, conversationId))) {
      awake.add(child.name);
    }
  }
  return place(tree, name, awake);
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
      // The agent's own conversation: root's, or a child's.
      const chat = runtime.conversationId;
      const invocation = withAbortSignal(runtime.signal, context);
      // Read only while an input waits, outside the commit; a host that can't tell (a locked keychain) is reported,
      // and the turn starts without it rather than never.
      const read = ((await runtime.snapshot(AppDoc, chat, invocation))?.pending.length ?? 0) > 0;
      const state = !read ? '' : await turnState().catch((error: unknown) => {
        runtime.report(error);
        return '';
      });
      const conversation = await runtime.conversation(chat, invocation);
      if (!conversation) throw new Error('The agent’s conversation is missing');
      const acquired = await Promise.all([
        runtime.watchDoc(AppDoc, chat, invocation),
        runtime.watchDoc(MemoryDoc, chat, invocation),
        runtime.watchDoc(LiveDoc, chat, invocation),
        runtime.watchDoc(InboxDoc, chat, invocation),
      ]);
      if (acquired.some((watch) => !watch)) {
        await Promise.all(acquired.map((watch) => watch?.stop()));
        throw new Error('OptChat documents were not initialized');
      }
      const watches = acquired.flatMap((watch) => (watch ? [watch] : []));
      const changed = new Promise<void>((resolve) => {
        for (const watch of watches) {
          const seen = JSON.stringify(watch.value);
          watch.start(async (call) => {
            if (call.kind === 'value' && JSON.stringify(call.value) !== seen) resolve();
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
          const projection = await projectEntries(tx, chat);
          progressed = projection.progressed;
          const now = new Date(runtime.now()).toISOString();
          await closeSettledEpoch(tx, chat);
          const app = await tx.doc(AppDoc, chat);
          const running = (await tx.doc(LiveDoc, chat)).run !== undefined;
          const ended = app.stopped >= app.stop && projection.caughtUp && !running;
          if (ended && (app.cut || app.endNote !== null)) {
            // As UniiChat ends a turn without a reply: what the cut attempt wrote, marked, then why.
            for (const record of app.cut?.records ?? []) {
              const mark = `\n[cut off: ${app.cut?.why.slice(0, 300)}]`;
              await appendMessage(tx, chat, { ...record, text: record.text + mark, images: [] });
            }
            if (app.endNote !== null) {
              await appendMessage(tx, chat, { kind: 'note', text: app.endNote, date: now, images: [],
                source: `end:${app.epoch}:${app.stop}` });
            }
            app.cut = null;
            app.endNote = null;
            app.revision++;
            progressed = true;
          }
          const next = app.pending[0];
          if (ended && (await requeueWithdrawn(tx, chat))) {
            progressed = true;
          } else if (ended && (await tx.doc(InboxDoc, chat)).items.some((item) => item.mode !== 'write')) {
            // pi-durable withdrew a failed run's queue above; one still queued is behind a run whose task faulted.
            await countRequeued(tx, chat);
            withdraw = true;
          } else if (app.stop > app.stopped) {
            if (projection.caughtUp) {
              stop = app.stop;
              // A withdrawn input was never handed to the model, so it never enters memory.
              for (const id of app.stopPending) {
                const input = await storedInput(tx, chat, id);
                input.phase = 'cancelled';
                input.envelope = null;
              }
              app.pending = app.pending.filter((id) => !app.stopPending.includes(id));
              app.stopPending = [];
              app.revision++;
              progressed = true;
            }
          } else if (next !== undefined) {
            const input = await storedInput(tx, chat, next);
            if (input.kind === 'note' && projection.caughtUp) {
              await appendMessage(tx, chat, {
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
            } else if (!input.fresh) {
              if (projection.caughtUp) {
                // A message sent while a turn runs goes to it as it is, between its tool calls: admitted as a steer in
                // this commit, which checks the run, so it never starts a run of its own (pi-durable example 34).
                // Before this commit's first table write; a known request ID, one submitted before a crash, returns
                // its submission.
                await settleViews(tx, chat);
                try {
                  await conversation.submit(tx, {
                    type: 'input',
                    requestId: nativeRequest(input),
                    content: input.content,
                    whenBusy: 'steer',
                    whenIdle: 'reject',
                    entry: { kind: DeliveryEntry.kind, data: { requestId: input.requestId, kind: input.kind } },
                  });
                  input.phase = 'submitted';
                  input.envelope = null;
                  app.pending.shift();
                  app.started = true;
                  app.revision++;
                } catch (error) {
                  if (!(error instanceof ConversationIdle)) throw error;
                  // Its turn ended before it reached it, so it starts the next, with the inputs after it.
                  await carryOver(tx, chat, app.requests.filter((id) => app.pending.includes(id)));
                }
                progressed = true;
              }
            } else if (input.phase === 'prepared') {
              dispatchId = input.requestId;
            } else if (!read) {
              // Accepted after the turn state was skipped: the next tick reads it.
              progressed = true;
            } else if (projection.caughtUp && (await memoryReady(tx, chat))) {
              await settleViews(tx, chat);
              // The view is frozen here; the original enters memory once pi-durable places the delivery.
              input.envelope = envelope(await renderMain(tx, chat), input.content, state, await placeOf(tx, chat));
              input.phase = 'prepared';
              app.started = true;
              app.revision++;
              await tx.appendEntry(ResetEntry, chat, { head: 'self' });
              dispatchId = input.requestId;
              progressed = true;
            }
          }
          const launched = await pumpBuilds(tx, chat);
          if (launched.length > 0) progressed = true;
          // A fresh turn is submitted after this commit: an idle admission places its input at once, after the reset
          // this commit appends, and `submit(tx)` must come before a commit's table writes (durable
          // `src/harness/submissions.ts`). So the preparation is checkpointed first.
          if (dispatchId !== undefined || withdraw || progressed) {
            return {
              status: 'running',
              checkpoint: { phase: 'coordinate', tick: task.state.checkpoint.tick + 1 },
            };
          }
        }, context);
        if (withdraw) {
          // With no run, an abort only withdraws the queued inputs.
          await conversation.abort(context);
          await runtime.commit(async (tx) => {
            await requeueAborted(tx, chat);
            return { status: 'running', checkpoint: { phase: 'coordinate', tick: task.state.checkpoint.tick + 2 } };
          }, context);
        } else if (stop) {
          await conversation.abort(context);
          await runtime.commit(async (tx) => {
            const app = await tx.doc(AppDoc, chat);
            app.stopped = stop;
            app.revision++;
            return { status: 'running', checkpoint: { phase: 'coordinate', tick: task.state.checkpoint.tick + 2 } };
          }, context);
        } else if (dispatchId !== undefined) {
          const requestId = dispatchId;
          // The prepared admission is read back committed: a draft is not readable after its commit.
          const prepared = (await runtime.snapshot(InputDoc, chat, requestId, context))?.value;
          if (!prepared?.envelope) throw new Error(`Prepared input has no envelope: ${requestId}`);
          await conversation.submit({
            type: 'input',
            requestId: nativeRequest(prepared),
            content: prepared.envelope,
            whenBusy: 'steer',
            entry: { kind: DeliveryEntry.kind, data: { requestId, kind: prepared.kind } },
          }, context);
          await runtime.commit(async (tx) => {
            const app = await tx.doc(AppDoc, chat);
            const saved = await storedInput(tx, chat, requestId);
            saved.phase = 'submitted';
            saved.envelope = null;
            const position = app.pending.indexOf(requestId);
            if (position >= 0) app.pending.splice(position, 1);
            app.revision++;
            return { status: 'running', checkpoint: { phase: 'coordinate', tick: task.state.checkpoint.tick + 2 } };
          }, context);
        } else if (!progressed) {
          const ended = Promise.race(watches.map((watch) => watch.closed)).then((end) => {
            if (end.kind === 'failed' || end.kind === 'listener_error') throw end.error;
            throw new Error(`OptChat watch ended: ${end.kind}`);
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

/** What OptChat's extensions are built from: host capabilities, of which only `harness` is the Harness they run in. */
export type OptChatExtensionOptions = {
  /** The Harness the extensions run in, once the host has opened one: the schedule tools abort a waiting task on it. */
  harness: () => Harness | undefined;
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
  /** What changes between turns, such as the devices: read as a turn starts, it follows the view. */
  turnState?: () => Promise<string>;
};

/**
 * OptChat's extensions, which a host installs in the registry its Harness reads, and what the Harness's opening needs
 * of them. A task runs the code its registry holds under the definition's name.
 */
export type OptChatParts = {
  readonly name: string;
  readonly extensions: readonly Extension[];
  /** Gives a conversation its chat: its memory, and its coordinator from the definition the extensions hold. */
  readonly init: (tx: Tx, conversationId: ConversationId) => Promise<void>;
  /** `tell` and `spawn`, which the model is offered itself beside a tool `offer` names. */
  readonly voice: readonly ToolRegistration[];
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
  /** Runs in every commit that creates a conversation, a child's too, for the documents the host gives each. */
  conversationCreated?: HarnessOptions['conversationCreated'];
};

/**
 * All injected values are host capabilities, not omitted OptChat algorithms. The host selects root's model with
 * pi-durable's `configure` and the summary model in `ConfigDoc`, in one commit on `root`, before accepting input.
 * An operation that takes an agent's conversation is root's without one.
 */
export type OptChat = {
  harness: Harness;
  root: Conversation;
  /** The user's message, which only root takes. */
  accept(input: {
    requestId: string;
    content: UserInput;
    kind?: 'user' | 'work' | 'note';
    date?: string;
  }): Promise<string>;
  /**
   * The user's own instructions, pi-durable's `instructions` section rendered after the prompt, in the host's
   * settings commit, for every agent of the tree; empty text clears them. The host shows them from root's agent
   * document.
   */
  setInstructions(tx: Tx, text: string): Promise<void>;
  /**
   * Offers every agent the tool `only`, whose scripts call the others, as pi-durable's README offers code mode
   * (`modelTools`, "Who may call a tool"), and `tell` and `spawn` beside it, which are the model's own calls; every
   * tool without one, or while `only` is not registered. The host sets it before it resumes the Harness, since the
   * conversation moves between hosts with different tools. A child spawned later copies it with the rest of its
   * parent's settings.
   */
  offer(only?: string): Promise<void>;
  /**
   * Continues an agent's run that ended without an answer (`pi.live.runFailure`) with pi-durable's continue
   * submission, as a turn of its own: what it is sent meanwhile steers it, and its coordinator closes it. Refused
   * while a turn is open or being closed, or inputs wait for the coordinator.
   */
  continue(agent?: ConversationId): Promise<void>;
  /** The user's stop of one agent's turn, as UniiChat's: the others go on. */
  abort(agent?: ConversationId): Promise<void>;
  /**
   * Aborts a scheduled task still waiting, as pi-durable's example 23 cancels a task, and schedules `replacement`
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
  const init = async (tx: Tx, conversationId: ConversationId) => {
    await tx.doc(MemoryDoc, conversationId);
    const app = await tx.doc(AppDoc, conversationId);
    app.coordinator = await tx.createTask(coordinator, {}, {
      conversationId,
      ownership: { kind: 'conversation' },
      background: true,
    });
  };
  const scheduled = scheduledTask((tx, id, input) => admitInput(tx, id, { ...input, kind: 'work' }));
  // What only root has, an extension of its own, which a child's conversation goes without: nothing wakes a child
  // but a message.
  const schedule = scheduleTools(ROOT_CONVERSATION_ID, scheduled, options.harness);
  const master: Extension = defineExtension({ name: 'optchat.master', tools: schedule });
  const tree = agentTools({ master: () => master, init, admit: admitInput });
  const tools: ToolRegistration[] = [...memoryTools(), ...(options.tools ?? []), ...Object.values(tree)];
  const policy = toolPolicy([...tools, ...schedule], async (call, api, ctx) => {
    const { conversationId } = api;
    const stored = await api.snapshot(NativeAgentDoc, conversationId, ctx);
    const target: EnvTarget = { conversationId, cwd: stored?.cwd, read: api };
    return options.callEnv ? options.callEnv(call, target, ctx) : options.env?.(target, ctx);
  }, options.nativeContracts);
  // The prompt is an extension's own section and the offered tools follow the host, so an edited prompt or tool set
  // reaches an existing conversation as pi-durable's system entry instead of staying as created. Every agent has the
  // one prompt, as UniiChat's do, with the name the user gave the whole, which root's conversation keeps, so a rename
  // reaches it the same way.
  const extensions = [
    defineExtension({
      name: 'optchat',
      sections: [section('optchat', async ({ read }, sectionContext) => sharedPrompt(
        (await read.snapshot(ConfigDoc, ROOT_CONVERSATION_ID, sectionContext))?.name ?? name, hasDeviceTools),
      { tag: false })],
      tools,
      tasks: [coordinator, BuildNode, AgentAnchor, scheduled],
    }),
    master, policy, ...(options.extensions ?? []),
  ];
  return { name, extensions, init, voice: [tree.tell, tree.spawn], scheduled };
}

/**
 * Opens OptChat's Harness paused. Its host calls `harness.resume()` once `registry` holds every extension the host
 * offers, so a tool call a restart cut off finds its tool and reruns (durable `docs/spec.md` §2.2, README "Persist
 * and Resume"): a fixed registry right away, a machine's server once its plugins have loaded.
 */
export async function openOptChat(storage: Storage, options: OptChatOptions, context: Context): Promise<OptChat> {
  const { init, voice, scheduled } = options.parts;
  const opened = await Harness.open(storage, {
    models: options.models,
    registry: options.registry,
    env: options.env,
    onReport: options.onReport,
    conversationCreated: options.conversationCreated,
    settings: {
      toolExecution: 'sequential',
      steeringMode: 'all',
      followUpMode: 'all',
      compaction: { enabled: false },
      // The view changes only at its end between turns, so its cache entries are kept for the longest a provider
      // offers: pi-ai maps this to an hour on Anthropic and a day on OpenAI.
      stream: { cacheRetention: 'long' },
      // An input queued behind a failed run starts a fresh turn, as UniiChat's next call takes it, never the failed
      // turn's context.
      afterFailedRun: 'withdraw',
      // A coordinator is stored running while idle, so every iOS kill of the app would count toward the restart
      // limit, which ends a task that reaches it (durable README "Crash loops").
      restartLimit: Infinity,
    },
  }, context);
  const root = await opened.root(context, {
    init: async (tx, id) => {
      await tx.doc(ConfigDoc, id);
      await tx.doc(TreeDoc, id);
      await init(tx, id);
      await options.init?.(tx, id);
    },
  });
  // A conversation from before version 2 holds the composed prompt as its instructions, and one from version 1 the
  // tool list it was created with, which hides every tool added since. Clearing them once leaves the prompt to the
  // section and the tools to the host. One from before version 4 is a chat older than the tree: it gets the tree's
  // document, with root alone, and the message its replies stay in its own chat from, as UniiChat's `since` marks
  // one. pi-durable migrates the document on read, so its version is what tells.
  await root.commit(async (tx) => {
    const app = await tx.doc(AppDoc, root.id);
    if (app.promptVersion === PROMPT_VERSION) return;
    const tree = await tx.doc(TreeDoc, root.id);
    const { nextMessage } = await tx.doc(MemoryDoc, root.id);
    if (nextMessage > 0) tree.since = { message: nextMessage, at: Date.now() };
    await configure(tx, root.id, { ...(app.promptVersion < 2 ? { instructions: null } : {}), modelTools: null });
    app.promptVersion = PROMPT_VERSION;
  }, context);
  /** Every agent's conversation, root's first. */
  const conversations = async (tx: Tx) =>
    Object.values((await tx.doc(TreeDoc, root.id)).agents).map((agent) => agent.conversationId);
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
      for (const id of await conversations(tx)) await configure(tx, id, { instructions: text || null });
    },
    async offer(only) {
      const tool = only === undefined ? undefined : (await root.agent(context)).tools.find(({ name }) => name === only);
      const offered = tool === undefined ? undefined : [tool, ...voice];
      const names = offered?.map(({ name }) => name).join();
      await root.commit(async (tx) => {
        for (const id of await conversations(tx)) {
          const stored = (await tx.doc(NativeAgentDoc, id)).modelTools;
          const current = names === undefined ? stored === undefined : Array.isArray(stored) && stored.join() === names;
          if (!current) await configure(tx, id, { modelTools: offered ?? null });
        }
      }, context);
    },
    async continue(agent = root.id) {
      const conversation = await opened.conversation(agent, context);
      if (!conversation) throw new Error('That agent has no conversation.');
      await opened.commit(async (tx) => {
        const app = await tx.doc(AppDoc, agent);
        if (turnOpen(app)) throw new Error('The agent is still finishing its turn. Try again in a moment.');
        // Admitted in this commit, before its table writes, with the turn it opens (pi-durable's
        // `34-submit-in-commit.ts`); a run at work refuses it with `ConversationBusy`.
        await conversation.submit(tx, { type: 'continue' });
        app.open = true;
        app.started = true;
        app.requests = [];
        app.revision++;
      }, context);
    },
    async abort(agent = root.id) {
      const requested = await opened.commit(async (tx) => {
        const app = await tx.doc(AppDoc, agent);
        // As UniiChat's stop: that agent's turn, which its note tells its later turns. A failed turn's note not
        // logged yet stays, the stop's after it.
        const note = 'Stopped by the user.';
        if ((await tx.doc(LiveDoc, agent)).run) app.endNote = app.endNote === null ? note : `${app.endNote}\n${note}`;
        app.stop++;
        app.stopPending.push(...app.pending);
        app.open = false;
        app.started = false;
        app.requests = [];
        app.revision++;
        return app.stop;
      }, context);
      const watch = await opened.watchDoc(AppDoc, agent, context);
      if (!watch) throw new Error('OptChat application state is missing');
      const cancellation = new AbortController();
      const waiting = withAbortSignal(cancellation.signal, context);
      const done = new Promise<void>((resolve) => {
        const check = (value: typeof watch.value) => {
          if (value.stopped >= requested) resolve();
        };
        watch.start(async (call) => {
          if (call.kind === 'value') check(call.value);
        });
        check(watch.value);
      });
      try {
        await awaitWithContext(Promise.race([
          done,
          coordinatorFailure(opened, agent, waiting),
          watch.closed.then((end) => {
            if (end.kind === 'failed' || end.kind === 'listener_error') throw end.error;
            throw new Error(`Stop watch ended: ${end.kind}`);
          }),
        ]), context);
      } finally {
        cancellation.abort();
        await watch.stop();
      }
    },
    async cancelScheduled(id, replacement) {
      if (!await abortScheduled(opened, id, context)) return false;
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

async function coordinatorFailure(harness: Harness, chat: ConversationId, context: Context): Promise<never> {
  const app = await harness.snapshot(AppDoc, chat, context);
  if (!app?.coordinator) throw new Error('OptChat has no coordinator task');
  const task = await harness.waitForTask(app.coordinator, context);
  throw new Error(`OptChat coordinator ended: ${JSON.stringify(task.state.outcome)}`);
}
