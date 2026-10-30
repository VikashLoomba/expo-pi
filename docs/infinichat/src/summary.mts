import type { Context } from "@earendil-works/chord";
import {
  defineDoc,
  defineTask,
  type Agent,
  type ConversationId,
  type DocumentReader,
  type ModelRef,
  type TaskId,
  type Tx,
} from "@earendil-works/pi-durable";
import type {
  AssistantMessage,
  Context as ModelContext,
  ModelThinkingLevel,
} from "@earendil-works/pi-ai";
import {
  isRetryableAssistantError,
  retryDelayMs,
} from "@earendil-works/pi-ai/utils/retry";
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
  flat,
  shownMessage,
  type NodeRef,
} from "./memory.mjs";

/** A model and effort the host selected. */
export type ModelSelection = {
  model: ModelRef;
  thinkingLevel: ModelThinkingLevel;
};
export type OptChatConfig = {
  /** Builds wait while it is `null`. */
  summary: ModelSelection | null;
  /** What subagents run on, UniiChat's `agents`: `null` for the main agent's model and effort. */
  subagents: ModelSelection | null;
};
export const ConfigDoc = defineDoc<OptChatConfig>({
  kind: "optchat.config",
  version: 2,
  scope: "conversation",
  history: "latest",
  fork: "current",
  checkpointWhen: () => true,
  // Version 1 ran subagents on the main model.
  migrate: (value) => ({
    ...(value as Omit<OptChatConfig, "subagents">),
    subagents: null,
  }),
  initial: () => ({ summary: null, subagents: null }),
});
type BuildScratch = {
  source: string;
  task: string;
  view: string;
  selection: ModelSelection | null;
  /** The last line, when it was too long: the next try adds only a note of its size and where the limit cuts it. */
  last: string | null;
  shortest: string | null;
};
export const BuildScratchDoc = defineDoc<BuildScratch>({
  kind: "optchat.build-scratch",
  version: 2,
  scope: "task",
  checkpointWhen: () => true,
  // Version 1 kept every too-long reply to send again; the next try needs only the last one's line.
  migrate: (value) => {
    const { replies, ...scratch } = value as Omit<BuildScratch, "last"> & {
      replies: { text: string }[];
    };
    return { ...scratch, last: replies.at(-1)?.text ?? null };
  },
  initial: () => ({
    source: "",
    task: "",
    view: "",
    selection: null,
    last: null,
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
function tooLong(line: string): string {
  return (
    `Too long: your last line for this <input> was ${bytes(line)} bytes,\n` +
    "over the 512-byte limit. Write the whole line again, cutting just\n" +
    "enough of the least valuable items to fit before this cut:\n" +
    `${prefixUtf8(line, 512)}| ← LIMIT`
  );
}
const replyText = (reply: AssistantMessage): string =>
  reply.content
    .filter((block) => block.type === "text")
    .map((block) => block.text)
    .join("")
    .replace(/\r\n|\r|\n/g, " ")
    .trim();
/**
 * The model answered without a line: a refusal or another stop reason, a cut, an empty reply or a tool call. Asked
 * again it fails alike, so the summary is made without it.
 */
const unanswerable = (reply: AssistantMessage, text: string): boolean =>
  reply.stopReason === "length" ||
  (reply.stopReason === "error" && reply.rawStopReason !== undefined) ||
  reply.content.some((block) => block.type === "toolCall") ||
  (reply.stopReason !== "error" && reply.stopReason !== "aborted" && !text);
async function freeze(
  tx: Tx,
  root: ConversationId,
  ref: NodeRef,
): Promise<{ source: string; task: string; view: string }> {
  let source: string, task: string;
  const ruler = "-".repeat(512);
  if (ref[0] === 0) {
    const m = await readMessage(tx, root, ref[1]);
    source = shownMessage(m);
    task = `Compaction: compress message ${m.i} into one line of at most 512 bytes\n(about 70 words), the length of this ruler:\n${ruler}\n<input>\n${source}\n</input>`;
  } else {
    const a = await readNode(tx, root, [ref[0] - 1, ref[1] * 2]),
      b = await readNode(tx, root, [ref[0] - 1, ref[1] * 2 + 1]);
    if (!a || !b) throw new Error("Parent halves must both exist");
    // Each line flattened, as UniiChat's merge input is: a short leaf is its exact, maybe multi-line, source.
    source = `${flat(a.text)}\n${flat(b.text)}`;
    task = `Compaction: merge lines ${first(a.ref)}+${2 ** a.ref[0]} and ${first(b.ref)}+${2 ** b.ref[0]}, adjacent, into one line of at most\n512 bytes (about 70 words), the length of this ruler:\n${ruler}\n<chat> may hold their messages, ${first(ref)} to ${end(ref) - 1}, in more detail: take details\nof them from there too.\n<input>\n${source}\n</input>`;
  }
  const view = await renderCompaction(
    tx,
    root,
    ref[0] === 0 ? first(ref) : end(ref),
  );
  return { source, task, view };
}
/** UniiChat's JOBS: the summaries that build at once, and how many unbuilt leaves deep one may start. */
const JOBS = 64;
/** Where a node's context ends, UniiChat's `ctx`: before a leaf's message, after a merge's last. */
const ctx = ([l, i]: NodeRef): number => (l === 0 ? i : (i + 1) * 2 ** l);
/**
 * Queue work only, as UniiChat starts it: the nodes ready up to the JOBS-th unbuilt leaf, in the order the messages
 * came and a merge first at a tie, while fewer than JOBS build. A failed node keeps its place until it builds.
 */
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
  const deepest = s.pendingLeaves[JOBS - 1] ?? s.nextMessage;
  const ready: NodeRef[] = [
    ...s.pendingLeaves.filter((i) => i <= deepest).map((i): NodeRef => [0, i]),
    ...s.readyParents.filter((ref) => ctx(ref) <= deepest),
  ].sort((a, b) => ctx(a) - ctx(b) || b[0] - a[0]);
  for (const ref of ready) {
    if (Object.keys(s.active).length >= JOBS) break;
    const parent = s.readyParents.findIndex(
      ([l, i]) => l === ref[0] && i === ref[1],
    );
    if (parent >= 0 && (await readNode(tx, root, ref))) {
      s.readyParents.splice(parent, 1);
    } else if ((await admit(ref)) && parent >= 0) {
      // Failed parents leave the ready queue while running and are requeued exactly on failure.
      s.readyParents.splice(parent, 1);
    }
  }
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
/** `attempt` counts the lines the model wrote; `retries`, the provider failures since its last answer. */
type Phase =
  | { phase: "prepare" }
  | { phase: "request"; attempt: number; retries: number }
  | { phase: "retry"; attempt: number; retries: number; until: number }
  | { phase: "publish" };
type PhaseV1 =
  | { phase: "prepare" }
  | { phase: "request"; attempt: number }
  | { phase: "publish" };
/** A turn's system sections as pi-durable renders them: the text tagged `<key>` unless the section opts out. */
async function renderedSections(
  agent: Agent,
  conversationId: ConversationId,
  read: DocumentReader,
  context: Context,
): Promise<Record<string, string>> {
  const sections: Record<string, string> = {};
  for (const section of agent.sections) {
    const text = await section.render(
      { conversationId, agent, env: undefined, shown: {}, read },
      context,
    );
    if (text === undefined) continue;
    sections[section.key] =
      section.tag === false
        ? text
        : `<${section.key}>\n${text}\n</${section.key}>`;
  }
  return sections;
}

export const BuildNode = defineTask<
  {
    ref: NodeRef;
  },
  Phase,
  string
>({
  name: "optchat.build-node",
  version: 2,
  // Version 1 had no retry phase: a request it saved has had no provider failure since its last answer.
  migrate: (input, checkpoint) => {
    const saved = checkpoint as PhaseV1;
    return {
      input: input as { ref: NodeRef },
      checkpoint: saved.phase === "request" ? { ...saved, retries: 0 } : saved,
    };
  },
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
          checkpoint: { phase: "request", attempt: 0, retries: 0 },
        };
      }, ctx);
    },
    request: async (task, r, ctx) => {
      const { attempt, retries } = task.state.checkpoint;
      const saved = await r.snapshot(BuildScratchDoc, task.id, ctx);
      if (!saved?.selection) throw new Error("Missing native task scratch");
      const { selection } = saved;
      const model = r.models.getModel(
        selection.model.provider,
        selection.model.modelId,
      );
      // The same static system prompt and offered tool schemas as a turn, from the root agent.
      const agent = await r.agent(ctx);
      const request: ModelContext = {
        messages: [
          {
            role: "system",
            content: "",
            sections: await renderedSections(agent, r.conversationId, r, ctx),
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
            // Never a try's words or thoughts: a line too long comes back as one note on its size and cut.
            content: [
              { type: "text", text: saved.view },
              { type: "text", text: saved.task },
              ...(saved.last === null
                ? []
                : [{ type: "text" as const, text: tooLong(saved.last) }]),
            ],
          },
        ],
      };
      let failure: string | undefined;
      let reply: AssistantMessage | undefined;
      if (!model) {
        failure = "Configured summary model is unavailable";
      } else {
        try {
          reply = await r.models.completeSimple(model, request, {
            ...(selection.thinkingLevel === "off"
              ? {}
              : { reasoning: selection.thinkingLevel }),
            toolChoice: "none",
            signal: r.signal,
          });
          r.signal.throwIfAborted();
        } catch (error) {
          r.signal.throwIfAborted();
          failure = error instanceof Error ? error.message : String(error);
        }
      }
      const answer = reply;
      const { retry } = r.settings;
      const until = r.now() + retryDelayMs(retry, retries + 1);
      await r.commit(async (tx) => {
        const d = await tx.doc(BuildScratchDoc, task.id);
        const text = answer ? replyText(answer) : "";
        if (
          answer !== undefined &&
          !isRetryableAssistantError(answer) &&
          unanswerable(answer, text)
        ) {
          // The model's own failure, as a refusal: the best line a try wrote, else the source cut to the limit.
          d.shortest ??= prefixUtf8(flat(d.source), 512);
          return { status: "running", checkpoint: { phase: "publish" } };
        }
        if (
          answer === undefined ||
          answer.stopReason === "error" ||
          answer.stopReason === "aborted"
        ) {
          // Any other failure only delays a summary, as UniiChat's patient calls ask again till one is answered: an
          // outage or a missing credential, past pi-durable's bounded policy, at pi-ai's backoff, which caps at a
          // minute. With the Harness's retries off, it is tried again at the next message.
          if (retry.enabled) {
            return {
              status: "sleeping",
              checkpoint: {
                phase: "retry",
                attempt,
                retries: retries + 1,
                until,
              },
              until,
            };
          }
          await release(tx, r.conversationId, task.input.ref, task.id);
          const message =
            failure ?? answer?.errorMessage ?? "Summary model returned no reply";
          return {
            status: "terminal",
            outcome: { status: "failed", error: { message } },
          };
        }
        if (d.shortest === null || bytes(text) < bytes(d.shortest))
          d.shortest = text;
        const done = bytes(text) <= 512 || attempt + 1 >= 5;
        if (!done) d.last = text;
        return {
          status: "running",
          checkpoint: done
            ? { phase: "publish" }
            : { phase: "request", attempt: attempt + 1, retries: 0 },
        };
      }, ctx);
    },
    // After the backoff's sleep; a run before `until` (an early wake, or a record of an earlier version) sleeps again.
    retry: async (task, r, ctx) => {
      const { attempt, retries, until } = task.state.checkpoint;
      if (until > r.now()) return r.sleepUntil(until, task.state.checkpoint, ctx);
      await r.commit(
        () => ({
          status: "running",
          checkpoint: { phase: "request", attempt, retries },
        }),
        ctx,
      );
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
