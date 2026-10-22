import { ROOT_CONVERSATION_ID } from '@earendil-works/pi-durable';

import { PHONE_DEVICE, type RemoteHostRepository } from '../execution/remote/hosts';
import type { RemoteExecution } from '../execution/remote/owner';
import { WorkspaceDoc } from '../workspace/document';
import { WorkspaceExecutionEnv } from '../workspace/execution-env';
import type { Workspaces } from '../workspace/storage';
import { MACHINE_WORK, type Device } from './device-tools';

/** The phone's work dir is its workspace. */
const PHONE_WORK = '/workspace';

/**
 * The devices InfiniChat's tools run on from the phone: its workspace and the configured remote machines, resolved to
 * the environments the chats use.
 */
export function createDevices(workspaces: Workspaces, remote: RemoteExecution, hosts: RemoteHostRepository) {
  return async (): Promise<Device[]> => {
    await hosts.restore();
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
      // The repository keeps machine names unique and never the phone's.
      ...hosts.getSnapshot().hosts.map((host): Device => ({
        name: host.name,
        description: `${host.username}@${host.hostname} over SSH, work dir ~/${MACHINE_WORK}`,
        async environment(who) {
          const home = (await remote.environment(host.id, undefined)).cwd;
          return remote.environment(host.id, `${home}/${MACHINE_WORK}/${who}`);
        },
      })),
    ];
  };
}
