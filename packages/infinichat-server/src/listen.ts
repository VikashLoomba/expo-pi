import { timingSafeEqual } from 'node:crypto';
import { readdir, readFile, rename, writeFile } from 'node:fs/promises';
import type { IncomingMessage } from 'node:http';
import { join } from 'node:path';

import { webSocketLink, type Host } from '@earendil-works/chord';
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
 * loopback is open to every account on the machine, so each connection must also carry a client's secret; then it is
 * a client link acting as the owner, so every client shares one object (chord `docs/guide.md`, "Principals and
 * variants"). As Chord's `acceptWebSockets` does, the socket is wrapped at once, so frames sent while the secret is
 * checked wait; links send plain frames, because `acceptWebSockets` deflates large ones, which the phone's Hermes
 * cannot inflate. `bundle` tells the clients which bundle answers.
 */
export async function listen(host: Host<InfiniChatPrincipal>, home: string, bundle: string): Promise<WebSocketServer> {
  const server = new WebSocketServer({ host: '127.0.0.1', port: 0 });
  server.on('connection', (socket, request) => {
    const link = webSocketLink(socket, { compress: false, acceptPacked: false });
    authorized(request, join(home, 'clients')).then((ok) => {
      if (ok) host.accept(link, { principal: { kind: 'owner' }, kind: 'client' });
      else link.close('unauthorized');
    }, () => link.close('authentication failed'));
  });
  await new Promise<void>((resolve, reject) => {
    server.once('listening', resolve);
    server.once('error', reject);
  });
  const address = server.address();
  if (address === null || typeof address === 'string') throw new Error(`Unexpected listening address ${address}.`);
  // Written aside and renamed into place, so a client polling it never reads half a file. The install's readiness
  // check (packages/infinichat/src/pi/infinichat-remote/install.ts) matches this exact JSON.stringify form. `node` is
  // the Node the phone runs this bundle's page commands with (move.ts).
  const temporary = join(home, `server.json.${process.pid}`);
  await writeFile(temporary, JSON.stringify({ pid: process.pid, port: address.port, bundle, node: process.execPath }));
  await rename(temporary, join(home, 'server.json'));
  console.log(`InfiniChat listening on 127.0.0.1:${address.port}`);
  return server;
}
