import { BACKGROUND_CONTEXT } from '@earendil-works/chord/context';

import { createSshChannelFactory, type DaemonChannelFactory } from './channel';
import { Connection } from './connection';
import { MobileRemoteExecutionEnv } from './environment';
import { matchesHostKey, type RemoteHostAdmission, type RemoteHostRepository } from './hosts';

function admittedSshChannel(admission: RemoteHostAdmission): DaemonChannelFactory {
  const { host, auth, trustedHostKey } = admission;
  if (!trustedHostKey) {
    throw new Error('Test this machine in Remote machines and verify its SSH host key before running tools.');
  }
  return createSshChannelFactory({ host: host.hostname, port: host.port, username: host.username,
    auth, hostKeyAlgorithms: [trustedHostKey.algorithm],
    verifyHostKey: (observed) => matchesHostKey(trustedHostKey, observed) });
}

export type RemoteExecution = ReturnType<typeof createRemoteExecution>;

/**
 * Holds the app's SSH connections. Tools and tasks borrow its environments; the chat service closes
 * it with the Harness. SSH opens lazily, and a closed owner can hand out environments again for a reopened service.
 */
export function createRemoteExecution(hosts: RemoteHostRepository) {
  const environments = new Map<string, MobileRemoteExecutionEnv>();
  return {
    async environment(machineId: string, cwd: string | undefined): Promise<MobileRemoteExecutionEnv> {
      if (!cwd?.startsWith('/') || cwd.includes('\0')) {
        throw new Error('Choose a working directory in this chat’s settings before remote execution.');
      }
      await hosts.restore();
      const host = hosts.get(machineId);
      if (!host) {
        throw new Error('This remote machine was removed. Choose another execution environment in chat settings.');
      }
      // Reuse actual connection settings, excluding display metadata. Previously
      // admitted environments keep their captured settings until owner shutdown.
      const key = JSON.stringify([host.id, host.namespaceId, host.hostname, host.port, host.username,
        host.credentialRef, cwd]);
      const existing = environments.get(key);
      if (existing) return existing;
      // Metadata is captured now; secrets only at admission. A concurrent settings
      // edit fails admission instead of silently redirecting this resolved facade.
      let factory: Promise<DaemonChannelFactory> | undefined;
      const connection = new Connection({ openChannel: async (options) => {
        options.signal.throwIfAborted();
        factory ??= hosts.admit(host.id, host).then(admittedSshChannel).catch((cause) => {
          // Failed admission owns no usable configuration. A later operation can
          // retry (for example after the device's credential store is unlocked).
          factory = undefined;
          throw cause;
        });
        const open = await factory;
        options.signal.throwIfAborted();
        return open(options);
      } });
      const env = new MobileRemoteExecutionEnv({ connection, id: `ssh:${host.namespaceId}`, cwd });
      environments.set(key, env);
      return env;
    },
    async close(): Promise<void> {
      const open = [...environments.values()];
      environments.clear();
      for (const env of open) env.stop();
      // Await every environment even if one fails, so none still uses its transport after close resolves.
      const results = await Promise.allSettled(open.map((env) => env.cleanup(BACKGROUND_CONTEXT)));
      const failed = results.find((result) => result.status === 'rejected');
      if (failed?.status === 'rejected') throw failed.reason;
    },
  };
}
