import { randomBytes, timingSafeEqual } from 'node:crypto';
import type { IncomingMessage } from 'node:http';

import { acceptWebSockets, type Host } from '@earendil-works/chord';
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
 * Listens on the loopback for the windows. The loopback is open to every account on this Mac, so a window presents
 * the launch's secret, which the main process preloads into its page, as the WebSocket subprotocol: the one request
 * header a browser lets a page choose, which the server must echo for the browser to keep the socket. Every window
 * acts as the owner, so all of them share the main process's objects (chord `docs/guide.md`, "Principals and
 * variants").
 */
export async function listenForWindows(host: Host<MacPrincipal>): Promise<WindowListener> {
  const secret = randomBytes(32).toString('hex');
  const server = new WebSocketServer({
    host: '127.0.0.1',
    port: 0,
    handleProtocols: (protocols) => [...protocols].some((offered) => equal(offered, secret)) ? secret : false,
  });
  acceptWebSockets(server, host, {
    principal: (request): MacPrincipal | undefined => admitted(request, secret) ? { kind: 'owner' } : undefined,
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
