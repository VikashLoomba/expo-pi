import { webSocketLink, type Link } from '@earendil-works/chord';
import { awaitWithContext, BACKGROUND_CONTEXT, withAbortSignal } from '@earendil-works/chord/context';
import { connect, type SshConnection, type SshLocalForward } from '@automatalabs/react-native-ssh';
import type { ServerDialer } from '@pi-agent/infinichat/pi/infinichat-remote/dialer';
import {
  installServer, machineSecret, requestUpdate, runningServer, savedSecret,
} from '@pi-agent/infinichat/pi/infinichat-remote/install';
import { getRandomBytesAsync } from 'expo-crypto';

import { connectionFailure } from '../execution/remote/channel';
import { hostKeyPolicy, type RemoteHostAdmission, type RemoteHostRepository } from '../execution/remote/hosts';
import { tailscaleSignIn } from '../execution/remote/tailscale';
import type { RemoteExecution } from '../execution/remote/owner';
import { createCredentialBackend } from '../secure-storage';
import { phoneClient } from './phone-client';

type Target = { port: number; secret: string; version: string };

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
  const signIn = tailscaleSignIn();
  return connect({
    host: host.hostname, port: host.port, username: host.username, auth, signal: options.signal,
    ...hostKeyPolicy(hosts, admission), onBanner: signIn.onBanner, onDisconnected: options.onDisconnected,
  }).catch((error: unknown) => {
    throw connectionFailure(error);
  }).finally(() => signIn.settled());
}

/**
 * How this phone reaches a configured machine's InfiniChat server: one SSH connection with the machine's admission,
 * and a WebSocket tunnelled over it to the server's loopback port (`server/listen.ts`), carrying this phone's secret.
 * It writes the secret as this phone's client file there and starts the server, setting one up first on a machine
 * with none (`installServer`), when this phone has no secret for the machine or `server.json` names no live server.
 * That check and setup go through the environment owner.ts keeps for the machine: one daemon connection, shared with
 * the chats' tools, which the provider closes. It borrows that, the machine record and the phone's secret, and closes
 * only the SSH connection and tunnel it opened.
 */
export function phoneDialer(hosts: RemoteHostRepository, remote: RemoteExecution, machineId: string): ServerDialer {
  return {
    async dial({ signal, onStage, onInstalled, onDropped }) {
      // As owner.ts checks a chat's machine, with InfiniChat's own way out.
      await hosts.restore();
      if (!hosts.get(machineId)) {
        throw new Error('This iPhone has no credentials for the machine InfiniChat’s conversation is on. Add them in '
          + 'Remote machines.');
      }
      const credentials = createCredentialBackend();
      const secret = await savedSecret(credentials, machineId);
      const admission = await hosts.admit(machineId);
      const { host } = admission;
      const connection = await connectAdmitted(hosts, admission, { signal, onDisconnected: onDropped });
      // A dial that is cancelled stops waiting for it; the owner keeps the connection it opens.
      const machine = () => awaitWithContext(remote.environment(machineId, undefined),
        withAbortSignal(signal, BACKGROUND_CONTEXT));
      const name = host.hostname;
      let forward: SshLocalForward | undefined;
      let link: Link | undefined;
      const install = async (): Promise<Target> => {
        const installing = await machineSecret(credentials, getRandomBytesAsync, machineId);
        const server = await installServer({ machine: await machine(), name, username: host.username },
          phoneClient().id, installing, { signal, onProgress: onStage });
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
        const running = secret === undefined ? undefined : await runningServer(await machine(), name, signal);
        const target = secret !== undefined && running !== undefined ? { ...running, secret } : await install();
        return {
          link: await open(target),
          version: target.version,
          install: async () => open(await install()),
          requestUpdate: async () => requestUpdate(await machine(), name, signal),
          close,
        };
      } catch (error) {
        await close();
        throw error;
      }
    },
  };
}
