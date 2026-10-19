import {
  AgentDoc,
  configure,
  defineDoc,
  defineDocFamily,
  defineTask,
  defineTool,
  type ConversationId,
  type Cursor,
  type Extension,
  type TaskId,
  type Tx,
} from "@earendil-works/pi-durable";
import {
  awaitWithContext,
  withAbortSignal,
} from "@earendil-works/chord/context";
import { Type } from "@earendil-works/pi-ai";
import { MemoryDoc, renderMain } from "./memory.mjs";

export type AgentInput = { name: string; task: string } & (
  | { frozenView: string }
  | { cutoff: number }
);
/** What a subagent's conversation is set up from. */
export type SubagentSetup = {
  /** The extension of the master's prompt and of the agent tool, which a subagent goes without. */
  master: () => Extension;
  /** The subagents' prompt; the user's instructions follow it. */
  prompt: string;
  /** The host's device list, read as a subagent starts. */
  turnState: () => Promise<string>;
};
export type AgentStatus =
  | "starting"
  | "running"
  | "completed"
  | "unanswered"
  | "aborted";
export const AgentDirectoryDoc = defineDoc({
  kind: "optchat.agent-directory",
  version: 1,
  scope: "conversation",
  history: "latest",
  fork: "current",
  initial: (): { names: string[]; pendingReports: string[] } => ({
    names: [],
    pendingReports: [],
  }),
});
export const PrivateAgentDoc = defineDocFamily<
  {
    taskId: TaskId;
    conversationId: ConversationId | null;
    status: AgentStatus;
  },
  TaskId
>({
  kind: "optchat.private-agent",
  version: 1,
  family: true,
  scope: "conversation",
  history: "latest",
  fork: "current",
  initial: (taskId) => ({ taskId, conversationId: null, status: "starting" }),
});
export const AgentReportDoc = defineDocFamily<
  { text: string; requestId: string; consumed: boolean },
  { text: string; requestId: string }
>({
  kind: "optchat.agent-report",
  version: 1,
  family: true,
  scope: "conversation",
  history: "latest",
  fork: "current",
  initial: (value) => ({ ...value, consumed: false }),
});
/** `turnState`: the host's device list as the agent started, which its first message gives after the view. */
type Checkpoint =
  | { phase: "create" }
  | {
      phase: "run";
      conversationId: ConversationId;
      requestId: string;
      frozenView: string;
      turnState: string;
    };
type CheckpointV1 =
  | { phase: "create" }
  | {
      phase: "run";
      conversationId: ConversationId;
      requestId: string;
      frozenView: string;
    };
type Result = {
  name: string;
  status: "completed" | "unanswered";
  conversationId: ConversationId;
};

/** The agent task's registered kind, by which the agents at work count it. */
export const AGENT_TASK = "optchat.private-agent";

