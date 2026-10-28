import { createHost, webSocketLink, type Host, type WebSocketLike } from '@earendil-works/chord';

import { principalKey, type MacPrincipal } from '../contract';

/**
 * The browser's socket as chord's link takes it. TypeScript 6's DOM library types `send` with `BufferSource`, a view
 * over a plain `ArrayBuffer`, and chord's `WebSocketLike` with a view over any buffer; chord sends views over its own
 * plain buffers, and the interface's methods compare bivariantly, so this narrower `send` satisfies it.
 */
function socketLike(socket: WebSocket): WebSocketLike {
  return {
    get readyState() {
      return socket.readyState;
    },
    send(data: string | Uint8Array<ArrayBuffer>) {
      socket.send(data);
    },
    close: (code, reason) => socket.close(code, reason),
    // chord reads `data` of message events only; its other listeners take no event.
    addEventListener: (type: 'message' | 'open' | 'close' | 'error',
      listener: (event: { readonly data: unknown }) => void) =>
      socket.addEventListener(type, (event) =>
        listener({ data: event instanceof MessageEvent ? event.data : undefined })),
  };
}

/**
 * This window's Chord host: a client of the main process over the loopback port it preloaded, presenting the launch's
 * secret as the subprotocol. The main process's own requests act as the host. A link can't be lost while the main
 * process lives, and a protocol mismatch reloads the page, as chord's guide has browsers do ("Hosts and links").
 */
export function connectToMain({ port, secret }: { port: number; secret: string }): Host<MacPrincipal> {
  const host = createHost<MacPrincipal>({ name: 'window', self: { kind: 'owner' }, principalKey, kind: 'client' });
  host.connect(webSocketLink(socketLike(new WebSocket(`ws://127.0.0.1:${port}`, [secret]))),
    { principal: { kind: 'host' }, onProtocolMismatch: () => location.reload() });
  return host;
}
