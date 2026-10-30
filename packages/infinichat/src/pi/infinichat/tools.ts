import type { Context } from '@earendil-works/chord';
import { Type, type ImageContent, type TextContent } from '@earendil-works/pi-ai';
import {
  GenerationTask, ToolTask, defineExtension, defineTool, hook, wrapTool,
  type ConversationId, type HookApi, type ToolHookCall, type ToolRegistration,
} from '@earendil-works/pi-durable';
import { getOrThrow, type ExecutionEnv } from '@earendil-works/pi-durable/env';

import { PrivateAgentDoc, agentLog } from './agents';
import { MemoryDoc, MessageDoc, NodeDoc, clipToolText, key, nodeLine, shownMessage, type NodeRef } from './memory';

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
  return out.join(', ');
}

/**
 * pi-durable built-ins by the name the host registers them under: bash and code mode spill their complete output to a
 * file, and read pages itself, so its page is never clipped (a clipped page would lose the lines its offset skips).
 */
export type NativeContracts = Readonly<Record<string, 'bash' | 'codemode' | 'read'>>;

function pageText(text: string, page = 0): string {
  const chars = Array.from(text);
  const count = Math.max(1, Math.ceil(chars.length / PAGE));
  if (!Number.isSafeInteger(page) || page < 0 || page >= count) {
    throw new Error(`Page must be between 0 and ${count - 1}`);
  }
  const next = page + 1 < count ? `; call zoom again with page=${page + 1}` : '';
  return `Page ${page + 1}/${count}${next}\n` + chars.slice(page * PAGE, (page + 1) * PAGE).join('');
}

export function memoryTools(root: ConversationId) {
  const zoom = defineTool({
    name: 'zoom',
    description: 'Open line id+n into its two children; n=1 gives the complete message with images, in pages. '
      + 'A string id opens the named agent’s separate chat. Use page=0 first.',
    replay: 'safe',
    parameters: Type.Object({
      id: Type.Union([Type.Integer({ minimum: 0 }), Type.String({ minLength: 1 })]),
      n: Type.Optional(Type.Integer({ minimum: 1 })),
      page: Type.Optional(Type.Integer({ minimum: 0 })),
    }),
    outputLimits: { maxBytes: 120_000, maxLines: 30_000 },
    async execute({ id: given, n = 1, page = 0 }, api, context) {
      const images: ImageContent[] = [];
      let text: string;
      // Only a name starts with a letter: a model may pass a message id as a string.
      const id = typeof given === 'string' && !/^[A-Za-z]/.test(given) ? Number(given) : given;
      if (typeof id === 'string') {
        const agent = await api.snapshot(PrivateAgentDoc, root, id, context);
        // An answer, not a failure, for an agent there isn't, as UniiChat's agent log gives.
        if (!agent?.conversationId) return { output: [{ type: 'text' as const, text: `No agent ${id}.` }] };
        const conversationId = agent.conversationId;
        const log = await api.commit((tx) => agentLog(tx, conversationId, agent.effort), context);
        text = log.lines.map((line, i) => `${i}|${line}`).join('\n\n');
        images.push(...log.images);
      } else {
        const count = (await api.snapshot(MemoryDoc, root, context))?.nextMessage ?? 0;
        const line = Number.isSafeInteger(id) && id >= 0 && Number.isInteger(Math.log2(n)) && id % n === 0
          && id + n <= count;
        const message = line && n === 1 ? await api.snapshot(MessageDoc, root, String(id), context) : undefined;
        if (!line || (n === 1 && !message)) {
          // A wrong line is an answer, not a failure: the roots show where the tree starts.
          return {
            output: [{
              type: 'text' as const,
              text: `No line ${id}+${n}: n is a power of 2, id a multiple of n. The tree's roots: ${roots(count)}.`,
            }],
          };
        }
        if (message) {
          // UniiChat's head for a message whole: its id and +0.
          text = `${id}+0|${shownMessage(message)}`;
          images.push(...message.images.map((image) => ({ type: 'image' as const, ...image })));
        } else {
          const l = Math.log2(n) - 1;
          const halves: NodeRef[] = [[l, id / (n / 2)], [l, id / (n / 2) + 1]];
          const lines: string[] = [];
          for (const half of halves) {
            const node = await api.snapshot(NodeDoc, root, key(half), context);
            lines.push(node?.value ? nodeLine(node.value)
              : `${half[1] * 2 ** l}+${2 ** l}|(not summarized yet: zoom it)`);
          }
          text = lines.join('\n');
        }
      }
      return { output: [{ type: 'text' as const, text: pageText(text, page) }, ...(page === 0 ? images : [])] };
    },
  });
  const date = defineTool({
    name: 'date',
    description: 'The date and time of message id.',
    replay: 'safe',
    parameters: Type.Object({ id: Type.Integer({ minimum: 0 }) }),
    async execute({ id }, api, context) {
      const message = Number.isSafeInteger(id) ? await api.snapshot(MessageDoc, root, String(id), context) : undefined;
      // As UniiChat's date: the device's local time, and an answer, not a failure, for a message there isn't. It is
      // how the model learns the time, which no turn states.
      const text = message ? new Date(message.date).toLocaleString('sv-SE') : `No message ${id}.`;
      return { output: [{ type: 'text' as const, text }] };
    },
  });
  return [zoom, date];
}

