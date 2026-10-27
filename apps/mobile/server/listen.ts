import { timingSafeEqual } from 'node:crypto';
import { readFile, rename, writeFile } from 'node:fs/promises';
import type { IncomingMessage } from 'node:http';
import { join } from 'node:path';

import { webSocketLink, type Host } from '@earendil-works/chord';
import type { InfiniChatPrincipal } from '@pi-agent/infinichat/pi/infinichat-remote/contract';
import { WebSocketServer } from 'ws';

/** Whether the request carries `Authorization: Bearer <secret>`, compared in constant time. */
function authorized(request: IncomingMessage, secret: Buffer): boolean {
  const given = Buffer.from(request.headers.authorization ?? '');
  const wanted = Buffer.concat([Buffer.from('Bearer '), secret]);
  return given.length === wanted.length && timingSafeEqual(given, wanted);
}

/**
 * Listens on the machine's loopback, where the phone's SSH tunnel arrives, and records where in `server.json`. The
 * loopback is open to every account on the machine, so each connection must also carry the secret the phone wrote;
 * then it is a client link acting as the owner. Links send plain frames: Chord's `acceptWebSockets` deflates large
 * ones, which the phone's Hermes cannot inflate. `bundle` tells the phone which bundle answers.
 */
export async function listen(host: Host<InfiniChatPrincipal>, home: string, bundle: string): Promise<WebSocketServer> {
  const secret = Buffer.from((await readFile(join(home, 'secret'), 'utf8')).trim());
  if (secret.length === 0) throw new Error(`${join(home, 'secret')} is empty.`);
  const server = new WebSocketServer({ host: '127.0.0.1', port: 0 });
  server.on('connection', (socket, request) => {
    if (!authorized(request, secret)) {
      socket.close(1008, 'unauthorized');
      return;
    }
    host.accept(webSocketLink(socket, { compress: false, acceptPacked: false }), { principal: { kind: 'owner' },
      kind: 'client' });
  });
  await new Promise<void>((resolve, reject) => {
    server.once('listening', resolve);
    server.once('error', reject);
  });
  const address = server.address();
  if (address === null || typeof address === 'string') throw new Error(`Unexpected listening address ${address}.`);
  // Written aside and renamed into place, so the phone polling it never reads half a file. The phone's readiness
  // check (src/pi/infinichat-remote/install.ts) matches this exact JSON.stringify form. `node` is the Node the phone
  // runs this bundle's page commands with (move.ts).
  const temporary = join(home, `server.json.${process.pid}`);
  await writeFile(temporary, JSON.stringify({ pid: process.pid, port: address.port, bundle, node: process.execPath }));
  await rename(temporary, join(home, 'server.json'));
  console.log(`InfiniChat listening on 127.0.0.1:${address.port}`);
  return server;
}
