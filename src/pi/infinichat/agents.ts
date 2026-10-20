import type { Context } from '@earendil-works/chord';
import { awaitWithContext, withAbortSignal } from '@earendil-works/chord/context';
import { Type, type ImageContent, type ThinkingLevel } from '@earendil-works/pi-ai';
import { ThinkingLevelSchema } from '@earendil-works/pi-ai/providers/model-schema';
import {
  AgentDoc, InboxDoc, LiveDoc, ResetEntry, configure, defineDoc, defineDocFamily, defineEntry, defineTask, defineTool,
  type ConversationId, type Cursor, type EntryId, type Extension, type TaskId, type Tx, type WatchHandle,
} from '@earendil-works/pi-durable';

import { MemoryDoc, renderMain } from './memory';
import { agentName } from './names';

/** What a subagent's conversation is set up from. */
export type SubagentSetup = {
  /** The extension of the master's prompt and of the agent tools, which a subagent goes without. */
  master: () => Extension;
  /** The subagents' prompt; the user's instructions follow it. */
  prompt: string;
  /** The host's device list, read as a message to an agent is sent. */
  turnState: () => Promise<string>;
};
/** `pendingReports`: the keys of reports not admitted yet, an agent's name for those from before keys named a task. */
export const AgentDirectoryDoc = defineDoc({
  kind: 'optchat.agent-directory',
  version: 1,
  scope: 'conversation',
  history: 'latest',
  fork: 'current',
  initial: (): { names: string[]; pendingReports: string[] } => ({ names: [], pendingReports: [] }),
});
/**
 * An agent by name: its conversation, the effort it thinks at (the main agent's when `null`), the task of the call
 * under way and what it was told meanwhile, which that call delivers, as UniiChat's agent takes a message at work.
 */
type PrivateAgent = {
  conversationId: ConversationId | null;
  effort: ThinkingLevel | null;
  calling: TaskId | null;
  waiting: string[];
};
export const PrivateAgentDoc = defineDocFamily<PrivateAgent, ThinkingLevel | null>({
  kind: 'optchat.private-agent',
  version: 2,
  scope: 'conversation',
  history: 'latest',
  fork: 'current',
  family: true,
  // Version 1 was the one task an agent was: it answered once and was told nothing more. One still under way goes on
  // as the agent's call.
  migrate: (value) => {
    const { taskId, conversationId, status } = value as {
      taskId: TaskId; conversationId: ConversationId | null; status: string;
    };
    const calling = status === 'starting' || status === 'running' ? taskId : null;
    return { conversationId, effort: null, calling, waiting: [] };
  },
  initial: (effort) => ({ conversationId: null, effort, calling: null, waiting: [] }),
});
/** A report waiting for admission; a stopped agent's is logged with no turn, as UniiChat's is. */
type AgentReport = { text: string; requestId: string; stopped: boolean };
const AgentReportDoc = defineDocFamily<AgentReport & { consumed: boolean }, AgentReport>({
  kind: 'optchat.agent-report',
  version: 2,
  scope: 'conversation',
  history: 'latest',
  fork: 'current',
  family: true,
  // Version 1 reported only an agent that ended on its own.
  migrate: (value) => ({ ...(value as Omit<AgentReport, 'stopped'> & { consumed: boolean }), stopped: false }),
  initial: (value) => ({ ...value, consumed: false }),
});
/** The entry a message to an agent is placed as: its words, which its log shows without the view sent with them. */
const AgentInputEntry = defineEntry<{ words: string[] }>('optchat.agent-input');

/**
 * As pi-durable's background-subagent example: a background task that ends at once owns each agent's conversation,
 * so the conversation outlives the turns and only the agent's own stop reaches its work.
 */
export const AgentAnchor = defineTask<null, { phase: 'done' }, null>({
  name: 'optchat.agent-anchor',
  version: 1,
  initial: () => ({ phase: 'done' }),
  phases: {
    done: (_anchor, runtime, context) =>
      runtime.commit(() => ({ status: 'terminal', outcome: { status: 'completed', result: null } }), context),
  },
  abort: (_anchor, runtime, context) =>
    runtime.commit(() => ({ status: 'terminal', outcome: { status: 'aborted' } }), context),
});

