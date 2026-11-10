import type { Context } from '@earendil-works/chord/context';
import {
  AgentDoc, ROOT_CONVERSATION_ID, defineTool, type ConversationId, type DocumentReader, type ToolRegistration,
} from '@earendil-works/pi-durable';
import { getOrThrow, type ExecutionEnv } from '@earendil-works/pi-durable/env';
import {
  createBashTool, createEditTool, createReadTool, createWriteTool, type ImageProcessor,
} from '@earendil-works/pi-durable/tools';
import { str, type Schema } from '@earendil-works/pi-schema';

import type { OptChatExtensionOptions } from './app';

/**
 * UniiChat's work dirs: a device's tools run in <work>/<who>, `main` for the main agent and its name for a subagent.
 * A machine's work dir is a folder of its own in the account's home, as UniiChat's `~/.unii/work`.
 */
export const MACHINE_WORK = '.infinichat/work';
/** How the device list describes a machine, also on the machine itself once the conversation moves there. */
export const machineDescription = (host: { username: string; hostname: string }) =>
  `${host.username}@${host.hostname} over SSH, work dir ~/${MACHINE_WORK}`;

/** One device InfiniChat's tools run on, as the devices list at the start of each message names it. */
export type Device = {
  name: string;
  description: string;
  /** The device's environment in <work>/<who>. */
  environment(who: string, read: DocumentReader, context: Context): Promise<ExecutionEnv>;
};

/**
 * What InfiniChat's tools need from the host it runs on, and `env`, the conversation's environment
 * (`HarnessOptions.env`): the device holding the chat, which pi-durable's own tools, such as code mode, run on.
 */
export type InfiniChatDevices = Required<Pick<OptChatExtensionOptions, 'tools' | 'callEnv' | 'turnState' | 'env'>>;

const deviceParameter = str({
  description: 'The device to run on, from the list at the start of the message; by default the one holding this chat',
});

/**
 * A built-in tool's parameters with an optional `device` first: the same JSON Schema object, as pi's built-in tools
 * write theirs with pi-schema (an open object, `durable/src/tools/bash.ts`), typed as the values it accepts the way
 * pi-schema's own builders type theirs. pi-schema has no combinator that adds a property to an object schema.
 */
function withDevice<T>(parameters: Schema<T>): Schema<T & { device?: string }> {
  // Its keywords as plain data, so the copy carries no value type of its own.
  const keywords = Object.fromEntries(Object.entries(parameters));
  const own = typeof keywords.properties === 'object' && keywords.properties !== null ? keywords.properties : {};
  return { ...keywords, properties: { device: deviceParameter, ...own } };
}

/**
 * What a device tool keeps of the built-in registration; its schema gains `device` and `execute` injects that env.
 * Its description says where it runs, as UniiChat's does.
 */
const kept = ({ name, description, replay, outputLimits, structuredOutputSchema, callers }: ToolRegistration) => ({
  name,
  description: `${description} It runs on the device named, or the one holding this chat when none is, in `
    + '<work>/<who>, <work> being the work dir the devices list gives for it and <who> main for the main agent, or a '
    + 'subagent\'s own name.',
  replay,
  outputLimits,
  structuredOutputSchema,
  callers,
});

/** The device a call's raw arguments name, kept through argument repair; none for the device holding the chat. */
const deviceArgument = (args: unknown): { device?: string } =>
  typeof args === 'object' && args !== null && 'device' in args && typeof args.device === 'string'
    ? { device: args.device } : {};

/**
 * The devices `list` returns, read at each use since they change, the first being the one holding the chat, as
 * InfiniChat's tools use them: pi-durable's bash, read, write and edit with an optional `device`, each calling the
 * built-in's `execute` with that device's environment, the holder's when none is named, as the Harness injects `env`
 * into every call. The holder is also the conversation's environment. Each use builds a fresh environment, as the chat
 * service's resolver does.
 */
export function infiniChatDevices(list: () => Promise<readonly Device[]>, images: ImageProcessor): InfiniChatDevices {
  /** The device's environment, the holder's without a name, in the calling conversation's folder as UniiChat's. */
  async function environment(
    name: string | undefined, read: DocumentReader, conversationId: ConversationId, context: Context,
  ): Promise<ExecutionEnv> {
    const devices = await list();
    // The host keeps device names unique, so a name is one device.
    const device = name === undefined ? devices[0] : devices.find((candidate) => candidate.name === name);
    if (!device) {
      const names = devices.map((candidate) => JSON.stringify(candidate.name)).join(', ');
      throw new Error(`Unknown device ${JSON.stringify(name)}. The devices are ${names}.`);
    }
    // A subagent's conversation names its folder as its working directory; the main agent's has none.
    const who = conversationId === ROOT_CONVERSATION_ID
      ? 'main'
      : (await read.snapshot(AgentDoc, conversationId, context))?.cwd ?? 'main';
    const env = await device.environment(who, read, context);
    getOrThrow(await env.createDir(env.cwd, { recursive: true }, context));
    return env;
  }
  const bash = createBashTool();
  const read = createReadTool({ images });
  const write = createWriteTool();
  const edit = createEditTool();
  const prepareEdit = edit.prepareArguments;
  const envFor = (device: string | undefined, api: DocumentReader & { conversationId: ConversationId },
    context: Context) =>
    environment(device, api, api.conversationId, context);
  return {
    tools: [
      defineTool({
        ...kept(bash),
        parameters: withDevice(bash.parameters),
        execute: async ({ device, ...args }, api, context) =>
          bash.execute(args, { ...api, env: await envFor(device, api, context) }, context),
      }),
      defineTool({
        ...kept(read),
        parameters: withDevice(read.parameters),
        execute: async ({ device, ...args }, api, context) =>
          read.execute(args, { ...api, env: await envFor(device, api, context) }, context),
      }),
      defineTool({
        ...kept(write),
        parameters: withDevice(write.parameters),
        execute: async ({ device, ...args }, api, context) =>
          write.execute(args, { ...api, env: await envFor(device, api, context) }, context),
      }),
      defineTool({
        ...kept(edit),
        parameters: withDevice(edit.parameters),
        prepareArguments: prepareEdit && ((args) => ({ ...prepareEdit(args), ...deviceArgument(args) })),
        execute: async ({ device, ...args }, api, context) =>
          edit.execute(args, { ...api, env: await envFor(device, api, context) }, context),
      }),
    ],
    /** The device a completed call ran on, so its spilled output is read on the machine that produced it. */
    callEnv(call, target, context) {
      const { device } = call.arguments;
      return environment(typeof device === 'string' ? device : undefined, target.read, target.conversationId, context);
    },
    env: (target, context) => environment(undefined, target.read, target.conversationId, context),
    /** The device list at the start of each message; it changes, so it stays out of the cached prompt. */
    async turnState() {
      const devices = await list();
      return ['Devices:', ...devices.map((device, index) =>
        `${JSON.stringify(device.name)}${index === 0 ? ' (holds this chat, the default)' : ''}: ${device.description}`)]
        .join('\n');
    },
  };
}
