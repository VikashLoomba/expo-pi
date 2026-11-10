import { randomBytes, timingSafeEqual } from 'node:crypto';
import type { IncomingMessage } from 'node:http';

import { webSocketLink, type Host } from '@earendil-works/chord';
import { BACKGROUND_CONTEXT } from '@earendil-works/chord/context';
import { WebSocketServer } from 'ws';

import type { MacPrincipal } from '../contract';

/** Where this launch's windows connect, and the secret that admits them. */
export interface WindowListener {
  readonly port: number;
  readonly secret: string;
  close(): Promise<void>;
}

/** Compared in constant time. */
function equal(left: string, right: string): boolean {
  const a = Buffer.from(left);
  const b = Buffer.from(right);
  return a.length === b.length && timingSafeEqual(a, b);
}

/** Whether the handshake offers the secret among its subprotocols. */
const admitted = (request: IncomingMessage, secret: string) =>
  (request.headers['sec-websocket-protocol'] ?? '').split(',').some((offered) => equal(offered.trim(), secret));

/**
 * Listens on the loopback for the windows of a loaded host. The loopback is open to every account on this Mac, so a
 * window presents the launch's secret, which the main process preloads into its page, as the WebSocket subprotocol:
 * the one request header a browser lets a page choose, which the server must echo for the browser to keep the socket.
 * It is checked at the upgrade, before a socket exists; then the socket is a link from a client acting as the owner,
 * so every window shares the main process's objects (chord `docs/design.md` §3: an entry point authenticates and
 * calls `accept`; §4, principals).
 */
export async function listenForWindows(host: Host<MacPrincipal>): Promise<WindowListener> {
  const secret = randomBytes(32).toString('hex');
  const server = new WebSocketServer({
    host: '127.0.0.1',
    port: 0,
    verifyClient: ({ req }: { req: IncomingMessage }) => admitted(req, secret),
    // An admitted handshake offered the secret, which is the subprotocol the browser gets back.
    handleProtocols: () => secret,
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
  return {
    port: address.port,
    secret,
    close: () => new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve())),
  };
}