/**
 * A call of an agent on a message; `cutoff` is the next main message as it was sent, and its view covers those
 * before.
 */
type AgentInput = { name: string; message: string; cutoff: number };
/**
 * `content` is the call's first submission, `words` what it was told in it, `steers` what it was told after, each
 * submitted as a steer under the call's request ID and its place.
 */
type Checkpoint =
  | { phase: 'prepare' }
  | {
    phase: 'deliver';
    conversationId: ConversationId;
    requestId: string;
    content: string[];
    words: string[];
    steers: string[];
  };
type CheckpointV2 =
  | { phase: 'create' }
  | { phase: 'run'; conversationId: ConversationId; requestId: string; frozenView: string; turnState?: string };

/** The call task's registered kind, by which the keep-alive and the agents at work count it. */
export const AGENT_TASK = 'optchat.private-agent';

const note = (effort: ThinkingLevel | null): string => `note: subagent${effort ? ` at effort ${effort}` : ''}`;
const report = (name: string, text: string): string => `[${name}]\n${text}\n\nFull chat: zoom("${name}")`;

/**
 * An agent's log as UniiChat keeps one, its lines `kind: text`: what it is, then each message it was sent, its
 * replies, calls and their results. A message's own words are its entry's, or for one from before they were, its last
 * text, after the view and the devices.
 */
export async function agentLog(
  tx: Tx, conversationId: ConversationId, effort: ThinkingLevel | null,
): Promise<{ lines: string[]; images: ImageContent[] }> {
  const lines = [note(effort)];
  const images: ImageContent[] = [];
  let cursor: Cursor | undefined;
  do {
    const batch = await tx.scanEntries({ conversationId, order: 'ascending' }, 100, cursor);
    for (const entry of batch.items) {
      for (const message of entry.model ?? []) {
        if (message.role === 'user') {
          const content = typeof message.content === 'string'
            ? [{ type: 'text' as const, text: message.content }]
            : message.content;
          const last = content.findLast((item) => item.type === 'text');
          const words = AgentInputEntry.is(entry) ? entry.data.words : [last?.type === 'text' ? last.text : ''];
          const pictures = content.filter((item): item is ImageContent => item.type === 'image');
          for (const said of words) lines.push(`user: ${said}`);
          lines[lines.length - 1] += pictures.map(() => '\n[image]').join('');
          images.push(...pictures);
        } else if (message.role === 'assistant') {
          const why = message.stopReason === 'aborted' ? 'stopped' : message.errorMessage ?? 'failed';
          const cut = message.stopReason === 'error' || message.stopReason === 'aborted' ? `\n[cut off: ${why}]` : '';
          for (const item of message.content) {
            if (item.type === 'text' && item.text.trim()) {
              lines.push(`unii: ${item.text.trim()}${cut}`);
            } else if (item.type === 'toolCall') {
              lines.push(`tool: ${item.name} ${JSON.stringify(item.arguments)}${cut}`);
            }
          }
        } else if (message.role === 'toolResult') {
          const output = message.content.map((item) => (item.type === 'text' ? item.text : '[image]')).join('\n');
          lines.push(`echo: ${message.isError ? 'error: ' : ''}${output || '(no output)'}`);
        }
      }
    }
    cursor = batch.next;
  } while (cursor);
  return { lines, images };
}

/**
 * The work message of an agent's call, published with its task's terminal commit so a restart publishes it once,
 * under the request ID it is admitted with.
 */
async function publishReport(tx: Tx, root: ConversationId, id: TaskId, text: string, stopped: boolean): Promise<void> {
  const requestId = `optchat:agent:${id}:report`;
  await tx.doc(AgentReportDoc, root, requestId, { text, requestId, stopped });
  (await tx.doc(AgentDirectoryDoc, root)).pendingReports.push(requestId);
}

