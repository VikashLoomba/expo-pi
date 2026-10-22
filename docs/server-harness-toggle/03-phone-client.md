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

As built, the interface sits beside the core in `src/pi/infinichat-service.ts`, which the server also imports, so
`client.ts` needs nothing from the React provider. The settings sheet's draft now takes any
`ChatViewSource<InfiniChatControls>` instead of the local `InfiniChatView`.

### `src/pi/infinichat-remote/client.ts`: `RemoteInfiniChat`

1. **SSH.**
   - `connect` with `hosts.admit(machineId)`: the credentials, `verifyHostKey` against the pinned key, and
     `hostKeyAlgorithms`, as `admittedSshChannel` does.
   - Install or update first when needed (piece 2). `installServer` opens its own connection and resolves to
     `{ port, secret, notice? }`: the port it read from `~/.infinichat/server.json`, and the secret from the
     Keychain.
   - Read `~/.infinichat/server.json` for the port when install didn't run, then
     `connection.forwardLocal({ remoteHost: "127.0.0.1", remotePort: port })`.
   - Tolerate a stale `server.json`. On Linux without lingering, the user manager stops the unit when the last
     session closes and starts it again with the phone's SSH session, so the file can name a dead process or an old
     port until the new server rewrites it. Wait for a live `pid` as install's readiness step does, or retry.

   As built, "when needed" is decided on every connection attempt, and install runs at most once per attempt:
   - The attempt opens its own admitted SSH connection (`connectAdmitted`, shared with `installServer`). When the
     Keychain holds this phone's secret for the machine, `runningServer` reads `server.json` once over that
     connection: a port when it names this bundle and a live `pid`.
   - Install runs when there is no secret, when `server.json` names no live server of this bundle (a stopped server
     or a stale file), and when the server then refuses the socket or answers as another bundle or device. Install's
     own readiness step is the wait for a live `pid`: a stale file is handled by installing, which restarts the
     service and waits, rather than by a second wait loop in the client.
   - So choosing a machine, or launching with one chosen, installs only when the machine's server needs it. A
     running server of this bundle is reached with one SSH connection and no setup scripts.
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

   As built:
   - The client host takes `self: { kind: "owner" }` and connects with `principal: { kind: "host" }`, the
     server's own principal. The hold has to follow the first `host.connect`: a client host holding before it has an
     upstream ends the binding at once with `unavailable: no route to infinichat-server` (chord `src/host.ts:1126`).
   - Once the reference is live, the attempt checks the `server` member: its `bundle` must be this app's and its
     `device` the machine's current name. Either mismatch installs, so a renamed machine restarts with its new
     `--device`. The screens see nothing from a server until that check passes. That restart stops the server
     mid-turn if one is running; pi-durable resumes the interrupted work when the new server opens the database, as
     after any restart (pi-durable `README.md:127`).
   - The server's own view starts `loading` on the first hold after the server starts, and publishes `ready` once it
     has read the conversation, so the screens show "Opening this conversation…" for a moment then.
   - Calls run inside `host.root(…, { signal })`. The prefix is stripped with the regular expression
     `fromWireError` uses (`src/wire.ts:180-181`).
