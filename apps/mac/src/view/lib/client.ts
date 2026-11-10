import { createHost, webSocketLink, type Host } from '@earendil-works/chord';
import { BACKGROUND_CONTEXT } from '@earendil-works/chord/context';

import type { MacPrincipal } from '../../contract';

/** How long a window waits before connecting again after its link closed. */
const RECONNECT_MS = 1000;

/**
 * This window's Chord host: a client of the main process (chord `docs/design.md` §3, "a browser tab") over the
 * loopback port it preloaded, presenting the launch's secret as the subprotocol. The main process's own requests act
 * as the host. Resolves once the host may hold, with its first link connecting: a reference made on a host that never
 * had a parent link has nowhere to go. A link that closes is replaced after a moment, as the phone's client replaces
 * a dropped link: `host.connect` takes the next and holds every reference again, which keep their last values
 * meanwhile (§7). A protocol error, which a failed handshake is reported as (§3, `onError`), reloads the page
 * instead: its code and the main process's do not speak the same protocol.
 */
export async function connectToMain({ port, secret }: { port: number; secret: string }): Promise<Host<MacPrincipal>> {
  const host = createHost<MacPrincipal>({
    onError: (error) => {
      if (error.kind === 'protocol_error') location.reload();
      else console.error('The window’s Chord host reported an error.', error);
    },
  });
  // A client loads nothing, and still publishes once before it may hold or get anything (§3, `load`).
  await host.load([], BACKGROUND_CONTEXT);
  const connect = () => {
    const socket = new WebSocket(`ws://127.0.0.1:${port}`, [secret]);
    // The next attempt follows the socket's own close: a link has one close listener, which the host takes.
    socket.addEventListener('close', () => {
      console.warn('The link to the main process closed; connecting again.');
      setTimeout(connect, RECONNECT_MS);
    });
    host.connect(webSocketLink(socket), { principal: { kind: 'host' } }, BACKGROUND_CONTEXT);
  };
  connect();
  return host;
}
