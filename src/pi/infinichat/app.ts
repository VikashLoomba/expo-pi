import type { Context, JsonRepresentation } from '@earendil-works/chord';
import { awaitWithContext, withAbortSignal } from '@earendil-works/chord/context';
import type { ImageContent, Models } from '@earendil-works/pi-ai';
import {
  AgentDoc as NativeAgentDoc, Harness, InboxDoc, LiveDoc, ROOT_CONVERSATION_ID, ResetEntry,
  configure, createRegistry, defineDoc, defineDocFamily, defineEntry, defineExtension, defineTask, section,
  type Conversation, type ConversationId, type ConversationInit, type EntryId, type EnvTarget, type HarnessOptions,
  type Storage, type Submission, type TaskId, type ToolHookCall, type ToolRegistration, type Tx, type UserInput,
} from '@earendil-works/pi-durable';
import type { ExecutionEnv } from '@earendil-works/pi-durable/env';

import { AgentDirectoryDoc, AgentTask, agentTool, takeAgentReports } from './agents';
import { MemoryDoc, advanceMessageProgress, appendMessage, memoryReady, renderMain, settleViews } from './memory';
import { sharedPrompt } from './prompt';
import { BuildNode, ConfigDoc, pumpBuilds } from './summary';
import { memoryTools, toolPolicy } from './tools';