4. **Reconnect.** Done on demand, the way the app's daemon `Connection` restarts:
   - when the socket or the SSH session closes;
   - when the app becomes active;
   - when the user acts while disconnected.

   Each attempt opens a new SSH connection, forward and socket, and calls `host.connect` again. While loading, the
   screens keep the last values. The header shows "Connecting to <machine>…", or the failure ("<machine> is
   unreachable"). Input keeps its draft `requestId`, and OptChat admits a repeated one once, so a send that waited
   through a reconnect is never doubled.

   As built:
   - A drop is the link's `onClose`, the forward's `onClosed` with a reason, the connection's `onDisconnected`, or
     the reference going `gone` (the server shutting down). It only counts once the session was live, so a socket
     the server refuses during an attempt never loops.
   - Nothing retries after a failed attempt. The failure stays until the app becomes active or the user acts: a
     call, or "Try Again" on the error notice.
   - A forward that can't be opened fails with the same fixed SSH messages as a connect (`connectionFailure`).
   - A Chord call on a `loading` reference waits until it is live, with only its `ctx` to cancel it
     (`src/remote.ts:338`). The calls run with a signal the client aborts when an attempt fails, so a call waiting
     through a failed reconnect rejects with that failure, such as "The SSH server could not be reached through
     Tailscale…", instead of waiting until the next attempt.
   - A call in flight when its link closes rejects with `unavailable: link to … closed` (`src/connection.ts:1237`,
     `:1242`). A call on a reference the server forced away (its shutdown or restart) rejects with that `gone`
     error (`src/remote.ts:291-297`). Either may have reached the server, so both show "The connection to <machine>
     was lost. Try again.", and the resend keeps its `requestId`. Measured: a call on the wire when its link was
     replaced was applied by the server, rejected on the phone, and never resent by Chord.
   - **Back from the background** (owner decision, 2026-10-22): the link is replaced even when it looks live, as
     after a drop: a new SSH connection, forward, socket and `host.connect`. iOS suspends the app in the background,
     and Chord's pinger and react-native-ssh's keepalive with it, so a link that died meanwhile would otherwise show
     stale state until the ping timeout (45 s, `src/connection.ts:440-445`) or the keepalive (3 × 15 s) noticed.
     `connect` "Sets (or replaces, after a reconnect) the link" and re-holds with the values kept (`src/host.ts:229-231`,
     `:956-966`; `src/remote.ts:305-315`). No timer is involved. The provider calls `RemoteInfiniChat.resume()` only
     when the app state goes from `background` to `active`: returning from `inactive` (Control Center, a system
     prompt) was never suspended, and calls `reconnect()`, which leaves a live link alone. React Native reports a
     return from the background as `background` → `active` (`React/CoreModules/RCTAppState.mm:115-124`).
5. **Close.** Runs when the selection changes or the provider unmounts: `host.close()`, `forward.close()`, then
   `connection.disconnect()`.

   As built, close also cancels an attempt under way and waits for it, rejects the calls still waiting, and releases
   the reference before `host.close()`: `host.close()` closes links but leaves a held reference `loading`, where its
   waiting calls would never settle.

### The selector and the provider

- **The selector.** The InfiniChat header's right toolbar (`src/app/(tabs)/(infinichat)/index.tsx`, beside the
  Scheduled tasks button) gains a pull-down menu, as HIG recommends for a quick switch between a few options:
  - *This iPhone* and each machine in `remoteHosts`, with a checkmark on the current one;
  - the header's existing subtitle line names the machine while InfiniChat runs on one.

  Picking a machine runs install (piece 2) and connect. Progress and errors show in the header subtitle and the
  existing error notice, without leaving the conversation.

  As built:
  - `Stack.Toolbar.Menu` before the Scheduled tasks button, with `Stack.Toolbar.MenuAction isOn` for the checkmark,
    as Expo's toolbar guide does for a choice (`isOn` becomes the item's `on` state,
    `StackToolbarMenu/index.js:186-193`). The button shows `iphone` or `server.rack`, the symbol the app's Remote
    machines button uses, and each item has the same symbol. The menu has no title: a root menu's `title` would
    also become the button's label.
  - The subtitle reads "<machine> · <models>" when connected, "Connecting to <machine>…", "Installing InfiniChat on
    <machine>…" or "Starting InfiniChat on <machine>…" during an attempt, and "Can’t connect to <machine>" after
    any failure. It names the machine only once Remote machines are restored, so a launch never flashes a placeholder;
    until then it shows the models line. The title's accessibility label reads the same line.
  - The failure's own message shows in the error notice with "Try Again", also when a send failed with that same
    message, and "Try Again" clears both. An install's `notice` shows as a neutral notice with "Dismiss".
- **Where the choice is stored.** In app settings storage, like `pi.remote-hosts.v1`. Piece 5 turns it into the home
  record.

  As built: `pi.infinichat.machine.v1` in expo-sqlite's kv-store, the machine's ID or nothing for *This iPhone*,
  read and written with the synchronous API as the keep-alive setting is (`src/pi/infinichat-remote/machine-choice.ts`).
  A machine removed from Remote machines stays chosen. Each attempt first restores the machines and looks it up, as
  `owner.ts` does for a chat's machine, and fails without SSH with InfiniChat's own message: "This machine was
  removed from Remote machines. Choose This iPhone or another machine in the InfiniChat header." The subtitle reads
  "Machine removed", and the notice offers no "Try Again".
- **The provider.** `chat-provider.tsx` opens the local core only when InfiniChat runs on the phone, and a
  `RemoteInfiniChat` otherwise. In remote mode the keep-alive observes nothing for InfiniChat (piece 6), because the
  work isn't on the phone.

  As built, the choice is a store the provider's lifecycle effect subscribes to. A change queues the close of the
  current side on the same queue that opens and closes storage, then `open()`. `open()` creates the
  `RemoteInfiniChat` when a machine is chosen, and calls its `reconnect()` when it already exists, so becoming
  active retries a failed connection; a return from the background calls `resume()` first (step 4). InfiniChat's
  keep-alive observation and its local notifications exist only in `openPhoneInfiniChat`, so remote mode has neither.
  A toggle sets `infiniChat` to `undefined` before the other side opens, so the screens show loading in between;
  piece 5 has to keep the last values instead (see its "What the user sees").