/** Resolves once `ready` holds for the watched values, which a stream's partials change many times a second. */
async function until(watches: readonly WatchHandle<unknown>[], ready: () => boolean, context: Context): Promise<void> {
  try {
    if (ready()) return;
    const change = new Promise<void>((resolve) => {
      for (const watch of watches) {
        watch.start(async () => {
          if (ready()) resolve();
        });
      }
    });
    const ended = Promise.race(watches.map((watch) => watch.closed)).then((end) => {
      if (end.reason === 'session_failed' || end.reason === 'listener_error') throw end.error;
      throw new Error(`Agent watch ended: ${end.reason}`);
    });
    await awaitWithContext(Promise.race([change, ended]), context);
  } finally {
    await Promise.all(watches.map((watch) => watch.stop()));
  }
}

/**
 * One call of an agent, UniiChat's `Tools.run`: once the main memory has the messages before it, the view, the
 * devices and its log, ending with what it was told, go to its conversation, created for a new agent and started over
 * for an idle one. The call alone sends to the conversation: what the agent is told meanwhile it steers in, between the
 * agent's tool calls, and once the conversation rests with nothing more told, it reports the call's replies at once.
 */
export const agentTask = (setup: SubagentSetup) => defineTask<AgentInput, Checkpoint, { name: string }>({
  name: AGENT_TASK,
  version: 3,
  // Version 2 was an agent's one task: its task the message, its `run` the delivery of the view, devices and task.
  migrate: (input, checkpoint) => {
    const { name, task: message, cutoff } = input as { name: string; task: string; cutoff: number };
    const saved = checkpoint as CheckpointV2;
    if (saved.phase === 'create') return { input: { name, message, cutoff }, checkpoint: { phase: 'prepare' } };
    const state = saved.turnState ? [`\n${saved.turnState}\n\n`] : [];
    return {
      input: { name, message, cutoff },
      checkpoint: {
        phase: 'deliver',
        conversationId: saved.conversationId,
        requestId: saved.requestId,
        content: [saved.frozenView, ...state, message],
        words: [message],
        steers: [],
      },
    };
  },
  initial: () => ({ phase: 'prepare' }),
  phases: {
    async prepare(task, runtime, context) {
      const { name, message, cutoff } = task.input;
      const root = runtime.conversationId;
      const invocation = withAbortSignal(runtime.signal, context);
      const watch = await runtime.watchDoc(MemoryDoc, root, invocation);
      if (!watch) throw new Error('MemoryDoc must be initialized before calling an agent');
      try {
        await awaitWithContext(new Promise<void>((resolve, reject) => {
          watch.start(async (value) => {
            if (value && value.frontier >= cutoff) resolve();
          });
          if (watch.value && watch.value.frontier >= cutoff) resolve();
          void watch.closed.then((ended) => {
            if (ended.reason === 'session_failed' || ended.reason === 'listener_error') reject(ended.error);
            else reject(new Error(`Agent memory watch ended: ${ended.reason}`));
          });
        }), invocation);
      } finally {
        await watch.stop();
      }
      // Read outside the commit; a host that can't tell (a locked keychain) is reported, and the call goes without
      // it rather than never.
      const turnState = await setup.turnState().catch((error: unknown) => {
        runtime.report(error);
        return '';
      });
      await runtime.commit(async (tx) => {
        const agent = await tx.doc(PrivateAgentDoc, root, name, null);
        agent.calling = task.id;
        let child = agent.conversationId;
        // Native table reads come before the commit's first table write.
        const log = child ? (await agentLog(tx, child, agent.effort)).lines : [note(agent.effort)];
        const view = await renderMain(tx, root, cutoff);
        if (child === null) {
          // Native task ownership copies pi.agent from the root conversation. As pi-durable's subagent example sets
          // one up, it goes without the master's extension, so without the master's prompt and the agent tools, and
          // its own prompt leads the user's instructions. Its device tools run in its own folder, its name.
          const anchor = await tx.createTask(AgentAnchor, null, {
            conversationId: root,
            ownership: { kind: 'conversation' },
            background: true,
          });
          const created = await tx.createConversation({ ownership: { kind: 'task', taskId: anchor } });
          const instructions = (await tx.doc(AgentDoc, root)).instructions;
          await configure(tx, created.id, {
            extensions: { remove: [setup.master()] },
            instructions: instructions ? `${setup.prompt}\n\n${instructions}` : setup.prompt,
            cwd: name,
            ...(agent.effort ? { thinkingLevel: agent.effort } : {}),
          });
          agent.conversationId = created.id;
          child = created.id;
        } else {
          if ((await tx.doc(AgentDoc, child)).cwd === undefined) await configure(tx, child, { cwd: name });
          await tx.appendEntry(ResetEntry, child, { head: 'self' });
        }
        // What it was told before the call began joins its log.
        const words = [message, ...agent.waiting];
        agent.waiting = [];
        const lines = [...log, ...words.map((said) => `user: ${said}`)].map((line, i) => `${i}|${line}`).join('\n\n');
        return {
          status: 'running',
          checkpoint: {
            phase: 'deliver',
            conversationId: child,
            requestId: `optchat:agent:${task.id}`,
            content: [view, ...(turnState ? [`\n${turnState}\n\n`] : []), lines],
            words,
            steers: [],
          },
        };
      }, context);
    },
    async deliver(task, runtime, context) {
      const checkpoint = task.state.checkpoint;
      const { conversationId, requestId, content, words, steers } = checkpoint;
      const { name } = task.input;
      const root = runtime.conversationId;
      const child = await runtime.conversation(conversationId, context);
      if (!child) throw new Error('The private conversation is missing');
      const sent = [requestId, ...steers.map((_, i) => `${requestId}:${i + 1}`)];
      // Re-submitting a request ID recovers the same submission after a restart or a lost acknowledgement.
      await child.submit({
        type: 'input',
        requestId,
        content: content.map((text) => ({ type: 'text' as const, text })),
        whenBusy: 'followUp',
        entry: { kind: AgentInputEntry.kind, data: { words } },
      }, context);
      for (const [i, said] of steers.entries()) {
        await child.submit({
          type: 'input',
          requestId: sent[i + 1],
          content: [{ type: 'text', text: said }],
          whenBusy: 'steer',
          entry: { kind: AgentInputEntry.kind, data: { words: [said] } },
        }, context);
      }
      const invocation = withAbortSignal(runtime.signal, context);
      for (;;) {
        const told = await runtime.watchDoc(PrivateAgentDoc, root, name, invocation);
        const live = await runtime.watchDoc(LiveDoc, conversationId, invocation);
        if (!told || !live) {
          await Promise.all([told?.stop(), live?.stop()]);
          throw new Error('The agent documents are missing');
        }
        // Until it is told more, or its conversation rests.
        await until([told, live], () => Boolean(told.value?.waiting.length) || !live.value?.run, invocation);
        // A failed run leaves what was steered to it queued; withdrawn, it ends with the call.
        const inbox = await runtime.snapshot(InboxDoc, conversationId, context);
        const resting = !(await runtime.snapshot(LiveDoc, conversationId, context))?.run;
        if (resting && inbox?.items.some((item) => item.mode !== 'write')) {
          await child.abort(context);
          continue;
        }
        let ended = false;
        await runtime.commit(async (tx) => {
          const agent = await tx.doc(PrivateAgentDoc, root, name, null);
          if (agent.waiting.length > 0) {
            const more = agent.waiting;
            agent.waiting = [];
            ended = true;
            return { status: 'running', checkpoint: { ...checkpoint, steers: [...steers, ...more] } } as const;
          }
          if ((await tx.doc(LiveDoc, conversationId)).run) return undefined;
          // The call's replies, as UniiChat reports them: each answer once, and each failure but a withdrawal.
          const replies: string[] = [];
          const answers = new Set<EntryId>();
          for (const id of sent) {
            const settled = await tx.submissionByRequest(conversationId, id);
            if (settled?.type === 'input' && settled.status === 'done' && !answers.has(settled.answer)) {
              answers.add(settled.answer);
              const entry = await tx.entry(settled.answer);
              const text = (entry?.model ?? [])
                .flatMap((reply) => reply.role === 'assistant'
                  ? reply.content.flatMap((block) => (block.type === 'text' ? [block.text] : []))
                  : [])
                .join('')
                .trim();
              replies.push(text);
            } else if (settled?.status === 'unanswered' && settled.reason !== 'aborted') {
              const why = `failed: ${typeof settled.detail === 'string' ? settled.detail : settled.reason}`;
              if (!replies.includes(why)) replies.push(why);
            } else if (settled?.status === 'queued' || settled?.status === 'placed') {
              return undefined;
            }
          }
          if (agent.calling === task.id) agent.calling = null;
          await publishReport(tx, root, task.id, report(name, replies.join('\n\n')), false);
          ended = true;
          return { status: 'terminal', outcome: { status: 'completed', result: { name } } } as const;
        }, context);
        if (ended) return;
      }
    },
  },
  // The user's stop: the call's work is cut, what it was told dropped, and its report logged with no turn.
  async abort(task, runtime, context) {
    const saved = task.state.checkpoint;
    if (saved.phase === 'deliver') await (await runtime.conversation(saved.conversationId, context))?.abort(context);
    await runtime.commit(async (tx) => {
      const agent = await tx.doc(PrivateAgentDoc, runtime.conversationId, task.input.name, null);
      if (agent.calling === task.id) {
        agent.calling = null;
        agent.waiting = [];
      }
      const text = report(task.input.name, 'failed: stopped');
      await publishReport(tx, runtime.conversationId, task.id, text, true);
      return { status: 'terminal', outcome: { status: 'aborted' } };
    }, context);
  },
});
type AgentTask = ReturnType<typeof agentTask>;

