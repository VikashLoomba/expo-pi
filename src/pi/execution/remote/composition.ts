import { createSshChannelFactory, type DaemonChannelFactory } from './channel';
import { Connection } from './connection';
import { MobileRemoteExecutionEnv } from './environment';
import { matchesHostKey, type RemoteHostAdmission, type RemoteHostRepository } from './hosts';
import type { RemotePlatformState } from './provisioning';

function admittedSshChannel(admission: RemoteHostAdmission, platform: RemotePlatformState): DaemonChannelFactory {
  const { host, auth, trustedHostKey } = admission;
  if (!trustedHostKey) {
    throw new Error('Test this machine in Remote machines and verify its SSH host key before running tools.');
  }
  return createSshChannelFactory({ host: host.hostname, port: host.port, username: host.username,
    auth, platform, hostKeyAlgorithms: [trustedHostKey.algorithm],
    verifyHostKey: (observed) => matchesHostKey(trustedHostKey, observed) });
}

export type RemoteExecution = ReturnType<typeof createRemoteExecution>;

/**
 * Holds one SSH connection per machine, shared by the environments built on it at each use, as in pi-env's README.
 * The chat service closes it with the Harness; a resolve after that opens a new connection.
 */
export function createRemoteExecution(hosts: RemoteHostRepository) {
  const connections = new Map<string, Connection>();
  return {
    async environment(machineId: string, cwd: string | undefined): Promise<MobileRemoteExecutionEnv> {
      await hosts.restore();
      const host = hosts.get(machineId);
      if (!host) {
        throw new Error('This remote machine was removed. Choose another execution environment in chat settings.');
      }
      let connection = connections.get(machineId);
      if (!connection) {
        const platform: RemotePlatformState = {};
        // Like pi-env's `command`, each start reads the machine's current credentials and trusted key.
        connection = new Connection({
          openChannel: async (options) => admittedSshChannel(await hosts.admit(machineId), platform)(options),
        });
        connections.set(machineId, connection);
      }
      // A chat without a working directory uses the account's home, as pi-env's external SSH test does.
      return new MobileRemoteExecutionEnv({ connection, id: `ssh:${host.namespaceId}`,
        cwd: cwd ?? (await connection.info()).home });
    },
    async close(): Promise<void> {
      const open = [...connections.values()];
      connections.clear();
      await Promise.all(open.map((connection) => connection.close()));
    },
  };
}