## Ownership and lifetime

| Resource | Created by | Cancelled by | Closed by |
| --- | --- | --- | --- |
| SSH connection, forward, socket | `RemoteInfiniChat`, per connection attempt | the next attempt's start, close | `RemoteInfiniChat` (on a drop, the old ones are disposed before the next attempt) |
| Chord client host | `RemoteInfiniChat`, once | — | `RemoteInfiniChat.close()` |
| Reference to `infinichat.remote` | the client host | — | released by `close()` |
| A method call | the screen | the screen's own signal, which cancels only the wait | settles; server work is never cancelled by a dropped link, only by `stop()` |
| A call's wait for a connection (as built) | `RemoteInfiniChat`, a root per call | a failed attempt, close | settles with the call |
| An install's SSH connection (as built) | `installServer`, when an attempt needs it | the attempt's signal | `installServer`, when it ends |

As built, the screens pass no signal of their own: they never did, and nothing needs one yet. A call's wait ends when
its attempt fails or `RemoteInfiniChat` closes; the server's work is untouched either way.

`RemoteInfiniChat` borrows the machine record and the credential store; it closes nothing it didn't create.
It has its own SSH connection, separate from the tools' daemon connections in `owner.ts`. They have different
lifetimes, and the server, not the phone, runs tools while InfiniChat is remote.

## Deviations (need approval)

None beyond the README's decisions. If App Transport Security refuses `ws://127.0.0.1` in a Release build (see
Checks), the fallback is a Chord `Link` over an SSH channel:
- the server gets an `attach` subcommand that pipes its stdio to the loopback socket;
- the phone implements Chord's public `Link` interface (`src/link.ts:5-18` at v1.4.0) over `openShell`.

That would be a deviation from Chord's provided links, and needs approval before it's built.

Found while implementing, against the installed sources (pi 1.4.0, React Native 0.88.0, react-native-ssh 0.3.0,
expo-router 58.0.25):

- **Install only when needed** (step 1, as built), instead of on every pick: a running server of this bundle needs
  no setup scripts and no second SSH connection.
- **The `device` in the handshake** is checked too, so renaming a machine reinstalls it under its new name.
- **Waiting calls reject with a failed attempt's error** (step 4, as built). The plan left them waiting until the
  next attempt, with nothing on screen to end them.
- **The WebSocket constructor's type.** Expo's `tsconfig.base.json` loads the DOM lib (`"lib": ["DOM", "ESNext"]`),
  whose `WebSocket` constructor takes two arguments, ahead of React Native's `globals.d.ts:569`, which declares the
  third. `client.ts` assigns the global to a constructor type with the `{ headers }` argument. That is an ordinary
  assignment, which TypeScript accepts because a constructor with fewer parameters fits a type with more, and no
  cast.
- **Shared admission connect.** `installServer`'s connect moved into `connectAdmitted` in `install.ts`, which the
  client also uses. `install.ts` exports `SERVER_BUNDLE`, `savedSecret` and `runningServer` for the client.
- **Back from the background replaces the link** (owner decision at review, step 4). It applies to the
  `background` → `active` transition only, the one iOS suspends the app for.

## Size

About 350 lines: the interface and provider changes ~80, `client.ts` ~170, the header menu and status ~100.

As built, about 530 lines after the review: `client.ts` 351, of which about a third is comments; `machine-choice.ts`
26; the provider +55 net; the header menu, subtitle and notices +55 net; the interface +25; `install.ts` +40 net, for
`connectAdmitted`, `savedSecret` and `runningServer`. The extra in `client.ts` is the install-when-needed decision,
the bundle and device check, and the wait for a live reference that also ends when the socket closes.

## Checks

Done in this piece on the implementer's Mac, with no device available. The real `RemoteInfiniChat`, contract,
Chord and `install.ts` ran on Node against a real server, with throwaway stand-ins (not committed) for
react-native-ssh, the Expo modules and React Native's three-argument `WebSocket`, which wrapped Node's own. The
results are in [references](references.md#piece-3-on-macos). Everything below is still unverified.

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
- **The menu** (added while implementing): the pull-down opens from the header, the checkmark follows the choice,
  the button's symbol changes with it, and VoiceOver reads "InfiniChat runs on …".
- **Hermes** (added while implementing): the time zone the server keeps is the phone's IANA name, and a call that
  waited through a failed attempt shows that attempt's message (it relies on `AbortController.abort(reason)`, which
  React Native 0.88 implements, `src/private/webapis/dom/abort-api/AbortController.js:63`).

## Not in this piece

Signing in on the server (piece 4; until then a send says to sign in), moving the phone's conversation (piece 5),
remote notifications (piece 6).
