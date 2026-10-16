import type { Context } from '@earendil-works/chord';
import { Type } from '@earendil-works/pi-ai';
import {
  ROOT_CONVERSATION_ID, defineTool, type DocumentReader, type ToolHookCall, type ToolRegistration,
} from '@earendil-works/pi-durable';
import type { ExecutionEnv } from '@earendil-works/pi-durable/env';
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
 * The devices InfiniChat's tools run on: the phone's workspace and the configured remote machines, resolved to the
 * environments the chats use. Each use builds a fresh environment, as the chat service's resolver does.
 */
export function createDevices(workspaces: Workspaces, remote: RemoteExecution, hosts: RemoteHostRepository) {
  async function list() {
    await hosts.restore();
    return [
      { name: PHONE_DEVICE, description: 'this phone, a sandboxed workspace at /workspace', machineId: undefined },
      ...hosts.getSnapshot().hosts.map((host) => ({
        name: host.name, description: `${host.username}@${host.hostname} over SSH`, machineId: host.id,
      })),
    ];
  }
  async function environment(name: string, read: DocumentReader, context: Context): Promise<ExecutionEnv> {
    const devices = await list();
    // The repository keeps machine names unique and never the phone's, so a name is one device.
    const device = devices.find((candidate) => candidate.name === name);
    if (!device) {
      const names = devices.map((candidate) => JSON.stringify(candidate.name)).join(', ');
      throw new Error(`Unknown device ${JSON.stringify(name)}. The devices are ${names}.`);
    }
    // Each remote machine runs in its account's home directory, the phone in its workspace.
    if (device.machineId !== undefined) return remote.environment(device.machineId, undefined);
    // Agents run in their own conversations, but the phone's workspace belongs to the root conversation.
    const workspace = await read.snapshot(WorkspaceDoc, ROOT_CONVERSATION_ID, context);
    if (!workspace?.id) throw new Error('InfiniChat has no committed workspace identity.');
    return new WorkspaceExecutionEnv(workspaces.workspace(workspace.id), workspace.id);
  }
  return {
    environment,
    /** The device a completed call named, so its spilled output is read on the machine that produced it. */
    callEnvironment(call: ToolHookCall, read: DocumentReader, context: Context): Promise<ExecutionEnv> {
      const { device } = call.arguments;
      if (typeof device !== 'string') throw new Error(`The ${call.name} call names no device.`);
      return environment(device, read, context);
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

/** What a device tool keeps of the built-in registration; its schema gains `device` and `execute` injects that env. */
const kept = ({ name, description, replay, outputLimits, structuredOutputSchema, callers }: ToolRegistration) =>
  ({ name, description, replay, outputLimits, structuredOutputSchema, callers });

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
  return [
    defineTool({
      ...kept(bash),
      parameters: Type.Object({ device: deviceParameter, ...bash.parameters.properties }),
      execute: async ({ device, ...args }, api, context) =>
        bash.execute(args, { ...api, env: await devices.environment(device, api, context) }, context),
    }),
    defineTool({
      ...kept(read),
      parameters: Type.Object({ device: deviceParameter, ...read.parameters.properties }),
      execute: async ({ device, ...args }, api, context) =>
        read.execute(args, { ...api, env: await devices.environment(device, api, context) }, context),
    }),
    defineTool({
      ...kept(write),
      parameters: Type.Object({ device: deviceParameter, ...write.parameters.properties }),
      execute: async ({ device, ...args }, api, context) =>
        write.execute(args, { ...api, env: await devices.environment(device, api, context) }, context),
    }),
    defineTool({
      ...kept(edit),
      parameters: Type.Object({ device: deviceParameter, ...edit.parameters.properties }),
      prepareArguments: prepareEdit && ((args) => ({ ...prepareEdit(args), device: deviceArgument(args) })),
      execute: async ({ device, ...args }, api, context) =>
        edit.execute(args, { ...api, env: await devices.environment(device, api, context) }, context),
    }),
  ];
}
