import {
  defineDoc,
  defineTask,
  type ConversationId,
  type ModelRef,
  type TaskId,
  type Tx,
} from "@earendil-works/pi-durable";
import type {
  AssistantMessage,
  Context as ModelContext,
  ModelThinkingLevel,
  StopReason,
} from "@earendil-works/pi-ai";
import {
  MemoryDoc,
  readMessage,
  readNode,
  renderCompaction,
  publishNode,
  bytes,
  key,
  first,
  end,
  type NodeRef,
} from "./memory.mjs";

/** The summary model and effort the host selected. Builds wait while it is `null`. */
export type SummarySelection = {
  model: ModelRef;
  thinkingLevel: ModelThinkingLevel;
};
export const ConfigDoc = defineDoc<{ summary: SummarySelection | null }>({
  kind: "optchat.config",
  version: 1,
  scope: "conversation",
  history: "latest",
  fork: "current",
  initial: () => ({ summary: null }),
});
/** A native reply copied field by field: documents hold strict JSON, and provider objects may carry `undefined`. */
type StoredReply = {
  text: string;
  content: (
    | { type: "text"; text: string; textSignature: string | null }
    | {
        type: "thinking";
        thinking: string;
        thinkingSignature: string | null;
        redacted: boolean;
      }
  )[];
  api: string;
  provider: string;
  model: string;
  responseModel: string | null;
  responseId: string | null;
  providerThinkingLevel: string | null;
  thinkingLevel: ModelThinkingLevel | null;
  stopReason: StopReason;
  timestamp: number;
};
export const BuildScratchDoc = defineDoc<{
  source: string;
  task: string;
  view: string;
  selection: SummarySelection | null;
  replies: StoredReply[];
  shortest: string | null;
}>({
  kind: "optchat.build-scratch",
  version: 1,
  scope: "task",
  initial: () => ({
    source: "",
    task: "",
    view: "",
    selection: null,
    replies: [],
    shortest: null,
  }),
});
export function prefixUtf8(text: string, budget: number): string {
  let out = "",
    n = 0;
  for (const ch of text) {
    const k = bytes(ch);
    if (n + k > budget) break;
    out += ch;
    n += k;
  }
  return out;
}
export function correction(text: string): string {
  return `Too long: your line is ${bytes(text)} bytes, over the 512-byte limit. Write\nthe whole line again for the same <input>, cutting just enough of the\nleast valuable items to fit before this cut:\n${prefixUtf8(text, 512)}| ← LIMIT`;
}
const replyText = (reply: AssistantMessage): string =>
  reply.content
    .filter((block) => block.type === "text")
    .map((block) => block.text)
    .join("")
    .replace(/\r\n|\r|\n/g, " ")
    .trim();
