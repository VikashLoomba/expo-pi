# Native tools, bounded output and recall

[Guide index](../README.md) · [Behavioral coverage](09-validation.md) · [Pinned references](10-references.md)

Sources: [OptChat §§1 and 6](https://gist.github.com/VictorTaelin/91837951a5ce5b38f341ec1ba1df6449), [UniiChat zoom](https://github.com/VictorTaelin/UniiChat/blob/0500bf6a8ea4bf0ce047488562022b1b6532cc30/Memory.ts#L1028-L1040), [native hooks](https://github.com/earendil-works/pi/blob/71023aec1546d6d677a65669c5665c0927ce0dd0/packages/durable/docs/spec.md#L2681-L2806), [native tool tasks](https://github.com/earendil-works/pi/blob/71023aec1546d6d677a65669c5665c0927ce0dd0/packages/durable/docs/spec.md#L2808-L3429).

`zoom(id,n)` opens a line of the tree: `n` a power of two, `id` a multiple of `n`, and the line within the messages logged. A line that isn’t one is an answer, not a failed call: it lists the tree’s roots, as UniiChat’s zoom does. For `n>1`, return its two immediate children, not a fresh summary; a child not built yet shows `(not summarized yet: zoom it)`. For `n=1`, return the original message, an `[image]` line for each image, and its images. An `id` that does not start with a letter is a message id, since a model may pass one as a string. `date(id)` returns the message’s date and time in the device’s local time, formatted as UniiChat’s (`sv-SE`, such as `2026-10-19 15:40:12`), and `No message N.` for a message there isn’t. No turn states the current time, as in UniiChat: the model learns it with `date` on the newest message. Long recall has explicit lossless pagination. `zoom(name)` reads the named private transcript, with no semantic thinking content.

Tool output keeps head and tail within **30,000 Unicode scalar characters total**, including any clipping marker and presented diagnostic text. Other long text is not clipped. A native retention window that discarded the middle/tail cannot reconstruct a complete source; obtain a complete explicit return or a documented native spill before clipping. Keep provider-native output metadata and tool result pairing. `nativeContracts` names the host’s registrations of pi-durable built-ins. A `bash` or `codemode` result is clipped from its native spill. A `read` result is not clipped: read pages itself at 50 KB or 2,000 lines and names the offset to continue from, which a clipped page would skip past. Its echo in memory is clipped like any other. A spill is read through the environment the call ran in: the host’s `callEnv`, or the conversation’s environment when the host supplies none. An arbitrary custom tool returning a `fullOutputPath` is not permission to read that path; unrecognized output metadata is not treated as a trusted native spill.

Native `afterTool` can transform a completed explicit result; `wrapTool` can configure output limits without replacing the execution API. Abort/recovery paths retain native semantics and do not guarantee uncommitted external output recovery. A raw interleaved stdout/stderr spill may differ from per-stream decoded callback text when Unicode bytes split across streams.

The implementation must compose these narrowly scoped native extensions rather than proxying every tool API, reimplementing the executor, or adding a parallel recovery engine.

## Implementation

<!-- implementation:start -->

### `src/tools.mts`

[Complete source](../src/tools.mts)

```typescript
import type { Context } from "@earendil-works/chord";
import {
  Type,
  type ImageContent,
  type TextContent,
} from "@earendil-works/pi-ai";
import {
  defineExtension,
  defineTool,
  hook,
  wrapTool,
  ToolTask,
  GenerationTask,
  type ConversationId,
  type Cursor,
  type ToolHookCall,
  type ToolRegistration,
} from "@earendil-works/pi-durable";
import { type ExecutionEnv, getOrThrow } from "@earendil-works/pi-durable/env";
import {
  MemoryDoc,
  MessageDoc,
  NodeDoc,
  key,
  nodeLine,
  clipToolText,
  shownMessage,
  type NodeRef,
} from "./memory.mjs";
import { PrivateAgentDoc } from "./agents.mjs";

const PAGE = 29_000;
/** The tree's roots over `count` messages, largest first, as UniiChat's zoom lists them for a line that isn't one. */
function roots(count: number): string {
  const out: string[] = [];
  for (let l = 30, id = 0; l >= 0; l--) {
    if (id + 2 ** l <= count) {
      out.push(`${id}+${2 ** l}`);
      id += 2 ** l;
    }
  }
  return out.join(", ");
}
/**
 * pi-durable built-ins by the name the host registers them under: bash and code mode spill their complete output to a
 * file, and read pages itself, so its page is never clipped (a clipped page would lose the lines its offset skips).
 */
export type NativeContracts = Readonly<Record<string, "bash" | "codemode" | "read">>;
export function pageText(text: string, page = 0): string {
  const chars = Array.from(text),
    count = Math.max(1, Math.ceil(chars.length / PAGE));
  if (!Number.isSafeInteger(page) || page < 0 || page >= count)
    throw new Error(`Page must be between 0 and ${count - 1}`);
  return (
    `Page ${page + 1}/${count}${page + 1 < count ? `; call zoom again with page=${page + 1}` : ""}\n` +
    chars.slice(page * PAGE, (page + 1) * PAGE).join("")
  );
}
export function memoryTools(root: ConversationId) {
  const zoom = defineTool({
    name: "zoom",
    description:
      "Open line id+n into its two children; n=1 gives the complete message with images, in pages. A string id opens the named agent’s separate chat. Use page=0 first.",
    replay: "safe",
    parameters: Type.Object({
      id: Type.Union([
        Type.Integer({ minimum: 0 }),
        Type.String({ minLength: 1 }),
      ]),
      n: Type.Optional(Type.Integer({ minimum: 1 })),
      page: Type.Optional(Type.Integer({ minimum: 0 })),
    }),
    outputLimits: { maxBytes: 120_000, maxLines: 30_000 },
    async execute({ id: given, n = 1, page = 0 }, api, context) {
      const images: ImageContent[] = [];
      let text: string;
      // Only a name starts with a letter: a model may pass a message id as a string.
      const id =
        typeof given === "string" && !/^[A-Za-z]/.test(given)
          ? Number(given)
          : given;
      if (typeof id === "string") {
        const agent = await api.snapshot(PrivateAgentDoc, root, id, context);
        if (!agent?.conversationId)
          throw new Error(`No transcript for agent ${id}`);
        const conversationId = agent.conversationId;
        const parts: string[] = [];
        let cursor: Cursor | undefined;
        do {
          const batch = await api.commit(
            (tx) =>
              tx.scanEntries(
                { conversationId, order: "ascending" },
                100,
                cursor,
              ),
            context,
          );
          for (const entry of batch.items)
            for (const message of entry.model ?? []) {
              if (message.role === "system") continue;
              if (typeof message.content === "string")
                parts.push(`${message.role}: ${message.content}`);
              else {
                const content: string[] = [];
                for (const item of message.content) {
                  if (item.type === "text") content.push(item.text);
                  else if (item.type === "toolCall")
                    content.push(
                      `${item.name} ${JSON.stringify(item.arguments)}`,
                    );
                  else if (item.type === "image") images.push(item);
                }
                parts.push(`${message.role}: ${content.join("\n")}`);
              }
            }
          cursor = batch.next;
        } while (cursor);
        text = parts.join("\n\n");
      } else {
        const count =
          (await api.snapshot(MemoryDoc, root, context))?.nextMessage ?? 0;
        const line =
          Number.isSafeInteger(id) &&
          id >= 0 &&
          Number.isInteger(Math.log2(n)) &&
          id % n === 0 &&
          id + n <= count;
        const message =
          line && n === 1
            ? await api.snapshot(MessageDoc, root, String(id), context)
            : undefined;
        if (!line || (n === 1 && !message))
          // A wrong line is an answer, not a failure: the roots show where the tree starts.
          return {
            output: [
              {
                type: "text" as const,
                text:
                  `No line ${id}+${n}: n is a power of 2, id a multiple of n. ` +
                  `The tree's roots: ${roots(count)}.`,
              },
            ],
          };
        if (message) {
          text = shownMessage(message);
          images.push(
            ...message.images.map((image) => ({
              type: "image" as const,
              ...image,
            })),
          );
        } else {
          const l = Math.log2(n) - 1;
          const halves: NodeRef[] = [
            [l, id / (n / 2)],
            [l, id / (n / 2) + 1],
          ];
          const lines: string[] = [];
          for (const half of halves) {
            const node = await api.snapshot(NodeDoc, root, key(half), context);
            lines.push(
              node?.value
                ? nodeLine(node.value)
                : `${half[1] * 2 ** l}+${2 ** l}|(not summarized yet: zoom it)`,
            );
          }
          text = lines.join("\n");
        }
      }
      return {
        output: [
          { type: "text" as const, text: pageText(text, page) },
          ...(page === 0 ? images : []),
        ],
      };
    },
  });
  const date = defineTool({
    name: "date",
    description: "The date and time of message id.",
    replay: "safe",
    parameters: Type.Object({ id: Type.Integer({ minimum: 0 }) }),
    async execute({ id }, api, context) {
      const message = Number.isSafeInteger(id)
        ? await api.snapshot(MessageDoc, root, String(id), context)
        : undefined;
      // As UniiChat's date: the device's local time, and an answer, not a failure, for a message there isn't. It is
      // how the model learns the time, which no turn states.
      const text = message ? new Date(message.date).toLocaleString("sv-SE") : `No message ${id}.`;
      return { output: [{ type: "text" as const, text }] };
    },
  });
  return [zoom, date];
}

