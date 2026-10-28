import { createHost, webSocketLink, type Host, type WebSocketLike } from '@earendil-works/chord';

import { principalKey, type MacPrincipal } from '../../contract';

/**
 * The browser's socket as chord's link takes it. TypeScript 6's DOM library types `send` with `BufferSource`, a view
 * over a plain `ArrayBuffer`, and chord's `WebSocketLike` with a view over any buffer; chord sends views over its own
 * plain buffers, and the interface's methods compare bivariantly, so this narrower `send` satisfies it. chord sets
 * `binaryType` on the socket it is given (`link.js:306`), so deflated frames arrive as `ArrayBuffer`, not `Blob`; the
 * property reaches the socket through the accessors.
 */
function socketLike(socket: WebSocket): WebSocketLike {
  const like = {
    get readyState() {
      return socket.readyState;
    },
    get binaryType() {
      return socket.binaryType;
    },
    set binaryType(value: BinaryType) {
      socket.binaryType = value;
    },
    send(data: string | Uint8Array<ArrayBuffer>) {
      socket.send(data);
    },
    close: (code?: number, reason?: string) => socket.close(code, reason),
    // chord reads `data` of message events only; its other listeners take no event.
    addEventListener: (type: 'message' | 'open' | 'close' | 'error',
      listener: (event: { readonly data: unknown }) => void) =>
      socket.addEventListener(type, (event) =>
        listener({ data: event instanceof MessageEvent ? event.data : undefined })),
  };
  return like;
}

/** How long a window waits before connecting again after its link closed. */
const RECONNECT_MS = 1000;

/**
 * This window's Chord host: a client of the main process over the loopback port it preloaded, presenting the launch's
 * secret as the subprotocol. The main process's own requests act as the host. A link that closes is replaced after a
 * moment, as the phone's client replaces a dropped link: `host.connect` re-holds the references, which keep their last
 * values meanwhile (chord `docs/guide.md`, "References"). A protocol mismatch reloads the page instead, as chord's
 * guide has browsers do.
 */
export function connectToMain({ port, secret }: { port: number; secret: string }): Host<MacPrincipal> {
  const host = createHost<MacPrincipal>({ name: 'window', self: { kind: 'owner' }, principalKey, kind: 'client' });
  const connect = () => {
    const link = webSocketLink(socketLike(new WebSocket(`ws://127.0.0.1:${port}`, [secret])));
    link.onClose((reason) => {
      console.warn(`The link to the main process closed (${reason}); connecting again.`);
      setTimeout(connect, RECONNECT_MS);
    });
    host.connect(link, { principal: { kind: 'host' }, onProtocolMismatch: () => location.reload() });
  };
  connect();
  return host;
}
