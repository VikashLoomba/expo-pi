# Piece 7: Several clients

## Goal

Fix the server code that assumes the iPhone is its only client, so the iPhone and the Mac app can both use one
server, following Chord's and pi-durable's own model. This corrects the implementation; it isn't a product choice.
Watching and using InfiniChat from two clients at once already works, and stays as it is.

## What upstream already does

- **Several clients:** Chord gives one object per principal key, so "two tabs of the owner share an object" (chord
  `docs/guide.md:356`). pi-durable's late-join example shows a client attaching mid-run and catching up
  (`test/examples/21-late-join.ts`). The server already accepts every connection as `{ kind: 'owner' }`
  (`server/listen.ts:33`), so both clients share one object.
- **Each connection is authenticated and stamped:** "A link stamps the principal of whatever connects to it. Callers
  can never supply their own" (chord `docs/guide.md:359`). The guide's server authenticates every request:
  `webSocketLink(wss, { principal: (req) => authenticate(req) })` (`:717`).
- **The worker owns its machines:** pi-env's tools run elsewhere "while the Durable worker, its storage and
  credentials stay local" (pi-env `README.md:3-4`).
- **One holder, decided once per handover:** "One process owns a storage at a time" (pi-durable `README.md:790`). In
  upstream's unreleased session sync, a store "creates each slot once and never replaces it, so the device whose
  upload creates it continues the session" (pi `replication` branch at `f6f3d5507`,
  `packages/durable/src/sync/remote.ts:7`).

## What the app does instead

| Single-client code | Where | With two clients |
| --- | --- | --- |
| One secret file, read once at start; an install replaces it ("another phone's secret is refused from then on") | `server/listen.ts:25`, `install.ts:363` | Each client's install locks the other out |
| The phone's home record alone decides who may open the database | `home.ts` | A move started on the Mac leaves the phone's record wrong, and two copies could open |
| `setMachines` at every connect replaces the server's list, keyed by the client's own machine IDs | `client.ts` (`sendMachines`), `server/machines.ts:15`, `:101` | The clients overwrite each other's lists and drop each other's connections |
| `setTimeZone` at every connect | `server/state.ts:62` | The last client's zone wins: harmless while both are in the same zone, so it stays |

## Builds

It lands after piece 4, in the package's code.

### Each client authenticates as itself

- Each app keeps a client ID, generated once and stored with its other settings, and its secret for each machine, as
  today.
- An install writes this client's secret to `~/.infinichat/clients/<client ID>` (mode `0600`, in the `0700` folder)
  and leaves the other clients' files alone. The server stops replacing a single `secret`.
- `listen.ts` checks each connection against the files in `clients/` at that moment, so a new client needs no
  restart. Every connection is still stamped `{ kind: 'owner' }`, so both clients share the one object.
- Removing a machine on a client also removes that client's file there, when the machine is reachable.

### The server owns its list of other machines

- `ServerMachines` keeps its list as its own state, which it already persists (`server/machines.ts:101-104`).
- Clients edit it when the user edits Remote machines on that client: `putMachine` and `removeMachine` replace
  `setMachines`. Nothing is sent at connect. A machine is keyed by its endpoint (`username@hostname:port`), not by a
  client's ID.
- Host keys: whichever client the user is on accepts them, through the existing `acceptHostKey`.
- What users see: a machine added on either device becomes reachable by the server's tools.

### The conversation's holder is recorded where every client can read it

The iPhone is reachable by no one, so the record lives on the machines, which every client reaches. This follows
upstream's handover: one claim per handover, created once.

- `relinquish({ to })` records the next holder (a machine, or a phone with its client ID and name) in `state.json`
  before it closes the Harness. Called again with the same `to`, it returns the files again, as today. With a different
  `to` it is refused while that handover is pending, so two clients can't move it in two directions.
