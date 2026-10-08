import { BACKGROUND_CONTEXT } from '@earendil-works/chord/context';
import { defineExtension, section } from '@earendil-works/pi-durable';

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
 * Holds the app's SSH connections. Tools, prompt sections and tasks borrow its environments; the chat service closes
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
      // First admission can include detection and a bounded daemon upload.
      const connection = new Connection({ startTimeoutMs: 420_000, openChannel: async (options) => {
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

/** What a remote environment tells the model about itself; renders only when the chat runs on a remote machine. */
export const RemoteExecutionExtension = defineExtension({
  name: 'remote-execution',
  sections: [section('remote_machine', ({ env }) => env instanceof MobileRemoteExecutionEnv ? [
    'The read, write, edit and bash tools execute on the selected remote machine through SSH over Tailscale. ' +
      'Files and installed programs belong to that machine; its working directory is not a filesystem sandbox.',
    'Each bash invocation starts a separate command, so shell variables do not persist between tools. ' +
      'Ordinary remote files persist and may be shared with other chats. Environment-created temporary files are ' +
      'cleaned up when the chat service closes while connected; files a shell creates in /tmp follow the host’s ' +
      'ordinary lifetime.',
    'Switching environments does not copy files. Forked conversations see the remote machine’s current files, ' +
      'not a historical filesystem snapshot.',
    'Output previews are bounded. This remote environment does not save complete output artifacts. ' +
      'Connection loss or interruption can leave mutations applied; inspect the remote state before retrying.',
    'Execution requires the phone’s active Tailscale VPN, working tailnet DNS, and a reachable SSH server. ' +
      'Background execution is not guaranteed.',
  ].join('\n') : undefined)],
});
