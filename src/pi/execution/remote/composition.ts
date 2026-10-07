import { BACKGROUND_CONTEXT } from '@earendil-works/chord/context';
import type { ExecutionComposition } from '../composition';
import { ExecutionTargetDoc } from '../document';
import { createSshChannelFactory, type DaemonChannelFactory } from './channel';
import { Connection } from './connection';
import { MobileRemoteExecutionEnv } from './environment';
import { matchesHostKey, type RemoteHostAdmission, type RemoteHostRepository } from './hosts';

/** Native SSH is the production transport; tests can run the same client against a real daemon pipe. */
export function admittedSshChannel(admission: RemoteHostAdmission): DaemonChannelFactory {
  const { host, auth, trustedHostKey } = admission;
  if (!trustedHostKey) throw new Error('Test this machine in Remote machines and verify its SSH host key before running tools.');
  return createSshChannelFactory({ host: host.hostname, port: host.port, username: host.username,
    auth, hostKeyAlgorithms: [trustedHostKey.algorithm],
    verifyHostKey: (observed) => matchesHostKey(trustedHostKey, observed) });
}

/** Service-owned environments are borrowed by tools, prompt sections and tasks. SSH opens lazily. */
export function createRemoteExecution(local: ExecutionComposition, hosts: RemoteHostRepository,
  channel: (admission: RemoteHostAdmission) => DaemonChannelFactory = admittedSshChannel): ExecutionComposition {
  const environments = new Map<string, MobileRemoteExecutionEnv>();
  let stopped = false;
  let closing: Promise<void> | undefined;
  const assertOpen = () => { if (stopped) throw new Error('Execution admission is stopped. Return to the app to continue.'); };
  return {
    extensions: local.extensions,
    conversationCreated: local.conversationCreated,
    async resolve(target, context) {
      assertOpen();
      const selection = (await target.read.snapshot(ExecutionTargetDoc, target.conversationId, context))?.target;
      if (!selection || selection.kind === 'local') return local.resolve(target, context);
      if (!target.cwd?.startsWith('/') || target.cwd.includes('\0')) {
        throw new Error('Choose a working directory in this chat’s settings before remote execution.');
      }
      await hosts.restore();
      context.abortSignal?.throwIfAborted();
      assertOpen();
      const host = hosts.get(selection.machineId);
      if (!host) throw new Error('This remote machine was removed. Choose another execution environment in chat settings.');
      // Reuse actual connection settings, excluding display metadata. Previously
      // admitted environments keep their captured settings until owner shutdown.
      const key = JSON.stringify([host.id, host.namespaceId, host.hostname, host.port, host.username, host.credentialRef, target.cwd]);
      const existing = environments.get(key);
      if (existing) return existing;
      // Metadata is captured now; secrets only at admission. A concurrent settings
      // edit fails admission instead of silently redirecting this resolved facade.
      let factory: Promise<DaemonChannelFactory> | undefined;
      // First admission can include detection and a bounded daemon upload.
      const connection = new Connection({ startTimeoutMs: 420_000, openChannel: async (options) => {
        assertOpen();
        options.signal.throwIfAborted();
        factory ??= hosts.admit(host.id, host).then(channel).catch((cause) => {
          // Failed admission owns no usable configuration. A later operation can
          // retry (for example after the device's credential store is unlocked).
          factory = undefined;
          throw cause;
        });
        const open = await factory;
        assertOpen();
        options.signal.throwIfAborted();
        return open(options);
      } });
      const env = new MobileRemoteExecutionEnv({ connection,
        id: `ssh:${host.namespaceId}`,
        cwd: target.cwd,
      });
      environments.set(key, env);
      return env;
    },
    toolPolicy: {
      ...local.toolPolicy,
      promptFacts(input, context) {
        if (!(input.env instanceof MobileRemoteExecutionEnv)) return local.toolPolicy.promptFacts(input, context);
        return [
          'The read, write, edit and bash tools execute on the selected remote machine through SSH over Tailscale. Files and installed programs belong to that machine; its working directory is not a filesystem sandbox.',
          'Each bash invocation starts a separate command, so shell variables do not persist between tools. Ordinary remote files persist and may be shared with other chats. Environment-created temporary files are cleaned up when the chat service closes while connected; files a shell creates in /tmp follow the host’s ordinary lifetime.',
          'Switching environments does not copy files. Forked conversations see the remote machine’s current files, not a historical filesystem snapshot.',
          'Output previews are bounded. This remote environment does not save complete output artifacts. Connection loss or interruption can leave mutations applied; inspect the remote state before retrying.',
          'Execution requires the phone’s active Tailscale VPN, working tailnet DNS, and a reachable SSH server. Background execution is not guaranteed.',
        ];
      },
    },
    stop() { stopped = true; local.stop(); for (const env of environments.values()) env.stop(); },
    close() {
      stopped = true;
      local.stop();
      for (const env of environments.values()) env.stop();
      return closing ??= (async () => {
        // Await every owner even if one fails; shutdown must not leave siblings
        // using storage or transport after the service has finished closing.
        const results = await Promise.allSettled([local.close(),
          ...[...environments.values()].map((env) => env.cleanup(BACKGROUND_CONTEXT))]);
        environments.clear();
        const failed = results.find((result) => result.status === 'rejected');
        if (failed?.status === 'rejected') throw failed.reason;
      })();
    },
  };
}
