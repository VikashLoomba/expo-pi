# Requested background agents and permanent reports

[Guide index](../README.md) · [Behavioral coverage](09-validation.md) · [Pinned references](10-references.md)

Sources: UniiChat’s [agents](https://github.com/VictorTaelin/UniiChat/blob/0500bf6a8ea4bf0ce047488562022b1b6532cc30/Tools.ts#L14-L16), [subagent prompt](https://github.com/VictorTaelin/UniiChat/blob/0500bf6a8ea4bf0ce047488562022b1b6532cc30/Tools.ts#L123-L190), [`spawn` and `tell`](https://github.com/VictorTaelin/UniiChat/blob/0500bf6a8ea4bf0ce047488562022b1b6532cc30/Tools.ts#L199-L202), [their calls](https://github.com/VictorTaelin/UniiChat/blob/0500bf6a8ea4bf0ce047488562022b1b6532cc30/Tools.ts#L491-L539), [an agent’s calls and report](https://github.com/VictorTaelin/UniiChat/blob/0500bf6a8ea4bf0ce047488562022b1b6532cc30/Tools.ts#L557-L599), [stop](https://github.com/VictorTaelin/UniiChat/blob/0500bf6a8ea4bf0ce047488562022b1b6532cc30/Tools.ts#L656-L661), [names](https://github.com/VictorTaelin/UniiChat/blob/0500bf6a8ea4bf0ce047488562022b1b6532cc30/Names.ts#L1-L50), [report text](https://github.com/VictorTaelin/UniiChat/blob/0500bf6a8ea4bf0ce047488562022b1b6532cc30/Call.ts#L60-L62), [a report’s turn](https://github.com/VictorTaelin/UniiChat/blob/0500bf6a8ea4bf0ce047488562022b1b6532cc30/Server.ts#L709-L726), [agents at work](https://github.com/VictorTaelin/UniiChat/blob/0500bf6a8ea4bf0ce047488562022b1b6532cc30/Tools.ts#L259-L265) and [agent logs](https://github.com/VictorTaelin/UniiChat/blob/0500bf6a8ea4bf0ce047488562022b1b6532cc30/Memory.ts#L1153-L1194), [native conversation ownership](https://github.com/earendil-works/pi/blob/4a080252f06caf63a525d7873c5d94d3c23887e0/packages/durable/docs/spec.md#L2095-L2402), [background-agent example](https://github.com/earendil-works/pi/blob/4a080252f06caf63a525d7873c5d94d3c23887e0/packages/durable/test/examples/23-subagent-background.ts#L187-L198) and [its anchor and reporter](https://github.com/earendil-works/pi/blob/4a080252f06caf63a525d7873c5d94d3c23887e0/packages/durable/test/examples/23-subagent-background.ts#L57-L127).

Subagents are optional and used only when the user requests them. The master has UniiChat’s two agent tools. `spawn(tasks, effort)` starts one subagent per task, in parallel, and answers at once with their names. A name is UniiChat’s: a common adjective and noun from its `Names.ts` lists, capitalized and joined, such as FireAnt, drawn again while taken. `effort` is the thinking level the subagents work at, by default the main agent’s. `tell(name, message)` sends an agent one more message: an agent with a call under way is told through that call, reading it between its tool calls, and the call’s report answers it; an idle one goes on from its chat in a call of its own and replies; a name that isn’t an agent’s answers `No agent <name> to tell.` Both tools are in the `optchat.master` extension, which a subagent’s conversation goes without, so a subagent starts no agents. A third, `schedule_task(task, run_after)`, is this port’s own and starts no agent: at `run_after` the task reaches the main agent itself as a work message, through a waiting background task the host mirrors as a local notification; see [the host](08-host-and-lifecycle.md#expo-host). A call’s answer is kept by the call’s task ID in the agent-call record, so a native replay of the call answers alike without starting anything twice.

Each call of an agent, UniiChat’s [`Tools.run`](https://github.com/VictorTaelin/UniiChat/blob/0500bf6a8ea4bf0ce047488562022b1b6532cc30/Tools.ts#L557-L572), is one native background task, shaped after [pi-durable’s background-subagent example](https://github.com/earendil-works/pi/blob/4a080252f06caf63a525d7873c5d94d3c23887e0/packages/durable/test/examples/23-subagent-background.ts#L74-L127), and the call alone sends to the agent’s conversation. The agent’s document names the call under way and keeps what the agent is told meanwhile: `spawn` starts a call per task, and `tell` starts one for an idle agent, else adds the message to the call’s. The call’s `prepare` phase waits until the main memory has summarized the messages before the call, as UniiChat calls an agent anew, reads the host’s turn state outside its commit, reporting a failure and going on without it, and in one commit creates a new agent’s conversation or resets an idle one’s context, then freezes the call’s message: the main view, the turn state, then the agent’s log, its lines numbered `i|kind: text` as `zoom(name)` shows them, ending with a `user:` line for its message and one for each told before the call began. A new agent’s conversation is owned by an anchor, a background task that ends at once, as the example’s is, so it outlives the call that created it and only a stop reaches its work. It is configured as the example configures one: a copy of the root’s agent without the `optchat.master` extension, so without the master’s prompt or the agent tools, with the subagents’ prompt followed by the user’s instructions, its name as its working directory, the folder a host’s device tools run it in, and the spawn’s effort as its thinking level. A message’s entry keeps its own words, so the agent’s log shows them without the view and devices sent with them. A call task that ended without clearing its place, as one that faulted would, holds no call: `tell` reads its task’s state and starts a new call, which takes along what the ended one was told, first.

The call’s `deliver` phase submits that message and watches the agent’s document and its conversation. What the agent is told while the call delivers goes in as a steer, each under the call’s request ID and its place, so the agent reads it between its tool calls. What was steered to a run that failed is withdrawn by pi-durable (`afterFailedRun: "withdraw"`), so it ends with the call; a run whose task faulted keeps its queue (pi-durable’s spec), so once the conversation rests the call withdraws it with an abort, and it ends with the call too. When the conversation rests and nothing more is told, the call reports at once, in the commit that ends it.

The subagents’ prompt is UniiChat’s, `SUB_HEAD` verbatim, `VIEW_DOC` and `DEVICES`, renamed and without the devices paragraph as the master’s is; its images are marked `[image]`, without a file. An agent’s intermediate replies and tools stay in its own conversation and never become main-chat memory.

A call is reported once as a work event, in UniiChat’s report text: `[Name]`, a newline, its replies, a blank line and `Full chat: zoom("Name")`. Its replies are, as UniiChat joins them, each answer of its submissions once, its whole visible text trimmed, and each failure as `failed: <detail or reason>`, apart from a message it withdrew, joined by blank lines; a steer usually ends in the answer under way, so both messages share one reply. Do not summarize the report again before admission. Long non-tool report text may occupy consecutive canonical records while remaining one logical report event. When the main agent is active, deliver it as native steering; when idle, start a fresh logical turn through the same admission path as other messages. A fresh turn’s message lists the agents at work, read from pi-durable’s task records.

The main agent does not wait or poll for the background result. Native task lifecycle and durable report admission own completion. A turn’s end never touches the agents; the user’s stop ends the turn and every agent at work, as UniiChat’s stop does. Each call task’s abort cuts its agent’s run, drops what it was told and reports `failed: stopped`, which is logged as a `work` record with no turn of its own, as UniiChat logs a stopped agent’s report, and the stop’s note names the agents. Permanent named transcript access survives completion and reopening, allowing `zoom(name)`.

Changed shapes migrate through pi-durable, as it reads them. The call task is version 3: a version 2 task, an agent’s one task, saved in `create` prepares its task as a call’s message, and one saved in `run` delivers the view, turn state and task it froze, a version 1 one without a turn state, with no steers. The agent document is version 2, a version 1 agent keeping its conversation with no effort and nothing told, its task the call under way while it was starting or running; the report document is version 2, a version 1 report not stopped; the agent-call record is version 2, a version 1 `agent` call answering `Started <Name>. Its report will arrive automatically.`

## Implementation

<!-- implementation:start -->

### `src/agents.mts`

[Complete source](../src/agents.mts)

```typescript
import type { Context } from "@earendil-works/chord";
import {
  awaitWithContext,
  withAbortSignal,
} from "@earendil-works/chord/context";
import {
  Type,
  type ImageContent,
  type ThinkingLevel,
} from "@earendil-works/pi-ai";
import { ThinkingLevelSchema } from "@earendil-works/pi-ai/providers/model-schema";
import {
  AgentDoc,
  InboxDoc,
  LiveDoc,
  ResetEntry,
  configure,
  defineDoc,
  defineDocFamily,
  defineEntry,
  defineTask,
  defineTool,
  type ConversationId,
  type Cursor,
  type EntryId,
  type Extension,
  type TaskId,
  type Tx,
  type WatchHandle,
} from "@earendil-works/pi-durable";

import { MemoryDoc, renderMain } from "./memory.mjs";
import { agentName } from "./names.mjs";

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
  kind: "optchat.agent-directory",
  version: 1,
  scope: "conversation",
  history: "latest",
  fork: "current",
  checkpointWhen: () => true,
  initial: (): { names: string[]; pendingReports: string[] } => ({
    names: [],
    pendingReports: [],
  }),
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
export const PrivateAgentDoc = defineDocFamily<
  PrivateAgent,
  ThinkingLevel | null
>({
  kind: "optchat.private-agent",
  version: 2,
  scope: "conversation",
  history: "latest",
  fork: "current",
  family: true,
  checkpointWhen: () => true,
  // Version 1 was the one task an agent was: it answered once and was told nothing more. One still under way goes on
  // as the agent's call.
  migrate: (value) => {
    const { taskId, conversationId, status } = value as {
      taskId: TaskId;
      conversationId: ConversationId | null;
      status: string;
    };
    const calling = status === "starting" || status === "running" ? taskId : null;
    return { conversationId, effort: null, calling, waiting: [] };
  },
  initial: (effort) => ({
    conversationId: null,
    effort,
    calling: null,
    waiting: [],
  }),
});
/** A report waiting for admission; a stopped agent's is logged with no turn, as UniiChat's is. */
type AgentReport = { text: string; requestId: string; stopped: boolean };
export const AgentReportDoc = defineDocFamily<
  AgentReport & { consumed: boolean },
  AgentReport
>({
  kind: "optchat.agent-report",
  version: 2,
  scope: "conversation",
  history: "latest",
  fork: "current",
  family: true,
  checkpointWhen: () => true,
  // Version 1 reported only an agent that ended on its own.
  migrate: (value) => ({
    ...(value as Omit<AgentReport, "stopped"> & { consumed: boolean }),
    stopped: false,
  }),
  initial: (value) => ({ ...value, consumed: false }),
});
/** The entry a message to an agent is placed as: its words, which its log shows without the view sent with them. */
const AgentInputEntry = defineEntry<{ words: string[] }>("optchat.agent-input");

/**
 * As pi-durable's background-subagent example: a background task that ends at once owns each agent's conversation,
 * so the conversation outlives the turns and only the agent's own stop reaches its work.
 */
export const AgentAnchor = defineTask<null, { phase: "done" }, null>({
  name: "optchat.agent-anchor",
  version: 1,
  initial: () => ({ phase: "done" }),
  phases: {
    done: (_anchor, runtime, context) =>
      runtime.commit(
        () => ({
          status: "terminal",
          outcome: { status: "completed", result: null },
        }),
        context,
      ),
  },
  abort: (_anchor, runtime, context) =>
    runtime.commit(
      () => ({ status: "terminal", outcome: { status: "aborted" } }),
      context,
    ),
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
  | { phase: "prepare" }
  | {
      phase: "deliver";
      conversationId: ConversationId;
      requestId: string;
      content: string[];
      words: string[];
      steers: string[];
    };
type CheckpointV2 =
  | { phase: "create" }
  | {
      phase: "run";
      conversationId: ConversationId;
      requestId: string;
      frozenView: string;
      turnState?: string;
    };

/** The call task's registered kind, by which the agents at work count it. */
export const AGENT_TASK = "optchat.private-agent";

const note = (effort: ThinkingLevel | null): string =>
  `note: subagent${effort ? ` at effort ${effort}` : ""}`;
const report = (name: string, text: string): string =>
  `[${name}]\n${text}\n\nFull chat: zoom("${name}")`;

/**
 * An agent's log as UniiChat keeps one, its lines `kind: text`: what it is, then each message it was sent, its
 * replies, calls and their results. A message's own words are its entry's, or for one from before they were, its last
 * text, after the view and the devices.
 */
export async function agentLog(
  tx: Tx,
  conversationId: ConversationId,
  effort: ThinkingLevel | null,
): Promise<{ lines: string[]; images: ImageContent[] }> {
  const lines = [note(effort)];
  const images: ImageContent[] = [];
  let cursor: Cursor | undefined;
  do {
    const batch = await tx.scanEntries(
      { conversationId, order: "ascending" },
      100,
      cursor,
    );
    for (const entry of batch.items) {
      for (const message of entry.model ?? []) {
        if (message.role === "user") {
          const content =
            typeof message.content === "string"
              ? [{ type: "text" as const, text: message.content }]
              : message.content;
          const last = content.findLast((item) => item.type === "text");
          const words = AgentInputEntry.is(entry)
            ? entry.data.words
            : [last?.type === "text" ? last.text : ""];
          const pictures = content.filter(
            (item): item is ImageContent => item.type === "image",
          );
          for (const said of words) lines.push(`user: ${said}`);
          lines[lines.length - 1] += pictures.map(() => "\n[image]").join("");
          images.push(...pictures);
        } else if (message.role === "assistant") {
          const why =
            message.stopReason === "aborted"
              ? "stopped"
              : (message.errorMessage ?? "failed");
          const cut =
            message.stopReason === "error" || message.stopReason === "aborted"
              ? `\n[cut off: ${why}]`
              : "";
          for (const item of message.content) {
            if (item.type === "text" && item.text.trim()) {
              lines.push(`unii: ${item.text.trim()}${cut}`);
            } else if (item.type === "toolCall") {
              lines.push(
                `tool: ${item.name} ${JSON.stringify(item.arguments)}${cut}`,
              );
            }
          }
        } else if (message.role === "toolResult") {
          const output = message.content
            .map((item) => (item.type === "text" ? item.text : "[image]"))
            .join("\n");
          lines.push(
            `echo: ${message.isError ? "error: " : ""}${output || "(no output)"}`,
          );
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
async function publishReport(
  tx: Tx,
  root: ConversationId,
  id: TaskId,
  text: string,
  stopped: boolean,
): Promise<void> {
  const requestId = `optchat:agent:${id}:report`;
  await tx.doc(AgentReportDoc, root, requestId, { text, requestId, stopped });
  (await tx.doc(AgentDirectoryDoc, root)).pendingReports.push(requestId);
}

/** Resolves once `ready` holds for the watched values, which a stream's partials change many times a second. */
async function until(
  watches: readonly WatchHandle<unknown>[],
  ready: () => boolean,
  context: Context,
): Promise<void> {
  try {
    if (ready()) return;
    const change = new Promise<void>((resolve) => {
      for (const watch of watches) {
        watch.start(async () => {
          if (ready()) resolve();
        });
      }
    });
    const ended = Promise.race(watches.map((watch) => watch.closed)).then(
      (end) => {
        if (end.reason === "session_failed" || end.reason === "listener_error")
          throw end.error;
        throw new Error(`Agent watch ended: ${end.reason}`);
      },
    );
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
export const agentTask = (setup: SubagentSetup) =>
  defineTask<AgentInput, Checkpoint, { name: string }>({
    name: AGENT_TASK,
    version: 3,
    // Version 2 was an agent's one task: its task the message, its `run` the delivery of the view, devices and task.
    migrate: (input, checkpoint) => {
      const {
        name,
        task: message,
        cutoff,
      } = input as { name: string; task: string; cutoff: number };
      const saved = checkpoint as CheckpointV2;
      if (saved.phase === "create")
        return {
          input: { name, message, cutoff },
          checkpoint: { phase: "prepare" },
        };
      const state = saved.turnState ? [`\n${saved.turnState}\n\n`] : [];
      return {
        input: { name, message, cutoff },
        checkpoint: {
          phase: "deliver",
          conversationId: saved.conversationId,
          requestId: saved.requestId,
          content: [saved.frozenView, ...state, message],
          words: [message],
          steers: [],
        },
      };
    },
    initial: () => ({ phase: "prepare" }),
    phases: {
      async prepare(task, runtime, context) {
        const { name, message, cutoff } = task.input;
        const root = runtime.conversationId;
        const invocation = withAbortSignal(runtime.signal, context);
        const watch = await runtime.watchDoc(MemoryDoc, root, invocation);
        if (!watch)
          throw new Error(
            "MemoryDoc must be initialized before calling an agent",
          );
        try {
          await awaitWithContext(
            new Promise<void>((resolve, reject) => {
              watch.start(async (value) => {
                if (value && value.frontier >= cutoff) resolve();
              });
              if (watch.value && watch.value.frontier >= cutoff) resolve();
              void watch.closed.then((ended) => {
                if (
                  ended.reason === "session_failed" ||
                  ended.reason === "listener_error"
                )
                  reject(ended.error);
                else
                  reject(
                    new Error(`Agent memory watch ended: ${ended.reason}`),
                  );
              });
            }),
            invocation,
          );
        } finally {
          await watch.stop();
        }
        // Read outside the commit; a host that can't tell (a locked keychain) is reported, and the call goes without
        // it rather than never.
        const turnState = await setup.turnState().catch((error: unknown) => {
          runtime.report(error);
          return "";
        });
        await runtime.commit(async (tx) => {
          const agent = await tx.doc(PrivateAgentDoc, root, name, null);
          agent.calling = task.id;
          let child = agent.conversationId;
          // Native table reads come before the commit's first table write.
          const log = child
            ? (await agentLog(tx, child, agent.effort)).lines
            : [note(agent.effort)];
          const view = await renderMain(tx, root, cutoff);
          if (child === null) {
            // Native task ownership copies pi.agent from the root conversation. As pi-durable's subagent example sets
            // one up, it goes without the master's extension, so without the master's prompt and the agent tools, and
            // its own prompt leads the user's instructions. Its working directory, its name, is the folder a host's
            // device tools run it in.
            const anchor = await tx.createTask(AgentAnchor, null, {
              conversationId: root,
              ownership: { kind: "conversation" },
              background: true,
            });
            const created = await tx.createConversation({
              ownership: { kind: "task", taskId: anchor },
            });
            const instructions = (await tx.doc(AgentDoc, root)).instructions;
            await configure(tx, created.id, {
              extensions: { remove: [setup.master()] },
              instructions: instructions
                ? `${setup.prompt}\n\n${instructions}`
                : setup.prompt,
              cwd: name,
              ...(agent.effort ? { thinkingLevel: agent.effort } : {}),
            });
            agent.conversationId = created.id;
            child = created.id;
          } else {
            if ((await tx.doc(AgentDoc, child)).cwd === undefined)
              await configure(tx, child, { cwd: name });
            await tx.appendEntry(ResetEntry, child, { head: "self" });
          }
          // What it was told before the call began joins its log.
          const words = [message, ...agent.waiting];
          agent.waiting = [];
          const lines = [...log, ...words.map((said) => `user: ${said}`)]
            .map((line, i) => `${i}|${line}`)
            .join("\n\n");
          return {
            status: "running",
            checkpoint: {
              phase: "deliver",
              conversationId: child,
              requestId: `optchat:agent:${task.id}`,
              content: [
                view,
                ...(turnState ? [`\n${turnState}\n\n`] : []),
                lines,
              ],
              words,
              steers: [],
            },
          };
        }, context);
      },
      async deliver(task, runtime, context) {
        const checkpoint = task.state.checkpoint;
        const { conversationId, requestId, content, words, steers } =
          checkpoint;
        const { name } = task.input;
        const root = runtime.conversationId;
        const child = await runtime.conversation(conversationId, context);
        if (!child) throw new Error("The private conversation is missing");
        const sent = [
          requestId,
          ...steers.map((_, i) => `${requestId}:${i + 1}`),
        ];
        // Re-submitting a request ID recovers the same submission after a restart or a lost acknowledgement.
        await child.submit(
          {
            type: "input",
            requestId,
            content: content.map((text) => ({ type: "text" as const, text })),
            whenBusy: "followUp",
            entry: { kind: AgentInputEntry.kind, data: { words } },
          },
          context,
        );
        for (const [i, said] of steers.entries()) {
          await child.submit(
            {
              type: "input",
              requestId: sent[i + 1],
              content: [{ type: "text", text: said }],
              whenBusy: "steer",
              entry: { kind: AgentInputEntry.kind, data: { words: [said] } },
            },
            context,
          );
        }
        const invocation = withAbortSignal(runtime.signal, context);
        for (;;) {
          const told = await runtime.watchDoc(
            PrivateAgentDoc,
            root,
            name,
            invocation,
          );
          const live = await runtime.watchDoc(
            LiveDoc,
            conversationId,
            invocation,
          );
          if (!told || !live) {
            await Promise.all([told?.stop(), live?.stop()]);
            throw new Error("The agent documents are missing");
          }
          // Until it is told more, or its conversation rests.
          await until(
            [told, live],
            () => Boolean(told.value?.waiting.length) || !live.value?.run,
            invocation,
          );
          // pi-durable withdraws what was steered to a run that failed (`afterFailedRun: "withdraw"`), but a run
          // whose task faulted keeps its inbox (spec "afterFailedRun"). Withdrawn here, that input ends with the
          // call too.
          const inbox = await runtime.snapshot(
            InboxDoc,
            conversationId,
            context,
          );
          const resting = !(
            await runtime.snapshot(LiveDoc, conversationId, context)
          )?.run;
          if (resting && inbox?.items.some((item) => item.mode !== "write")) {
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
              return {
                status: "running",
                checkpoint: { ...checkpoint, steers: [...steers, ...more] },
              } as const;
            }
            if ((await tx.doc(LiveDoc, conversationId)).run) return undefined;
            // The call's replies, as UniiChat reports them: each answer once, and each failure but a withdrawal, by
            // a stop or by a failed run.
            const replies: string[] = [];
            const answers = new Set<EntryId>();
            for (const id of sent) {
              const settled = await tx.submissionByRequest(conversationId, id);
              if (
                settled?.type === "input" &&
                settled.status === "done" &&
                !answers.has(settled.answer)
              ) {
                answers.add(settled.answer);
                const entry = await tx.entry(settled.answer);
                const text = (entry?.model ?? [])
                  .flatMap((reply) =>
                    reply.role === "assistant"
                      ? reply.content.flatMap((block) =>
                          block.type === "text" ? [block.text] : [],
                        )
                      : [],
                  )
                  .join("")
                  .trim();
                replies.push(text);
              } else if (
                settled?.status === "unanswered" &&
                settled.reason !== "aborted" &&
                settled.reason !== "run_failed"
              ) {
                const why = `failed: ${typeof settled.detail === "string" ? settled.detail : settled.reason}`;
                if (!replies.includes(why)) replies.push(why);
              } else if (
                settled?.status === "queued" ||
                settled?.status === "placed"
              ) {
                return undefined;
              }
            }
            if (agent.calling === task.id) agent.calling = null;
            await publishReport(
              tx,
              root,
              task.id,
              report(name, replies.join("\n\n")),
              false,
            );
            ended = true;
            return {
              status: "terminal",
              outcome: { status: "completed", result: { name } },
            } as const;
          }, context);
          if (ended) return;
        }
      },
    },
    // The user's stop: the call's work is cut, what it was told dropped, and its report logged with no turn.
    async abort(task, runtime, context) {
      const saved = task.state.checkpoint;
      if (saved.phase === "deliver")
        await (
          await runtime.conversation(saved.conversationId, context)
        )?.abort(context);
      await runtime.commit(async (tx) => {
        const agent = await tx.doc(
          PrivateAgentDoc,
          runtime.conversationId,
          task.input.name,
          null,
        );
        if (agent.calling === task.id) {
          agent.calling = null;
          agent.waiting = [];
        }
        const text = report(task.input.name, "failed: stopped");
        await publishReport(tx, runtime.conversationId, task.id, text, true);
        return { status: "terminal", outcome: { status: "aborted" } };
      }, context);
    },
  });
type AgentTask = ReturnType<typeof agentTask>;

/** The messages to agents still being answered, read from pi-durable's own task records so they can't drift. */
export async function agentWork(
  tx: Tx,
  root: ConversationId,
): Promise<{ id: TaskId; name: string }[]> {
  const work: { id: TaskId; name: string }[] = [];
  for (const status of [
    "pending",
    "running",
    "waiting",
    "sleeping",
  ] as const) {
    let cursor: Cursor | undefined;
    do {
      const page = await tx.scanTasks(
        { conversationId: root, kind: AGENT_TASK, status },
        100,
        cursor,
      );
      for (const { id, input } of page.items) {
        if (
          typeof input === "object" &&
          input !== null &&
          !Array.isArray(input) &&
          typeof input.name === "string"
        ) {
          work.push({ id, name: input.name });
        }
      }
      cursor = page.next;
    } while (cursor);
  }
  return work;
}

/** The agents at work now, by name. */
export async function agentsAtWork(
  tx: Tx,
  root: ConversationId,
): Promise<string[]> {
  return [...new Set((await agentWork(tx, root)).map(({ name }) => name))];
}

/** Call only in the same Tx that durably admits returned items as main work. */
export async function takeAgentReports(
  tx: Tx,
  rootId: ConversationId,
): Promise<AgentReport[]> {
  const directory = await tx.doc(AgentDirectoryDoc, rootId);
  const reports: AgentReport[] = [];
  for (const key of directory.pendingReports) {
    const pending = await tx.doc(AgentReportDoc, rootId, key, {
      text: "",
      requestId: "",
      stopped: false,
    });
    if (!pending.consumed) {
      reports.push({
        requestId: pending.requestId,
        text: pending.text,
        stopped: pending.stopped,
      });
      pending.consumed = true;
    }
  }
  directory.pendingReports = [];
  return reports;
}

/** A tool call's answer, kept so a native replay of the call answers alike without acting twice. */
export const AgentCallDoc = defineDocFamily<{ result: string | null }, null>({
  kind: "optchat.agent-launch",
  version: 2,
  scope: "conversation",
  history: "latest",
  fork: "current",
  family: true,
  checkpointWhen: () => true,
  // Version 1 recorded the one agent an `agent` call launched.
  migrate: (value) => {
    const { taskId, name } = value as { taskId: TaskId | null; name: string };
    return {
      result:
        taskId === null
          ? null
          : `Started ${name}. Its report will arrive automatically.`,
    };
  },
  initial: () => ({ result: null }),
});

/** UniiChat's master tools: `spawn` starts subagents, `tell` messages one. */
export function agentTools(rootId: ConversationId, task: AgentTask) {
  /** Starts a call of an agent on a message, in the same commit that records the tool call's answer. */
  async function call(tx: Tx, name: string, message: string): Promise<void> {
    const memory = await tx.doc(MemoryDoc, rootId);
    const agent = await tx.doc(PrivateAgentDoc, rootId, name, null);
    agent.calling = await tx.createTask(
      task,
      { name, message, cutoff: memory.nextMessage },
      {
        conversationId: rootId,
        ownership: { kind: "conversation" },
        background: true,
      },
    );
  }
  const spawn = defineTool({
    name: "spawn",
    description:
      "Start one subagent per task, in parallel, and return their names at once. Each one's report " +
      'reaches you as a message "[Name] report" when it finishes. A subagent sees the view and the user\'s ' +
      "instructions, but knows what you want only from its task.",
    replay: "safe",
    parameters: Type.Object({
      tasks: Type.Array(Type.String()),
      effort: Type.Optional({
        ...ThinkingLevelSchema,
        description: "How hard they think; by default, as hard as you.",
      }),
    }),
    async execute({ tasks, effort }, api, context) {
      const text = await api.commit(async (tx) => {
        // A native tool task may replay after a lost result commit; its own ID makes it act once.
        const done = await tx.doc(
          AgentCallDoc,
          rootId,
          String(api.taskId),
          null,
        );
        if (done.result !== null) return done.result;
        if (tasks.length === 0) return "No tasks.";
        const directory = await tx.doc(AgentDirectoryDoc, rootId);
        const names: string[] = [];
        for (const each of tasks) {
          const name = agentName(directory.names);
          directory.names.push(name);
          await tx.doc(PrivateAgentDoc, rootId, name, effort ?? null);
          await call(tx, name, each);
          names.push(name);
        }
        done.result = `Started ${names.join(", ")}. Each one's report will reach you as a message when it finishes.`;
        return done.result;
      }, context);
      return { output: [{ type: "text" as const, text }] };
    },
  });
  const tell = defineTool({
    name: "tell",
    description:
      "Send a message to a subagent, by name. One at work reads it between its tool calls, and its " +
      'report answers it; an idle one goes on from its chat, and its reply reaches you as a message "[Name] reply".',
    replay: "safe",
    parameters: Type.Object({ name: Type.String(), message: Type.String() }),
    async execute({ name, message }, api, context) {
      const text = await api.commit(async (tx) => {
        const done = await tx.doc(
          AgentCallDoc,
          rootId,
          String(api.taskId),
          null,
        );
        if (done.result !== null) return done.result;
        if (!(await tx.doc(AgentDirectoryDoc, rootId)).names.includes(name))
          return `No agent ${name} to tell.`;
        const agent = await tx.doc(PrivateAgentDoc, rootId, name, null);
        // An agent at work is told through its call; an idle one goes on in a call of its own, which takes along
        // what a call that faulted was told.
        const caller = agent.calling === null ? undefined : await tx.task(agent.calling);
        if (caller !== undefined && caller.state.status !== "completing" && caller.state.status !== "terminal") {
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
      return { output: [{ type: "text" as const, text }] };
    },
  });
  return [spawn, tell];
}
```

### `src/names.mts`

[Complete source](../src/names.mts)

```typescript
/**
 * UniiChat's agent names (Names.ts, VictorTaelin/UniiChat 0500bf6, Apache-2.0): a common adjective and noun,
 * capitalized and joined, as FireAnt; one taken is drawn again.
 */
const ADJECTIVES = `
red blue green yellow orange purple pink brown black white gray silver golden amber azure bronze copper jade
lemon lime mint navy peach plum ruby violet cherry honey big small tiny huge giant little tall short long
round flat thick thin deep soft hard smooth rough fuzzy fluffy shiny crunchy crispy leafy spiky hot cold warm
cool icy frosty snowy rainy sunny cloudy windy stormy foggy misty sweet sour salty spicy juicy minty nutty
creamy smoky tasty fresh bright dark quiet loud happy jolly merry calm brave bold clever wise kind gentle
lucky proud quick swift fast slow eager busy sleepy silly funny shy neat noble grand royal mighty strong
steady nimble lively cozy old new young ancient wooden stone paper iron magic cosmic lunar solar polar wild
`
  .split(/\s+/)
  .filter(Boolean);

const NOUNS = `
ant bat bear bee beetle bird bison camel cat cheetah chicken clam cobra cougar cow crab crane crow deer dog
dolphin donkey dove dragon duck eagle eel elk falcon finch fish flamingo fox frog gazelle gecko giraffe goat
goose gorilla hamster hare hawk hedgehog heron hippo horse hyena iguana jaguar jay kangaroo kitten koala lamb
lemur leopard lion lizard llama lobster moose moth mouse mule octopus orca otter owl ox oyster panda parrot
pelican penguin pig pigeon pony puffin puma rabbit raccoon raven rhino robin salmon seal shark sheep shrimp
skunk sloth snail snake sparrow spider squid squirrel swan tiger toad toucan trout tuna turkey turtle walrus
wasp whale wolf wombat yak zebra apple banana bagel cookie mango melon muffin noodle pancake pepper potato
pretzel radish taco waffle
`
  .split(/\s+/)
  .filter(Boolean);

const capitalized = (word: string): string =>
  word[0].toUpperCase() + word.slice(1);
const pick = (words: string[]): string =>
  capitalized(words[Math.floor(Math.random() * words.length)]);

/** A name no agent has, drawn as UniiChat draws one. */
export function agentName(taken: readonly string[]): string {
  for (;;) {
    const name = pick(ADJECTIVES) + pick(NOUNS);
    if (!taken.includes(name)) return name;
  }
}
```

<!-- implementation:end -->