export type Admission = {
  requestId: string;
  kind: 'user' | 'work' | 'note';
  content: JsonRepresentation<UserInput>;
  date: string;
  turnState: string;
  epoch: number;
  fresh: boolean;
  phase: 'pending' | 'prepared' | 'submitted' | 'cancelled';
  envelope: JsonRepresentation<UserInput> | null;
};
export const InputDoc = defineDocFamily<{ value: Admission | null }, Admission | null>({
  kind: 'optchat.input',
  version: 1,
  scope: 'conversation',
  history: 'latest',
  fork: 'current',
  family: true,
  initial: (value) => ({ value }),
});
/** The entry a dispatched input is placed as. Its user message carries the envelope; the input is in `InputDoc`. */
export const DeliveryEntry = defineEntry<{ requestId: string; kind: Admission['kind'] }>('optchat.delivery');
/** 2: the prompt is the extension's section and `instructions` hold only the user's text; 1 composed both. */
const PROMPT_VERSION = 2;
export type AppState = {
  /** The prompt layout the conversation's instructions were written for, `PROMPT_VERSION` once current. */
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
};
export const AppDoc = defineDoc<AppState>({
  kind: 'optchat.app',
  version: 2,
  scope: 'conversation',
  history: 'latest',
  fork: 'current',
  // Version 1 had every field but the prompt version; its instructions hold the composed prompt.
  migrate: (value) => ({ ...(value as Omit<AppState, 'promptVersion'>), promptVersion: 1 }),
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

/** The native run and its real receipts decide whether an epoch is still open. */
async function closeSettledEpoch(tx: Tx, root: ConversationId): Promise<void> {
  const app = await tx.doc(AppDoc, root);
  const live = await tx.doc(LiveDoc, root);
  const inbox = await tx.doc(InboxDoc, root);
  if (!app.open || !app.started || live.run || inbox.items.some((i) => i.mode !== 'write')) return;
  for (const id of app.requests) {
    const receipt = await tx.submissionByRequest(root, nativeRequest(id));
    // A prepared effect with a lost acknowledgement is not pending if its receipt settled.
    if (!receipt || receipt.status === 'queued' || receipt.status === 'placed') return;
  }
  app.open = false;
  app.requests = [];
  app.revision++;
}
const nativeRequest = (requestId: string): string => `optchat:${requestId}`;

/** Called in the acceptance transaction, including when a private report arrives. */
async function admitInput(tx: Tx, root: ConversationId, input: {
  requestId: string;
  kind: 'user' | 'work' | 'note';
  content: UserInput;
  date: string;
  turnState?: string;
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
      turnState: input.turnState ?? '',
      content: input.content,
      epoch: app.epoch,
      fresh: false,
      phase: 'pending',
      envelope: null,
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
    turnState: input.turnState ?? '',
    content: input.content,
    epoch: app.epoch,
    fresh,
    phase: 'pending',
    envelope: null,
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
    // A placed delivery is the gist's "log it as user": the original the admission keeps, not the envelope.
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
        let text = '';
        const flush = async () => {
          if (text) {
            await appendMessage(tx, root, { kind: 'unii', text, date, images: [], source: `${entry.id}:${index++}` });
          }
          text = '';
        };
        for (const block of message.content) {
          if (block.type === 'text') {
            text += block.text;
          } else if (block.type === 'toolCall') {
            await flush();
            await appendMessage(tx, root, {
              kind: 'tool',
              text: `${block.name} ${JSON.stringify(block.arguments)}`,
              date,
              images: [],
              source: `${entry.id}:${index++}`,
            });
          }
          // Thinking remains in native history/provider context but not semantic memory.
        }
        await flush();
      } else if (message.role === 'toolResult') {
        await appendMessage(tx, root, {
          kind: 'echo',
          text: message.content.filter((x) => x.type === 'text').map((x) => x.text).join(''),
          date,
          images: message.content.filter((x): x is ImageContent => x.type === 'image'),
          source: `${entry.id}:${index++}`,
        });
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
    await admitInput(tx, root, { requestId: report.requestId, kind: 'work', content: report.text, date });
  }
}

function envelope(view: string, content: UserInput, date: string, turnState: string): UserInput {
  // Dynamic date belongs after the saved view, never in instructions/tool schemas.
  return [
    ...(view ? [{ type: 'text' as const, text: view }] : []),
    { type: 'text', text: `\n<turn date="${date}"/>\n${turnState}${turnState ? '\n' : ''}` },
    ...(typeof content === 'string' ? [{ type: 'text' as const, text: content }] : content),
  ];
}

type CoordinatorState = { phase: 'coordinate'; tick: number };
const CoordinatorTask = defineTask<Record<string, never>, CoordinatorState, null>({
  name: 'optchat.coordinator',
  version: 1,
  initial: () => ({ phase: 'coordinate', tick: 0 }),
  phases: {
    async coordinate(task, runtime, context) {
      const root = runtime.conversationId;
      const invocation = withAbortSignal(runtime.signal, context);
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
      let progressed = false;
      try {
        await runtime.commit(async (tx) => {
          // All native table reads happen before reset/task creation table writes.
          const projection = await projectEntries(tx, root);
          progressed = projection.progressed;
          await consumeReports(tx, root, new Date(runtime.now()).toISOString());
          await closeSettledEpoch(tx, root);
          const app = await tx.doc(AppDoc, root);
          const next = app.pending[0];
          if (app.stop > app.stopped) {
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
            } else if (input.phase === 'prepared') {
              dispatchId = input.requestId;
            } else if (projection.caughtUp && (!input.fresh || (await memoryReady(tx, root)))) {
              await settleViews(tx, root);
              const view = input.fresh ? await renderMain(tx, root) : '';
              // The view is frozen here; the original enters memory once pi-durable places the delivery.
              input.envelope = envelope(view, input.content, input.date, input.turnState);
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
          if (dispatchId !== undefined || progressed) {
            return {
              status: 'running',
              checkpoint: { phase: 'coordinate', tick: task.state.checkpoint.tick + 1 },
            };
          }
        }, context);
        if (stop) {
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
            requestId: nativeRequest(requestId),
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

export type OptChatOptions = {
  models: Models;
  name?: string;
  hasDeviceTools?: boolean;
  tools?: readonly ToolRegistration[];
  env?: HarnessOptions['env'];
  /** The environment a completed call ran in, for reading its spilled output. Default: `env` for the conversation. */
  callEnv?: (call: ToolHookCall, target: EnvTarget, context: Context) =>
    ExecutionEnv | undefined | Promise<ExecutionEnv | undefined>;
  nativeSpillContracts?: Record<string, 'bash' | 'codemode'>;
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
    turnState?: string;
  }): Promise<string>;
  /**
   * The user's own instructions, pi-durable's `instructions` section rendered after the prompt, in the host's
   * settings commit; empty text clears them. The host shows them from the agent document.
   */
  setInstructions(tx: Tx, text: string): Promise<void>;
  waitForAnswer(requestId: string, context?: Context): ReturnType<Submission['wait']>;
  abort(): Promise<void>;
  close(): Promise<void>;
};

export async function openOptChat(storage: Storage, options: OptChatOptions, context: Context): Promise<OptChat> {
  const registry = createRegistry();
  const prompt = sharedPrompt(options.name ?? 'OptChat', options.hasDeviceTools ?? false);
  const tools: ToolRegistration[] = [
    ...memoryTools(ROOT_CONVERSATION_ID),
    agentTool(ROOT_CONVERSATION_ID),
    ...(options.tools ?? []),
  ];
  // The prompt is the extension's own section and the offered tools follow the host, so an edited prompt or tool
  // set reaches an existing conversation as pi-durable's system entry instead of staying as created.
  registry.install(defineExtension({
    name: 'optchat',
    sections: [section('optchat', () => prompt, { tag: false })],
    tools,
    tasks: [CoordinatorTask, BuildNode, AgentTask],
  }));
  let harness: Harness | undefined;
  registry.install(toolPolicy(tools, async (call, conversationId, ctx) => {
    if (!harness) throw new Error('OptChat is still opening');
    const agent = await harness.snapshot(NativeAgentDoc, conversationId, ctx);
    const target: EnvTarget = { conversationId, cwd: agent?.cwd, read: harness };
    return options.callEnv ? options.callEnv(call, target, ctx) : options.env?.(target, ctx);
  }, options.nativeSpillContracts));
  const opened = await Harness.open(storage, {
    models: options.models,
    registry,
    env: options.env,
    onReport: options.onReport,
    settings: {
      toolExecution: 'sequential',
      steeringMode: 'all',
      followUpMode: 'all',
      compaction: { enabled: false },
    },
  }, context);
  harness = opened;
  const root = await opened.root(context, {
    init: async (tx, id) => {
      await tx.doc(MemoryDoc, id);
      await tx.doc(AgentDirectoryDoc, id);
      await tx.doc(ConfigDoc, id);
      const app = await tx.doc(AppDoc, id);
      app.coordinator = await tx.createTask(CoordinatorTask, {}, {
        conversationId: id,
        ownership: { kind: 'conversation' },
        background: true,
      });
      await options.init?.(tx, id);
    },
  });
  // A conversation from before version 2 holds the composed prompt as its instructions; clearing them once leaves
  // the prompt to the section. pi-durable migrates the document on read, so its version is what tells.
  await root.commit(async (tx) => {
    const app = await tx.doc(AppDoc, root.id);
    if (app.promptVersion === PROMPT_VERSION) return;
    await configure(tx, root.id, { instructions: null });
    app.promptVersion = PROMPT_VERSION;
  }, context);
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
          if (value?.value?.phase === 'submitted' || value?.value?.phase === 'cancelled') resolve();
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
      const admission = await opened.snapshot(InputDoc, root.id, requestId, waitContext);
      if (admission?.value?.phase === 'cancelled') throw new Error('Input was cancelled before native submission');
      const record = await opened.commit((tx) => tx.submissionByRequest(root.id, nativeRequest(requestId)),
        waitContext);
      if (!record) throw new Error('Submitted admission is missing its native receipt');
      const submission = await opened.submission(record.id, waitContext);
      if (!submission) throw new Error('Submitted admission is missing its native submission');
      return submission.wait(waitContext);
    },
    async abort() {
      const requested = await opened.commit(async (tx) => {
        const app = await tx.doc(AppDoc, root.id);
        app.stop++;
        app.stopPending.push(...app.pending);
        app.open = false;
        app.started = false;
        app.requests = [];
        app.revision++;
        return app.stop;
      }, context);
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
