# Native tools, bounded output and recall

[Guide index](../README.md) · [Behavioral coverage](09-validation.md) · [Pinned references](10-references.md)

Sources: [OptChat §§1 and 6](https://gist.github.com/VictorTaelin/91837951a5ce5b38f341ec1ba1df6449), [native hooks](https://github.com/earendil-works/pi/blob/06a466935536f8c9bcacb2d5efc0fc021be1bdff/packages/durable/docs/spec.md#L2669-L2794), [native tool tasks](https://github.com/earendil-works/pi/blob/06a466935536f8c9bcacb2d5efc0fc021be1bdff/packages/durable/docs/spec.md#L2796-L3417).

`zoom(id,n)` validates that `n` is a positive power of two and `id` is aligned. For `n>1`, return its two immediate children, not a fresh summary. For `n=1`, return the original message and its images. `date(id)` returns the original stored timestamp. Long recall has explicit lossless pagination. `zoom(name)` reads the named private transcript, with no semantic thinking content.

Tool output keeps head and tail within **30,000 Unicode scalar characters total**, including any clipping marker and presented diagnostic text. Other long text is not clipped. A native retention window that discarded the middle/tail cannot reconstruct a complete source; obtain a complete explicit return or a documented native spill before clipping. Keep provider-native output metadata and tool result pairing. Configure `nativeSpillContracts` only for known native bash/code-mode tool registrations. A spill is read through the environment the call ran in: the host’s `callEnv`, or the conversation’s environment when the host supplies none. An arbitrary custom tool returning a `fullOutputPath` is not permission to read that path; unrecognized output metadata is not treated as a trusted native spill.

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
  InboxDoc,
  type ConversationId,
  type Cursor,
  type ToolHookCall,
  type ToolRegistration,
} from "@earendil-works/pi-durable";
import { type ExecutionEnv, getOrThrow } from "@earendil-works/pi-durable/env";
import { MessageDoc, NodeDoc, key, nodeLine, clipToolText } from "./memory.mjs";
import { PrivateAgentDoc } from "./agents.mjs";

const PAGE = 29_000;
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
    async execute({ id, n = 1, page = 0 }, api, context) {
      const images: ImageContent[] = [];
      let text: string;
      if (typeof id === "number" && !Number.isSafeInteger(id)) throw new Error('id must be a safe integer');
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
        if (
          !Number.isSafeInteger(n) ||
          n < 1 ||
          !Number.isInteger(Math.log2(n)) ||
          id % n !== 0
        )
          throw new Error("n must be a power of two and id a multiple of n");
        if (n === 1) {
          const message = await api.snapshot(
            MessageDoc,
            root,
            String(id),
            context,
          );
          if (!message) throw new Error(`Unknown message ${id}`);
          text = `${message.kind}: ${message.text}`;
          images.push(
            ...message.images.map((image) => ({
              type: "image" as const,
              ...image,
            })),
          );
        } else {
          const l = Math.log2(n) - 1,
            i = id / (n / 2);
          const left = await api.snapshot(NodeDoc, root, key([l, i]), context);
          const right = await api.snapshot(
            NodeDoc,
            root,
            key([l, i + 1]),
            context,
          );
          if (!left?.value || !right?.value)
            throw new Error("The requested child lines have not been built");
          text = nodeLine(left.value) + "\n" + nodeLine(right.value);
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
      if (!Number.isSafeInteger(id)) throw new Error('id must be a safe integer');
      const message = await api.snapshot(MessageDoc, root, String(id), context);
      if (!message) throw new Error(`Unknown message ${id}`);
      return { output: [{ type: "text" as const, text: message.date }] };
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
  nativeSpillContracts: Readonly<Record<string, 'bash' | 'codemode'>> = {},
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
        async beforeTool(call, api, context) {
          if (call.parent) return;
          const inbox = await api.snapshot(
            InboxDoc,
            api.conversationId,
            context,
          );
          if (inbox?.items.some((item) => item.mode === "steer"))
            return {
              block:
                "A newer message is queued. Replan with that message before executing additional calls.",
            };
        },
        async afterTool(call, result, api, context) {
          const contract = nativeSpillContracts[call.name];
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
              message.role !== "toolResult"
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