/** The independent task, not the main generation, waits for its private run. */
export const agentTask = (setup: SubagentSetup) =>
  defineTask<AgentInput, Checkpoint, Result>({
    name: AGENT_TASK,
    version: 2,
    // Version 1 gave its first message no device list, so an agent it started goes on without one.
    migrate: (input, checkpoint) => {
      const saved = checkpoint as CheckpointV1;
      return {
        input: input as AgentInput,
        checkpoint: saved.phase === "run" ? { ...saved, turnState: "" } : saved,
      };
    },
    initial: () => ({ phase: "create" }),
    phases: {
      async create(task, runtime, context) {
        if ("cutoff" in task.input) {
          const cutoff = task.input.cutoff;
          const invocation = withAbortSignal(runtime.signal, context);
          const watch = await runtime.watchDoc(
            MemoryDoc,
            runtime.conversationId,
            invocation,
          );
          if (!watch)
            throw new Error(
              "MemoryDoc must be initialized before launching an agent",
            );
          try {
            await awaitWithContext(
              new Promise<void>((resolve, reject) => {
                watch.start(async (value) => {
                  if (value && value.frontier >= cutoff) resolve();
                });
                if (watch.value && watch.value.frontier >= cutoff) resolve();
                void watch.closed.then((end) => {
                  if (
                    end.reason === "session_failed" ||
                    end.reason === "listener_error"
                  )
                    reject(end.error);
                  else reject(new Error(`Agent memory watch ended: ${end.reason}`));
                });
              }),
              invocation,
            );
          } finally {
            await watch.stop();
          }
        }
        // Read outside the commit; a host that can't tell (a locked keychain) is reported, and the agent starts
        // without it rather than never.
        const turnState = await setup.turnState().catch((error: unknown) => {
          runtime.report(error);
          return "";
        });
        await runtime.commit(async (tx) => {
          const frozenView =
            "frozenView" in task.input
              ? task.input.frozenView
              : await renderMain(tx, runtime.conversationId, task.input.cutoff);
          // Native task ownership copies pi.agent from the root conversation: model, reasoning, instructions, tool
          // and extension selection. As pi-durable's subagent example sets one up, it goes without the master's
          // extension, so without the master's prompt and the agent tool, and its own prompt leads the user's
          // instructions. Do not fork history.
          const child = await tx.createConversation({
            ownership: { kind: "task", taskId: task.id },
          });
          const instructions = (await tx.doc(AgentDoc, runtime.conversationId))
            .instructions;
          await configure(tx, child.id, {
            extensions: { remove: [setup.master()] },
            instructions: instructions
              ? `${setup.prompt}\n\n${instructions}`
              : setup.prompt,
          });
          const agent = await tx.doc(
            PrivateAgentDoc,
            runtime.conversationId,
            task.input.name,
            task.id,
          );
          agent.conversationId = child.id;
          agent.status = "running";
          return {
            status: "running",
            checkpoint: {
              phase: "run",
              frozenView,
              turnState,
              conversationId: child.id,
              requestId: `optchat:agent:${task.id}:initial`,
            },
          };
        }, context);
      },
      async run(task, runtime, context) {
        const { conversationId, requestId, frozenView, turnState } =
          task.state.checkpoint;
        const { name } = task.input;
        const child = await runtime.conversation(conversationId, context);
        if (!child) throw new Error("The private conversation is missing");
        // Frozen at launch, never re-rendered during recovery. Re-submitting this
        // native request ID recovers the same receipt after a lost acknowledgement.
        const receipt = await child.submit(
          {
            type: "input",
            requestId,
            content: [
              { type: "text", text: frozenView },
              ...(turnState
                ? [{ type: "text" as const, text: `\n${turnState}\n\n` }]
                : []),
              { type: "text", text: task.input.task },
            ],
          },
          context,
        );
        const settled = await receipt.wait(context);
        await runtime.commit(async (tx) => {
          const agent = await tx.doc(
            PrivateAgentDoc,
            runtime.conversationId,
            name,
            task.id,
          );
          if (settled.type !== "input" || settled.status !== "done") {
            agent.status = "unanswered";
            // As pi-durable's background subagents report: a stopped agent nothing, a failed one that it failed.
            if (settled.status === "unanswered" && settled.reason !== "aborted") {
              const why =
                typeof settled.detail === "string" ? settled.detail : settled.reason;
              await publishReport(
                tx,
                runtime.conversationId,
                name,
                `[${name}] failed: ${why}`,
                task.id,
              );
            }
            return {
              status: "terminal",
              outcome: {
                status: "completed",
                result: {
                  name: task.input.name,
                  status: "unanswered",
                  conversationId,
                },
              },
            };
          }
          const entry = await tx.entry(settled.answer);
          if (!entry)
            throw new Error("Native answered submission has no answer entry");
          // Keep full reasoning/tool history in the native private transcript. Only
          // final visible assistant text is a work message; no shortening or summarizing.
          const text = (entry.model ?? [])
            .flatMap((message) =>
              message.role === "assistant"
                ? message.content
                    .filter((block) => block.type === "text")
                    .map((block) => block.text)
                : [],
            )
            .join("");
          await publishReport(
            tx,
            runtime.conversationId,
            name,
            `[${name}] ${text}`,
            task.id,
          );
          agent.status = "completed";
          // Publication and terminality are one native commit, so restart cannot
          // publish the report twice. The coordinator consumes it with input admission.
          return {
            status: "terminal",
            outcome: {
              status: "completed",
              result: {
                name: task.input.name,
                status: "completed",
                conversationId,
              },
            },
          };
        }, context);
      },
    },
    async abort(task, runtime, context) {
      await runtime.commit(async (tx) => {
        (
          await tx.doc(
            PrivateAgentDoc,
            runtime.conversationId,
            task.input.name,
            task.id,
          )
        ).status = "aborted";
        return { status: "terminal", outcome: { status: "aborted" } };
      }, context);
    },
  });
