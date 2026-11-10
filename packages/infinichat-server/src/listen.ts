import { timingSafeEqual } from 'node:crypto';
import { readdir, readFile, rename, writeFile } from 'node:fs/promises';
import type { IncomingMessage } from 'node:http';
import { join } from 'node:path';

import { webSocketLink, type Host } from '@earendil-works/chord';
import { BACKGROUND_CONTEXT } from '@earendil-works/chord/context';
import type { InfiniChatPrincipal } from '@pi-agent/infinichat/pi/infinichat-remote/contract';
import { WebSocketServer } from 'ws';

/**
 * Whether the request carries `Authorization: Bearer <secret>` with a secret a client's install wrote to `clients/`,
 * read at this moment, so a client installed since needs no restart. Compared in constant time.
 */
async function authorized(request: IncomingMessage, clients: string): Promise<boolean> {
  const given = Buffer.from(request.headers.authorization ?? '');
  const secrets = await Promise.all((await readdir(clients)).map((name) => readFile(join(clients, name), 'utf8')));
  return secrets.some((text) => {
    const secret = text.trim();
    const wanted = Buffer.from(`Bearer ${secret}`);
    return given.length === wanted.length && timingSafeEqual(given, wanted);
  });
}

/**
 * Listens on the machine's loopback, where the clients' SSH tunnels arrive, and records where in `server.json`. The
 * loopback is open to every account on the machine, so each connection must also carry a client's secret, checked at
 * the upgrade, before a socket exists; then it is a link from a client acting as the owner, so every client shares
 * one object (chord `docs/design.md` §3: an entry point authenticates and calls `accept`; §4, principals). The host
 * sets no compression (`createHost`'s `compression`), so links send plain frames, which the phone's Hermes needs: it
 * cannot inflate. `version` tells the clients which release answers.
 */
export async function listen(host: Host<InfiniChatPrincipal>, home: string, version: string,
): Promise<WebSocketServer> {
  const clients = join(home, 'clients');
  const server = new WebSocketServer({
    host: '127.0.0.1',
    port: 0,
    verifyClient: ({ req }, done) => {
      authorized(req, clients).then((ok) => done(ok, 401), () => done(false, 500));
    },
  });
  server.on('connection', (socket) => {
    host.accept(webSocketLink(socket), { principal: { kind: 'owner' } }, BACKGROUND_CONTEXT);
  });
  await new Promise<void>((resolve, reject) => {
    server.once('listening', resolve);
    server.once('error', reject);
  });
  const address = server.address();
  if (address === null || typeof address === 'string') throw new Error(`Unexpected listening address ${address}.`);
  // Written aside and renamed into place, so a client polling it never reads half a file. The apps' checks
  // (packages/infinichat/src/pi/infinichat-remote/install.ts) match this exact JSON.stringify form. `node` is the Node
  // the phone runs the server's page commands with (move.ts).
  const temporary = join(home, `server.json.${process.pid}`);
  await writeFile(temporary,
    JSON.stringify({ pid: process.pid, port: address.port, version, node: process.execPath }));
  await rename(temporary, join(home, 'server.json'));
  console.log(`InfiniChat listening on 127.0.0.1:${address.port}`);
  return server;
}
