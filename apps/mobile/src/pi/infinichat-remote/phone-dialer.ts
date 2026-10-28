import { webSocketLink, type Link } from '@earendil-works/chord';
import { awaitWithContext, BACKGROUND_CONTEXT, withAbortSignal } from '@earendil-works/chord/context';
import { connect, type SshConnection, type SshLocalForward } from '@osuki-dev/react-native-ssh';
import { machineEndpoint, type Machine } from '@pi-agent/infinichat/pi/infinichat-remote/contract';
import type { MachineDirectory, ServerDialer } from '@pi-agent/infinichat/pi/infinichat-remote/dialer';
import {
  installServer, machineIdentity, machineSecret, runningServer, savedSecret,
} from '@pi-agent/infinichat/pi/infinichat-remote/install';
import { machineDescription } from '@pi-agent/infinichat/pi/infinichat/device-tools';
import { getRandomBytesAsync } from 'expo-crypto';

import { connectionFailure } from '../execution/remote/channel';
import { hostKeyPolicy, type RemoteHostAdmission, type RemoteHostRepository } from '../execution/remote/hosts';
import type { RemoteExecution } from '../execution/remote/owner';
import { createCredentialBackend } from '../secure-storage';
import { phoneClient } from './phone-client';
import { phoneServerAssets, SERVER_BUNDLE } from './server-assets';

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
 * An SSH connection with the machine's admission: its credentials, and its host key under the same policy as
 * owner.ts's daemon channels. The caller owns the connection and disconnects it.
 */
function connectAdmitted(hosts: RemoteHostRepository, admission: RemoteHostAdmission, options: {
  signal: AbortSignal;
  onDisconnected?: () => void;
}): Promise<SshConnection> {
  const { host, auth } = admission;
  return connect({
    host: host.hostname, port: host.port, username: host.username, auth, signal: options.signal,
    ...hostKeyPolicy(hosts, admission), onDisconnected: options.onDisconnected,
  }).catch((error: unknown) => {
    throw connectionFailure(error);
  });
}

/**
 * How this phone reaches a configured machine's InfiniChat server: one SSH connection with the machine's admission,
 * and a WebSocket tunnelled over it to the server's loopback port (`server/listen.ts`), carrying this phone's secret.
 * It installs or updates the server, writing the secret as this phone's client file there, when this phone has no
 * secret for the machine, and when `server.json` names no live server of this bundle. That check and the install go
 * through the environment owner.ts keeps for the machine: one daemon connection, shared with the chats' tools, which
 * the provider closes. It borrows that, the machine record and the phone's secret, and closes only the SSH connection
 * and tunnel it opened.
 */
export function phoneDialer(hosts: RemoteHostRepository, remote: RemoteExecution, machineId: string): ServerDialer {
  return {
    async dial({ signal, onStage, onInstalled, onDropped }) {
      // As owner.ts checks a chat's machine, with InfiniChat's own way out.
      await hosts.restore();
      if (!hosts.get(machineId)) {
        throw new Error('This machine was removed from Remote machines while InfiniChat’s conversation is on it.');
      }
      const credentials = createCredentialBackend();
      const secret = await savedSecret(credentials, machineId);
      const admission = await hosts.admit(machineId);
      const { host } = admission;
      const connection = await connectAdmitted(hosts, admission, { signal, onDisconnected: onDropped });
      // A dial that is cancelled stops waiting for it; the owner keeps the connection it opens.
      const machine = () => awaitWithContext(remote.environment(machineId, undefined),
        withAbortSignal(signal, BACKGROUND_CONTEXT));
      // The server's device name and description are the machine's own, as every client reads them.
      const identity = await machineIdentity(await machine(), host.name, signal);
      const name = (await hosts.setName(host, identity.name)).name;
      const description = machineDescription({ username: host.username, hostname: identity.hostname });
      let forward: SshLocalForward | undefined;
      let link: Link | undefined;
      const install = async (): Promise<Target> => {
        const installing = await machineSecret(credentials, getRandomBytesAsync, machineId);
        const server = await installServer({ machine: await machine(), name, description, username: host.username },
          phoneServerAssets, phoneClient().id, installing, { signal, onProgress: onStage });
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
        const port = secret === undefined ? undefined
          : await runningServer(await machine(), name, SERVER_BUNDLE, signal);
        const target = secret !== undefined && port !== undefined ? { port, secret } : await install();
        return {
          link: await open(target),
          expected: { bundle: SERVER_BUNDLE, device: name, description },
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
 * pinned for it and the InfiniChat keys it authorized there, never their credentials.
 */
export function phoneMachines(hosts: RemoteHostRepository, machineId: string): MachineDirectory {
  return {
    id: machineId,
    name: () => hosts.get(machineId)?.name,
    endpoint: () => {
      const host = hosts.get(machineId);
      return host && machineEndpoint(host);
    },
    publicKey: () => hosts.get(machineId)?.publicKey,
    others: async () => {
      const others = hosts.getSnapshot().hosts.filter((host) => host.id !== machineId);
      const machines = await Promise.all(others.map(async (host): Promise<Machine[]> => {
        const { id, name, hostname, port, username, authorizedKeys } = host;
        // A pin that can't be read is left out, so that machine's key waits for this phone; one removed meanwhile
        // is left out entirely.
        const pinned = await hosts.admit(id).then(({ trustedHostKey }) => trustedHostKey, () => null);
        if (pinned === null && hosts.get(id) === undefined) return [];
        return [{ name, hostname, port, username,
          ...(pinned ? { hostKey: { algorithm: pinned.algorithm, fingerprint: pinned.fingerprint } } : {}),
          ...(authorizedKeys === undefined ? {} : { authorizedKeys: [...authorizedKeys] }) }];
      }));
      return machines.flat();
    },
    subscribe: hosts.subscribe,
  };
}