/** Read a completed native bash/code-mode spill by its public filesystem API.
 * Keep only the required end windows; do not load arbitrary-size files into RAM. */
export async function clippedSpill(
  env: ExecutionEnv,
  path: string,
  context: Context,
): Promise<string> {
  const reader = getOrThrow(
    await env.openBinaryReader(path, { noFollow: true }, context),
  );
  try {
    const { size } = getOrThrow(await reader.info(context));
    if (size <= 240_000)
      return clipToolText(
        new TextDecoder().decode(
          getOrThrow(await reader.read(0, size, context)),
        ),
      );
    const head = new TextDecoder().decode(
      getOrThrow(await reader.read(0, 120_000, context)),
    );
    const tail = new TextDecoder("utf-8", { ignoreBOM: true }).decode(
      getOrThrow(await reader.read(size - 120_000, 120_000, context)),
    );
    return clipToolText(head + tail);
  } finally {
    await reader.close(context);
  }
}
const textOf = (content: readonly (TextContent | ImageContent)[]) =>
  content
    .filter((x): x is TextContent => x.type === "text")
    .map((x) => x.text)
    .join("");
/** The complete-output file a native bash or code-mode result names, read only under a registered contract. */
function spillPath(value: unknown): string | undefined {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return undefined;
  if (!("fullOutputPath" in value) || typeof value.fullOutputPath !== "string") return undefined;
  return value.fullOutputPath;
}
/** Environment selection is host plumbing, not OptChat behavior. `environment`
 * resolves the environment a completed call ran in: the conversation's, or the
 * device the call's arguments name. Completed streaming tools must return full
 * output or a native spill contract explicitly registered by the host. Native
 * bash spill text is decoded from the raw stdout/stderr byte sequence, not
 * reconstructed from separately decoded stream callbacks. Arbitrary tools must
 * return full explicit text; discarded stream bytes cannot be reconstructed. */