/** The messages to agents still being answered, read from pi-durable's own task records so they can't drift. */
export async function agentWork(tx: Tx, root: ConversationId): Promise<{ id: TaskId; name: string }[]> {
  const work: { id: TaskId; name: string }[] = [];
  for (const status of ['pending', 'running', 'waiting'] as const) {
    let cursor: Cursor | undefined;
    do {
      const page = await tx.scanTasks({ conversationId: root, kind: AGENT_TASK, status }, 100, cursor);
      for (const { id, input } of page.items) {
        if (typeof input === 'object' && input !== null && !Array.isArray(input) && typeof input.name === 'string') {
          work.push({ id, name: input.name });
        }
      }
      cursor = page.next;
    } while (cursor);
  }
  return work;
}

/** The agents at work now, by name. */
export async function agentsAtWork(tx: Tx, root: ConversationId): Promise<string[]> {
  return [...new Set((await agentWork(tx, root)).map(({ name }) => name))];
}

/** Call only in the same Tx that durably admits returned items as main work. */
export async function takeAgentReports(tx: Tx, rootId: ConversationId): Promise<AgentReport[]> {
  const directory = await tx.doc(AgentDirectoryDoc, rootId);
  const reports: AgentReport[] = [];
  for (const key of directory.pendingReports) {
    const pending = await tx.doc(AgentReportDoc, rootId, key, { text: '', requestId: '', stopped: false });
    if (!pending.consumed) {
      reports.push({ requestId: pending.requestId, text: pending.text, stopped: pending.stopped });
      pending.consumed = true;
    }
  }
  directory.pendingReports = [];
  return reports;
}

