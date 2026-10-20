import type { Context } from '@earendil-works/chord';
import { Type } from '@earendil-works/pi-ai';
import {
  AgentDoc, ROOT_CONVERSATION_ID, defineTool, type ConversationId, type DocumentReader, type ToolHookCall,
  type ToolRegistration,
} from '@earendil-works/pi-durable';
import { getOrThrow, type ExecutionEnv } from '@earendil-works/pi-durable/env';
import {
  createBashTool, createEditTool, createReadTool, createWriteTool,
} from '@earendil-works/pi-durable/tools';

import { PHONE_DEVICE, type RemoteHostRepository } from '../execution/remote/hosts';
import type { RemoteExecution } from '../execution/remote/owner';
import { createExpoImages } from '../images';
import { WorkspaceDoc } from '../workspace/document';
import { WorkspaceExecutionEnv } from '../workspace/execution-env';
import type { Workspaces } from '../workspace/storage';

export type Devices = ReturnType<typeof createDevices>;

/**
 * UniiChat's work dirs: a device's tools run in <work>/<who>, `main` for the main agent and its name for a subagent.
 * The phone's work dir is its workspace; a machine's, a folder of its own in the account's home, as UniiChat's
 * `~/.unii/work`.
 */
const PHONE_WORK = '/workspace';
const MACHINE_WORK = '.infinichat/work';

/**
 * The devices InfiniChat's tools run on: the phone's workspace and the configured remote machines, resolved to the
 * environments the chats use. Each use builds a fresh environment, as the chat service's resolver does.
 */
export function createDevices(workspaces: Workspaces, remote: RemoteExecution, hosts: RemoteHostRepository) {
  async function list() {
    await hosts.restore();
    return [
      {
        name: PHONE_DEVICE,
        description: `this phone, a sandboxed workspace at /workspace, work dir ${PHONE_WORK}`,
        machineId: undefined,
      },
      ...hosts.getSnapshot().hosts.map((host) => ({
        name: host.name,
        description: `${host.username}@${host.hostname} over SSH, work dir ~/${MACHINE_WORK}`,
        machineId: host.id,
      })),
    ];
  }
  /** The device's environment in the calling conversation's folder, created as UniiChat creates one. */
  async function environment(
    name: string, read: DocumentReader, conversationId: ConversationId, context: Context,
  ): Promise<ExecutionEnv> {
    const devices = await list();
    // The repository keeps machine names unique and never the phone's, so a name is one device.
    const device = devices.find((candidate) => candidate.name === name);
    if (!device) {
      const names = devices.map((candidate) => JSON.stringify(candidate.name)).join(', ');
      throw new Error(`Unknown device ${JSON.stringify(name)}. The devices are ${names}.`);
    }
    // A subagent's conversation names its folder as its working directory; the main agent's has none.
    const who = conversationId === ROOT_CONVERSATION_ID
      ? 'main'
      : (await read.snapshot(AgentDoc, conversationId, context))?.cwd ?? 'main';
    let env: ExecutionEnv;
    if (device.machineId !== undefined) {
      const home = (await remote.environment(device.machineId, undefined)).cwd;
      env = await remote.environment(device.machineId, `${home}/${MACHINE_WORK}/${who}`);
    } else {
      // Agents run in their own conversations, but the phone's workspace belongs to the root conversation.
      const workspace = await read.snapshot(WorkspaceDoc, ROOT_CONVERSATION_ID, context);
      if (!workspace?.id) throw new Error('InfiniChat has no committed workspace identity.');
      env = new WorkspaceExecutionEnv(workspaces.workspace(workspace.id), workspace.id, `${PHONE_WORK}/${who}`);
    }
    getOrThrow(await env.createDir(env.cwd, { recursive: true }, context));
    return env;
  }
  return {
    environment,
    /** The device a completed call named, so its spilled output is read on the machine that produced it. */
    callEnvironment(
      call: ToolHookCall, read: DocumentReader, conversationId: ConversationId, context: Context,
    ): Promise<ExecutionEnv> {
      const { device } = call.arguments;
      if (typeof device !== 'string') throw new Error(`The ${call.name} call names no device.`);
      return environment(device, read, conversationId, context);
    },
    /** The device list at the start of each message; it changes, so it stays out of the cached prompt. */
    async turnState(): Promise<string> {
      const devices = await list();
      return ['Devices:', ...devices.map((device) => `${JSON.stringify(device.name)}: ${device.description}`)]
        .join('\n');
    },
  };
}

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
 * pi-durable's bash, read, write and edit with a required `device`. Each calls the built-in's `execute` with that
 * device's environment in place of the conversation's, as the Harness injects `env` into every call.
 */
export function deviceTools(devices: Devices) {
  const bash = createBashTool();
  const read = createReadTool({ images: createExpoImages() });
  const write = createWriteTool();
  const edit = createEditTool();
  const prepareEdit = edit.prepareArguments;
  const envFor = (device: string, api: DocumentReader & { conversationId: ConversationId }, context: Context) =>
    devices.environment(device, api, api.conversationId, context);
  return [
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
  ];
}