export function toolPolicy(
  tools: readonly ToolRegistration[],
  environment: (
    call: ToolHookCall,
    conversationId: ConversationId,
    context: Context,
  ) => Promise<ExecutionEnv | undefined>,
  nativeContracts: NativeContracts = {},
) {
  return defineExtension({
    name: "optchat.tool-policy",
    wraps: tools.map((tool) =>
      wrapTool(tool, (original) => ({
        ...original,
        executionMode: "sequential" as const,
        outputLimits: {
          maxBytes: 120_000,
          maxLines: 30_000,
          retain: "tail" as const,
        },
      })),
    ),
    hooks: [
      hook(ToolTask, {
        async afterTool(call, result, api, context) {
          const contract = nativeContracts[call.name];
          if (contract === "read") return undefined;
          const path =
            contract === "bash"
              ? spillPath(result.structuredOutput)
              : contract === "codemode"
                ? spillPath(result.details)
                : undefined;
          const env =
            path === undefined
              ? undefined
              : await environment(call, api.conversationId, context);
          if (path !== undefined && !env)
            throw new Error(
              "Native spill output requires the conversation execution environment",
            );
          const text =
            path !== undefined && env
              ? await clippedSpill(env, path, context)
              : clipToolText(textOf(result.output ?? []));
          return {
            ...result,
            output: [
              { type: "text" as const, text },
              ...(result.output ?? []).filter(
                (x): x is ImageContent => x.type === "image",
              ),
            ],
          };
        },
      }),
      hook(GenerationTask, {
        beforeRequest({ messages }) {
          return {
            messages: messages.map((message) =>
              message.role !== "toolResult" ||
              nativeContracts[message.toolName] === "read"
                ? message
                : {
                    ...message,
                    content: [
                      {
                        type: "text" as const,
                        text: clipToolText(textOf(message.content)),
                      },
                      ...message.content.filter(
                        (x): x is ImageContent => x.type === "image",
                      ),
                    ],
                  },
            ),
          };
        },
      }),
    ],
  });
}
```

<!-- implementation:end -->
