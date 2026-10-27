import { webSocketLink, type Link } from '@earendil-works/chord';
import type { SshLocalForward } from '@osuki-dev/react-native-ssh';
import type { Machine } from '@pi-agent/infinichat/pi/infinichat-remote/contract';
import type { MachineDirectory, ServerDialer } from '@pi-agent/infinichat/pi/infinichat-remote/dialer';
import { machineDescription } from '@pi-agent/infinichat/pi/infinichat/device-tools';

import { connectionFailure } from '../execution/remote/channel';
import type { RemoteHostRepository } from '../execution/remote/hosts';
import { connectAdmitted, installServer, runningServer, savedSecret, SERVER_BUNDLE } from './install';

type Target = { port: number; secret: string };

/**
 * React Native's own declaration of its WebSocket constructor, restated from
 * `react-native/src/types/globals.d.ts:569-578`: request headers are the third argument
 * (`Libraries/WebSocket/WebSocket.js:100`). Expo's tsconfig loads the DOM lib first, whose constructor declares two,
 * and a constructor of fewer parameters is assignable to this type as it is.
 */
type HeaderWebSocket = new (url: string, protocols: undefined, options: { headers: Record<string, string> }) =>
  WebSocket;
const NativeWebSocket: HeaderWebSocket = WebSocket;

/**
 * How this phone reaches a configured machine's InfiniChat server: one SSH connection with the machine's admission,
 * and a WebSocket tunnelled over it to the server's loopback port (`server/listen.ts`), carrying this phone's secret.
 * It installs or updates the server when this phone has no secret for the machine, and when `server.json` names no
 * live server of this bundle. It borrows the machine record and the phone's secret, and closes only the connections
 * it opened, which are its own: the tools' daemon connections in owner.ts are not used while the machine runs
 * InfiniChat.
 */
export function phoneDialer(hosts: RemoteHostRepository, machineId: string): ServerDialer {
  return {
    async dial({ signal, onStage, onInstalled, onDropped }) {
      // As owner.ts checks a chat's machine, with InfiniChat's own way out.
      await hosts.restore();
      if (!hosts.get(machineId)) {
        throw new Error('This machine was removed from Remote machines while InfiniChat’s conversation is on it.');
      }
      const secret = await savedSecret(machineId);
      const admission = await hosts.admit(machineId);
      const name = admission.host.name;
      const connection = await connectAdmitted(admission, { signal, onDisconnected: onDropped });
      let forward: SshLocalForward | undefined;
      let link: Link | undefined;
      const install = async (): Promise<Target> => {
        const server = await installServer(hosts, machineId, { signal, onProgress: onStage });
        onInstalled(server.notice);
        return server;
      };
      // Tunnels to the server's port and opens a new socket over it, closing the previous ones first.
      const open = async (target: Target): Promise<Link> => {
        link?.close();
        await forward?.close().catch(() => {});
        forward = await connection.forwardLocal({ remoteHost: '127.0.0.1', remotePort: target.port },
          { onClosed: (reason) => { if (reason !== undefined) onDropped(); } })
          .catch((error: unknown) => {
            throw connectionFailure(error);
          });
        const socket = new NativeWebSocket(`ws://127.0.0.1:${forward.localPort}`, undefined,
          { headers: { authorization: `Bearer ${target.secret}` } });
        // The client side of a link never deflates, which Hermes could not inflate anyway.
        link = webSocketLink(socket);
        return link;
      };
      const close = async () => {
        link?.close();
        await forward?.close().catch(() => {});
        await connection.disconnect().catch(() => {});
      };
      try {
        const port = secret === undefined ? undefined : await runningServer(connection, name, signal);
        const target = secret !== undefined && port !== undefined ? { port, secret } : await install();
        return {
          link: await open(target),
          expected: { bundle: SERVER_BUNDLE, device: name, description: machineDescription(admission.host) },
          reinstall: async () => open(await install()),
          close,
        };
      } catch (error) {
        await close();
        throw error;
      }
    },
  };
}

/**
 * The machine as Remote machines lists it, and the other configured machines, each with the host key this phone
 * pinned for it, never their credentials.
 */
export function phoneMachines(hosts: RemoteHostRepository, machineId: string): MachineDirectory {
  return {
    id: machineId,
    name: () => hosts.get(machineId)?.name,
    others: async () => {
      const others = hosts.getSnapshot().hosts.filter((host) => host.id !== machineId);
      const machines = await Promise.all(others.map(async (host): Promise<Machine[]> => {
        const { id, name, hostname, port, username } = host;
        // A pin that can't be read is left out, so that machine's key waits for this phone; one removed meanwhile
        // is left out entirely.
        const pinned = await hosts.admit(id).then(({ trustedHostKey }) => trustedHostKey, () => null);
        if (pinned === null && hosts.get(id) === undefined) return [];
        return [{ id, name, hostname, port, username,
          ...(pinned ? { hostKey: { algorithm: pinned.algorithm, fingerprint: pinned.fingerprint } } : {}) }];
      }));
      return machines.flat();
    },
    subscribe: hosts.subscribe,
  };
}
