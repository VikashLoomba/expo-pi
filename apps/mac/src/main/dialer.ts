import { randomBytes } from 'node:crypto';
import { homedir } from 'node:os';

import { webSocketLink, type Link } from '@earendil-works/chord';
import { NodeExecutionEnv } from '@earendil-works/pi-durable/env/node';
import type { InfiniChatClient } from '@pi-agent/infinichat/pi/infinichat-remote/contract';
import type { ServerDialer } from '@pi-agent/infinichat/pi/infinichat-remote/dialer';
import {
  installServer, machineIdentity, machineSecret, runningServer, savedSecret,
} from '@pi-agent/infinichat/pi/infinichat-remote/install';
import { machineDescription } from '@pi-agent/infinichat/pi/infinichat/device-tools';
import type { CredentialBackend } from '@pi-agent/infinichat/pi/provider-credentials';
import { WebSocket } from 'ws';

import type { MacMachine } from './machines';
import { macServerAssets, SERVER_BUNDLE } from './server-assets';

type Target = { port: number; secret: string };
const random = (count: number) => Promise.resolve(new Uint8Array(randomBytes(count)));

/**
 * How this app reaches this Mac's own InfiniChat server, as `phone-dialer.ts` reaches a machine's: no SSH and no
 * tunnel, since the server listens on this Mac's loopback (`listen.ts`). `runningServer` and `installServer` run
 * through a local `NodeExecutionEnv` in the home directory, and the socket is `ws`'s, which carries the Bearer header
 * a browser can't. It installs or updates the server, writing this app's client file there, when this app has no
 * secret for the Mac and when `server.json` names no live server of this bundle. The server's device name and
 * description are the Mac's own (`machineIdentity`), as the phone reads them too. With no transport under the link,
 * the link's own close is the only drop.
 */
export function macDialer(machine: MacMachine, client: InfiniChatClient, secrets: CredentialBackend): ServerDialer {
  return {
    async dial({ signal, onStage, onInstalled }) {
      const environment = new NodeExecutionEnv({ cwd: homedir() });
      const secret = await savedSecret(secrets, machine.id);
      const identity = await machineIdentity(environment, machine.name, signal);
      const name = identity.name;
      const description = machineDescription({ username: machine.username, hostname: identity.hostname });
      let link: Link | undefined;
      const install = async (): Promise<Target> => {
        const installing = await machineSecret(secrets, random, machine.id);
        const server = await installServer(
          { machine: environment, name, description, username: machine.username },
          macServerAssets, client.id, installing, { signal, onProgress: onStage });
        onInstalled(server.notice);
        return server;
      };
      // Opens a new socket to the server's port, closing the previous link first.
      const open = (target: Target): Link => {
        link?.close();
        const socket = new WebSocket(`ws://127.0.0.1:${target.port}`,
          { headers: { authorization: `Bearer ${target.secret}` } });
        link = webSocketLink(socket);
        return link;
      };
      try {
        const port = secret === undefined ? undefined
          : await runningServer(environment, name, SERVER_BUNDLE, signal);
        const target = secret !== undefined && port !== undefined ? { port, secret } : await install();
        return {
          link: open(target),
          expected: { bundle: SERVER_BUNDLE, device: name, description },
          reinstall: async () => open(await install()),
          close: async () => { link?.close(); },
        };
      } catch (error) {
        link?.close();
        throw error;
      }
    },
  };
}
