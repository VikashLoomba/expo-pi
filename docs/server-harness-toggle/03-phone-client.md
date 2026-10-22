# Piece 3: Phone client and the machine selector

## Goal

InfiniChat's header gains a machine selector: *This iPhone* or a configured machine. When a machine is chosen, the
InfiniChat tab, its settings and the Scheduled tasks sheet show that machine's conversation through a Chord client
over an SSH tunnel, with the screens they have today. Until piece 5 lands, that conversation is the machine's own,
new one; the phone's own conversation stays on the phone, closed. Piece 5 makes the toggle move the conversation
itself.

## Starts from

- Chord, pi 1.4.0:
  - Tutorial §6, "Reach the list from another process": a `kind: "client"` host with an upstream link.
  - Guide "References" (`docs/guide.md:396`): a held reference stays readable while a link reconnects, and calls on
    a `loading` reference wait until it is live.
  - `host.connect(link, options)` "Sets (or replaces, after a reconnect) the link to this host's parent; remote
    references re-hold over it" (`src/host.ts:231`).
- react-native-ssh 0.3.0 README, "Local port forwarding (direct-tcpip): a loopback listener tunnelled through the
  session, so an HTTP/WebSocket client on the phone can reach a service bound to the server's loopback without
  exposing it" (`README.md:16-20`, example `:87-93`, options `src/index.ts:146-156`).
- React Native 0.88's `WebSocket(url, protocols, { headers })` (`Libraries/WebSocket/WebSocket.js:100`), for the
  secret.
- The app's remote owner (`src/pi/execution/remote/owner.ts`): admission with credentials and the pinned host key,
  and one connection per machine that its creator closes.
