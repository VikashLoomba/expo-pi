import { ROOT_CONVERSATION_ID } from '@earendil-works/pi-durable';
import { MACHINE_WORK, machineDescription, type Device } from '@pi-agent/infinichat/pi/infinichat/device-tools';
import { WorkspaceDoc } from '@pi-agent/infinichat/pi/workspace/document';

import type { MachinesState } from '@pi-agent/infinichat/pi/infinichat-remote/machines';

import { PHONE_DEVICE } from './execution/remote/hosts';
import type { RemoteExecution } from './execution/remote/owner';
import { WorkspaceExecutionEnv } from './workspace/execution-env';
import type { Workspaces } from './workspace/storage';

/** The phone's work dir is its workspace. */
const PHONE_WORK = '/workspace';

/**
 * The devices InfiniChat's tools run on from the phone: its workspace and the conversation's machines, resolved to
 * the environments the chats use, over this phone's credentials for each.
 */
export function createDevices(workspaces: Workspaces, remote: RemoteExecution,
  machines: () => MachinesState | undefined) {
  return async (): Promise<Device[]> => {
    return [
      {
        name: PHONE_DEVICE,
        description: `this phone, a sandboxed workspace at /workspace, work dir ${PHONE_WORK}`,
        async environment(who, read, context) {
          // Agents run in their own conversations, but the phone's workspace belongs to the root conversation.
          const workspace = await read.snapshot(WorkspaceDoc, ROOT_CONVERSATION_ID, context);
          if (!workspace?.id) throw new Error('InfiniChat has no committed workspace identity.');
          return new WorkspaceExecutionEnv(workspaces.workspace(workspace.id), workspace.id, `${PHONE_WORK}/${who}`);
        },
      },
      // The document keeps machine names unique, and the phone's test never gives one the phone's.
      ...Object.entries(machines()?.machines ?? {}).map(([endpoint, machine]): Device => ({
        name: machine.name,
        description: machineDescription(machine),
        async environment(who) {
          const home = (await remote.environment(endpoint, undefined)).cwd;
          return remote.environment(endpoint, `${home}/${MACHINE_WORK}/${who}`);
        },
      })),
    ];
  };
}
