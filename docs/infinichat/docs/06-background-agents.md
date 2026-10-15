# Requested background agents and permanent reports

[Guide index](../README.md) · [Behavioral coverage](09-validation.md) · [Pinned references](10-references.md)

Sources: [OptChat §6](https://gist.github.com/VictorTaelin/91837951a5ce5b38f341ec1ba1df6449), [native conversation ownership](https://github.com/earendil-works/pi/blob/06a466935536f8c9bcacb2d5efc0fc021be1bdff/packages/durable/docs/spec.md#L1977-L2257), [background-agent example](https://github.com/earendil-works/pi/blob/06a466935536f8c9bcacb2d5efc0fc021be1bdff/packages/durable/test/examples/23-subagent-background.ts).

Subagents are optional and used only when the user requests them. Each native background task owns a private conversation. Its first request contains the frozen main memory view followed by its task. Its intermediate replies and tools stay in its private transcript and never become main-chat memory.

The complete final reply is admitted once as a work event, prefixed `[Name] `. Do not summarize the report again before admission. Long non-tool report text may occupy consecutive canonical records while remaining one logical report event. When the main agent is active, deliver it as native steering; when idle, start a fresh logical turn through the same admission path as other messages.

The main agent does not wait or poll for the background result. Native task lifecycle and durable report admission own completion. Foreground abort must not silently cancel independent background work. Permanent named transcript access survives task-local scratch retirement, allowing `zoom(name)` after completion and reopening.

## Implementation

<!-- implementation:start -->

### `src/agents.mts`

[Complete source](../src/agents.mts)

```typescript
import {
  defineDoc,
  defineDocFamily,
  defineTask,
  defineTool,
  type ConversationId,
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
type Checkpoint =
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

/** The independent task, not the main generation, waits for its private run. */
export const AgentTask = defineTask<AgentInput, Checkpoint, Result>({
  name: "optchat.private-agent",
  version: 1,
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
      await runtime.commit(async (tx) => {
        const frozenView =
          "frozenView" in task.input
            ? task.input.frozenView
            : await renderMain(tx, runtime.conversationId, task.input.cutoff);
        // Native task ownership copies pi.agent from the root conversation, including
        // model, reasoning, instructions, tool and extension selection. Do not fork history.
        const child = await tx.createConversation({
          ownership: { kind: "task", taskId: task.id },
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
            conversationId: child.id,
            requestId: `optchat:agent:${task.id}:initial`,
          },
        };
      }, context);
    },
    async run(task, runtime, context) {
      const { conversationId, requestId } = task.state.checkpoint;
      const child = await runtime.conversation(conversationId, context);
      if (!child) throw new Error("The private conversation is missing");
      // Frozen at launch, never re-rendered during recovery. Re-submitting this
      // native request ID recovers the same receipt after a lost acknowledgement.
      const receipt = await child.submit(
        {
          type: "input",
          requestId,
          content: [
            { type: "text", text: task.state.checkpoint.frozenView },
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
          task.input.name,
          task.id,
        );
        if (settled.type !== "input" || settled.status !== "done") {
          agent.status = "unanswered";
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
        await tx.doc(AgentReportDoc, runtime.conversationId, task.input.name, {
          text: `[${task.input.name}] ${text}`,
          requestId: `optchat:agent:${task.id}:report`,
        });
        const directory = await tx.doc(
          AgentDirectoryDoc,
          runtime.conversationId,
        );
        directory.pendingReports.push(task.input.name);
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

/** Names identify permanent separate transcripts; duplicate names are not reused. */
export async function launchAgent(
  tx: Tx,
  rootId: ConversationId,
  input: AgentInput,
): Promise<TaskId<Result>> {
  if (!input.name.trim() || /[\r\n\[\]]/.test(input.name))
    throw new Error(
      "Agent name must be nonempty and contain no brackets or newlines",
    );
  const directory = await tx.doc(AgentDirectoryDoc, rootId);
  if (directory.names.includes(input.name))
    throw new Error(`Agent name already exists: ${input.name}`);
  const id = await tx.createTask(AgentTask, input, {
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

/** Register only when the user has enabled subagents for this conversation. */
export function agentTool(rootId: ConversationId) {
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
        launch.taskId = await launchAgent(tx, rootId, {
          ...input,
          cutoff: memory.nextMessage,
        });
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
```

<!-- implementation:end -->
