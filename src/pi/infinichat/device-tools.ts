import type { Context } from '@earendil-works/chord';
import { Type } from '@earendil-works/pi-ai';
import {
  AgentDoc, ROOT_CONVERSATION_ID, defineTool, type ConversationId, type DocumentReader, type ToolRegistration,
} from '@earendil-works/pi-durable';
import { getOrThrow, type ExecutionEnv } from '@earendil-works/pi-durable/env';
import {
  createBashTool, createEditTool, createReadTool, createWriteTool, type ImageProcessor,
} from '@earendil-works/pi-durable/tools';

import type { OptChatOptions } from './app';

/**
 * UniiChat's work dirs: a device's tools run in <work>/<who>, `main` for the main agent and its name for a subagent.
 * A machine's work dir is a folder of its own in the account's home, as UniiChat's `~/.unii/work`.
 */
export const MACHINE_WORK = '.infinichat/work';

/** One device InfiniChat's tools run on, as the devices list at the start of each message names it. */
export type Device = {
  name: string;
  description: string;
  /** The device's environment in <work>/<who>. */
  environment(who: string, read: DocumentReader, context: Context): Promise<ExecutionEnv>;
};

/** What InfiniChat's tools need from the host it runs on. */
export type InfiniChatDevices = Required<Pick<OptChatOptions, 'tools' | 'callEnv' | 'turnState'>>;

const deviceParameter = Type.String({ description: 'The device to run on, from the list at the start of the message' });

/**
 * What a device tool keeps of the built-in registration; its schema gains `device` and `execute` injects that env.
 * Its description says where it runs, as UniiChat's does.
 */
const kept = ({ name, description, replay, outputLimits, structuredOutputSchema, callers }: ToolRegistration) => ({
  name,
  description: `${description} It runs on the device named, in <work>/<who>, <work> being the work dir the devices `
    + 'list gives for it and <who> main for the main agent, or a subagent\'s own name.',
  replay,
  outputLimits,
  structuredOutputSchema,
  callers,
});

/** The device a call's raw arguments name, for argument repair; an absent one fails as an unknown device. */
const deviceArgument = (args: unknown): string =>
  typeof args === 'object' && args !== null && 'device' in args && typeof args.device === 'string' ? args.device : '';

/**
 * The devices `list` returns, read at each use since they change, as InfiniChat's tools use them: pi-durable's bash,
 * read, write and edit with a required `device`, each calling the built-in's `execute` with that device's environment
 * in place of the conversation's, as the Harness injects `env` into every call. Each use builds a fresh environment,
 * as the chat service's resolver does.
 */
export function infiniChatDevices(list: () => Promise<readonly Device[]>, images: ImageProcessor): InfiniChatDevices {
  /** The device's environment in the calling conversation's folder, created as UniiChat creates one. */
  async function environment(
    name: string, read: DocumentReader, conversationId: ConversationId, context: Context,
  ): Promise<ExecutionEnv> {
    const devices = await list();
    // The host keeps device names unique, so a name is one device.
    const device = devices.find((candidate) => candidate.name === name);
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
  const envFor = (device: string, api: DocumentReader & { conversationId: ConversationId }, context: Context) =>
    environment(device, api, api.conversationId, context);
  return {
    tools: [
      defineTool({
        ...kept(bash),
        parameters: Type.Object({ device: deviceParameter, ...bash.parameters.properties }),
        execute: async ({ device, ...args }, api, context) =>
          bash.execute(args, { ...api, env: await envFor(device, api, context) }, context),
      }),
      defineTool({
        ...kept(read),
        parameters: Type.Object({ device: deviceParameter, ...read.parameters.properties }),
        execute: async ({ device, ...args }, api, context) =>
          read.execute(args, { ...api, env: await envFor(device, api, context) }, context),
      }),
      defineTool({
        ...kept(write),
        parameters: Type.Object({ device: deviceParameter, ...write.parameters.properties }),
        execute: async ({ device, ...args }, api, context) =>
          write.execute(args, { ...api, env: await envFor(device, api, context) }, context),
      }),
      defineTool({
        ...kept(edit),
        parameters: Type.Object({ device: deviceParameter, ...edit.parameters.properties }),
        prepareArguments: prepareEdit && ((args) => ({ ...prepareEdit(args), device: deviceArgument(args) })),
        execute: async ({ device, ...args }, api, context) =>
          edit.execute(args, { ...api, env: await envFor(device, api, context) }, context),
      }),
    ],
    /** The device a completed call named, so its spilled output is read on the machine that produced it. */
    callEnv(call, target, context) {
      const { device } = call.arguments;
      if (typeof device !== 'string') throw new Error(`The ${call.name} call names no device.`);
      return environment(device, target.read, target.conversationId, context);
    },
    /** The device list at the start of each message; it changes, so it stays out of the cached prompt. */
    async turnState() {
      const devices = await list();
      return ['Devices:', ...devices.map((device) => `${JSON.stringify(device.name)}: ${device.description}`)]
        .join('\n');
    },
  };
}