- The probe ([references](references.md#chord-over-websocket-in-hermes)): in Hermes, a Chord client hydrated an
  81 KB view, sent input, streamed diffs, lost its socket, and caught up after `connect(newLink)`.

## Builds

### `InfiniChatHost`

The surface the screens already use, as one interface (`src/chat/chat-provider.tsx`):
- `view()`, a `ChatViewSource<InfiniChatControls>`;
- `accept`, `stop`, `updateSettings`, `cancelScheduled` and `dismissError`;
- `scheduled`, a store with `subscribe` and `getSnapshot`;
- the report store, also `subscribe` and `getSnapshot`.

Piece 1's core implements it on the phone; `RemoteInfiniChat` implements it remotely. `useChatApp().infiniChat`
becomes an `InfiniChatHost`. The screens don't change.

### `src/pi/infinichat-remote/client.ts`: `RemoteInfiniChat`

1. **SSH.**
   - `connect` with `hosts.admit(machineId)`: the credentials, `verifyHostKey` against the pinned key, and
     `hostKeyAlgorithms`, as `admittedSshChannel` does.
   - Install or update first when needed (piece 2).
   - Read `~/.infinichat/server.json` for the port, then `connection.forwardLocal({ remoteHost: "127.0.0.1",
     remotePort: port })`.
2. **Socket and link.** Open `new WebSocket(`ws://127.0.0.1:${forward.localPort}`, undefined, { headers: {
   authorization: `Bearer ${secret}` } })` and wrap it with `webSocketLink(socket)`. The link's own options keep
   their defaults: `compress: false` is already the client side's default.
3. **Chord.**
   - One client host per `RemoteInfiniChat`: `createHost({ name: "phone", self: …, kind: "client" })`.
   - Connect it with `host.connect(link, { principal })`.
   - Take one reference with `host.hold(InfiniChatRemote, {})`.
   - The `ChatViewSource` adapter and the stores read the reference's `snapshot` (`{ view, report? }`: the view's
     `ChatViewSnapshot` and the Harness's latest report), `controls`, `messages` and `scheduled`, typed by the
     contract's schemas. The member is not `status`: that name is the reference's own (Chord reserves it).
   - A method that rejects on the server arrives wrapped. The server's error crosses as
     `{ code: "unavailable", message }` (Chord `src/wire.ts:171-178`). The client rebuilds a `ChordError`, whose
     `message` carries the code again (`src/errors.ts:36`), so `accept` rejects with
     `unavailable: Sign in or connect OpenAI in Account to send a message.` Show the text after that prefix, as
     the error notice shows a local error today.
4. **Reconnect.** Done on demand, the way the app's daemon `Connection` restarts:
   - when the socket or the SSH session closes;
   - when the app becomes active;
   - when the user acts while disconnected.

   Each attempt opens a new SSH connection, forward and socket, and calls `host.connect` again. While loading, the
   screens keep the last values. The header shows "Connecting to <machine>…", or the failure ("<machine> is
   unreachable"). Input keeps its draft `requestId`, and OptChat admits a repeated one once, so a send that waited
   through a reconnect is never doubled.
5. **Close.** Runs when the selection changes or the provider unmounts: `host.close()`, `forward.close()`, then
   `connection.disconnect()`.

### The selector and the provider

- **The selector.** The InfiniChat header's right toolbar (`src/app/(tabs)/(infinichat)/index.tsx`, beside the
  Scheduled tasks button) gains a pull-down menu, as HIG recommends for a quick switch between a few options:
  - *This iPhone* and each machine in `remoteHosts`, with a checkmark on the current one;
  - the header's existing subtitle line names the machine while InfiniChat runs on one.

  Picking a machine runs install (piece 2) and connect. Progress and errors show in the header subtitle and the
  existing error notice, without leaving the conversation.
- **Where the choice is stored.** In app settings storage, like `pi.remote-hosts.v1`. Piece 5 turns it into the home
  record.
- **The provider.** `chat-provider.tsx` opens the local core only when InfiniChat runs on the phone, and a
  `RemoteInfiniChat` otherwise. In remote mode the keep-alive observes nothing for InfiniChat (piece 6), because the
  work isn't on the phone.

## Ownership and lifetime

| Resource | Created by | Cancelled by | Closed by |
| --- | --- | --- | --- |
| SSH connection, forward, socket | `RemoteInfiniChat`, per connection attempt | the next attempt's start, close | `RemoteInfiniChat` (on a drop, the old ones are disposed before the next attempt) |
| Chord client host | `RemoteInfiniChat`, once | — | `RemoteInfiniChat.close()` |
| Reference to `infinichat.remote` | the client host | — | released by `close()` |
| A method call | the screen | the screen's own signal, which cancels only the wait | settles; server work is never cancelled by a dropped link, only by `stop()` |

`RemoteInfiniChat` borrows the machine record and the credential store; it closes nothing it didn't create.
It has its own SSH connection, separate from the tools' daemon connections in `owner.ts`. They have different
lifetimes, and the server, not the phone, runs tools while InfiniChat is remote.

## Deviations (need approval)

None beyond the README's decisions. If App Transport Security refuses `ws://127.0.0.1` in a Release build (see
Checks), the fallback is a Chord `Link` over an SSH channel:
- the server gets an `attach` subcommand that pipes its stdio to the loopback socket;
- the phone implements Chord's public `Link` interface (`src/link.ts:5-18` at v1.4.0) over `openShell`.

That would be a deviation from Chord's provided links, and needs approval before it's built.

## Size

About 350 lines: the interface and provider changes ~80, `client.ts` ~170, the header menu and status ~100.

## Checks

On the owner's iPhone Release install, InfiniChat database backed up, a machine with the piece 2 server:

- **App Transport Security.** The socket opens through `forwardLocal` on a Release build (the generated
  `Info.plist` has `NSAllowsArbitraryLoads = false` and `NSAllowsLocalNetworking = true`). This is unverified until
  this check.
- **Choosing a machine** installs, connects, and shows that machine's conversation. *This iPhone* shows the phone's
  conversation again, unchanged.
- **Locked phone.** Lock for five minutes during a run started from the phone, then unlock: it reconnects and shows
  the finished answer.
- **Offline.** Turn Tailscale off: the header shows the failure. Turn it back on: it reconnects without a relaunch.
- **Killed app.** Quit it in the middle of a stream and relaunch: it shows the current state.
- **Send while disconnected:** admitted once after the reconnect.

## Not in this piece

Signing in on the server (piece 4; until then a send says to sign in), moving the phone's conversation (piece 5),
remote notifications (piece 6).
