import { randomBytes } from 'node:crypto';
import { homedir } from 'node:os';

import { webSocketLink, type Link } from '@earendil-works/chord';
import { NodeExecutionEnv } from '@earendil-works/pi-durable/env/node';
import type { InfiniChatClient, Machine } from '@pi-agent/infinichat/pi/infinichat-remote/contract';
import type { ServerDialer } from '@pi-agent/infinichat/pi/infinichat-remote/dialer';
import {
  installServer, machineSecret, requestUpdate, runningServer, savedSecret,
} from '@pi-agent/infinichat/pi/infinichat-remote/install';
import type { CredentialBackend } from '@pi-agent/infinichat/pi/provider-credentials';
import { WebSocket } from 'ws';

import type { MacMachine, MacMachines } from './machines';
import { openTunnel, type Tunnel } from './tunnel';

type Target = { port: number; secret: string; version: string };
const random = (count: number) => Promise.resolve(new Uint8Array(randomBytes(count)));

/**
 * How this app reaches this Mac's own InfiniChat server, as `phone-dialer.ts` reaches a machine's: no SSH and no
 * tunnel, since the server listens on this Mac's loopback (`listen.ts`). `runningServer` and `installServer` run
 * through a local `NodeExecutionEnv` in the home directory, and the socket is `ws`'s, which carries the Bearer header
 * a browser can't. It writes this app's client file there and starts the server, setting one up first when the Mac
 * has none, when this app has no secret for the Mac or `server.json` names no live server. With no transport under
 * the link, the link's own close is the only drop.
 */
export function macDialer(machine: MacMachine, client: InfiniChatClient, secrets: CredentialBackend): ServerDialer {
  return {
    async dial({ signal, onStage, onInstalled }) {
      const environment = new NodeExecutionEnv({ cwd: homedir() });
      const secret = await savedSecret(secrets, machine.id);
      const { name } = machine;
      let link: Link | undefined;
      const install = async (): Promise<Target> => {
        const installing = await machineSecret(secrets, random, machine.id);
        const server = await installServer({ machine: environment, name, username: machine.username }, client.id,
          installing, { signal, onProgress: onStage });
        onInstalled(server.notice);
        return server;
      };
      // Opens a new socket to the server's port, closing the previous link first.
      const open = (target: Target): Link => {
        link?.close();
        const socket = new WebSocket(`ws://127.0.0.1:${target.port}`,
          { headers: { authorization: `Bearer ${target.secret}` } });
        // `ws` emits a failed connection as an error, which would end the process unheard; the close that follows
        // ends the link, and the client connects again.
        socket.on('error', () => {});
        link = webSocketLink(socket);
        return link;
      };
      try {
        const running = secret === undefined ? undefined : await runningServer(environment, name, signal);
        const target = secret !== undefined && running !== undefined ? { ...running, secret } : await install();
        return {
          link: open(target),
          name,
          version: target.version,
          install: async () => open(await install()),
          requestUpdate: () => requestUpdate(environment, name, signal),
          close: async () => { link?.close(); },
        };
      } catch (error) {
        link?.close();
        throw error;
      }
    },
  };
}

/**
 * How this app reaches another machine's InfiniChat server, as `phone-dialer.ts` does over the phone's SSH: the
 * machine's files and commands through the pi-env connection `MacMachines` pools, which `installServer` and
 * `runningServer` use, and the socket through a tunnel of this Mac's own `ssh` to the server's loopback port. The
 * record comes from the conversation's machines document, read when the dial starts.
 */
export function remoteDialer(endpoint: string, record: () => Machine | undefined, machines: MacMachines,
  client: InfiniChatClient, secrets: CredentialBackend): ServerDialer {
  return {
    async dial({ signal, onStage, onInstalled, onDropped }) {
      const machine = record();
      if (machine === undefined) throw new Error('This machine is no longer among InfiniChat’s machines.');
      const environment = await machines.environment(endpoint, signal);
      const secret = await savedSecret(secrets, endpoint);
      const { name } = machine;
      let tunnel: Tunnel | undefined;
      let link: Link | undefined;
      const install = async (): Promise<Target> => {
        const installing = await machineSecret(secrets, random, endpoint);
        const server = await installServer({ machine: environment, name, username: machine.username }, client.id,
          installing, { signal, onProgress: onStage });
        onInstalled(server.notice);
        return server;
      };
      // Tunnels to the server's port and opens a new socket over it, closing the previous ones first.
      const open = async (target: Target): Promise<Link> => {
        link?.close();
        await tunnel?.close();
        tunnel = await openTunnel(machines.target(machine), target.port, machines.watchTailscale);
        tunnel.onDropped(onDropped);
        const socket = new WebSocket(`ws://127.0.0.1:${tunnel.port}`,
          { headers: { authorization: `Bearer ${target.secret}` } });
        socket.on('error', () => {});
        link = webSocketLink(socket);
        return link;
      };
      const close = async () => {
        link?.close();
        await tunnel?.close();
      };
      try {
        const running = secret === undefined ? undefined : await runningServer(environment, name, signal);
        const target = secret !== undefined && running !== undefined ? { ...running, secret } : await install();
        return {
          link: await open(target),
          name,
          version: target.version,
          install: async () => open(await install()),
          requestUpdate: () => requestUpdate(environment, name, signal),
          close,
        };
      } catch (error) {
        await close();
        throw error;
      }
    },
  };
}