type AgentTask = ReturnType<typeof agentTask>;

/** The agents at work now, by name, read from pi-durable's own task records so the list can't drift from them. */
export async function agentsAtWork(
  tx: Tx,
  root: ConversationId,
): Promise<string[]> {
  const names: string[] = [];
  for (const status of ["pending", "running", "waiting"] as const) {
    let cursor: Cursor | undefined;
    do {
      const page = await tx.scanTasks(
        { conversationId: root, kind: AGENT_TASK, status },
        100,
        cursor,
      );
      for (const { input } of page.items)
        if (
          typeof input === "object" &&
          input !== null &&
          !Array.isArray(input) &&
          typeof input.name === "string"
        )
          names.push(input.name);
      cursor = page.next;
    } while (cursor);
  }
  return names;
}

/** The work message of an agent's end, published with its task's terminal commit so a restart publishes it once. */
async function publishReport(
  tx: Tx,
  root: ConversationId,
  name: string,
  text: string,
  id: TaskId,
): Promise<void> {
  await tx.doc(AgentReportDoc, root, name, {
    text,
    requestId: `optchat:agent:${id}:report`,
  });
  (await tx.doc(AgentDirectoryDoc, root)).pendingReports.push(name);
}

/** Names identify permanent separate transcripts; duplicate names are not reused. */
export async function launchAgent(
  tx: Tx,
  rootId: ConversationId,
  input: AgentInput,
  task: AgentTask,
): Promise<TaskId<Result>> {
  if (!input.name.trim() || /[\r\n\[\]]/.test(input.name))
    throw new Error(
      "Agent name must be nonempty and contain no brackets or newlines",
    );
  const directory = await tx.doc(AgentDirectoryDoc, rootId);
  if (directory.names.includes(input.name))
    throw new Error(`Agent name already exists: ${input.name}`);
  const id = await tx.createTask(task, input, {
    conversationId: rootId,
    ownership: { kind: "conversation" },
    background: true,
  });
  directory.names.push(input.name);
  await tx.doc(PrivateAgentDoc, rootId, input.name, id);
  return id;
}

/** Call only in the same Tx that durably admits returned items as main work. */
export async function takeAgentReports(
  tx: Tx,
  rootId: ConversationId,
): Promise<{ requestId: string; text: string }[]> {
  const directory = await tx.doc(AgentDirectoryDoc, rootId);
  const reports: { requestId: string; text: string }[] = [];
  for (const name of directory.pendingReports) {
    const report = await tx.doc(AgentReportDoc, rootId, name, {
      text: "",
      requestId: "",
    });
    if (!report.consumed) {
      reports.push({ requestId: report.requestId, text: report.text });
      report.consumed = true;
    }
  }
  directory.pendingReports = [];
  return reports;
}

const AgentLaunchDoc = defineDocFamily<
  { taskId: TaskId<Result> | null; name: string },
  null
>({
  kind: "optchat.agent-launch",
  version: 1,
  family: true,
  scope: "conversation",
  history: "latest",
  fork: "current",
  initial: () => ({ taskId: null, name: "" }),
});

/** The master's tool, in the extension a subagent's conversation goes without; the prompt keeps it to user requests. */
export function agentTool(rootId: ConversationId, task: AgentTask) {
  return defineTool({
    name: "agent",
    description:
      "Start a named background agent on a task, using the saved chat view. Its final reply returns as a work message; inspect its separate transcript with zoom(name).",
    replay: "safe",
    parameters: Type.Object({
      name: Type.String({ minLength: 1 }),
      task: Type.String({ minLength: 1 }),
    }),
    async execute(input, api, context) {
      const name = await api.commit(async (tx) => {
        // A native ToolTask may replay after a lost result commit. Its stable task
        // identity makes creation and acknowledgement one durable transaction.
        const launch = await tx.doc(
          AgentLaunchDoc,
          rootId,
          String(api.taskId),
          null,
        );
        if (launch.taskId !== null) return launch.name;
        const memory = await tx.doc(MemoryDoc, rootId);
        launch.taskId = await launchAgent(
          tx,
          rootId,
          { ...input, cutoff: memory.nextMessage },
          task,
        );
        launch.name = input.name;
        return input.name;
      }, context);
      return {
        output: [
          {
            type: "text" as const,
            text: `Started ${name}. Its report will arrive automatically.`,
          },
        ],
      };
    },
  });
}