/** Read a completed native bash/code-mode spill by its public filesystem API.
 * Keep only the required end windows; do not load arbitrary-size files into RAM. */
async function clippedSpill(env: ExecutionEnv, path: string, context: Context): Promise<string> {
  const reader = getOrThrow(await env.openBinaryReader(path, { noFollow: true }, context));
  try {
    const { size } = getOrThrow(await reader.info(context));
    if (size <= 240_000) {
      return clipToolText(new TextDecoder().decode(getOrThrow(await reader.read(0, size, context))));
    }
    const head = new TextDecoder().decode(getOrThrow(await reader.read(0, 120_000, context)));
    const tail = new TextDecoder('utf-8', { ignoreBOM: true })
      .decode(getOrThrow(await reader.read(size - 120_000, 120_000, context)));
    return clipToolText(head + tail);
  } finally {
    await reader.close(context);
  }
}

const textOf = (content: readonly (TextContent | ImageContent)[]) => content
  .filter((x): x is TextContent => x.type === 'text')
  .map((x) => x.text)
  .join('');

/** The complete-output file a native bash or code-mode result names, read only under a registered contract. */
function spillPath(value: unknown): string | undefined {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return undefined;
  if (!('fullOutputPath' in value) || typeof value.fullOutputPath !== 'string') return undefined;
  return value.fullOutputPath;
}

/** Environment selection is host plumbing, not OptChat behavior. `environment`
 * resolves the environment a completed call ran in, through the hook's reader: the conversation's, or the
 * device the call's arguments name. Completed streaming tools must return full
 * output or a native spill contract explicitly registered by the host. Native
 * bash spill text is decoded from the raw stdout/stderr byte sequence, not
 * reconstructed from separately decoded stream callbacks. Arbitrary tools must
 * return full explicit text; discarded stream bytes cannot be reconstructed. */
export function toolPolicy(
  tools: readonly ToolRegistration[],
  environment: (call: ToolHookCall, api: HookApi, context: Context) => Promise<ExecutionEnv | undefined>,
  nativeContracts: NativeContracts = {},
) {
  return defineExtension({
    name: 'optchat.tool-policy',
    wraps: tools.map((tool) => wrapTool(tool, (original) => ({
      ...original,
      executionMode: 'sequential' as const,
      outputLimits: { maxBytes: 120_000, maxLines: 30_000, retain: 'tail' as const },
    }))),
    hooks: [
      hook(ToolTask, {
        async afterTool(call, result, api, context) {
          const contract = nativeContracts[call.name];
          if (contract === 'read') return undefined;
          const path = contract === 'bash' ? spillPath(result.structuredOutput)
            : contract === 'codemode' ? spillPath(result.details) : undefined;
          const env = path === undefined ? undefined : await environment(call, api, context);
          if (path !== undefined && !env) {
            throw new Error('Native spill output requires the conversation execution environment');
          }
          const text = path !== undefined && env
            ? await clippedSpill(env, path, context)
            : clipToolText(textOf(result.output ?? []));
          return {
            ...result,
            output: [
              { type: 'text' as const, text },
              ...(result.output ?? []).filter((x): x is ImageContent => x.type === 'image'),
            ],
          };
        },
      }),
      hook(GenerationTask, {
        beforeRequest({ messages }) {
          return {
            messages: messages.map((message) => message.role !== 'toolResult'
              || nativeContracts[message.toolName] === 'read' ? message : {
              ...message,
              content: [
                { type: 'text' as const, text: clipToolText(textOf(message.content)) },
                ...message.content.filter((x): x is ImageContent => x.type === 'image'),
              ],
            }),
          };
        },
      }),
    ],
  });
}