function storedReply(reply: AssistantMessage, text: string): StoredReply {
  const content: StoredReply["content"] = [];
  for (const block of reply.content) {
    if (block.type === "text")
      content.push({
        type: "text",
        text: block.text,
        textSignature: block.textSignature ?? null,
      });
    else if (block.type === "thinking")
      content.push({
        type: "thinking",
        thinking: block.thinking,
        thinkingSignature: block.thinkingSignature ?? null,
        redacted: block.redacted ?? false,
      });
    // A reply with a tool call fails the attempt before it could be stored.
  }
  return {
    text,
    content,
    api: reply.api,
    provider: reply.provider,
    model: reply.model,
    responseModel: reply.responseModel ?? null,
    responseId: reply.responseId ?? null,
    providerThinkingLevel: reply.providerThinkingLevel ?? null,
    thinkingLevel: reply.thinkingLevel ?? null,
    stopReason: reply.stopReason,
    timestamp: reply.timestamp,
  };
}
function nativeReply(stored: StoredReply): AssistantMessage {
  return {
    role: "assistant",
    content: stored.content.map((block) =>
      block.type === "text"
        ? {
            type: "text",
            text: block.text,
            ...(block.textSignature === null
              ? {}
              : { textSignature: block.textSignature }),
          }
        : {
            type: "thinking",
            thinking: block.thinking,
            ...(block.thinkingSignature === null
              ? {}
              : { thinkingSignature: block.thinkingSignature }),
            ...(block.redacted ? { redacted: true } : {}),
          },
    ),
    api: stored.api,
    provider: stored.provider,
    model: stored.model,
    ...(stored.responseModel === null
      ? {}
      : { responseModel: stored.responseModel }),
    ...(stored.responseId === null ? {} : { responseId: stored.responseId }),
    ...(stored.providerThinkingLevel === null
      ? {}
      : { providerThinkingLevel: stored.providerThinkingLevel }),
    ...(stored.thinkingLevel === null
      ? {}
      : { thinkingLevel: stored.thinkingLevel }),
    usage: {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 0,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
    stopReason: stored.stopReason,
    timestamp: stored.timestamp,
  };
}
async function freeze(
  tx: Tx,
  root: ConversationId,
  ref: NodeRef,
): Promise<{ source: string; task: string; view: string }> {
  let source: string, task: string;
  const ruler = "-".repeat(512);
  if (ref[0] === 0) {
    const m = await readMessage(tx, root, ref[1]);
    source = `${m.kind}: ${m.text}`;
    task = `Compaction: compress message ${m.i} into one line of at most 512 bytes\n(about 70 words), the length of this ruler:\n${ruler}\n<input>\n${source}\n</input>`;
  } else {
    const a = await readNode(tx, root, [ref[0] - 1, ref[1] * 2]),
      b = await readNode(tx, root, [ref[0] - 1, ref[1] * 2 + 1]);
    if (!a || !b) throw new Error("Parent halves must both exist");
    source = `${a.text}\n${b.text}`;
    task = `Compaction: merge lines ${first(a.ref)}+${2 ** a.ref[0]} and ${first(b.ref)}+${2 ** b.ref[0]}, adjacent, into one line of at most\n512 bytes (about 70 words), the length of this ruler:\n${ruler}\n<chat> may hold their messages, ${first(ref)} to ${end(ref) - 1}, in more detail: take details\nof them from there too.\n<input>\n${source}\n</input>`;
  }
  const view = await renderCompaction(
    tx,
    root,
    ref[0] === 0 ? first(ref) : end(ref),
  );
  return { source, task, view };
}
// Queue work only. At most the first eight unresolved leaves are eligible; a failed
// earlier leaf still occupies its place in that eligibility window until it succeeds.
export async function pumpBuilds(
  tx: Tx,
  root: ConversationId,
): Promise<TaskId<string>[]> {
  const s = await tx.doc(MemoryDoc, root);
  const { summary } = await tx.doc(ConfigDoc, root);
  const created: TaskId<string>[] = [];
  // Nothing is built until the host selects a summary model.
  if (!summary) return created;
  const selected = summary;
  async function admit(ref: NodeRef): Promise<boolean> {
    const k = key(ref);
    if (s.active[k] || s.failed[k]?.at === s.messageProgress) return false;
    if (await readNode(tx, root, ref)) return false;
    const frozen = await freeze(tx, root, ref);
    const id = await tx.createTask(
      BuildNode,
      { ref },
      {
        conversationId: root,
        ownership: { kind: "conversation" },
        background: true,
      },
    );
    const scratch = await tx.doc(BuildScratchDoc, id);
    scratch.source = frozen.source;
    scratch.task = frozen.task;
    scratch.view = frozen.view;
    scratch.selection = {
      model: { provider: selected.model.provider, modelId: selected.model.modelId },
      thinkingLevel: selected.thinkingLevel,
    };
    s.active[k] = id;
    delete s.failed[k];
    s.revision++;
    created.push(id);
    return true;
  }
  async function leaf(): Promise<boolean> {
    for (const i of s.pendingLeaves.slice(0, 8))
      if (await admit([0, i])) return true;
    return false;
  }
  async function parent(): Promise<boolean> {
    for (let j = 0; j < s.readyParents.length; ) {
      const r = s.readyParents[j];
      if (await readNode(tx, root, r)) {
        s.readyParents.splice(j, 1);
        continue;
      }
      if (await admit(r)) {
        s.readyParents.splice(j, 1);
        return true;
      }
      j++;
    }
    return false;
  }
  while (Object.keys(s.active).length < 8) {
    const preferParent = s.nextQueue === "parent";
    const made = preferParent
      ? (await parent()) || (await leaf())
      : (await leaf()) || (await parent());
    if (!made) break;
    s.nextQueue = preferParent ? "leaf" : "parent";
  }
  // Failed parents leave the ready queue while running and are requeued exactly on failure.
  return created;
}
async function release(
  tx: Tx,
  root: ConversationId,
  ref: NodeRef,
  id: TaskId<string>,
): Promise<void> {
  const s = await tx.doc(MemoryDoc, root);
  const k = key(ref);
  if (s.active[k] !== id) return;
  delete s.active[k];
  s.failed[k] = { ref, at: s.messageProgress };
  if (ref[0] > 0) s.readyParents.push(ref);
  s.revision++;
}
type Phase =
  | {
      phase: "prepare";
    }
  | {
      phase: "request";
      attempt: number;
    }
  | {
      phase: "publish";
    };
export const BuildNode = defineTask<
  {
    ref: NodeRef;
  },
  Phase,
  string
>({
  name: "optchat.build-node",
  version: 1,
  initial: () => ({ phase: "prepare" }),
  phases: {
    prepare: async (task, r, ctx) => {
      await r.commit(async (tx) => {
        const d = await tx.doc(BuildScratchDoc, task.id);
        if (bytes(d.source) <= 512) {
          d.shortest = d.source;
          return { status: "running", checkpoint: { phase: "publish" } };
        }
        return {
          status: "running",
          checkpoint: { phase: "request", attempt: 0 },
        };
      }, ctx);
    },
    request: async (task, r, ctx) => {
      const saved = await r.snapshot(BuildScratchDoc, task.id, ctx);
      if (!saved?.selection) throw new Error("Missing native task scratch");
      const { selection } = saved;
      const model = r.models.getModel(
        selection.model.provider,
        selection.model.modelId,
      );
      if (!model) throw new Error("Configured summary model is unavailable");
      // The same static system prompt and offered tool schemas as a turn, from the root agent.
      const agent = await r.agent(ctx);
      const request: ModelContext = {
        messages: [
          {
            role: "system",
            content: "",
            sections: {
              instructions: `<instructions>\n${agent.instructions ?? ""}\n</instructions>`,
            },
            toolsAdded: agent.tools.map(({ name, description, parameters }) => ({
              name,
              description,
              parameters,
            })),
            timestamp: 0,
          },
          {
            role: "user",
            timestamp: 0,
            content: [
              { type: "text", text: saved.view },
              { type: "text", text: saved.task },
            ],
          },
          ...saved.replies.flatMap((reply) => [
            nativeReply(reply),
            {
              role: "user" as const,
              timestamp: 0,
              content: correction(reply.text),
            },
          ]),
        ],
      };
      let failure: string | undefined;
      let reply: AssistantMessage | undefined;
      try {
        reply = await r.models.completeSimple(model, request, {
          ...(selection.thinkingLevel === "off"
            ? {}
            : { reasoning: selection.thinkingLevel }),
          toolChoice: "none",
          signal: r.signal,
        });
        r.signal.throwIfAborted();
        if (
          reply.stopReason === "error" ||
          reply.stopReason === "aborted" ||
          reply.stopReason === "length" ||
          reply.content.some((c) => c.type === "toolCall")
        )
          failure =
            reply.errorMessage ??
            "Summary model did not produce a successful text response";
      } catch (error) {
        r.signal.throwIfAborted();
        failure = error instanceof Error ? error.message : String(error);
      }
      const answer = reply;
      const text = answer ? replyText(answer) : "";
      if (!text) failure ??= "Summary model returned empty text";
      await r.commit(async (tx) => {
        if (failure !== undefined || answer === undefined) {
          await release(tx, r.conversationId, task.input.ref, task.id);
          return {
            status: "terminal",
            outcome: {
              status: "failed",
              error: { message: failure ?? "Summary model returned no reply" },
            },
          };
        }
        const d = await tx.doc(BuildScratchDoc, task.id);
        if (d.shortest === null || bytes(text) < bytes(d.shortest))
          d.shortest = text;
        const attempt = task.state.checkpoint.attempt + 1;
        const done = bytes(text) <= 512 || attempt >= 5;
        // The oversized native reply stays in the same saved conversation, followed by its correction.
        if (!done) d.replies.push(storedReply(answer, text));
        return {
          status: "running",
          checkpoint: done
            ? { phase: "publish" }
            : { phase: "request", attempt },
        };
      }, ctx);
    },
    publish: async (task, r, ctx) => {
      await r.commit(async (tx) => {
        const d = await tx.doc(BuildScratchDoc, task.id);
        if (d.shortest === null) throw new Error("No candidate to publish");
        await publishNode(tx, r.conversationId, {
          ref: task.input.ref,
          text: d.shortest,
          bytes: bytes(d.shortest),
          builder: task.id,
        });
        return {
          status: "terminal",
          outcome: { status: "completed", result: key(task.input.ref) },
        };
      }, ctx);
    },
  },
  abort: async (task, r, ctx) => {
    await r.commit(async (tx) => {
      await release(tx, r.conversationId, task.input.ref, task.id);
      return { status: "terminal", outcome: { status: "aborted" } };
    }, ctx);
  },
});
