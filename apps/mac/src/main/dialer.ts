import { randomBytes } from 'node:crypto';
import { homedir } from 'node:os';

import { webSocketLink, type Link } from '@earendil-works/chord';
import { NodeExecutionEnv } from '@earendil-works/pi-durable/env/node';
import type { InfiniChatClient, Machine } from '@pi-agent/infinichat/pi/infinichat-remote/contract';
import { dialServer, type ServerDialer } from '@pi-agent/infinichat/pi/infinichat-remote/dialer';
import type { CredentialBackend } from '@pi-agent/infinichat/pi/provider-credentials';
import { WebSocket } from 'ws';

import type { MacMachine, MacMachines } from './machines';
import { openTunnel, type Tunnel } from './tunnel';

const random = (count: number) => Promise.resolve(new Uint8Array(randomBytes(count)));

/**
 * How this app reaches this Mac's own InfiniChat server, as `phone-dialer.ts` reaches a machine's: no SSH and no
 * tunnel, since the server listens on this Mac's loopback (`listen.ts`). The check and an install (`dialServer`) run
 * through a local `NodeExecutionEnv` in the home directory, and the socket is `ws`'s, which carries the Bearer header
 * a browser can't. With no transport under the link, the link's own close is the only drop.
 */
export function macDialer(machine: MacMachine, client: InfiniChatClient, secrets: CredentialBackend): ServerDialer {
  return {
    async dial({ signal, onStage, onInstalled }) {
      const environment = new NodeExecutionEnv({ cwd: homedir() });
      let link: Link | undefined;
      return dialServer({
        machineId: machine.id, name: machine.name, username: machine.username, client: client.id,
        credentials: secrets, randomBytes: random, environment: async () => environment,
        // Opens a new socket to the server's port, closing the previous link first.
        open: (target) => {
          link?.close();
          const socket = new WebSocket(`ws://127.0.0.1:${target.port}`,
            { headers: { authorization: `Bearer ${target.secret}` } });
          // `ws` emits a failed connection as an error, which would end the process unheard; the close that follows
          // ends the link, and the client connects again.
          socket.on('error', () => {});
          link = webSocketLink(socket);
          return link;
        },
        close: async () => { link?.close(); },
      }, { signal, onStage, onInstalled });
    },
  };
}

/**
 * How this app reaches another machine's InfiniChat server, as `phone-dialer.ts` does over the phone's SSH: the
 * machine's files and commands through the pi-env connection `MacMachines` pools, which the check and an install
 * (`dialServer`) use, and the socket through a tunnel of this Mac's own `ssh` to the server's loopback port. The
 * record comes from the conversation's machines document, read when the dial starts.
 */
export function remoteDialer(endpoint: string, record: () => Machine | undefined, machines: MacMachines,
  client: InfiniChatClient, secrets: CredentialBackend): ServerDialer {
  return {
    async dial({ signal, onStage, onInstalled, onDropped }) {
      const machine = record();
      if (machine === undefined) throw new Error('This machine is no longer among InfiniChat’s machines.');
      const environment = await machines.environment(endpoint, signal);
      let tunnel: Tunnel | undefined;
      let link: Link | undefined;
      return dialServer({
        machineId: endpoint, name: machine.name, username: machine.username, client: client.id,
        credentials: secrets, randomBytes: random, environment: async () => environment,
        // Tunnels to the server's port and opens a new socket over it, closing the previous ones first.
        open: async (target) => {
          link?.close();
          await tunnel?.close();
          tunnel = await openTunnel(machines.target(machine), target.port, machines.watchTailscale);
          tunnel.onDropped(onDropped);
          const socket = new WebSocket(`ws://127.0.0.1:${tunnel.port}`,
            { headers: { authorization: `Bearer ${target.secret}` } });
          socket.on('error', () => {});
          link = webSocketLink(socket);
          return link;
        },
        close: async () => {
          link?.close();
          await tunnel?.close();
        },
      }, { signal, onStage, onInstalled });
    },
  };
}
