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

Moving InfiniChat directly between two machines, and the Mac app's screens.