/** A tool call's answer, kept so a native replay of the call answers alike without acting twice. */
const AgentCallDoc = defineDocFamily<{ result: string | null }, null>({
  kind: 'optchat.agent-launch',
  version: 2,
  scope: 'conversation',
  history: 'latest',
  fork: 'current',
  family: true,
  // Version 1 recorded the one agent an `agent` call launched.
  migrate: (value) => {
    const { taskId, name } = value as { taskId: TaskId | null; name: string };
    return { result: taskId === null ? null : `Started ${name}. Its report will arrive automatically.` };
  },
  initial: () => ({ result: null }),
});

/** UniiChat's master tools: `spawn` starts subagents, `tell` messages one. */
export function agentTools(rootId: ConversationId, task: AgentTask) {
  /** Starts a call of an agent on a message, in the same commit that records the tool call's answer. */
  async function call(tx: Tx, name: string, message: string): Promise<void> {
    const memory = await tx.doc(MemoryDoc, rootId);
    const agent = await tx.doc(PrivateAgentDoc, rootId, name, null);
    agent.calling = await tx.createTask(task, { name, message, cutoff: memory.nextMessage }, {
      conversationId: rootId,
      ownership: { kind: 'conversation' },
      background: true,
    });
  }
  const spawn = defineTool({
    name: 'spawn',
    description: 'Start one subagent per task, in parallel, and return their names at once. Each one\'s report '
      + 'reaches you as a message "[Name] report" when it finishes. A subagent sees the view and the user\'s '
      + 'instructions, but knows what you want only from its task.',
    replay: 'safe',
    parameters: Type.Object({
      tasks: Type.Array(Type.String()),
      effort: Type.Optional({
        ...ThinkingLevelSchema,
        description: 'How hard they think; by default, as hard as you.',
      }),
    }),
    async execute({ tasks, effort }, api, context) {
      const text = await api.commit(async (tx) => {
        // A native tool task may replay after a lost result commit; its own ID makes it act once.
        const done = await tx.doc(AgentCallDoc, rootId, String(api.taskId), null);
        if (done.result !== null) return done.result;
        if (tasks.length === 0) return 'No tasks.';
        const directory = await tx.doc(AgentDirectoryDoc, rootId);
        const names: string[] = [];
        for (const each of tasks) {
          const name = agentName(directory.names);
          directory.names.push(name);
          await tx.doc(PrivateAgentDoc, rootId, name, effort ?? null);
          await call(tx, name, each);
          names.push(name);
        }
        done.result = `Started ${names.join(', ')}. Each one's report will reach you as a message when it finishes.`;
        return done.result;
      }, context);
      return { output: [{ type: 'text' as const, text }] };
    },
  });
  const tell = defineTool({
    name: 'tell',
    description: 'Send a message to a subagent, by name. One at work reads it between its tool calls, and its '
      + 'report answers it; an idle one goes on from its chat, and its reply reaches you as a message "[Name] reply".',
    replay: 'safe',
    parameters: Type.Object({ name: Type.String(), message: Type.String() }),
    async execute({ name, message }, api, context) {
      const text = await api.commit(async (tx) => {
        const done = await tx.doc(AgentCallDoc, rootId, String(api.taskId), null);
        if (done.result !== null) return done.result;
        if (!(await tx.doc(AgentDirectoryDoc, rootId)).names.includes(name)) return `No agent ${name} to tell.`;
        const agent = await tx.doc(PrivateAgentDoc, rootId, name, null);
        // An agent at work is told through its call; an idle one goes on in a call of its own, which takes along
        // what a call that faulted was told.
        const caller = agent.calling === null ? undefined : await tx.task(agent.calling);
        if (caller !== undefined && caller.state.status !== 'completing' && caller.state.status !== 'terminal') {
          agent.waiting.push(message);
          done.result = `Sent. ${name} reads it between its tool calls, and its report answers it.`;
        } else {
          // In the order it was told: what the faulted call was told first.
          const told = [...agent.waiting, message];
          agent.waiting = told.slice(1);
          await call(tx, name, told[0]);
          done.result = `Sent. ${name}'s reply will reach you as a message.`;
        }
        return done.result;
      }, context);
      return { output: [{ type: 'text' as const, text }] };
    },
  });
  return [spawn, tell];
}