- `adopt` on the next holder is unchanged: refused while active, and checked against the files' hashes. An `adopt` on
  the releasing machine itself (Cancel's undo) clears the claim.
- After a move back to a phone, `archive` keeps `heldBy` (that phone) in `state.json`. The `conversation` cell shows
  it, so the Mac can say "InfiniChat is on <phone>" instead of offering a move.
- The phone keeps its home record for its own side: whether it holds the conversation, and a move's phase across a
  relaunch.

On the Mac, InfiniChat lives in the Mac's own server, the same bundle the phone installs, and the Mac app is a client
of it, as Chord's guide has a server host own the Harness while clients connect (`docs/guide.md:756`). So a holder is
always a machine's server or a phone, never the Mac app's window. Moving InfiniChat directly between two machines is a
new capability for the Mac app, not part of this fix.

### The contract

`InfiniChatPrincipal`'s comment says "the phone, its one client" (`contract.ts:13`); it becomes "a client". The
contract's version changes with the new methods (`putMachine`, `removeMachine`, `relinquish({ to })`). The phone
installs the matching server bundle before it moves anything, as it already does.

## Ownership and lifetime

- Client credential files: the install of each client creates its own; removing the machine on that client deletes
  it. The server only reads them.
- The machine list: owned by `ServerMachines`, as today. Clients only send edits.
- The holder claim: written by `ServerConversation`'s operation queue, which already runs one operation at a time, so
  two clients' calls are serialized there.

## Deviations (need approval)

None. Two notes:
- Each app keeps a client ID, which Chord's model needs: every connection authenticates as its own client.
- The holder claim follows upstream sync's slot, built on today's transport because sync is unreleased, as AGENTS.md
  asks ("build it in the simplest way consistent with upstream's mechanics"). Sync replaces it once released.

## Size

About 150 lines: the client files in `listen.ts` and `install.ts`, the machine edits in `machines.ts`, `serve.ts` and
the client, and the claim in `conversation.ts`, `move.ts` and the contract.

## Checks

- Lint, typecheck, server typecheck; rebuild the server asset.
- With the iPhone and a second client (a throwaway Node client on the Mac until the Mac app exists):
  - Both connected at once: both see the same transcript live, and both can send.
  - The second client's install doesn't disconnect the phone.
  - A machine added on one client keeps working after the other connects.
  - A move started on one client: the other sees it; a second move from the other is refused while it's pending.
  - After a move back to the phone: the other client sees "on <phone>".
- One move each way from the phone, as before.

## Not in this piece

The Mac app's screens. Moving InfiniChat directly between two machines came later; see "As built".

## As built

From `ab19daf`, with pi 1.4.0 (the latest on npm on 2026-10-26), Expo 58.0.17 and React Native 0.88.0; one commit,
since the doc names no steps. What differs from the plan:

- **Machine lists go per client, at connect, not as `putMachine` and `removeMachine`.** A client reaches a server
  only while InfiniChat is on that machine (the provider makes a `RemoteInfiniChat` only then), so edits made while
  it is on the phone, the usual case, would never arrive, and a machine added or removed then would be missing or
  stale after the next move. `setMachines({ client, machines })` replaces only that client's list; the server uses
  each endpoint once, named by the client that sent last, so clients still never drop each other's machines.
  `machines.json` holds the lists by client ID; one from before this piece, an array, adds no machines and can be
  removed.
- **The holder is one field, `heldBy`, and only a phone.** Nothing in this piece hands the conversation to a machine
  from a machine, so `to` has no machine form yet. `RemoteInfiniChat` fills it in, so `InfiniChatMoves` is unchanged.
- **An install no longer restarts the server for a new secret**, which it did only because the server read one file
  at start. A machine keeps its unused `~/.infinichat/secret`.
- **Host keys on the server are stored under the endpoint**, not the phone's machine ID, so a key the phone pinned is
  accepted again by itself, and one accepted only on the server waits for a client once more.
- **Machines reach each other with InfiniChat keys the phone exchanges** (2026-10-27, after the owner found a
  `Permission denied` from the server's own `ssh` to a Mac on the same tailnet "silly"). At every connection to a
  machine, the phone's `ssh-keys.ts` gives it `~/.infinichat/ssh/id_ed25519`, authorizes the other machines' keys in
  its `authorized_keys` as `ssh-copy-id` does, and keeps the public keys on the machine's record (`publicKey`,
  `authorizedKeys`). `MachineSchema` carries `authorizedKeys`, so a change re-checks the machine; `ServerMachines`
  passes the key as pi-env's `identityFile` (`IdentitiesOnly`), so personal keys and agents stay out of it. Passwords
  still never leave the phone; a machine running Tailscale SSH needs none of this.
- **Tailscale SSH's check mode on the phone** (owner, 2026-10-29: "Is it possible to do the same detection on the
  iOS app to open an oauth browser?"). The sign-in comes as the SSH auth banner (RFC 4252 §5.4), which the phone's
  SSH library dropped, so the phone now uses the owner's fork `@automatalabs/react-native-ssh` (0.4.0, source in
  `packages/react-native-ssh`, mirrored at github.com/VikashLoomba/react-native-ssh; iOS archives only, built by its
  `scripts/build-rust-ios.sh` and not committed): an `onBanner` connection handler, and the time from
  the banner until authentication completes is not counted against `connectTimeoutMs`, as a host-key or prompt
  decision is not (up to the library's ten-minute cap). `execution/remote/tailscale.ts` gives every SSH connect
  (`channel.ts`, `phone-dialer.ts`) a `tailscaleSignIn`: the package's `TailscaleLogins` finds the URL and opens it
  once in expo-web-browser's in-app browser, which closes by itself once the connection settled. Not
  `openAuthSessionAsync`: Tailscale's page never redirects back to the app.
- **A move goes straight from one machine to another** (2026-10-27, the owner: "why does the process need the
  iphone if transferring between machines?"). The phone orchestrates, as it holds the home record and installs the
  target's server, but the bytes don't pass through it. `between` in `move.ts`: the phone's own connection to the
  target gives it its InfiniChat key, the source authorizes that key through the environment the phone borrows there
  (`authorize`, with the exchange script now in `keys.ts`), the target's server connects, the source `relinquish`es
  to the target (`ClientSchema` now names a machine by its endpoint too, so `heldBy` reads "on Mac"), the target
  `pull`s the released database over its own SSH (`ServerConversation.pull`, a new contract method; version 3) and
  `adopt`s it, and the source archives. The home record keeps `from` while `moving-there`, so a relaunch resumes it
  and Cancel has the source adopt its files again. The provider keeps one client per machine, two during such a
  move. A Cancel during the pull waits for the pull to end.
- **SSH host keys are trusted on first use** (2026-10-27, the owner: "no user is going to actually cross-check, and
  pi-env already does verification"). pi-env's README example has the owner compare the fingerprint between
  `scanHostKey` and `acceptHostKey`; the app now follows OpenSSH's `accept-new` instead, which pi-env also offers:
  `hostKeyPolicy` in `hosts.ts`, shared by the test, the chats' tools and the InfiniChat dialer, pins the first key a
  machine presents and refuses a different one (`HOST_KEY_REJECTED`), which Remote machines turns into a confirmed
  "Trust new key". The server does the same for the machines it reaches (`ServerMachines.open`): the client's pin
  when there is one, else the scanned keys; only a changed key waits for a client. Saving a machine now connects to
  it in the form itself, so an added machine is ready at once; the fingerprint screen and the reset button are
  gone. The exposure is a node already inside the tailnet answering at the address on the day a machine is added.
- The client ID is `pi.infinichat.client.v1` in kv-store and the name is expo-device's `deviceName` ("iPhone" on
  iOS 16 and later without the entitlement). Removal removes this phone's file only where it has a secret, so a
  machine never used for InfiniChat isn't connected to. The bundle is 8,355,444 bytes, SHA-256 `0d1897ad…3f8432`.
